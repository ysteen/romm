import pytest
from pydantic import ValidationError

from endpoints.responses.netplay_bridge import BridgeControlRequest, BridgeRoomRequest


def room(**overrides):
    return BridgeRoomRequest(
        **{
            "rom_id": 1,
            "system": "gb",
            "coreName": "SameBoy",
            "coreVersion": "test",
            "contentCrc": 1,
            "stateSize": 64,
            "players": 2,
            **overrides,
        }
    )


def test_disconnect_policy_preserves_legacy_default():
    assert room().disconnectPolicy == "continue"
    for value in ("pause", "continue"):
        assert room(disconnectPolicy=value).model_dump()["disconnectPolicy"] == value
        assert BridgeControlRequest(action="disconnect-policy", disconnectPolicy=value)


@pytest.mark.parametrize("value", [None, True, "stop", "", 1])
def test_disconnect_policy_rejects_invalid_settings(value):
    with pytest.raises(ValidationError):
        room(disconnectPolicy=value)
    with pytest.raises(ValidationError):
        BridgeControlRequest(action="disconnect-policy", disconnectPolicy=value)


def test_policy_action_requires_a_value_without_changing_other_actions():
    with pytest.raises(ValidationError):
        BridgeControlRequest(action="disconnect-policy")
    assert BridgeControlRequest(action="start").action == "start"
