#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Offline comparison of actual USB Session and M5GO worker transactions.

Only synthetic keys/peripherals; no CLI credentials, native API or BlueZ.
Successful fake replies establish code paths, NOT HBF registration semantics.
"""
import asyncio
import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server' / 'ble'))
import ble_protocol as protocol
from ble_worker import Session, sync_session
from esp_proxy_security import LinkSecurityError
from esp_proxy_worker import operate
from test_esp_proxy_worker import Peripheral, Remote, REQUEST


class RecordingPeripheral(Peripheral):
    def __init__(self):
        super().__init__()
        self.events = []

    def channel(self, char):
        return 'unlock' if char == protocol.UNLOCK else 'RX' + str(protocol.RX.index(char))

    async def start_notify(self, char, callback):
        self.events.append('notify_on:' + self.channel(char))
        await super().start_notify(char, callback)

    async def stop_notify(self, char):
        self.events.append('notify_off:' + self.channel(char))
        await super().stop_notify(char)

    async def pair(self):
        self.events.append('ble_pair')
        await super().pair()

    async def write_gatt_char(self, char, data, response):
        if char == protocol.UNLOCK:
            self.events.append('unlock_opcode:' + str(data[0]))
            self.writes.append((char, bytes(data)))
            status = 1 if self.fail == 'auth' else 0
            self.notifications[char](char, bytes([data[0] | 0x80, status]))
            return
        # Summarize memory traffic, never print even synthetic record payloads.
        event = 'memory_opcode:' + str(data[1])
        if not self.events or self.events[-1] != event:
            self.events.append(event)
        await super().write_gatt_char(char, data, response)


async def compare():
    report = {'mode': 'offline_synthetic_peripheral', 'hardware_acceptance': 'NOT TESTED', 'cases': {}}
    for mode in ('usb_registration', 'usb_sync', 'm5go_ble_only',
                 'm5go_bond_sync', 'm5go_unlock_refused', 'm5go_security_failed'):
        client = RecordingPeripheral()
        remote = Remote(client)
        request = copy.deepcopy(REQUEST)
        trace = {'slots': [], 'rx_notifications': 0}
        outcome = 'completed'
        if mode.endswith('refused'):
            client.fail = 'auth'
        gate = SimpleNamespace(connected=AsyncMock(), authenticated=AsyncMock(), mark=Mock())
        if mode.endswith('security_failed'):
            gate.authenticated.side_effect = LinkSecurityError('authentication_failed')
        remote.prepare_security = AsyncMock(return_value=gate)
        remote.prepare_bond = AsyncMock()
        try:
            if mode.startswith('usb_'):
                session = Session(client, trace)
                await client.connect()
                try:
                    await session.subscribe()
                    if mode == 'usb_registration':
                        await session.pair(bytes.fromhex(request['key']), 'HBF-228T')
                    else:
                        await sync_session(session, request, trace)
                finally:
                    await client.disconnect()
            else:
                if mode == 'm5go_ble_only':
                    request['action'] = 'bond'
                else:
                    request['bond_session'] = True
                await operate(request, trace, remote.factory)
        except (ValueError, LinkSecurityError):
            if mode not in ('m5go_unlock_refused', 'm5go_security_failed'):
                raise
            outcome = 'stopped'
        unlocks = [data[0] for char, data in client.writes if char == protocol.UNLOCK]
        commands = [data[1] for char, data in client.writes if char != protocol.UNLOCK]
        expected = {'usb_registration': [2, 0], 'usb_sync': [1], 'm5go_ble_only': [],
                    'm5go_bond_sync': [1], 'm5go_unlock_refused': [1], 'm5go_security_failed': []}
        assert unlocks == expected[mode], (mode, 'unexpected application registration/authentication')
        if mode == 'usb_registration':
            assert commands == [0, 15]
            assert client.writes[1][1] == b'\x00' + bytes.fromhex(request['key'])
        if mode in ('m5go_ble_only', 'm5go_unlock_refused', 'm5go_security_failed'):
            assert commands == [], (mode, 'unexpected memory transaction')
        if mode in ('usb_sync', 'm5go_bond_sync'):
            assert commands == [0] + [1] * 60 + [15]
        assert client.disconnected
        if mode.startswith('m5go_'):
            assert remote.closed
        report['cases'][mode] = {'outcome': outcome, 'events': client.events,
                                 'unlock_opcodes': unlocks, 'memory_commands': len(commands)}
    return report


if __name__ == '__main__':
    # Remove fixed waits only; actual Session/worker logic and frame parser run.
    with patch('asyncio.sleep', new=AsyncMock()):
        print(json.dumps(asyncio.run(compare()), ensure_ascii=False, indent=2))
