#!/usr/bin/env python3
"""QNAP HOST-ONLY, read-only per-process write attribution.

Execute on the QNAP SSH host, not in Docker:
PYTHONDONTWRITEBYTECODE=1 /opt/bin/python3.11 scripts/qnap-host-io-trace.py

No log file, hci reset, pairing change, Docker or QTS mutation.
Read /proc/PID/io access may be restricted. This tool never escalates rights.
"""
import argparse
from pathlib import Path
import sys
import time

PROC = Path("/proc")


def snapshot():
    result = {}
    readable = 0
    denied = 0
    for folder in PROC.iterdir():
        if not folder.name.isdigit():
            continue
        try:
            pid = int(folder.name)
            name = (folder / "comm").read_text().strip()[:32]
            stats = (folder / "stat").read_text().rsplit(")", 1)[1].split()
            if stats[0] == "Z":
                continue
            starttime = stats[19]
            counters = {}
            for line in (folder / "io").read_text().splitlines():
                key, _, value = line.partition(":")
                if key in ("write_bytes", "syscw"):
                    counters[key] = int(value.strip())
            if len(counters) == 2:
                result[pid] = (name, starttime, counters)
                readable += 1
        except (PermissionError, OSError):
            denied += 1
        except (ValueError, IndexError):
            continue
    return result, readable, denied


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=15)
    args = parser.parse_args()
    if not 5 <= args.seconds <= 120:
        parser.error("seconds must be between 5 and 120")
    before, readable, denied = snapshot()
    print(f"Capturing QNAP host process writes for {args.seconds}s (RAM only). "
          f"Readable PIDs={readable}, denied={denied}", flush=True)
    start = time.monotonic()
    time.sleep(args.seconds)
    elapsed = time.monotonic() - start
    after, _, denied_after = snapshot()
    values = []
    for pid, (name, starttime, first) in before.items():
        last = after.get(pid)
        if not last or last[1] != starttime:
            continue
        written = last[2]["write_bytes"] - first["write_bytes"]
        syscw = last[2]["syscw"] - first["syscw"]
        if written < 0 or syscw < 0:
            continue
        values.append((written, syscw, pid, name))
    values.sort(reverse=True)
    print(f"Seconds: {elapsed:.1f}; denied process reads during follow-up: {denied_after}")
    print(f"{'PID':>8} {'Process name':<34} {'Write KiB/s':>13} {'Write calls/s':>13}")
    for written, syscw, pid, name in values[:20]:
        print(f"{pid:8} {name:<34} {written / 1024 / elapsed:13.2f} {syscw / elapsed:13.2f}")
    print("Note: process writes (including dirty cache), not necessarily physical RAID writes; "
          "kernel/journal/short-lived processes may be absent.")
    print("If all rows are zero or denied, run as a QNAP administrator or use the Web diskstats report.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
