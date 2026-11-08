import ipaddress
import re
from typing import Any, Literal, Self
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

BRIDGE_CORE_NAMES = {
    "gb": "SameBoy",
    "gba": "mGBA Splitscreen",
    "snes": "Snes9x",
}


class BridgeConfigResponse(BaseModel):
    enabled: bool
    player_url: str = "/assets/emulatorjs/input-netplay/bridge.html"


class BridgeRuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    roomsEnabled: bool = Field(strict=True)
    maxRooms: int = Field(ge=1, le=8, strict=True)
    saveIntervalSeconds: int = Field(ge=5, le=120, strict=True)


class BridgeNetworkSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    public_url: str = Field(default="", max_length=2048)
    native_host: str = Field(default="", max_length=255)

    @field_validator("public_url")
    @classmethod
    def validate_public_url(cls, value: str) -> str:
        if not value:
            return value
        parsed = urlsplit(value)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or any(ord(char) <= 32 or char == "\\" for char in value)
        ):
            raise ValueError(
                "Use an HTTP or HTTPS address without credentials, query or fragment"
            )
        _ = parsed.port
        return value.rstrip("/")

    @field_validator("native_host")
    @classmethod
    def validate_native_host(cls, value: str) -> str:
        if not value:
            return value
        try:
            return str(ipaddress.ip_address(value))
        except ValueError:
            if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value):
                raise ValueError(
                    "Use a hostname or IP address without a port"
                ) from None
        return value


class BridgeAdminContextResponse(BaseModel):
    application_name: str
    application_url: str
    csrf_cookie: str
    csrf_header: str


class BridgeAdminResponse(BaseModel):
    username: str
    public_url: str
    native_host: str
    internal_url: str
    network: BridgeNetworkSettings
    defaults: BridgeNetworkSettings
    broker: dict[str, Any]


class BridgeIdentity(BaseModel):
    nickname: str = Field(default="", max_length=31)
    password: str | None = Field(default=None, max_length=120)

    @field_validator("nickname", "password")
    @classmethod
    def validate_wire_text(cls, value: str | None, info: ValidationInfo) -> str | None:
        limit = 120 if info.field_name == "password" else 31
        if value is not None and ("\0" in value or len(value.encode("utf-8")) > limit):
            raise ValueError("Text exceeds the relay protocol limit")
        return value


class BridgeCartridge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    romId: int = Field(gt=0, strict=True)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    size: int = Field(gt=0, le=32 * 1024 * 1024, strict=True)
    crc32: int = Field(ge=0, le=0xFFFFFFFF, strict=True)


class BridgeRoomRequest(BridgeIdentity):
    model_config = ConfigDict(extra="forbid")

    rom_id: int = Field(gt=0, strict=True)
    system: Literal["gb", "gba", "snes"]
    coreName: Literal["SameBoy", "mGBA Splitscreen", "Snes9x"]
    coreVersion: str = Field(min_length=1, max_length=31)
    contentCrc: int = Field(ge=0, le=0xFFFFFFFF, strict=True)
    stateSize: int = Field(gt=0, le=16 * 1024 * 1024, strict=True)
    players: int = Field(ge=2, le=4, strict=True)
    nativeAllowed: bool = False
    nativeCalibration: Literal["sameboy-v1"] | None = None
    maxPrediction: int = Field(default=0, ge=0, le=30, strict=True)
    cartridges: list[BridgeCartridge] | None = Field(default=None, max_length=4)
    collectCartridges: bool = False
    disconnectPolicy: Literal["continue", "pause"] = "continue"
    saveSize: int | None = Field(default=None, ge=0, le=131072, strict=True)

    @field_validator("coreVersion")
    @classmethod
    def validate_core_version(cls, value: str) -> str:
        if "\0" in value or len(value.encode("utf-8")) > 31:
            raise ValueError("Core version exceeds the relay protocol limit")
        return value

    @model_validator(mode="after")
    def validate_core_profile(self) -> Self:
        if self.collectCartridges and (
            self.system not in {"gb", "gba"} or not self.cartridges
        ):
            raise ValueError("Cartridge collection requires a GB/GBC or GBA cartridge")
        if self.coreName != BRIDGE_CORE_NAMES[self.system] or (
            self.system != "gba" and self.players != 2
        ):
            raise ValueError("Core or player count does not match the selected system")
        if self.cartridges is not None:
            expected = 1 if self.system == "snes" else self.players
            if len(self.cartridges) != expected:
                raise ValueError("Supply one cartridge per console")
            if (
                self.cartridges[0].romId != self.rom_id
                or self.cartridges[0].crc32 != self.contentCrc
            ):
                raise ValueError("Primary cartridge does not match the room")
            if (
                self.system == "snes"
                and len({rom.sha256 for rom in self.cartridges}) > 1
            ):
                raise ValueError("SNES players share one cartridge")
        if self.nativeCalibration is not None and not (
            self.nativeAllowed
            and self.system == "gb"
            and self.coreName == "SameBoy"
            and self.coreVersion == "1.0.4 c87d256"
            and self.players == 2
            and self.maxPrediction == 0
        ):
            raise ValueError("Native calibration does not match the core profile")
        return self


