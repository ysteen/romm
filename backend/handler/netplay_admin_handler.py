"""Expose bridge management through the authenticated RomM adapter."""

from typing import Any
from urllib.parse import urlsplit

from fastapi import HTTPException

from config import (
    NETPLAY_BRIDGE_PUBLIC_HOST,
    NETPLAY_BRIDGE_PUBLIC_URL,
    NETPLAY_BRIDGE_URL,
)
from endpoints.responses.netplay_bridge import (
    BridgeAdminResponse,
    BridgeNetworkSettings,
    BridgeRuntimeSettings,
)
from handler import netplay_bridge_handler as bridge
from handler.netplay_settings_handler import (
    network_settings,
    public_addresses,
    save_network_settings,
)

ADMIN_ASSETS = {
    "index.html": "text/html",
    "admin.js": "text/javascript",
    "admin.css": "text/css",
}


async def ui_asset(name: str) -> tuple[bytes, str]:
    if name not in ADMIN_ASSETS:
        raise HTTPException(status_code=404, detail="Administration asset not found")
    value = await bridge.bridge_request(
        "GET", f"/admin/ui/{name}", response_limit=256 * 1024, raw_response=True
    )
    if not isinstance(value, bytes):
        raise HTTPException(status_code=502, detail="Invalid administration asset")
    return value, ADMIN_ASSETS[name]


async def overview(username: str) -> BridgeAdminResponse:
    public_url, native_host = public_addresses(
        NETPLAY_BRIDGE_PUBLIC_URL, NETPLAY_BRIDGE_PUBLIC_HOST
    )
    return BridgeAdminResponse(
        username=username,
        public_url=public_url,
        native_host=native_host or urlsplit(public_url).hostname or "",
        internal_url=NETPLAY_BRIDGE_URL,
        network=network_settings(),
        defaults=BridgeNetworkSettings(
            public_url=NETPLAY_BRIDGE_PUBLIC_URL,
            native_host=NETPLAY_BRIDGE_PUBLIC_HOST,
        ),
        broker=await bridge.bridge_request("GET", "/admin", response_limit=512 * 1024),
    )


async def update_runtime(value: BridgeRuntimeSettings) -> dict[str, Any]:
    result: dict[str, Any] = await bridge.bridge_request(
        "PUT", "/admin/settings", value.model_dump()
    )
    return result


def update_network(value: BridgeNetworkSettings) -> BridgeNetworkSettings:
    save_network_settings(value)
    return value


async def logs(after: int) -> dict[str, Any]:
    result: dict[str, Any] = await bridge.bridge_request(
        "GET", f"/admin/logs?after={after}", response_limit=2 * 1024 * 1024
    )
    return result
