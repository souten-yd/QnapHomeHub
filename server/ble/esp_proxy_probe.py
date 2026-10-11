# SPDX-License-Identifier: GPL-3.0-or-later
"""Read-only, one-shot M5GO ESPHome proxy BLE diagnostics.

Uses a separate Python environment from the existing BlueZ/Bleak 0.22 worker.
Never pairs, writes GATT, unlocks an Omron or reads measurements.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys

OMRON_SERVICE = "ecbe3980-c9a2-11e1-b1bd-0002a5d5c51b"
MAC = re.compile(r"^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$")


def normalize_mac(value: str) -> str:
    value = value.strip().upper()
    if not MAC.fullmatch(value):
        raise ValueError("BLE address must contain six hexadecimal octets")
    return value


def masked_mac(address: str) -> str:
    return "XX:XX:XX:" + normalize_mac(address)[9:]


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Read-only M5GO proxy diagnostic")
    parser.add_argument("--host", required=True)
    parser.add_argument("--target", type=normalize_mac)
    parser.add_argument("--scan-seconds", type=int, default=12)
    parser.add_argument("--connect", action="store_true")
    args = parser.parse_args(argv)
    if not 2 <= args.scan_seconds <= 30:
        parser.error("Scan time must be between 2 and 30 seconds")
    if args.connect and not args.target:
        parser.error("--connect requires --target")
    if not args.host or len(args.host) > 253 or any(char.isspace() for char in args.host) or "/" in args.host:
        parser.error("Invalid host")
    return args


async def probe(host, target, scan_seconds, connect, psk):
    try:
        import bleak
        import habluetooth
        from bleak_esphome import APIConnectionManager
    except ImportError as exc:
        raise RuntimeError("Isolated ESPHome proxy Python environment is missing") from exc

    output = {"schema": 1, "mode": "read-only",
              "target": masked_mac(target) if target else None,
              "api_connected": False, "advertisement_seen": False,
              "gatt_connected": False, "omron_service_found": False}
    await habluetooth.BluetoothManager().async_setup()
    manager = APIConnectionManager({"address": host, "noise_psk": psk})
    try:
        await asyncio.wait_for(manager.start(), timeout=20)
        output["api_connected"] = True
        observations = await bleak.BleakScanner.discover(timeout=scan_seconds, return_adv=True)
        if target:
            matched = next(((dev, adv) for dev, adv in observations.values()
                            if dev.address.upper() == target), None)
            if matched:
                device, adv = matched
                output["advertisement_seen"] = True
                output["rssi"] = adv.rssi
                if connect:
                    async with bleak.BleakClient(device, timeout=20) as client:
                        output["gatt_connected"] = bool(client.is_connected)
                        output["omron_service_found"] = client.services.get_service(OMRON_SERVICE) is not None
        else:
            output["devices_seen"] = len(observations)
        return output
    finally:
        await manager.stop()


def main(argv=None):
    args = parse_args(argv)
    try:
        result = asyncio.run(asyncio.wait_for(
            probe(args.host, args.target, args.scan_seconds, args.connect,
                  os.environ.get("HOMEHUB_M5GO_NOISE_PSK") or None), timeout=65))
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        # No credential, health value or raw advertisement is included.
        print(json.dumps({"schema": 1, "mode": "read-only", "success": False,
                          "error_type": type(error).__name__}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
