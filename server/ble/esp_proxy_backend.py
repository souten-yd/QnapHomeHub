# SPDX-License-Identifier: GPL-3.0-or-later
"""ESPHome notification disable with an acknowledged peripheral CCCD write."""
from bleak.exc import BleakError
from bleak_esphome.backend.client import CCCD_UUID, ESPHomeClient


class NotificationESPHomeClient(ESPHomeClient):
    async def stop_notify(self, characteristic):
        # Bleak 3 disallows CCCD writes through its public descriptor API.
        # Its supported notification API delegates here. ESPHome's upstream
        # stop only removes forwarding, so first clear the peripheral CCCD,
        # including cached notifications not subscribed by this connection.
        descriptor = characteristic.get_descriptor(CCCD_UUID)
        if descriptor is None:
            raise BleakError('HBF notification descriptor is unavailable')
        await super().write_gatt_descriptor(descriptor, b'\x00\x00')
        await super().stop_notify(characteristic)
