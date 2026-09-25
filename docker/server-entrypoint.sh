#!/bin/sh
set -eu
if [ "${HOMEHUB_RADIO_SERVICE:-0}" = 1 ]; then
    mkdir -p /run/dbus
    dbus-daemon --system --fork --nopidfile
fi
exec "$@"
