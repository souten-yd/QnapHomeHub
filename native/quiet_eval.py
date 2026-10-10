#!/usr/bin/env python3
"""Read-only disk I/O measurement using /proc/diskstats (never writes to disk).

Use --devices sda sdb for physical RAID1 HDD members. Prints rates only.
Capture a matching baseline before stopping services if possible, then repeat
while quiet; keep interval and other NAS workloads unchanged.
"""
import argparse
import os
import sys
import time
from pathlib import Path

DISKSTATS = Path("/proc/diskstats")


def parse_diskstats(content):
    result = {}
    for line in content.splitlines():
        fields = line.split()
        if len(fields) < 14:
            continue
        try:
            name = fields[2]
            result[name] = dict(
                read_ios=int(fields[3]),
                write_ios=int(fields[7]),
                read_sectors=int(fields[5]),
                write_sectors=int(fields[9]),
                io_ms=int(fields[12]),
            )
        except (IndexError, ValueError):
            continue
    return result


def measure(before, after, seconds, devices):
    if seconds <= 0:
        raise ValueError("Measurement seconds must be greater than zero")
    records = []
    for device in devices:
        if device not in before or device not in after:
            raise ValueError(f"Device {device} absent from /proc/diskstats")
        b, a = before[device], after[device]
        delta = {key: a[key] - b[key] for key in b}
        if min(delta.values()) < 0:
            raise ValueError(f"Device {device} reset or replaced during the sample")
        records.append(dict(
            device=device,
            read_iops=delta["read_ios"] / seconds,
            write_iops=delta["write_ios"] / seconds,
            read_mb_s=delta["read_sectors"] * 512 / 1_000_000 / seconds,
            write_mb_s=delta["write_sectors"] * 512 / 1_000_000 / seconds,
            busy_pct=delta["io_ms"] / (seconds * 1000) * 100,
        ))
    return records


def snapshot(source=DISKSTATS):
    return parse_diskstats(source.read_text(encoding="ascii"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=60,
                        help="Read-only sampling interval, default 60 seconds")
    parser.add_argument("--devices", nargs="+", default=["sda", "sdb"],
                        help="Physical Linux block devices, e.g. sda sdb")
    args = parser.parse_args(argv)
    if not 5 <= args.seconds <= 1800:
        parser.error("--seconds must be between 5 and 1800")
    if not args.devices or len(set(args.devices)) != len(args.devices):
        parser.error("At least one unique device is required")
    for device in args.devices:
        if not device or len(device) > 32 or not all(c.isalnum() or c in "-_" for c in device):
            parser.error(f"Invalid device name: {device!r}")
    try:
        baseline = snapshot()
        if any(d not in baseline for d in args.devices):
            available = ", ".join(sorted(name for name in baseline if name.startswith(("sd", "md", "nvme"))))
            raise ValueError(f"Selected device absent from /proc/diskstats. Available: {available}")
        print(f"Sampling {', '.join(args.devices)} for {args.seconds}s. Read-only; no output file is created.", flush=True)
        start = time.monotonic()
        time.sleep(args.seconds)
        elapsed = time.monotonic() - start
        after = snapshot()
        rows = measure(baseline, after, elapsed, args.devices)
        print(f"{'Device':<12} {'Read IOPS':>12} {'Write IOPS':>12} {'Read MB/s':>12} {'Write MB/s':>12} {'Busy %':>10}")
        for row in rows:
            print(f"{row['device']:<12} {row['read_iops']:12.1f} {row['write_iops']:12.1f}"
                  f" {row['read_mb_s']:12.3f} {row['write_mb_s']:12.3f} {row['busy_pct']:10.1f}")
        print("Compare per-device figures at the same sample duration and NAS workload.")
        return 0
    except (OSError, ValueError) as error:
        print(f"diskstats unavailable: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    raise SystemExit(main())
