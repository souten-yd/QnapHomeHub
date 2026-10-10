#!/usr/bin/env python3
"""Read-only Docker/QPKG migration diagnostics and opt-in reversible takeover.

Only qnaphomehub, qnaphomehub-matterbridge and qnaphomehub-updater may be
stopped. The qnaphomehub-radio container and QnapSelfCare are never managed.
No mutation occurs unless --apply --confirm / --rollback --confirm is provided.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys

PROJECT = Path("/share/Container/QnapHomeHub")
RADIO = PROJECT / "data/radio/ble.sock"
SETTINGS = PROJECT / "data/homehub/settings.json"
STATE = PROJECT / "data/native-migration/state.json"
RADIO_NAME = "qnaphomehub-radio"
NAMES = {
    "qnaphomehub": "homehub",
    "qnaphomehub-matterbridge": "matterbridge",
    "qnaphomehub-updater": "updater",
}
STOP_ORDER = ("qnaphomehub-updater", "qnaphomehub-matterbridge", "qnaphomehub")
START_ORDER = tuple(reversed(STOP_ORDER))


def fail(message):
    raise RuntimeError(message)


def docker(*args):
    executable = shutil.which("docker")
    if not executable:
        fail("Docker CLI not found. Nothing was modified.")
    result = subprocess.run([executable, *args], stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        fail(f"Docker {' '.join(args[:2])} failed (exit={result.returncode}).")
    return result.stdout


def inspect(name):
    return json.loads(docker("inspect", name))[0]


def expected_identity(item, service):
    labels = (item.get("Config", {}).get("Labels") or {})
    if labels.get("com.docker.compose.project") != "qnaphomehub":
        fail(f"{service}: Docker project label differs; refusing modification")
    if labels.get("com.docker.compose.service") != service:
        fail(f"{service}: Docker service label differs; refusing modification")
    working = labels.get("com.docker.compose.project.working_dir", "")
    if not working or Path(working).resolve() != PROJECT.resolve():
        fail(f"{service}: Compose working directory differs; refusing modification")
    source = labels.get("com.docker.compose.project.config_files", "")
    if source.split(",") != [str(PROJECT / "compose.yaml")]:
        fail(f"{service}: nonstandard Compose configuration; refusing modification")
    if item.get("HostConfig", {}).get("NetworkMode") != "host":
        fail(f"{service}: network mode differs; refusing modification")


def verify_radio(item):
    expected_identity(item, "radio")
    if not item.get("State", {}).get("Running"):
        fail("Shared radio must be running before migration")
    if item.get("Name") != "/" + RADIO_NAME:
        fail("Unexpected shared radio identity")
    mounts = item.get("Mounts") or []
    radio_mounts = [m for m in mounts if m.get("Destination") == "/radio"]
    if len(radio_mounts) != 1 or Path(radio_mounts[0].get("Source", "/invalid")).resolve() != RADIO.parent.resolve():
        fail("Radio Unix socket mount differs from SelfCare contract")
    if not RADIO.is_socket():
        fail("Shared radio Unix socket is missing")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(3)
        s.connect(str(RADIO))
    finally:
        s.close()


def check():
    if not PROJECT.is_dir() or not SETTINGS.is_file():
        fail("Standard HomeHub settings or project folder missing")
    radio = inspect(RADIO_NAME)
    verify_radio(radio)
    services = {}
    for name, service in NAMES.items():
        item = inspect(name)
        expected_identity(item, service)
        if item.get("Name") != "/" + name:
            fail(f"{name}: unexpected container name")
        services[name] = {
            "running": bool(item.get("State", {}).get("Running")),
            "restart": str(item.get("HostConfig", {}).get("RestartPolicy", {}).get("Name", "no")),
        }
        if name == "qnaphomehub":
            matches = [m for m in item.get("Mounts", [])
                       if m.get("Destination") == "/data" and
                       Path(m.get("Source", "/invalid")).resolve() == SETTINGS.parent.resolve()]
            if len(matches) != 1:
                fail("HomeHub Web settings mount differs; refusing modification")
    return dict(ok=True, radio_running=True, radio_socket=str(RADIO),
                selfcare_unchanged=True, web_services=services)


def ensure_admin():
    if os.geteuid() != 0:
        fail("Migration requires QPKG administrator/root execution; no changes made")


def write_state(info):
    STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if STATE.exists():
        fail("Existing migration state must be rolled back first")
    descriptor = os.open(STATE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        json.dump(info, file, indent=2)
        file.write("\n")
        file.flush()
        os.fsync(file.fileno())


def restore(saved, only_names=None):
    services = saved["web_services"]
    for name in START_ORDER:
        if only_names is not None and name not in only_names:
            continue
        old = services[name]
        policy = old["restart"]
        # Preserve the old policy before selectively starting the old Web service.
        if policy not in ("no", "always", "unless-stopped", "on-failure"):
            fail("Nonstandard original Docker restart policy; manual recovery required")
        docker("update", f"--restart={policy}", name)
        if old["running"]:
            docker("start", name)


def apply():
    ensure_admin()
    info = check()
    if not info["web_services"]["qnaphomehub"]["running"]:
        fail("Docker Web is not running; manual review is needed before takeover")
    if STATE.exists():
        fail("Native migration state already exists; refusing second run")
    changed = []
    try:
        # Disable restart first, in case the NAS reboots during the stop sequence.
        for name in STOP_ORDER:
            docker("update", "--restart=no", name)
            changed.append(name)
            docker("stop", name)
        write_state(info)
    except Exception:
        # No deletions. Restore exactly the services changed so far.
        restore(info, only_names=set(changed))
        raise
    return dict(migrated=True, radio_preserved=True, stopped_web_services=list(STOP_ORDER),
                state_file=str(STATE))


def rollback():
    ensure_admin()
    if not STATE.is_file():
        fail("No previously recorded migration state; no action taken")
    saved = json.loads(STATE.read_text(encoding="utf-8"))
    if not saved.get("radio_running") or saved.get("selfcare_unchanged") is not True:
        fail("Migration record invalid; no action taken")
    if set(saved.get("web_services", {})) != set(NAMES):
        fail("Migration record service set invalid; no action taken")
    # Re-check exact container identities and radio ownership before any Docker mutation.
    check()
    # Caller must disable the QPKG Web first: never terminate it from here.
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("0.0.0.0", 8787))
    except OSError:
        fail("Port 8787 still in use. Disable QnapHomeHub QPKG in App Center before rollback")
    finally:
        probe.close()
    restore(saved)
    STATE.unlink()
    return dict(rolled_back=True, original_web_services_restored=True, radio_preserved=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true", help="Stop only legacy Web containers")
    group.add_argument("--rollback", action="store_true", help="Restore saved Docker restart states")
    parser.add_argument("--confirm", action="store_true", help="Required for apply/rollback")
    args = parser.parse_args()
    try:
        if args.apply or args.rollback:
            if not args.confirm:
                fail("Explicit --confirm required. No changes made")
            result = apply() if args.apply else rollback()
        else:
            result = check()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (RuntimeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(json.dumps(dict(ok=False, error=str(exc)), ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
