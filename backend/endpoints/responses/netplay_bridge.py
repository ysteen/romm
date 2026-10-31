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

    @field_validator("coreVersion")
    @classmethod
    def validate_core_version(cls, value: str) -> str:
        if "\0" in value or len(value.encode("utf-8")) > 31:
            raise ValueError("Core version exceeds the relay protocol limit")
        return value

    @model_validator(mode="after")
    def validate_core_profile(self) -> Self:
        if self.coreName != BRIDGE_CORE_NAMES[self.system] or (
            self.system != "gba" and self.players != 2
        ):
            raise ValueError("Core or player count does not match the selected system")
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


class BridgeConnectionResponse(BaseModel):
    id: str
    websocket_url: str
    native_host: str
    native_port: int | None = Field(ge=1, le=65535, strict=True)
    password: str
    players: int = Field(ge=2, le=4, strict=True)
    player: int = Field(ge=0, le=3, strict=True)


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
