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

    async def test_api_disconnect_unblocks_advertisement_wait(self):
        async with ProxyConnection('proxy.local', 'test') as remote:
            waiting = asyncio.create_task(remote.find('AA:BB:CC:11:22:33', 5))
            await asyncio.sleep(0)
            await remote._on_stop(False)
            with self.assertRaises(ConnectionError):
                await waiting
