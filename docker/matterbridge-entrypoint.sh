#!/bin/sh
set -eu
MB="/app/plugin/node_modules/.bin/matterbridge"

node /app/plugin/matterbridge-bootstrap.mjs
"$MB" --homedir /data --add /app/plugin >/dev/null 2>&1 || true
"$MB" --homedir /data --enable /app/plugin >/dev/null 2>&1 || true
exec "$MB" --homedir /data --bridge --frontend 8283 --docker --no-ansi
