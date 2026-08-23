# Architecture

QnapHomeHub separates Bluetooth ownership from Matter exposure.

- `homehub` owns the USB Bluetooth HCI adapter and is the only process that uses `node-switchbot`/Noble.
- The Web UI talks to `homehub` over its authenticated REST API.
- `matterbridge` never opens Bluetooth. Its QnapHomeHub plugin calls an internal-token-protected HomeHub API.
- Both services use host networking. This is needed for raw Bluetooth networking semantics and Matter/mDNS discovery.
- Device commands are serialized in a single queue to avoid overlapping BLE transactions.

The HCI adapter is selected by setting `NOBLE_HCI_DEVICE_ID` before `node-switchbot` is dynamically imported. A Web UI change to the adapter therefore requires a HomeHub container restart.
