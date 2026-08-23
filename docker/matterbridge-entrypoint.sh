#!/bin/sh
set -eu
MB="$(command -v matterbridge)"
PLUGIN="${QNAPHOMEHUB_MATTERBRIDGE_PLUGIN:-/usr/local/lib/node_modules/matterbridge-qnaphomehub}"
HOME_DIR="${MATTERBRIDGE_HOMEDIR:-/data}"

node "$PLUGIN/matterbridge-bootstrap.mjs"

echo "QnapHomeHub: registering Matterbridge plugin from $PLUGIN"
if ! "$MB" --homedir "$HOME_DIR" --add "$PLUGIN"; then
  echo "QnapHomeHub: WARNING: Matterbridge --add failed; continuing so the frontend and logs remain available" >&2
fi

echo "QnapHomeHub: enabling Matterbridge plugin from $PLUGIN"
if ! "$MB" --homedir "$HOME_DIR" --enable "$PLUGIN"; then
  echo "QnapHomeHub: WARNING: Matterbridge --enable failed; continuing so the frontend and logs remain available" >&2
fi

echo "QnapHomeHub: starting Matterbridge frontend on :8283"
exec "$MB" --homedir "$HOME_DIR" --bridge --frontend 8283 --docker --no-ansi
