# Native QPKG preview: staged low-write migration

## Current milestone (0.3.15, opt-in preview only)

The existing QnapHomeHub is three/four Docker services: homehub, radio,
matterbridge and updater. SelfCare QPKG sends watch, pairing and sync
requests to radio over the existing Unix socket. **This milestone replaces
only the HomeHub HTTP/Web frontend.** It does *not* remove the radio
container. Matterbridge and Docker updater are intentionally not started by
the QPKG; QTS must manage the QPKG lifecycle.

The native Python 3.9+ Web/API reuses port 8787 and the existing public UI,
configuration file, Bot registration and shared-radio requests. It does not
spawn Node, BlueZ, HCI commands, Docker or external update processes.
The QPKG writes settings.json **only when edited**; UI status, health, and
debug polling do not write HDD access logs. Debug events remain in RAM.
Python can be provided by /opt/bin/python3.11. No BLE libraries are needed
for the Web process because the shared radio retains BLE ownership.

**Neither this draft nor the existence of the QTS org.bluez bus proves**
that the old host BlueZ can implement Omron's Bleak GATT path. The currently
documented host bluetoothd is 4.101; therefore no host-mode deployment is
promised. This QPKG is not a complete Docker-free replacement yet.

### Data and socket contract

- Web URL: `http://NAS:8787/`
- HomeHub settings: `/share/Container/QnapHomeHub/data/homehub/settings.json`
- Existing Secrets: `/share/Container/QnapHomeHub/secrets/`
- Shared radio: `/share/Container/QnapHomeHub/data/radio/ble.sock`
- SelfCare: `http://NAS:17863/`, unchanged; existing pairing keys, measurement
  database, lease/watch event behavior and socket path unchanged.
- Port and files remain owned by their current QNAP administrator; no default
  password override or exposed BLE TCP port is added.

### Build (QDK environment, not QNAP startup)

```sh
python3 -m unittest discover -s tests -p 'test_native*.py' -v
python3 -m py_compile native/webapp.py
sh -n qpkg/shared/homehub.sh
bash -n scripts/build-native-qpkg.sh
bash scripts/build-native-qpkg.sh x86_64 dist
```

QDK `qbuild` must be available on the build host. The packager reuses the
existing HomeHub icons, CSS, JS and HTML. The native UI hides unusable Matter
controls and disables the Docker-specific updater/restart actions. **Do not
advertise a working Web QPKG updater until it is implemented and tested.**

### NAS acceptance / rollback

1. Snapshot HomeHub `data/homehub/settings.json`, `secrets/`,
   `data/bluetooth/`, and SelfCare database/key backups. Record Docker
   versions and sda/sdb Write IOPS with idle BLE watch enabled.
2. Confirm the existing radio socket is accessible as the QPKG account.
   Confirm working SelfCare watch and a manual Omron synchronization first.
3. Stop **only the Docker HomeHub Web service** to free TCP 8787. Do **not**
   stop radio or SelfCare. Do not change host bluetoothd, bonding keys,
   USB adapter state, SelfCare sync mode, or HCI ownership.
4. Install QPKG in App Center, validate native HTTP health, device list,
   actual SwitchBot press, and SelfCare's manual and advertisement-based sync
   during/after SwitchBot operation. Reboot and recheck.
5. Run 15-minute idle write IOPS comparisons at the same watch settings.
   Record QTS disk busy and radio logs. The IOPS improvement is **unproven**
   until measured on the NAS.
6. If any device or sync fails, stop/disable the QPKG and restart the
   original Docker HomeHub Web. Existing radio and SelfCare must remain live.
   Do not delete/rewrite `data/bluetooth/` or SelfCare keys.

**Do not install simultaneously with Docker homehub on port 8787.** On
NAS reboot, Docker restart policies can bring back the old Web container.
Prevent concurrent auto-start **explicitly** during a test window, and
restore the original startup behavior on rollback. Do not silently stop
containers from QPKG install/start hooks.

### Next milestone: bundled BlueZ with exclusive adapter ownership

Bundling recent bluetoothd + libraries in `qpkg/shared/bluez/bin` and
`qpkg/shared/bluez/lib` is technically feasible. The build must compile
and bundle binaries against compatible QTS x86_64 libraries (glibc/ABI),
include licenses and verify SHA-256 checksums. Do not replace system BlueZ
or write to /usr, /lib or the QNAP D-Bus directory.

A separate child process can run bundled bluetoothd under controlled
environment variables and private D-Bus, but *a private D-Bus alone does
not prevent HCI controller contention*. First detect which QTS process
owns the dongle. Never stop/kill the NAS host bluetoothd or force HCI
reset automatically. If exclusive access cannot be safely established,
keep the existing radio container and show a clear diagnostics error.

After exclusivity can be guaranteed, migrate the shared radio manager to
QPKG **without changing** the SelfCare radio API, socket path, Omron GATT
semantics, 60-second queue expiry, watch lease behavior, bonding keys, or
manual sync workflows. A watchdog must not restart endlessly or generate
disk logs. Verify both SwitchBot raw BLE and Omron BLE against a single
radio owner in each session before removing the final container.
