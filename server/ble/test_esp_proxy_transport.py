# SPDX-License-Identifier: GPL-3.0-or-later
import asyncio
import importlib.util
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from esp_proxy_transport import ProxyConnection


@unittest.skipUnless(importlib.util.find_spec('bleak_esphome'), 'isolated proxy environment required')
class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from aioesphomeapi import APIVersion, DeviceInfo
        self.api = Mock()
        self.api.connect = AsyncMock()
        self.api.disconnect = AsyncMock()
        self.api.api_version = APIVersion(1, 10)
        self.api.device_info = AsyncMock(return_value=DeviceInfo(name='proxy', mac_address='00:11:22:33:44:55',
                                                               bluetooth_proxy_feature_flags=2 | 8))
        self.api.subscribe_bluetooth_le_advertisements.return_value = Mock()
        self.patch = patch('aioesphomeapi.APIClient', return_value=self.api)
        self.patch.start()

    async def asyncTearDown(self):
        self.patch.stop()

    async def test_actual_backend_is_explicit_and_disconnect_clears_slots(self):
        from bleak_esphome.backend.client import ESPHomeClient
        # Any generic HA manager setup is a regression: it can touch Linux HCI.
        with patch('habluetooth.BluetoothManager', side_effect=AssertionError('local HCI')):
            async with ProxyConnection('proxy.local', 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=') as remote:
                self.assertTrue(remote.pairing_supported)
                adv = SimpleNamespace(address=0xAABBCC112233, address_type=0, name='HBF', rssi=-50)
                self.api.subscribe_bluetooth_le_advertisements.call_args.args[0](adv)
                found = await remote.find('AA:BB:CC:11:22:33', .1)
                client = remote.client('AA:BB:CC:11:22:33', found)
                self.assertIsInstance(client._backend, ESPHomeClient)
                self.assertEqual(client._backend._address_type, 0)
                await remote._on_stop(False)
                self.assertFalse(remote.data.bluetooth_device.available)
                self.assertTrue(remote.disconnected.is_set())
        self.api.disconnect.assert_awaited_once()

    async def test_api_start_failure_is_cleaned_without_retry(self):
        self.api.connect.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            async with ProxyConnection('proxy.local', 'test'):
                pass
        self.api.connect.assert_awaited_once()
        self.api.disconnect.assert_awaited_once()

    async def test_raw_firmware_batch_decodes_to_existing_advertisement_contract(self):
        from aioesphomeapi import BluetoothProxyFeature, DeviceInfo
        from aioesphomeapi.api_pb2 import BluetoothLERawAdvertisementsResponse
        from ble_advertisement import AdvertisementEvents
        self.api.device_info.return_value = DeviceInfo(
            name='proxy', mac_address='00:11:22:33:44:55',
            bluetooth_proxy_feature_flags=int(BluetoothProxyFeature.ACTIVE_CONNECTIONS |
                                             BluetoothProxyFeature.RAW_ADVERTISEMENTS))
        unsub = self.api.subscribe_bluetooth_le_raw_advertisements.return_value = Mock()
        events = []
        formatter = AdvertisementEvents(['AA:BB:CC:11:22:33'], events.append)
        def callback(address, adv):
            formatter.detected(SimpleNamespace(address=address), SimpleNamespace(
                local_name=adv.name, manufacturer_data=adv.manufacturer_data,
                service_data=adv.service_data, service_uuids=adv.service_uuids,
                tx_power=None, rssi=adv.rssi))
        with patch('habluetooth.BluetoothManager', side_effect=AssertionError('local HCI')):
            async with ProxyConnection('proxy.local', 'test', callback) as remote:
                self.api.subscribe_bluetooth_le_advertisements.assert_not_called()
                batch = BluetoothLERawAdvertisementsResponse()
                # Flags, name, 16-bit UUID, service data, manufacturer data.
                batch.advertisements.add(address=0xAABBCC112233, address_type=1, rssi=-47,
                    data=bytes.fromhex('020106040948424603030d1805160d18aabb05ff0e033412'))
                batch.advertisements.add(address=0xAABBCC445566, address_type=0, rssi=-80,
                                         data=b'\xff')  # Truncated AD remains safe.
                self.api.subscribe_bluetooth_le_raw_advertisements.call_args.args[0](batch)
                adv = await remote.find('AA:BB:CC:11:22:33', .1)
                self.assertEqual(adv.name, 'HBF')
                self.assertEqual(adv.manufacturer_data, {0x030e: b'\x34\x12'})
                self.assertEqual(adv.service_uuids, ['0000180d-0000-1000-8000-00805f9b34fb'])
                self.assertEqual(adv.service_data, {'0000180d-0000-1000-8000-00805f9b34fb': b'\xaa\xbb'})
                self.assertEqual(remote.client('AA:BB:CC:11:22:33', adv)._backend._address_type, 1)
                self.assertEqual(len(remote.observations), 2)
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]['address'], 'AA:BB:CC:11:22:33')
                self.assertEqual(events[0]['rssi'], -47)
        unsub.assert_called_once()

    async def test_api_disconnect_unblocks_advertisement_wait(self):
        async with ProxyConnection('proxy.local', 'test') as remote:
            waiting = asyncio.create_task(remote.find('AA:BB:CC:11:22:33', 5))
            await asyncio.sleep(0)
            await remote._on_stop(False)
            with self.assertRaises(ConnectionError):
                await waiting

    async def test_security_diagnostics_accept_only_known_status_not_arbitrary_text(self):
        from aioesphomeapi import SensorInfo, SensorState, TextSensorInfo, TextSensorState
        self.api.list_entities_services = AsyncMock(return_value=([
            SensorInfo(key=1, name='Free Heap'),
            TextSensorInfo(key=2, name='BLE Security'),
            TextSensorInfo(key=3, name='Private text'),
        ], []))
        updates = []
        async with ProxyConnection('proxy.local', 'test') as remote:
            await remote.subscribe_diagnostics(updates.append)
            state = self.api.subscribe_states.call_args.args[0]
            state(SensorState(key=1, state=12345))
            state(TextSensorState(key=2, state='authenticated;disconnected:22'))
            self.assertEqual(updates[-1], {'Free Heap': 12345, 'BLE Security': 'authenticated;disconnected:22'})
            state(TextSensorState(key=2, state='auth_failed:97'))
            self.assertEqual(updates[-1]['BLE Security'], 'auth_failed:97')
            count = len(updates)
            for value in ('private credential', 'auth_failed:97\nsecret', 'bond_count:' + '1' * 100):
                state(TextSensorState(key=2, state=value))
            state(TextSensorState(key=3, state='authenticated'))
            state(TextSensorState(key=2, state='authenticated', missing_state=True))
            state(SensorState(key=1, state=float('nan')))
            self.assertEqual(len(updates), count)

    async def test_journal_opt_in_baseline_and_api_disconnect(self):
        from aioesphomeapi import TextSensorInfo, TextSensorState
        from test_esp_proxy_security import journal, OPEN, BOND
        from esp_proxy_security import LinkSecurityError
        self.api.list_entities_services = AsyncMock(return_value=([TextSensorInfo(key=4, name='BLE Session')], []))
        self.api.subscribe_states.side_effect = lambda cb: cb(TextSensorState(key=4, state=journal(4)))
        async with ProxyConnection('proxy.local', 'test') as remote:
            gate = await remote.prepare_security({})
            self.assertEqual(gate.baseline, 4)
            self.api.subscribe_states.call_args.args[0](TextSensorState(key=4, state=journal(5, OPEN, BOND)))
            waiting = asyncio.create_task(gate.authenticated(1))
            await asyncio.sleep(0)
            await remote._on_stop(False)
            with self.assertRaisesRegex(LinkSecurityError, 'api_disconnected'):
                await waiting
        self.api.list_entities_services.return_value = ([], [])
        async with ProxyConnection('proxy.local', 'test') as remote:
            trace = {}
            self.assertIsNone(await remote.prepare_security(trace))
            self.assertEqual(trace['link_security'], 'journal_unavailable')
