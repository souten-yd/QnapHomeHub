"""Docker-free native HomeHub QPKG self-update.

Only official GitHub release assets are eligible. No Bluetooth/Docker
processes are started by checks or installs. Disk files are created only
on explicit update, option change, or scheduled opt-in update.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

RELEASES = "https://api.github.com/repos/souten-yd/QnapHomeHub/releases?per_page=20"
OWNER = "souten-yd/QnapHomeHub"
TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)-qpkg-preview\.(\d+)$")
MAX_PACKAGE = 300 * 1024 * 1024
MAX_MANIFEST = 128 * 1024
PHASES = {"queued", "checking", "downloading", "backing_up", "installing", "verifying"}
TIMEOUT_INSTALL = 600
TIMEOUT_HEALTH = 120


class UpdateError(ValueError):
    pass


def version_parts(value):
    value = str(value)
    if not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise UpdateError("Invalid installed QPKG version")
    return tuple(map(int, value.split(".")))


def atomic_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = target.with_name(target.name + ".tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(value, out, ensure_ascii=False)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, target)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def open_official(url, max_size, timeout=15):
    request = urllib.request.Request(url, headers={
        "User-Agent": "QnapHomeHub-native-qpkg",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(max_size + 1)
    if len(raw) > max_size:
        raise UpdateError("GitHub response exceeded safety limit")
    return raw


def release_asset(release, name):
    tag = release["tag_name"]
    base = "https://github.com/" + OWNER + "/releases/download/" + tag + "/"
    for asset in release.get("assets", []):
        if asset.get("name") == name and asset.get("browser_download_url") == base + name:
            if not isinstance(asset.get("size"), int) or asset["size"] <= 0:
                raise UpdateError("Invalid release asset size")
            return asset
    raise UpdateError("Required official QPKG release asset is missing")


def discover(current, arch="x86_64", get_json=None):
    if arch != "x86_64":
        raise UpdateError("Native QPKG preview supports x86_64 only")
    fetch = get_json or (lambda: json.loads(open_official(RELEASES, 2 * 1024 * 1024)))
    releases = fetch()
    if not isinstance(releases, list):
        raise UpdateError("GitHub release response was not an array")
    choice = None
    for release in releases:
        if not isinstance(release, dict) or release.get("draft") or release.get("prerelease") is not True:
            continue
        matched = TAG.fullmatch(str(release.get("tag_name", "")))
        if matched is None:
            continue
        version = ".".join(matched.groups()[:3])
        if version_parts(version) <= version_parts(current):
            continue
        filename = "QnapHomeHub_" + version + "_" + arch + ".qpkg"
        try:
            package = release_asset(release, filename)
            manifest = release_asset(release, "SHA256SUMS")
        except UpdateError:
            continue
        if package["size"] > MAX_PACKAGE or manifest["size"] > MAX_MANIFEST:
            continue
        if choice is None or version_parts(version) > version_parts(choice["version"]):
            choice = {"version": version, "tag": release["tag_name"],
                      "package": package, "manifest": manifest,
                      "filename": filename,
                      "url": "https://github.com/" + OWNER + "/releases/tag/" + release["tag_name"]}
    return choice


def fetch_checked_asset(asset, destination, limit):
    name = asset["name"]
    url = asset["browser_download_url"]
    if not url.startswith("https://github.com/" + OWNER + "/releases/download/"):
        raise UpdateError("Unexpected release host")
    destination = Path(destination)
    tmp = destination.with_name(destination.name + ".part")
    digest = hashlib.sha256()
    total = 0
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "QnapHomeHub-QPKG-Updater"})
        with urllib.request.urlopen(request, timeout=30) as resp:
            with tmp.open("wb") as file:
                os.chmod(tmp, 0o600)
                for chunk in iter(lambda: resp.read(1024 * 1024), b""):
                    total += len(chunk)
                    if total > limit or total > asset["size"]:
                        raise UpdateError("Release asset larger than advertised")
                    file.write(chunk)
                    digest.update(chunk)
                file.flush()
                os.fsync(file.fileno())
        if total != asset["size"]:
            raise UpdateError("Downloaded release asset length mismatch")
        os.replace(tmp, destination)
        return digest.hexdigest()
    finally:
        tmp.unlink(missing_ok=True)


def expected_digest(manifest, filename):
    lines = Path(manifest).read_text(encoding="utf-8").splitlines()
    digest = None
    for line in lines:
        m = re.fullmatch(r"([0-9a-fA-F]{64})  (?:\*)?([A-Za-z0-9_.-]+)", line.strip())
        if m and m.group(2) == filename:
            if digest is not None:
                raise UpdateError("Duplicate QPKG SHA-256 entries")
            digest = m.group(1).lower()
    if digest is None:
        raise UpdateError("Official release checksum is missing")
    return digest


def registered_install_root():
    result = subprocess.check_output(
        ["/sbin/getcfg", "QnapHomeHub", "Install_Path", "-d", "", "-f", "/etc/config/qpkg.conf"],
        text=True, timeout=8).strip()
    if not result:
        raise UpdateError("QPKG installation path not registered")
    return Path(result).resolve()


def qpkg_version():
    return subprocess.check_output(
        ["/sbin/getcfg", "QnapHomeHub", "Version", "-d", "", "-f", "/etc/config/qpkg.conf"],
        text=True, timeout=8).strip()


def check_nas(install_root, current):
    if os.geteuid() != 0 or not Path("/sbin/getcfg").is_file():
        raise UpdateError("QPKG self-update requires NAS administrator rights")
    root = Path(install_root).resolve()
    if registered_install_root() != root or root.name != "QnapHomeHub":
        raise UpdateError("QPKG installation path mismatch")
    if not (root / "homehub.sh").is_file() or not (root / "webapp.py").is_file():
        raise UpdateError("HomeHub QPKG service missing")
    if version_parts(qpkg_version()) != version_parts(current):
        raise UpdateError("QPKG registered version differs from running version")
    if platform.machine().lower() not in ("x86_64", "amd64"):
        raise UpdateError("Unsupported QNAP architecture")


def process_identity(pid):
    try:
        parts = Path("/proc/" + str(int(pid)) + "/stat").read_text().rsplit(")", 1)[1].split()
        return parts[19] if parts[0] != "Z" else None
    except (OSError, IndexError, ValueError, TypeError):
        return None


def installer_alive(state):
    return bool(state.get("installer_start") and
                process_identity(state.get("installer_pid")) == state["installer_start"])


class Updater:
    def __init__(self, data_root, install_root, current, port=8787, nas_check=check_nas):
        self.data_root = Path(data_root).resolve()
        self.install_root = Path(install_root).resolve()
        self.current = current
        self.port = port
        self.nas_check = nas_check
        self.directory = self.data_root / "updates"
        self.status_file = self.directory / "status.json"
        self.config_file = self.directory / "config.json"
        self.mutex = threading.RLock()
        self.last_seen = 0.0
        self.cached_state = {}
        self.latest = None
        self.last_error = None
        self._stop = threading.Event()
        self._scheduler = None
        self._next_auto_check = time.monotonic() + 24 * 60 * 60

    def _state(self):
        now = time.monotonic()
        if now - self.last_seen > 3:
            self.cached_state = read_json(self.status_file)
            self.last_seen = now
        return dict(self.cached_state)

    def _refresh(self):
        self.last_seen = 0
        return self._state()

    def _config(self):
        return read_json(self.config_file)

    def _supported(self):
        try:
            self.nas_check(self.install_root, self.current)
            return None
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            return str(exc)

    def status(self):
        with self.mutex:
            state = self._state()
            busy = bool(state.get("phase") in PHASES and
                        (installer_alive(state) or (
                            state.get("phase") in {"queued", "checking", "downloading", "backing_up"} and
                            state.get("started_at", 0) > time.time() - 900)))
            # A non-running worker should never look busy indefinitely.
            interrupted = state.get("phase") in PHASES and not busy
            phase = "error" if interrupted else state.get("phase", "idle")
            latest = self.latest
            return {
                "currentVersion": self.current, "latestVersion": latest["version"] if latest else None,
                "latestTag": latest["tag"] if latest else None,
                "releaseUrl": latest["url"] if latest else None,
                "phase": phase, "busy": busy,
                "updateAvailable": bool(latest and version_parts(latest["version"]) > version_parts(self.current)),
                "autoUpdate": self._config().get("autoUpdate") is True,
                "lastError": (state.get("message") if interrupted else self.last_error or
                              state.get("message") if phase == "error" else self.last_error),
                "supported": self._supported() is None,
                "unsupportedReason": self._supported(),
                "matterbridge": {"phase": "disabled", "updateAvailable": False},
            }

    def check(self):
        with self.mutex:
            try:
                result = discover(self.current)
                self.latest = result
                self.last_error = None
            except Exception as error:
                self.last_error = str(error)[:350]
                raise
            return self.status()

    def configure(self, new_value):
        if set(new_value) != {"autoUpdate"} or type(new_value["autoUpdate"]) is not bool:
            raise UpdateError("autoUpdate boolean required")
        with self.mutex:
            current = self._config().get("autoUpdate") is True
            if current != new_value["autoUpdate"]:
                atomic_json(self.config_file, {"autoUpdate": new_value["autoUpdate"]})
                if new_value["autoUpdate"]:
                    self._next_auto_check = time.monotonic()
            return self.status()

    def lock(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.directory / "update.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise UpdateError("QPKG installation is already in progress")
        return fd

    def apply(self, tag):
        with self.mutex:
            self.nas_check(self.install_root, self.current)
            if not self.latest or tag != self.latest["tag"]:
                raise UpdateError("Please check the official release before installing")
            if version_parts(self.latest["version"]) <= version_parts(self.current):
                raise UpdateError("Cannot reinstall same or older QPKG")
            fd = self.lock()
            try:
                if installer_alive(read_json(self.status_file)):
                    raise UpdateError("Another QPKG installer is running")
                job_id = uuid.uuid4().hex
                job = self.directory / job_id
                job.mkdir(mode=0o700)
                shutil.copyfile(Path(__file__).resolve(), job / "qpkg_update.py")
                atomic_json(job / "request.json", {
                    "id": job_id, "data_root": str(self.data_root), "install_root": str(self.install_root),
                    "current": self.current, "version": self.latest["version"],
                    "tag": tag, "port": self.port})
                atomic_json(self.status_file, {
                    "id": job_id, "phase": "queued", "target": tag,
                    "started_at": time.time(), "message": "QPKG update queued"})
                with (job / "update.log").open("ab") as log:
                    subprocess.Popen(
                        [sys.executable, str(job / "qpkg_update.py"), "--worker", str(job), "--lock-fd", str(fd)],
                        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                        cwd=job, start_new_session=True, close_fds=True, pass_fds=(fd,),
                        env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
                self._refresh()
                return {"phase": "queued", "busy": True, "target": tag, "id": job_id}
            finally:
                os.close(fd)

    def start_scheduler(self):
        if self._scheduler is not None:
            return
        self._scheduler = threading.Thread(target=self._schedule, daemon=True, name="homehub-qpkg-update")
        self._scheduler.start()

    def _schedule(self):
        while not self._stop.wait(60):
            if not self._config().get("autoUpdate"):
                continue
            if time.monotonic() < self._next_auto_check:
                continue
            self._next_auto_check = time.monotonic() + 24 * 60 * 60
            try:
                latest = self.check()
                if latest["updateAvailable"] and not latest["busy"] and latest["supported"]:
                    self.apply(latest["latestTag"])
            except Exception as error:
                with self.mutex:
                    self.last_error = str(error)[:350]

    def close(self):
        self._stop.set()


def wait_updated(version, port, timeout=TIMEOUT_HEALTH):
    deadline = time.monotonic() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        try:
            if version_parts(qpkg_version()) == version_parts(version):
                with opener.open("http://127.0.0.1:" + str(port) + "/api/health", timeout=4) as response:
                    health = json.load(response)
                if version_parts(health["version"]) == version_parts(version):
                    return
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass
        time.sleep(2)
    raise UpdateError("New QPKG Web health/version verification timed out")


def run_worker(job, lock_fd):
    job = Path(job).resolve()
    request = read_json(job / "request.json")
    state_file = job.parent / "status.json"
    state = read_json(state_file)
    if state.get("id") != request.get("id"):
        raise UpdateError("QPKG update job id changed")
    if os.fstat(lock_fd).st_ino != os.stat(job.parent / "update.lock").st_ino:
        raise UpdateError("QPKG update lock mismatch")
    os.set_inheritable(lock_fd, False)
    installer = None
    stopped = False

    def phase(step, message):
        state.update(phase=step, message=message)
        atomic_json(state_file, state)
        print(message, flush=True)

    try:
        check_nas(request["install_root"], request["current"])
        phase("checking", "Validating official release")
        choice = discover(request["current"])
        if not choice or choice["tag"] != request["tag"] or choice["version"] != request["version"]:
            raise UpdateError("The official release changed; aborting")
        if shutil.disk_usage(job).free < choice["package"]["size"] * 3 + 32 * 1024 * 1024:
            raise UpdateError("Insufficient free NAS storage")
        phase("downloading", "Downloading and verifying official release")
        manifest_path = job / "SHA256SUMS"
        fetch_checked_asset(choice["manifest"], manifest_path, MAX_MANIFEST)
        package = job / choice["filename"]
        actual_hash = fetch_checked_asset(choice["package"], package, MAX_PACKAGE)
        if actual_hash != expected_digest(manifest_path, choice["filename"]):
            package.unlink(missing_ok=True)
            raise UpdateError("Official QPKG SHA-256 mismatch")
        phase("backing_up", "Backing up current HomeHub settings and credentials")
        backup_dir = job / "backup"
        backup_dir.mkdir(mode=0o700)
        settings = Path(request["data_root"]) / "homehub/settings.json"
        secrets = Path(request["data_root"]) / "does-not-contain-secrets"
        # Secrets are outside /data; use current QnapHomeHub deployment directory.
        secrets = Path(request["data_root"]).parent / "secrets"
        if not settings.is_file() or not (secrets / "homehub_admin_password.txt").is_file():
            raise UpdateError("HomeHub settings/credentials missing; aborting update")
        shutil.copy2(settings, backup_dir / "settings.json")
        shutil.copytree(secrets, backup_dir / "secrets", symlinks=False)
        check_nas(request["install_root"], request["current"])
        phase("installing", "Applying QPKG; Web access will temporarily disconnect")
        stopped = True
        subprocess.run(["/bin/sh", str(Path(request["install_root"]) / "homehub.sh"), "stop"],
                       stdin=subprocess.DEVNULL, timeout=25, check=True)
        installer = subprocess.Popen(["/bin/sh", str(package)], stdin=subprocess.DEVNULL,
                                     cwd=job, start_new_session=True, close_fds=True,
                                     env=dict(os.environ, QINSTALL_PATH=str(Path(request["install_root"]).parent)))
        state.update(installer_pid=installer.pid, installer_start=process_identity(installer.pid))
        atomic_json(state_file, state)
        code = installer.wait(timeout=TIMEOUT_INSTALL)
        if code not in (0, 10):
            raise UpdateError("QPKG installer exited with error code " + str(code))
        phase("verifying", "Waiting for QPKG registration and Web health")
        wait_updated(request["version"], request["port"])
        phase("success", "QPKG updated successfully")
        state.update(finished_at=time.time())
        atomic_json(state_file, state)
        package.unlink(missing_ok=True)
        return 0
    except Exception as error:
        phase("error", str(error)[:600])
        state.update(finished_at=time.time())
        atomic_json(state_file, state)
        if stopped and (installer is None or installer.poll() is not None):
            try:
                root = Path(request["install_root"])
                if (root / "homehub.sh").is_file():
                    subprocess.run(["/bin/sh", str(root / "homehub.sh"), "start"],
                                   stdin=subprocess.DEVNULL, timeout=25, check=True)
            except (OSError, subprocess.SubprocessError) as recovery:
                print("Service recovery failed: " + str(recovery), flush=True)
        return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", required=True)
    parser.add_argument("--lock-fd", type=int, required=True)
    opts = parser.parse_args()
    os.umask(0o077)
    try:
        return run_worker(opts.worker, opts.lock_fd)
    finally:
        os.close(opts.lock_fd)


if __name__ == "__main__":
    raise SystemExit(main())
