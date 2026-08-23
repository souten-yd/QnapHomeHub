#!/bin/sh
set -eu
MB="$(command -v matterbridge)"
PLUGIN="${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN:-/usr/local/lib/node_modules/matterbridge-qnaphomehub}"
HOME_DIR="${MATTERBRIDGE_HOMEDIR:-/data}"

node "$PLUGIN/matterbridge-bootstrap.mjs"
"$MB" --homedir "$HOME_DIR" --add "$PLUGIN" >/dev/null 2>&1 || true
"$MB" --homedir "$HOME_DIR" --enable "$PLUGIN" >/dev/null 2>&1 || true
exec "$MB" --homedir "$HOME_DIR" --bridge --frontend 8283 --docker --no-ansi
