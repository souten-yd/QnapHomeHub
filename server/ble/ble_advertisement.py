"""Shared advertisement payload contract for USB and ESPHome watchers."""
import hashlib
import json
import time


class AdvertisementEvents:
    def __init__(self, addresses, emit):
        self.addresses = set(addresses)
        self.emit = emit
        self.last = {}

    def detected(self, device, advertisement):
        address = device.address.upper()
        now = time.monotonic()
        if address not in self.addresses or now - self.last.get(address, -100) < 5:
            return
        self.last[address] = now
        payload = {
            'local_name': advertisement.local_name,
            'manufacturer_data': {str(k): bytes(v).hex() for k, v in sorted(advertisement.manufacturer_data.items())},
            'service_data': {str(k).lower(): bytes(v).hex() for k, v in sorted(advertisement.service_data.items())},
            'service_uuids': sorted(str(v).lower() for v in advertisement.service_uuids),
            'tx_power': advertisement.tx_power,
        }
        canonical = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
        self.emit({
            'address': address,
            'fingerprint': hashlib.sha256(canonical).hexdigest()[:24],
            'rssi': advertisement.rssi,
            'advertisement': payload,
        })
