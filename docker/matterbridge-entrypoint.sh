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

# Matterbridge requires the mDNS interface connected to the Matter controller.
# QNAP commonly exposes several interfaces (LAN, Docker bridges, Tailscale).
# Prefer an explicit override, otherwise select the IPv4 default-route interface.
MDNS_INTERFACE="${MATTERBRIDGE_MDNS_INTERFACE:-}"
if [ -z "$MDNS_INTERFACE" ] && [ -r /proc/net/route ]; then
  MDNS_INTERFACE="$(awk 'NR > 1 && $2 == "00000000" && $1 != "lo" && $1 !~ /^docker/ && $1 !~ /^veth/ && $1 !~ /^br-/ && $1 !~ /^tailscale/ { print $1; exit }' /proc/net/route 2>/dev/null || true)"
fi

set -- "$MB" --homedir "$HOME_DIR" --bridge --frontend 8283 --docker --no-ansi
if [ -n "$MDNS_INTERFACE" ]; then
  echo "QnapHomeHub: Matter mDNS interface: $MDNS_INTERFACE"
  set -- "$@" --mdnsinterface "$MDNS_INTERFACE"
else
  echo "QnapHomeHub: WARNING: unable to auto-detect Matter mDNS interface; configure Mdns Interface in Matterbridge Settings or set MATTERBRIDGE_MDNS_INTERFACE" >&2
fi

echo "QnapHomeHub: starting Matterbridge frontend on :8283"
exec "$@"
