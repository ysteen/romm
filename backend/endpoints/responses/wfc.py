from pydantic import BaseModel, Field


class WfcSettingsRequest(BaseModel):
    firmware: str = Field(max_length=5500)
    mac: str = Field(pattern=r"^[0-9a-f]{12}$")


class WfcProfileResponse(WfcSettingsRequest):
    pass


class WfcSessionResponse(BaseModel):
    websocket_url: str
    profile: WfcProfileResponse


class WfcSessionRequest(BaseModel):
    rom_id: int = Field(gt=0)
