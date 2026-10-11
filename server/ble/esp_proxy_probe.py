# SPDX-License-Identifier: GPL-3.0-or-later
"""Read-only, one-shot M5GO ESPHome proxy BLE diagnostics.

Uses a separate Python environment from the existing BlueZ/Bleak 0.22 worker.
Never pairs, writes GATT, unlocks an Omron or reads measurements.
"""
from __future__ import annotations

import argparse
import asyncio
import fcntl
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
    from esp_proxy_worker import operate
    lock = os.open(os.environ.get('SELFCARE_BLE_LOCK', '/tmp/qnapselfcare-ble.lock'),
                   os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return await operate({'action': 'probe', 'proxy': {'host': host, 'noise_psk': psk},
                              'target': target, 'scan_seconds': scan_seconds, 'connect': connect})
    finally:
        os.close(lock)


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
