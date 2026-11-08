import base64

import pytest
from fastapi import HTTPException

from handler import wfc_handler as wfc


@pytest.mark.asyncio
async def test_console_identity_and_settings_are_account_scoped(tmp_path, mocker):
    mocker.patch.object(wfc, "ASSETS_BASE_PATH", str(tmp_path))
    first = await wfc.profile(1)
    other = await wfc.profile(2)
    assert first.mac != other.mac
    assert first == await wfc.profile(1)
    firmware = base64.b64encode(b"settings").decode()
    await wfc.save_settings(1, first.mac, firmware)
    assert (await wfc.profile(1)).firmware == firmware
    assert (await wfc.profile(2)).firmware == ""
    assert (await wfc.profile(1)).mac == first.mac
    with pytest.raises(HTTPException, match="account changed"):
        await wfc.save_settings(2, first.mac, firmware)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value", ["invalid!", "", base64.b64encode(b"x" * 4097).decode()]
)
async def test_rejects_invalid_settings(value):
    with pytest.raises(HTTPException) as error:
        await wfc.save_settings(1, "0209bf112233", value)
    assert error.value.status_code == 422
