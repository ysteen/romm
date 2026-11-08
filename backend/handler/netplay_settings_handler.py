"""Persist the public connection addresses advertised to netplay clients."""

import json

from endpoints.responses.netplay_bridge import BridgeNetworkSettings
from handler.redis_handler import redis_client

SETTINGS_KEY = "netplay-public-addresses"


def network_settings() -> BridgeNetworkSettings:
    stored = redis_client.get(SETTINGS_KEY)
    return (
        BridgeNetworkSettings.model_validate_json(stored)
        if stored
        else BridgeNetworkSettings()
    )


def save_network_settings(value: BridgeNetworkSettings) -> None:
    redis_client.set(SETTINGS_KEY, json.dumps(value.model_dump()))


def public_addresses(default_url: str, default_host: str) -> tuple[str, str]:
    value = network_settings()
    return value.public_url or default_url, value.native_host or default_host
