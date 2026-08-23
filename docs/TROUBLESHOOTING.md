# Troubleshooting

## `lsusb` sees the dongle but no `hci0`

This is a host kernel/firmware problem. QnapHomeHub cannot create an HCI controller itself. Check `dmesg`, `lsmod`, and the chipset firmware.

## BLE scan returns nothing

1. Run `./scripts/qnap-diagnose.sh` on QNAP.
2. Confirm `/sys/class/bluetooth/hci0` (or the selected adapter) exists.
3. Keep `privileged: true` during initial validation.
4. If QTS `bluetoothd` is actively using the same dongle and commands fail, dedicate a second USB Bluetooth adapter to QnapHomeHub and select it from Advanced settings.

## Matter pairing

Open `http://QNAP-IP:8283`. Matterbridge owns commissioning/fabric storage under `./data/matterbridge`; keep this directory across upgrades.
