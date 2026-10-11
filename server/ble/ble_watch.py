"""Advertisement-only listener; never pairs, connects, or reads health records."""
import asyncio
import json
import sys

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
    from ble_advertisement import AdvertisementEvents
    events = AdvertisementEvents(addresses, lambda value: print(json.dumps(value, separators=(',', ':')), flush=True))
    async with BleakScanner(detection_callback=events.detected, adapter=adapter):
        print(json.dumps({'ready': True}), flush=True)
        await asyncio.Event().wait()

if __name__ == '__main__':
    asyncio.run(main())
