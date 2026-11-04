from typing import Literal, Self

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
    action: Literal["start", "assign", "kick"]
    player: int | None = Field(default=None, ge=0, le=3, strict=True)
    seat: int | None = Field(default=None, ge=0, le=3, strict=True)


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
    save_host: int | None = None
