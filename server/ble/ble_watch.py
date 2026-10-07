"""Advertisement-only listener; never pairs, connects, or reads health records."""
import asyncio
import hashlib
import json
import sys
import time

async def main():
    from bleak import BleakScanner
    from dbus_fast import BusType, Message, MessageType, Variant
    from dbus_fast.aio import MessageBus
    request = json.loads(sys.stdin.readline())
    adapter = request['adapter']
    addresses = set(request['addresses'])
    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    try:
        reply = await bus.call(Message(destination='org.bluez', path='/org/bluez/' + adapter,
            interface='org.freedesktop.DBus.Properties', member='Set', signature='ssv',
            body=['org.bluez.Adapter1', 'Powered', Variant('b', True)]))
        if reply.message_type == MessageType.ERROR:
            raise RuntimeError('Cannot enable Bluetooth adapter')
    finally:
        bus.disconnect()
    last = {}
    def detected(device, advertisement):
        address = device.address.upper()
        now = time.monotonic()
        if address not in addresses or now - last.get(address, -100) < 5:
            return
        last[address] = now
        # Keep the fingerprint independent of RSSI so movement/noise does not
        # look like a new measurement. Do not include health records or pairing data.
        manufacturer = {str(key): bytes(value).hex() for key, value in sorted(advertisement.manufacturer_data.items())}
        service_data = {str(key).lower(): bytes(value).hex() for key, value in sorted(advertisement.service_data.items())}
        service_uuids = sorted(str(value).lower() for value in advertisement.service_uuids)
        payload = {
            'local_name': advertisement.local_name,
            'manufacturer_data': manufacturer,
            'service_data': service_data,
            'service_uuids': service_uuids,
            'tx_power': advertisement.tx_power,
        }
        canonical = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
        event = {
            'address': address,
            'fingerprint': hashlib.sha256(canonical).hexdigest()[:24],
            'rssi': advertisement.rssi,
            'advertisement': payload,
        }
        print(json.dumps(event, separators=(',', ':')), flush=True)
    async with BleakScanner(detection_callback=detected, adapter=adapter):
        print(json.dumps({'ready': True}), flush=True)
        await asyncio.Event().wait()

if __name__ == '__main__':
    asyncio.run(main())
