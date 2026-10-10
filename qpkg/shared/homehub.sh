#!/bin/sh
# QPKG only replaces HomeHub Web/API. The existing radio service continues to serve SelfCare.
set -eu
name=QnapHomeHub
config=/etc/config/qpkg.conf
if [ -x /sbin/getcfg ] && [ -f "$config" ]; then
    root=$(/sbin/getcfg "$name" Install_Path -d "" -f "$config")
else
    root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fi
[ -n "$root" ] || { echo 'QnapHomeHub installation path missing' >&2; exit 1; }
data=${HOMEHUB_NATIVE_DATA_DIR:-/share/Container/QnapHomeHub/data/homehub}
secrets=${HOMEHUB_NATIVE_SECRETS_DIR:-/share/Container/QnapHomeHub/secrets}
radio=${HOMEHUB_NATIVE_RADIO_SOCKET:-/share/Container/QnapHomeHub/data/radio/ble.sock}
pidfile="$root/homehub.pid"
running() {
    [ -f "$pidfile" ] || return 1
    pid=$(cat "$pidfile")
    case "$pid" in *[!0-9]*|'') return 1;; esac
    [ -r "/proc/$pid/cmdline" ] || return 1
    command_line=$(tr '\000' ' ' < "/proc/$pid/cmdline")
    case "$command_line" in *"$root/webapp.py"*) kill -0 "$pid" 2>/dev/null;; *) return 1;; esac
}
find_python() {
    for candidate in "${HOMEHUB_NATIVE_PYTHON:-}" /opt/bin/python3.11 /opt/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
        [ -n "$candidate" ] && [ -x "$candidate" ] || continue
        if "$candidate" -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}
case "${1:-}" in
start)
    if [ -x /sbin/getcfg ] && [ -f "$config" ]; then
        enabled=$(/sbin/getcfg "$name" Enable -u -d FALSE -f "$config")
        [ "$enabled" = TRUE ] || { echo 'QnapHomeHub QPKG disabled' >&2; exit 1; }
    fi
    running && exit 0
    [ -d /share/Container ] || { echo '/share/Container not mounted; refusing startup' >&2; exit 1; }
    [ -f "$data/settings.json" ] || { echo 'Existing HomeHub settings.json missing; refusing empty migration' >&2; exit 1; }
    python=$(find_python) || { echo 'Python >= 3.9 not found; /opt/bin/python3.11 recommended' >&2; exit 1; }
    [ -S "$radio" ] || { echo 'SelfCare shared-radio Unix socket missing; refusing native Web startup' >&2; exit 1; }
    [ -r "$secrets/homehub_admin_username.txt" ] && [ -r "$secrets/homehub_admin_password.txt" ] ||
        { echo 'Existing HomeHub authentication secrets are not readable; refusing startup' >&2; exit 1; }
    # Detect legacy Docker Web on 8787 BEFORE starting QPKG Web; never stop it implicitly.
    if ! "$python" -c 'import socket; s=socket.socket(); s.bind(("0.0.0.0",8787)); s.close()' >/dev/null 2>&1; then
        echo 'Port 8787 is already occupied (possibly legacy Docker qnaphomehub). Stop only its Web container before enabling this QPKG.' >&2
        exit 1
    fi
    umask 077
    export PYTHONDONTWRITEBYTECODE=1
    # No request access log; no Docker operation, no QNAP BlueZ changes.
    "$python" "$root/webapp.py" --port 8787 --data-dir "$data" --secrets-dir "$secrets" --radio-socket "$radio" --public-dir "$root/public" --version 0.3.15 </dev/null >/dev/null 2>&1 &
    echo $! > "$pidfile"
    sleep 2
    running || { rm -f "$pidfile"; echo 'Native Web startup failed; ensure Docker homehub is stopped and port 8787 is free' >&2; exit 1; }
    ;;
stop)
    if running; then
        kill "$(cat "$pidfile")"
        n=0
        while running; do
            n=$((n + 1))
            [ "$n" -le 15 ] || { echo 'HomeHub Web still running; refusing overlapping instance' >&2; exit 1; }
            sleep 1
        done
    fi
    rm -f "$pidfile"
    ;;
restart)
    "$0" stop
    "$0" start
    ;;
*)
    echo "Usage: $0 {start|stop|restart}" >&2
    exit 2
    ;;
esac
