# SPDX-License-Identifier: GPL-3.0-or-later
import asyncio
import copy
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import ble_protocol as protocol
from ble_worker import Session, sync_session
from esp_proxy_worker import operate, validate, watch

ADDRESS = 'AA:BB:CC:11:22:33'
DESCRIPTORS = {protocol.UNLOCK: 0x123, **{uuid: 0x200 + index for index, uuid in enumerate(protocol.RX)}}
REQUEST = {'action': 'sync', 'proxy': {'host': 'm5go.local', 'noise_psk': 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='},
           'key': '12' * 16, 'device': {'id': 'scale', 'model': 'HBF-228T', 'address': ADDRESS,
                                      'bindings': {'1': 'alice', '4': 'bob'}, 'utc_offset_minutes': 540}}


def measurement():
    raw = bytearray(32)
    raw[7], raw[9], raw[11], raw[12], raw[13] = 26, 25, 10, (11 << 3) | 2, (1 << 6) | 30
    raw[26:28] = (1200 << 4).to_bytes(2, 'big')
    return bytes(raw)


class Peripheral:
    """Simulated HBF notification protocol; uses the real Session and decoder."""
    def __init__(self):
        self.is_connected = False
        self.disconnected = False
        self.writes = []
        self.notifications = {}
        self.fail = None
        self.bonds = 0
        self.bond_notifications = []
        self.notification_changes = []
        self.descriptor_writes = []
        self.require_staged = False
        self.services = SimpleNamespace(get_service=lambda _: True,
                                        get_characteristic=lambda char: SimpleNamespace(properties=['write'],
                                            get_descriptor=lambda _: SimpleNamespace(handle=DESCRIPTORS[char]))
                                            if char in DESCRIPTORS else SimpleNamespace(properties=['write']))

    async def connect(self):
        self.is_connected = True
        if self.fail == 'connect':
            raise TimeoutError()

    async def disconnect(self):
        self.disconnected = True
        self.is_connected = False
        self.notifications.clear()

    async def pair(self):
        self.bond_notifications.append(set(self.notifications))
        self.bonds += 1

    async def start_notify(self, char, callback):
        self.notification_changes.append(('start', char))
        self.notifications[char] = callback
        if self.fail == 'notify':
            raise ConnectionError()

    async def stop_notify(self, char):
        self.notification_changes.append(('stop', char))
        if self.fail == 'stop_notify':
            raise ConnectionError('CCCD transition failed')
        self.notifications.pop(char, None)

    async def write_gatt_descriptor(self, handle, data):
        self.descriptor_writes.append((handle, bytes(data)))
        if self.fail == 'clear_rx' or (self.fail == 'descriptor' and handle == DESCRIPTORS[protocol.UNLOCK]):
            raise ConnectionError('CCCD write failed')
        if data == b'\x00\x00':
            for uuid, value in DESCRIPTORS.items():
                if handle == value:
                    self.notifications.pop(uuid, None)

    async def write_gatt_char(self, char, data, response):
        self.writes.append((char, bytes(data)))
        if char == protocol.UNLOCK:
            if self.require_staged and set(self.notifications) != {protocol.RX[0], protocol.UNLOCK}:
                raise AssertionError('Extra data subscriptions before key authentication')
            status = b'\x81\x01' if self.fail == 'auth' else b'\x81\x00'
            self.notifications[char](char, status)
            return
        opcode, address, length = data[1], int.from_bytes(data[3:5], 'big'), data[5]
        if self.require_staged and set(self.notifications) != set(protocol.RX):
            raise AssertionError('Incorrect subscriptions at memory transfer')
        if self.require_staged and self.descriptor_writes != [(DESCRIPTORS[c], b'\x00\x00') for c in [*protocol.RX[1:], protocol.UNLOCK]]:
            raise AssertionError('Unlock CCCD was not disabled on the peripheral')
        if self.fail == 'read' and opcode == 1:
            raise ConnectionError('lost API')
        if self.fail == 'close' and opcode == 15:
            raise ConnectionError('lost close response')
        payload = measurement() if opcode == 1 and address in (0x2c0, 0xe60) else bytes(length if opcode == 1 else 0)
        frame = bytes([8 + len(payload), opcode | 0x80, 0, data[3], data[4], len(payload)]) + payload + b'\0'
        frame += bytes([protocol.checksum(frame)])
        if self.fail == 'checksum' and opcode == 1:
            frame = frame[:-1] + bytes([frame[-1] ^ 1])
        for i in range((len(frame) + 15) // 16):
            self.notifications[protocol.RX[i]](protocol.RX[i], frame[i * 16:(i + 1) * 16])


class Remote:
    def __init__(self, peripheral):
        self.peripheral = peripheral
        self.pairing_supported = True
        self.disconnected = asyncio.Event()
        self.closed = False
        self.callback = None

    def factory(self, host, psk, callback=None):
        self.callback = callback
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def find(self, address, timeout):
        if self.peripheral.fail == 'discovery':
            raise TimeoutError()
        return SimpleNamespace(rssi=-51)

    def client(self, address, adv):
        return self.peripheral

    async def prepare_security(self, trace=None):
        return None

    async def subscribe_diagnostics(self, callback):
        callback({'Free Heap': 50000})
        self.callback(ADDRESS, SimpleNamespace(name='HBF', rssi=-51, manufacturer_data={1: b'\x02'},
                                              service_data={}, service_uuids=[]))
        self.disconnected.set()


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = Peripheral()
        self.remote = Remote(self.client)
        self.request = copy.deepcopy(REQUEST)
        self.sleep = patch('ble_worker.asyncio.sleep', new=self.no_sleep)
        self.sleep.start()

    async def asyncTearDown(self):
        self.sleep.stop()

    async def no_sleep(self, seconds):
        pass

    async def test_history_auth_notifications_all_users_and_usb_equivalence(self):
        trace = {'slots': [], 'rx_notifications': 0}
        result = await operate(self.request, trace, self.remote.factory)
        self.assertEqual(result['invalid_records'], 0)
        self.assertEqual([(r['user_id'], r['slot'], r['values']['weight']) for r in result['records']],
                         [('alice', 1, 60.0), ('bob', 4, 60.0)])
        self.assertEqual(result['records'][0]['measured_at'], '2026-10-11T09:25:30+09:00')
        self.assertEqual(trace['stage'], 'completed')
        self.assertGreater(trace['rx_notifications'], 60)
        self.assertEqual(self.client.writes[0][1], b'\x01' + bytes.fromhex(REQUEST['key']))
        self.assertEqual([data[1] for char, data in self.client.writes if char != protocol.UNLOCK], [0] + [1] * 60 + [15])
        self.assertTrue(self.client.disconnected and self.remote.closed)
        self.assertEqual(self.client.bonds, 0)
        usb = Peripheral()
        session = Session(usb)
        await session.subscribe()
        same = await sync_session(session, self.request)
        self.assertEqual(same['records'], result['records'])
        self.assertEqual(usb.writes, self.client.writes)

    async def test_failures_release_resources_and_do_not_repair_or_replay(self):
        for phase in ('connect', 'notify', 'auth', 'read', 'checksum'):
            with self.subTest(phase=phase):
                client = Peripheral(); client.fail = phase
                remote = Remote(client)
                with self.assertRaises((ValueError, TimeoutError, ConnectionError)):
                    await operate(self.request, None, remote.factory)
                self.assertTrue(client.disconnected and remote.closed)
                self.assertEqual(client.bonds, 0)
                self.assertLessEqual(sum(char == protocol.UNLOCK for char, _ in client.writes), 1)

    async def test_cancel_releases_gatt_and_api(self):
        async def cancelled():
            raise asyncio.CancelledError()
        self.client.connect = cancelled
        with self.assertRaises(asyncio.CancelledError):
            await operate(self.request, None, self.remote.factory)
        self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_probe_never_writes_or_pairs(self):
        self.request.update(action='probe', target=ADDRESS, connect=True)
        result = await operate(self.request, None, self.remote.factory)
        self.assertTrue(result['gatt_connected'] and result['advertisement_seen'])
        self.assertEqual(result['rssi'], -51)
        self.assertEqual(self.client.writes, [])
        self.assertEqual(self.client.bonds, 0)

    async def test_link_failure_stops_before_application_key_write(self):
        from esp_proxy_security import LinkSecurityError
        from unittest.mock import AsyncMock, Mock
        for method in ('connected', 'authenticated'):
            gate = SimpleNamespace(connected=AsyncMock(), authenticated=AsyncMock(), mark=Mock())
            getattr(gate, method).side_effect = LinkSecurityError('authentication_failed')
            self.remote.prepare_security = AsyncMock(return_value=gate)
            with self.assertRaises(LinkSecurityError):
                await operate(self.request, {}, self.remote.factory)
            self.assertEqual(self.client.writes, [])
            self.assertEqual(self.client.bonds, 0)
            self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_security_gate_precedes_unlock_and_retains_history(self):
        from unittest.mock import AsyncMock, Mock
        async def authenticated():
            self.assertEqual(self.client.writes, [])
            self.assertEqual(set(self.client.notifications), {protocol.RX[0], protocol.UNLOCK})
        gate = SimpleNamespace(connected=AsyncMock(), authenticated=authenticated, mark=Mock())
        self.remote.prepare_security = AsyncMock(return_value=gate)
        result = await operate(self.request, {"slots": [], "rx_notifications": 0}, self.remote.factory)
        self.assertEqual(len(result['records']), 2)
        gate.connected.assert_awaited_once_with(require_bond=True)
        self.assertEqual(self.client.bonds, 0)

    async def test_untargeted_probe_preserves_advertisement_count(self):
        self.request = {**self.request, 'action': 'probe', 'target': None, 'scan_seconds': 2}
        self.remote.observations = {ADDRESS: object()}
        result = await operate(self.request, None, self.remote.factory)
        self.assertEqual(result['devices_seen'], 1)
        self.assertEqual(self.client.writes, [])
        self.assertTrue(self.remote.closed)

    async def test_explicit_bond_requires_feature_and_never_programs_omron(self):
        self.request['action'] = 'bond'
        self.remote.pairing_supported = False
        with self.assertRaisesRegex(ValueError, 'PAIRING'):
            await operate(self.request, None, self.remote.factory)
        self.assertEqual(self.client.bonds, 0)
        self.assertEqual(self.client.notifications, {})
        self.remote.pairing_supported = True
        result = await operate(self.request, None, self.remote.factory)
        self.assertFalse(result['application_key_changed'])
        self.assertEqual(self.client.bonds, 1)
        self.assertEqual(self.client.bond_notifications, [{protocol.RX[0], protocol.UNLOCK}])
        self.assertEqual(self.client.writes, [])

    async def test_explicit_bond_subscription_failure_aborts_without_pairing(self):
        self.request['action'] = 'bond'
        self.client.fail = 'notify'
        trace = {'slots': [], 'rx_notifications': 0}
        with self.assertRaises(ConnectionError):
            await operate(self.request, trace, self.remote.factory)
        self.assertEqual(trace['stage'], 'subscribe')
        self.assertEqual(self.client.bonds, 0)
        self.assertEqual(self.client.writes, [])
        self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_bond_reservation_precedes_connect_and_missing_support_blocks_connect(self):
        from esp_proxy_security import LinkSecurityError
        from unittest.mock import AsyncMock, Mock
        self.request['action'] = 'bond'
        gate = SimpleNamespace(connected=AsyncMock(), authenticated=AsyncMock(), mark=Mock())
        self.remote.prepare_security = AsyncMock(return_value=gate)
        async def prepare(address):
            self.assertEqual(address, ADDRESS)
            self.assertFalse(self.client.is_connected)
        self.remote.prepare_bond = AsyncMock(side_effect=prepare)
        result = await operate(self.request, {}, self.remote.factory)
        self.assertTrue(result['bonded'])
        self.assertEqual(self.client.writes, [])
        self.remote.prepare_bond.assert_awaited_once_with(ADDRESS)
        gate.connected.assert_awaited_once_with(require_bond=False)
        gate.authenticated.assert_awaited_once()
        self.remote.prepare_bond.side_effect = LinkSecurityError('explicit_bond_firmware_update_required')
        self.client.connect = AsyncMock()
        with self.assertRaises(LinkSecurityError):
            await operate(self.request, {}, self.remote.factory)
        self.client.connect.assert_not_called()

    async def test_advertisement_contract_and_api_loss(self):
        self.request.update(action='watch', addresses=[ADDRESS])
        events = []
        await watch(self.request, events.append, self.remote.factory)
        self.assertTrue(events[0]['ready'])
        adv = next(e for e in events if 'address' in e)
        self.assertEqual(adv['advertisement']['manufacturer_data'], {'1': '02'})
        self.assertEqual(len(adv['fingerprint']), 24)
        self.assertFalse(events[-1]['api_connected'])
        self.assertTrue(self.remote.closed)

    async def bond_session_gate(self):
        from unittest.mock import AsyncMock, Mock
        gate = SimpleNamespace(connected=AsyncMock(), authenticated=AsyncMock(), mark=Mock())
        self.remote.prepare_security = AsyncMock(return_value=gate)
        self.remote.prepare_bond = AsyncMock()
        self.request['bond_session'] = True
        return gate

    async def test_bond_and_existing_key_history_share_one_connection(self):
        gate = await self.bond_session_gate()
        self.client.require_staged = True
        from unittest.mock import AsyncMock
        self.client.connect = AsyncMock(wraps=self.client.connect)
        async def authenticated():
            self.assertEqual(self.client.writes, [])
            self.assertEqual(self.client.bonds, 1)
        gate.authenticated.side_effect = authenticated
        trace = {'slots': [], 'rx_notifications': 0}
        result = await operate(self.request, trace, self.remote.factory)
        self.client.connect.assert_awaited_once()
        gate.connected.assert_awaited_once_with(require_bond=False)
        self.remote.prepare_bond.assert_awaited_once_with(ADDRESS)
        self.assertEqual(self.client.bonds, 1)
        self.assertEqual([data for char, data in self.client.writes if char == protocol.UNLOCK],
                         [b'\x01' + bytes.fromhex(REQUEST['key'])])
        self.assertEqual([data[1] for char, data in self.client.writes if char != protocol.UNLOCK],
                         [0] + [1] * 60 + [15])
        self.assertEqual(len(result['records']), 2)
        self.assertTrue(result['diagnostic']['explicit_bond_session'])
        self.assertEqual(trace['stage'], 'completed')
        self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_normal_sync_stages_notifications_and_never_pairs(self):
        self.client.require_staged = True
        # Model cached peripheral CCCDs from a prior all-channel connection.
        self.client.notifications.update({char: lambda *_: None for char in protocol.RX[1:]})
        result = await operate(self.request, None, self.remote.factory)
        self.assertEqual(len(result['records']), 2)
        self.assertEqual(self.client.notification_changes,
                         [('start', protocol.RX[0]), ('start', protocol.UNLOCK), ('stop', protocol.UNLOCK)] +
                         [('start', char) for char in protocol.RX[1:]])
        self.assertEqual(self.client.descriptor_writes, [(DESCRIPTORS[c], b'\x00\x00') for c in [*protocol.RX[1:], protocol.UNLOCK]])
        self.assertEqual(self.client.bonds, 0)

    async def test_rejected_key_keeps_extra_channels_off_and_never_starts_memory(self):
        self.client.fail = 'auth'
        with self.assertRaises(ValueError):
            await operate(self.request, {}, self.remote.factory)
        self.assertEqual(self.client.notification_changes, [('start', protocol.RX[0]), ('start', protocol.UNLOCK)])
        self.assertEqual(len(self.client.writes), 1)

    async def test_notification_transition_failures_stop_before_memory(self):
        for phase in ('descriptor', 'stop_notify', 'extra_notify'):
            with self.subTest(phase=phase):
                client = Peripheral(); client.fail = phase
                if phase == 'extra_notify':
                    original = client.start_notify
                    async def start(char, callback):
                        if char == protocol.RX[2]:
                            raise ConnectionError('RX2 setup failed')
                        await original(char, callback)
                    client.start_notify = start
                remote = Remote(client)
                trace = {}
                with self.assertRaises(ConnectionError):
                    await operate(self.request, trace, remote.factory)
                self.assertEqual(trace['stage'], 'subscribe_history')
                self.assertEqual(len(client.writes), 1)
                self.assertTrue(client.disconnected and remote.closed)

    async def test_missing_unlock_descriptor_stops_before_memory(self):
        self.client.services.get_characteristic = lambda _: SimpleNamespace(get_descriptor=lambda _: None)
        with self.assertRaisesRegex(ValueError, 'descriptor is unavailable'):
            await operate(self.request, {}, self.remote.factory)
        self.assertEqual(len(self.client.writes), 0)
        self.assertEqual(self.client.descriptor_writes, [])
        self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_cached_notification_clear_failure_never_sends_key(self):
        self.client.fail = 'clear_rx'
        trace = {}
        with self.assertRaises(ConnectionError):
            await operate(self.request, trace, self.remote.factory)
        self.assertEqual(trace['stage'], 'prepare_unlock_notifications')
        self.assertEqual(self.client.writes, [])
        self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_hbf_proxy_session_rejects_key_programming(self):
        from esp_proxy_worker import HbfProxySession
        session = HbfProxySession(self.client)
        for opcode, expected in ((0, 0x80), (2, 0x82)):
            with self.assertRaises(ValueError):
                await session.unlock(opcode, bytes(16), expected)
        self.assertEqual(self.client.writes, [])

    async def test_bond_session_missing_gate_or_failed_auth_never_sends_key(self):
        from unittest.mock import AsyncMock
        from esp_proxy_security import LinkSecurityError
        self.request['bond_session'] = True
        self.client.connect = AsyncMock()
        with self.assertRaisesRegex(ValueError, 'security diagnostics'):
            await operate(self.request, {}, self.remote.factory)
        self.client.connect.assert_not_called()
        gate = await self.bond_session_gate()
        gate.authenticated.side_effect = LinkSecurityError('authentication_failed')
        with self.assertRaises(LinkSecurityError):
            await operate(self.request, {}, self.remote.factory)
        self.assertEqual(self.client.writes, [])
        self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_bond_session_unlock_rejection_never_reprograms_or_retries(self):
        await self.bond_session_gate()
        self.client.fail = 'auth'
        with self.assertRaises(ValueError):
            await operate(self.request, {}, self.remote.factory)
        self.assertEqual(self.client.bonds, 1)
        self.assertEqual(self.client.writes, [(protocol.UNLOCK, b'\x01' + bytes.fromhex(REQUEST['key']))])
        self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_bond_session_close_failure_is_not_reported_as_success(self):
        await self.bond_session_gate()
        self.client.fail = 'close'
        trace = {'slots': [], 'rx_notifications': 0}
        with self.assertRaises(ConnectionError):
            await operate(self.request, trace, self.remote.factory)
        self.assertNotEqual(trace['stage'], 'completed')
        self.assertEqual(self.client.bonds, 1)
        self.assertEqual(sum(char != protocol.UNLOCK and data[1] == 15 for char, data in self.client.writes), 1)
        self.assertTrue(self.client.disconnected and self.remote.closed)

    async def test_bond_session_cannot_bypass_existing_key_validation(self):
        from unittest.mock import Mock
        factory = Mock()
        for action, flag, key in [('bond', True, REQUEST['key']), ('sync', 'true', REQUEST['key']), ('sync', True, '')]:
            with self.subTest(action=action, flag=flag, key_present=bool(key)):
                self.request.update(action=action, bond_session=flag, key=key)
                with self.assertRaises(ValueError):
                    await operate(self.request, {}, factory)
        factory.assert_not_called()

    async def test_reject_hem_and_key_programming(self):
        for patch_value in ({'action': 'pair'}, {'device': {**REQUEST['device'], 'model': 'HEM-6232T'}}, {'key': ''}):
            with self.assertRaises(ValueError):
                validate({**REQUEST, **patch_value})


if __name__ == '__main__':
    unittest.main()
