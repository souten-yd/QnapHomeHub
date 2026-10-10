# Quiet-first HomeHub disk I/O evaluation

Priority is NAS disk quietness, even if SwitchBot and SelfCare Bluetooth sync become unavailable.
**No new QPKG, BlueZ swap, or container deletion is needed for this test.**

1. Stop QnapSelfCare in QTS App Center (temporary; data remains intact).
2. In SSH, use Docker CLI directly. QNAP may deny access to compose.yaml even when Docker CLI works:

```sh
docker ps --format 'table {{.Names}}\t{{.Status}}'
docker update --restart=no qnaphomehub qnaphomehub-radio qnaphomehub-matterbridge qnaphomehub-updater
docker stop qnaphomehub-updater qnaphomehub-matterbridge qnaphomehub qnaphomehub-radio
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

Alternatively, when this branch is available on the NAS, run `sh scripts/qnap-quiet-eval.sh status`
and `sh scripts/qnap-quiet-eval.sh stop` for label-validated operations.
The script neither deletes data nor touches Syncthing, Narou or unrelated containers.

3. Wait five minutes for pending jobs to settle. In QnapDiskInspector or QTS Resource Monitor
measure the physical RAID1 member disks' Write IOPS, Write MB/s and Busy % for 60 seconds,
then ideally for 15 minutes. Compare with the same-length baseline taken while services were running.
The IOPS reduction is **not guaranteed** until measured on this NAS.

An additional sampler in this branch reads kernel counters **without disk output files**:

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/bin/python3.11 native/quiet_eval.py --seconds 60 --devices sda sdb
PYTHONDONTWRITEBYTECODE=1 /opt/bin/python3.11 native/quiet_eval.py --seconds 900 --devices sda sdb
```

Check actual physical HDD device names first. With mirrored RAID1, do not sum two disks' Write IOPS
as though they were independent workloads. Other QTS jobs can still write with HomeHub off.

## Interpretation

- A large Write IOPS reduction supports the HomeHub/SelfCare stack as a significant contributor.
- If physical HDD writes stay high, investigate QTS or other services, not only Bluetooth.
- For a second isolation test, start only radio with `docker start qnaphomehub-radio`,
  sample it while SelfCare is still stopped, then `docker stop qnaphomehub-radio`.
- Disk logging, temporary D-Bus writes and frequent lease/health polling are candidate sources
  to investigate before trying container replacement or QPKG. Do not delete BlueZ bonding keys.

## Restore

First stop any QnapHomeHub QPKG that might occupy TCP 8787, then:

```sh
docker update --restart=unless-stopped qnaphomehub-radio qnaphomehub qnaphomehub-matterbridge qnaphomehub-updater
docker start qnaphomehub-radio qnaphomehub qnaphomehub-matterbridge qnaphomehub-updater
```

Enable SelfCare again in QTS App Center when needed. The restart policy above matches
the repository's standard Compose definition; restore custom original policies separately
if present. No Bluetooth pairing information or health history is deleted by these operations.

**All HomeHub/SelfCare BLE functions will be unavailable during the silent evaluation.**
The native QPKG preview also requires radio, so do not enable it while radio is stopped.
