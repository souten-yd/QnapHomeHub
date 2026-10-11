# SPDX-License-Identifier: GPL-3.0-or-later
"""Registration transactions, failure boundaries, and USB parity; synthetic BLE."""
import asyncio
import copy
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import ble_protocol as protocol
from ble_worker import Session
from esp_proxy_security import LinkSecurityError
from esp_proxy_worker import operate, validate, ProxyInputError
from test_esp_proxy_worker import Peripheral, Remote, REQUEST


class RegistrationPeripheral(Peripheral):
    def __init__(self):
        super().__init__()
        self.reject_opcode = None
        self.disconnect_opcode = None
        self.subscriptions_at_write = []

    async def write_gatt_char(self, char, data, response):
        self.subscriptions_at_write.append(set(self.notifications))
        if char == protocol.UNLOCK:
            self.writes.append((char, bytes(data)))
            if data[0] == self.disconnect_opcode:
                raise ConnectionError('ambiguous write outcome')
            self.notifications[char](char, bytes([data[0] | 0x80, int(data[0] == self.reject_opcode)]))
        else:
            await super().write_gatt_char(char, data, response)


class RegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sleeper = patch('asyncio.sleep', new=AsyncMock())
        self.sleeper.start()
        self.addCleanup(self.sleeper.stop)
        self.request = copy.deepcopy(REQUEST)
        self.request.update(bond_session=True, application_registration=True)
        self.client = RegistrationPeripheral()
        self.remote = Remote(self.client)
        self.gate = SimpleNamespace(connected=AsyncMock(), authenticated=AsyncMock(), mark=Mock())
        self.remote.prepare_security = AsyncMock(return_value=self.gate)
        self.remote.prepare_bond = AsyncMock()

    async def run_registration(self):
        return await operate(self.request, {'slots': [], 'rx_notifications': 0}, self.remote.factory)

    async def test_matches_usb_bytes_notifications_and_close_without_reading_records(self):
        usb = RegistrationPeripheral()
        session = Session(usb)
        await session.subscribe()
        await session.pair(bytes.fromhex(REQUEST['key']), 'HBF-228T')
        async def secure():
            self.assertEqual(self.client.writes, [])
        self.gate.authenticated.side_effect = secure
        result = await self.run_registration()
        self.assertEqual(self.client.writes, usb.writes)
        self.assertEqual(self.client.notification_changes, usb.notification_changes)
        self.assertEqual(self.client.subscriptions_at_write, usb.subscriptions_at_write)
        self.assertEqual([d[0] for c, d in self.client.writes if c == protocol.UNLOCK], [2, 0])
        self.assertEqual([d[1] for c, d in self.client.writes if c != protocol.UNLOCK], [0, 15])
        self.assertEqual(result['records'], [])
        self.assertTrue(result['registration_only'])
        self.assertEqual(result['diagnostic']['stage'], 'registration_completed')
        self.assertTrue(result['diagnostic']['application_key_value_reused'])
        self.assertFalse(result['diagnostic']['history_read'])
        self.assertNotIn(REQUEST['key'], str(result))
        self.assertTrue(self.client.disconnected and self.remote.closed)
        self.assertEqual(self.client.bonds, 1)

    async def test_key_refusal_or_ambiguous_write_never_retries_or_opens_memory(self):
        for field, opcode in [('reject_opcode', 2), ('reject_opcode', 0), ('disconnect_opcode', 0)]:
            with self.subTest(field=field, opcode=opcode):
                self.client = RegistrationPeripheral()
                setattr(self.client, field, opcode)
                self.remote.peripheral = self.client
                with self.assertRaises((ValueError, ConnectionError)):
                    await self.run_registration()
                self.assertEqual([d[0] for c, d in self.client.writes], [2] if opcode == 2 else [2, 0])
                self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_close_failure_is_not_registration_success(self):
        self.client.fail = 'close'
        with self.assertRaises(ConnectionError):
            await self.run_registration()
        self.assertTrue(self.client.disconnected and self.remote.closed)
        self.assertEqual([d[1] for c, d in self.client.writes if c != protocol.UNLOCK], [0, 15])

    async def test_security_failure_or_missing_journal_never_sends_key(self):
        self.gate.authenticated.side_effect = LinkSecurityError('authentication_failed')
        with self.assertRaises(LinkSecurityError):
            await self.run_registration()
        self.assertEqual(self.client.writes, [])
        self.remote.prepare_security = AsyncMock(return_value=None)
        with self.assertRaises(ProxyInputError):
            await self.run_registration()
        self.assertEqual(self.client.writes, [])

    async def test_cancellation_during_key_write_releases_connection_without_retry(self):
        self.client.disconnect_opcode = 0
        original = self.client.write_gatt_char
        async def cancelled(char, data, response):
            if char == protocol.UNLOCK and data[0] == 0:
                raise asyncio.CancelledError()
            await original(char, data, response)
        self.client.write_gatt_char = cancelled
        with self.assertRaises(asyncio.CancelledError):
            await self.run_registration()
        self.assertTrue(self.client.disconnected and self.remote.closed)
        self.assertEqual(len(self.client.writes), 1)

    def test_registration_requires_sync_bond_reservation_valid_key_and_hbf(self):
        for update in ({'bond_session': False}, {'action': 'bond'}, {'application_registration': 'true'},
                       {'key': ''}, {'key': 'bad'}, {'device': {**REQUEST['device'], 'model': 'HEM-6232T'}}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                validate({**self.request, **update})

