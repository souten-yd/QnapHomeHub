# SPDX-License-Identifier: GPL-3.0-or-later
"""One ESPHome API connection; never initializes BlueZ or local HCI.

bleak-esphome 4.1.0's explicit backend handles GATT, notifications and slot
release. No HA BluetoothManager: its Linux setup opens a management socket.
The parent owns reconnect/backoff and device exclusion, not this transport.
"""
import asyncio
import math
from contextlib import nullcontext
from types import SimpleNamespace


class ProxyConnection:
    def __init__(self, host, psk, on_advertisement=None):
        from aioesphomeapi import APIClient
        self.api = APIClient(host, 6053, None, noise_psk=psk)
        self.on_advertisement = on_advertisement
        self.disconnected = asyncio.Event()
        self.observations = {}
        self.changed = asyncio.Event()
        self.data = None
        self.flags = 0
        self.pairing_supported = False
        self.info = None
        self.diagnostics = {}
        self.unsub = None
        self.security = None

    async def __aenter__(self):
        from aioesphomeapi import BluetoothProxyFeature
        from bleak_esphome.backend.client import ESPHomeClientData
        from bleak_esphome.backend.device import ESPHomeBluetoothDevice
        try:
            await asyncio.wait_for(self.api.connect(on_stop=self._on_stop, login=True,
                                                   log_errors=False), 20)
            self.info = await asyncio.wait_for(self.api.device_info(), 10)
            self.flags = self.info.bluetooth_proxy_feature_flags_compat(self.api.api_version)
            if not self.flags & BluetoothProxyFeature.ACTIVE_CONNECTIONS:
                raise ValueError('M5GO active Bluetooth proxy is unavailable')
            self.pairing_supported = bool(self.flags & BluetoothProxyFeature.PAIRING)
            source = self.info.bluetooth_mac_address or self.info.mac_address
            device = ESPHomeBluetoothDevice(self.info.name, source, available=True)
            # Dedicated remote scanner has no HA scheduling to pause on connect.
            self.data = ESPHomeClientData(device, self.api, self.info, self.api.api_version,
                                          self.info.name, SimpleNamespace(connecting=nullcontext))
            self.api.subscribe_bluetooth_connections_free(device.async_update_ble_connection_limits)
            # Modern firmware sends raw batches only. A legacy subscription can
            # authenticate successfully while delivering no advertisements.
            if self.flags & BluetoothProxyFeature.RAW_ADVERTISEMENTS:
                self.unsub = self.api.subscribe_bluetooth_le_raw_advertisements(self._raw_advertisements)
            else:
                self.unsub = self.api.subscribe_bluetooth_le_advertisements(self._advertisement)
            return self
        except BaseException:
            await self.close()
            raise

    def _raw_advertisements(self, batch):
        from bluetooth_data_tools import parse_advertisement_data_bytes
        advertisements = batch.advertisements
        for i in range(len(advertisements)):
            raw = advertisements[i]
            name, uuids, service_data, manufacturer_data, _ = parse_advertisement_data_bytes(raw.data)
            self._advertisement(SimpleNamespace(
                address=raw.address, address_type=raw.address_type, rssi=raw.rssi,
                name=name or '', service_uuids=uuids, service_data=service_data,
                manufacturer_data=manufacturer_data))

    def _advertisement(self, adv):
        address = ':'.join(f'{adv.address:012X}'[i:i + 2] for i in range(0, 12, 2))
        # Bound memory even in a busy BLE environment.
        if len(self.observations) >= 256 and address not in self.observations:
            del self.observations[next(iter(self.observations))]
        self.observations[address] = adv
        self.changed.set()
        if self.on_advertisement:
            self.on_advertisement(address, adv)

    async def _on_stop(self, expected):
        self.disconnected.set()
        self.changed.set()
        if self.security:
            self.security.changed.set()
        if self.data:
            self.data.bluetooth_device.async_set_unavailable()
            for callback in list(self.data.disconnect_callbacks):
                callback()
            self.data.disconnect_callbacks.clear()

    async def find(self, address, timeout=20):
        async with asyncio.timeout(timeout):
            while not self.disconnected.is_set():
                if address in self.observations:
                    return self.observations[address]
                self.changed.clear()
                await self.changed.wait()
        raise ConnectionError('M5GO API disconnected')

    def client(self, address, adv):
        from bleak import BleakClient
        from bleak.backends.device import BLEDevice
        from bleak_esphome.backend.client import ESPHomeClient
        device = BLEDevice(address, adv.name, {
            'source': self.data.bluetooth_device.mac_address, 'address_type': adv.address_type})
        return BleakClient(device, timeout=20, backend=ESPHomeClient, client_data=self.data)

    async def prepare_security(self, trace=None):
        from aioesphomeapi import TextSensorInfo, TextSensorState
        from esp_proxy_security import SessionSecurity
        entities, _ = await asyncio.wait_for(self.api.list_entities_services(), 10)
        keys = [e.key for e in entities if isinstance(e, TextSensorInfo) and e.name == 'BLE Session']
        if not keys:
            # Released firmware predating the opt-in journal retains its behavior.
            if trace is not None:
                trace['link_security'] = 'journal_unavailable'
            return None
        if len(keys) != 1:
            raise ValueError('Ambiguous BLE session entity')
        self.security = SessionSecurity(self.disconnected, trace)
        def state(value):
            if isinstance(value, TextSensorState) and value.key == keys[0]:
                self.security.update(None if value.missing_state else value.state)
        self.api.subscribe_states(state)
        await self.security.arm()
        return self.security

    async def subscribe_diagnostics(self, callback):
        from aioesphomeapi import (SensorInfo, SensorState, BinarySensorInfo, BinarySensorState,
                                  TextSensorInfo, TextSensorState)
        entities, _ = await asyncio.wait_for(self.api.list_entities_services(), 10)
        names = {e.key: e.name for e in entities if isinstance(e, (SensorInfo, BinarySensorInfo)) or
                 (isinstance(e, TextSensorInfo) and e.name == 'BLE Security')}
        def state(value):
            if value.key in names and isinstance(value, (SensorState, BinarySensorState, TextSensorState)) and not value.missing_state:
                if isinstance(value, TextSensorState):
                    # Only the firmware's bounded security phase/status, never
                    # arbitrary text entities such as network or credential data.
                    import re
                    if names[value.key] != 'BLE Security' or not re.fullmatch(
                            r'(?:authenticated|encryption_requested|peer_not_bonded|bond_list_failed|'
                            r'(?:auth_failed|request_failed|open_failed|bond_count):-?\d{1,10})'
                            r'(?:;disconnected:\d{1,10})?', value.state):
                        return
                if isinstance(value.state, float) and not math.isfinite(value.state):
                    return
                self.diagnostics[names[value.key]] = value.state
                callback(dict(self.diagnostics))
        self.api.subscribe_states(state)

    async def close(self):
        try:
            if self.unsub:
                self.unsub()
                self.unsub = None
        finally:
            try:
                await asyncio.wait_for(self.api.disconnect(), 5)
            finally:
                await self._on_stop(True)

    async def __aexit__(self, *args):
        await self.close()
