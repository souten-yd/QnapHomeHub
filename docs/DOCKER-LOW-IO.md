# Docker HomeHub low-write diagnostics (v0.3.15)

## Goal and limitations

HomeHub continues as the original Docker Web + shared Bluetooth radio architecture.
Omron measurements are still durably recorded by the separate QnapSelfCare QPKG.
Pairing/bonding state remains in `./data/bluetooth`; HomeHub configuration stays in `./data/homehub`.
No native HomeHub QPKG is installed or started by this release.

**Original v0.3.15 investigation note (superseded by measured evidence on one QNAP NAS, 2026-10-11):**
At the time, the source of ~99 Write IOPS was not proven. Later controlled checks
showed that the QTS **host** `bluetoothd` wrote ~1.2–1.6 MB/s and the physical HDD
IOPS dropped from ~83.84 to ~2.7 during a brief host-daemon pause while the Docker
radio remained running; after disabling the QTS host daemon's persistent startup
setting, a NAS reboot preserved ~2.53 Write IOPS/HDD. Docker log/TMP changes **alone**
did not eliminate the high idle IOPS. For new installations see
[QNAP host BlueZ low-I/O runbook](QNAP-HOST-BLUEZ-LOW-IO-RUNBOOK.md).
These results are one-NAS evidence and do not establish universal QTS behavior.

## New built-in one-click report

1. Open the original Docker HomeHub Web UI at `http://NAS:8787/manage.html`.
2. Log in and click **15秒テストしてログ生成** under **Bluetooth / ディスクI/O診断**.
3. The report samples `/proc/diskstats` (host-wide kernel disk counters) for 15 seconds.
   It does not scan Bluetooth, toggle HCI, write a log to the NAS,
   reconfigure SelfCare, or control containers.
4. Click **ログをコピー** and paste into the ChatGPT conversation;
   or **TXT保存** to download a copy to your *browser device*.
5. Values are shown *per physical disk*, not summed for RAID1.
   Device MAC addresses and raw BLE/health payloads are excluded from the report.

Interpretation: this identifies whether physical disk IOPS rises during radio use,
but **cannot attribute writes to a QNAP host PID from inside Docker**.

For read-only PID attribution, run this from NAS **SSH** (not from Docker):

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/bin/python3.11 /share/Container/QnapHomeHub/scripts/qnap-host-io-trace.py --seconds 15
```

The process-specific trace prints process names, PID, Write KiB/s, and
write syscall rate to the terminal without creating a file. If SSH user
`kenshiro` cannot read some `/proc/<pid>/io` records, the tool explicitly
reports denied accesses; do not alter system permissions.

## Low-write Docker radio defaults

- Radio diagnostic informational messages are suppressed from stdout by default;
  distinct warnings/errors can be observed in Web diagnostics and are rate-limited
  before reaching stdout. `HOMEHUB_RADIO_LOG_LEVEL=info` is a temporary verbose override.
- `radio` uses `logging: {driver: none}` to avoid Docker json-file log writes.
  This means `docker logs qnaphomehub-radio` will be empty after re-creation.
- Only `/run/dbus` and `/tmp` are RAM-backed tmpfs; `/var/lib/bluetooth`
  is still persisted in the original `./data/bluetooth` bind mount.
- Set `PYTHONDONTWRITEBYTECODE=1` to avoid Python bytecode writes.
- `homehub` Web debug history stays in RAM except warnings/errors and rare
  service lifecycle notices. The 15-second report is *not saved to NAS HDD*.

## Existing Docker Web updater with Matter/Alexa stopped

HomeHub's existing updater will now detect an intentionally stopped
`qnaphomehub-matterbridge` container and **skip downloading, checking or
recreating it**. A HomeHub release update recreates `radio` and `homehub`,
but not unused Matterbridge. Rollback follows the same active-service set.
An explicitly requested Matterbridge update fails without starting it
if its service is stopped. This also reduces unnecessary GHCR pulls.

Running Web + radio + updater without Matterbridge is a supported
low-overhead setup; turn off automatic release updates if a stable
always-on device collection period must not be interrupted.

## Deployment caveat

Replacing a Docker image does **not** automatically apply updated `compose.yaml`.
QNAP SSH users may lack read permission to the existing Compose directory.
The current Docker updater updates images but does **not** apply Compose changes.
Apply the release's new Compose configuration through an administrator or
Container Station deployment, preserving the data and secrets directories.
Never use `docker compose down -v`, delete HomeHub storage, or delete SelfCare DB.
Do not run native QPKG Web simultaneously on 8787: uninstall the abandoned
QnapHomeHub QPKG from QTS App Center first. The QnapSelfCare QPKG remains.

To first validate the updated radio without modifying Compose,
deploy the versioned Docker image and retain existing Compose settings.
Then separately apply the low-write Compose configuration and compare
15-minute Write IOPS under the same SelfCare watch mode.

## Rollback

The previously deployed Compose config and image can be restored independently;
bonding data in `data/bluetooth` and SelfCare measurement DB must be preserved.
If the new RAM D-Bus or logging config causes radio errors, recreate
`qnaphomehub-radio` using the previous Compose configuration and previous
versioned server image. Record before/after HDD Write IOPS and Bluetooth
watch/manual sync status on real QNAP hardware before calling it successful.
