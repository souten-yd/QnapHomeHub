#!/bin/sh
set +e
echo '=== Kernel ==='; uname -a
echo '=== USB ==='; lsusb
echo '=== Bluetooth sysfs ==='; ls -la /sys/class/bluetooth 2>/dev/null
echo '=== HCI ==='; hciconfig -a 2>/dev/null
echo '=== Modules ==='; lsmod | grep -E 'bluetooth|btusb|btrtl|btintel|btbcm|btmtk'
echo '=== bluetoothd (informational) ==='; bluetoothd -v 2>/dev/null
echo '=== Docker ==='; docker --version 2>/dev/null