class BridgeJoinRequest(BridgeIdentity):
    model_config = ConfigDict(extra="forbid")

    rom_id: int = Field(gt=0, strict=True)
    cartridge: BridgeCartridge | None = None

    @model_validator(mode="after")
    def validate_cartridge(self) -> Self:
        if self.cartridge and self.cartridge.romId != self.rom_id:
            raise ValueError("Cartridge must match the selected ROM")
        return self


class BridgeConnectionResponse(BaseModel):
    id: str
    websocket_url: str
    native_host: str
    native_port: int | None = Field(ge=1, le=65535, strict=True)
    password: str
    players: int = Field(ge=2, le=4, strict=True)
    player: int = Field(ge=0, le=3, strict=True)


class BridgeNativeRequest(BridgeJoinRequest):
    platform: Literal["windows-x86_64", "windows-x86", "windows-arm64"]
    battery: str = Field(default="", max_length=174764)


class BridgeNativeResponse(BaseModel):
    id: str
    player: int
    credential: str
    native_password: str
    native_host: str
    native_port: int
    expires_at: int
    package_url: str


class BridgeNativeTicketResponse(BaseModel):
    ticket: str
    launch_url: str
    expires_at: int


class BridgeNativeTicketStatus(BaseModel):
    status: Literal["waiting", "preparing"]
    session: BridgeNativeResponse | None = None


class BridgeNativeSeatRequest(BaseModel):
    seat: int | None = Field(ge=0, le=3, strict=True)


class BridgeControlRequest(BaseModel):
    action: Literal["start", "assign", "kick", "disconnect-policy"]
    disconnectPolicy: Literal["continue", "pause"] | None = None
    player: int | None = Field(default=None, ge=0, le=3, strict=True)
    seat: int | None = Field(default=None, ge=0, le=3, strict=True)

    @model_validator(mode="after")
    def validate_disconnect_policy(self) -> Self:
        if self.action == "disconnect-policy" and self.disconnectPolicy is None:
            raise ValueError("Choose a disconnect policy")
        return self


class BridgeNativeSaveRequest(BaseModel):
    player: int = Field(ge=0, le=3, strict=True)
    owner: str = Field(max_length=128)
    generation: int = Field(ge=0, strict=True)
    frame: int = Field(ge=0, strict=True)
    battery: str = Field(max_length=174764)


class BridgeMember(BaseModel):
    player: int
    owner: str = ""
    romId: int | None = None
    clientPlatform: str | None = None
    nickname: str
    kind: Literal["web", "native", "preparing"]
    ready: bool
    playing: bool
    ping: int | None = None
    waitingForNewGame: bool = False


class BridgeSaveStatus(BaseModel):
    enabled: bool = False
    pending: int = 0
    synced: bool = False
    error: str | None = None


class BridgeRoomResponse(BaseModel):
    id: str
    rom_id: int
    players: int
    current: int
    started: bool
    native_allowed: bool
    core_name: str
    core_version: str
    state_size: int
    content_crc: int
    has_password: bool
    native_calibration: Literal["sameboy-v1"] | None = None
    max_prediction: int = Field(default=0, ge=0, le=30, strict=True)
    cartridges: list[BridgeCartridge] | None = None
    native_auth: bool = False
    collect_cartridges: bool = False
    content_prepared: bool = True
    members: list[BridgeMember] = Field(default_factory=list)
    seats: list[int | None] = Field(default_factory=list)
    generation: int = 0
    host: int | None = 0
    running: bool = False
    starting: bool = False
    can_start: bool = False
    native_authority: bool = False
    disconnect_policy: Literal["continue", "pause"] = "continue"
    waiting_for_players: list[int] = Field(default_factory=list)
    save_host: int | None = None
    requires_new_game: bool = False
    saves: BridgeSaveStatus = Field(default_factory=BridgeSaveStatus)
