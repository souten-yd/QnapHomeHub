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

# Matterbridge must advertise mDNS on the LAN shared with the Matter controller.
# QNAP may expose LAN, Docker, Tailscale and VPN/tunnel interfaces at once; the
# IPv4 default route can therefore be a tunnel and must not be trusted blindly.
MDNS_INTERFACE="${MATTERBRIDGE_MDNS_INTERFACE:-}"

is_unsuitable_interface() {
  case "$1" in
    ""|lo|docker*|veth*|br-*|tailscale*|tun*|tap*|wg*|zt*|virbr*) return 0 ;;
    *) return 1 ;;
  esac
}

# Prefer a non-tunnel interface carrying an RFC1918 IPv4 address. This matches
# the normal NAS LAN even when a VPN/exit-node installs the system default route.
if [ -z "$MDNS_INTERFACE" ] && command -v ip >/dev/null 2>&1; then
  MDNS_INTERFACE="$(ip -o -4 addr show up scope global 2>/dev/null | awk '
    {
      iface=$2; cidr=$4; split(cidr,a,"/"); ip=a[1];
      bad=(iface=="lo" || iface ~ /^docker/ || iface ~ /^veth/ || iface ~ /^br-/ || iface ~ /^tailscale/ || iface ~ /^tun/ || iface ~ /^tap/ || iface ~ /^wg/ || iface ~ /^zt/ || iface ~ /^virbr/);
      private=(ip ~ /^10\./ || ip ~ /^192\.168\./ || ip ~ /^172\.(1[6-9]|2[0-9]|3[0-1])\./);
      if (!bad && private) { print iface; exit }
    }' || true)"
fi

# Fallback: use a non-tunnel default-route interface only when the preferred
# private-LAN detection above was unavailable.
if [ -z "$MDNS_INTERFACE" ] && [ -r /proc/net/route ]; then
  CANDIDATE="$(awk 'NR > 1 && $2 == "00000000" { print $1; exit }' /proc/net/route 2>/dev/null || true)"
  if ! is_unsuitable_interface "$CANDIDATE"; then
    MDNS_INTERFACE="$CANDIDATE"
  fi
fi

set -- "$MB" --homedir "$HOME_DIR" --bridge --frontend 8283 --docker --no-ansi
if [ -n "$MDNS_INTERFACE" ]; then
  echo "QnapHomeHub: Matter mDNS interface: $MDNS_INTERFACE"
  set -- "$@" --mdnsinterface "$MDNS_INTERFACE"
else
  echo "QnapHomeHub: WARNING: unable to auto-detect a non-tunnel Matter LAN interface; configure Mdns Interface in Matterbridge Settings or set MATTERBRIDGE_MDNS_INTERFACE" >&2
fi

if [ -r /proc/net/if_inet6 ]; then
  IPV6_NON_LOOPBACK="$(awk '$6 != "lo" { print $6; exit }' /proc/net/if_inet6 2>/dev/null || true)"
  if [ -z "$IPV6_NON_LOOPBACK" ]; then
    echo "QnapHomeHub: WARNING: IPv6 is not enabled on any non-loopback interface. Matter commissioning requires IPv6 on the local LAN." >&2
  fi
fi

echo "QnapHomeHub: starting Matterbridge frontend on :8283"
exec "$@"
