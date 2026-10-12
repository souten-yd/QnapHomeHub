#!/bin/sh
# Isolated build with dummy credentials. Never upload firmware or read live secrets.
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/homehub-display-ci.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM
cp "$root/firmware/m5go/ble-proxy.yaml" "$build_dir/base.yaml"
cp "$root/firmware/m5go/display.yaml" "$build_dir/display.yaml"
cp -R "$root/firmware/m5go/display" "$build_dir/display"
if [ -d "$root/firmware/m5go/components" ]; then
  cp -R "$root/firmware/m5go/components" "$build_dir/components"
fi
cat > "$build_dir/dashboard.yaml" <<'EOF'
packages:
  base: !include base.yaml
  display: !include display.yaml
EOF
cat > "$build_dir/secrets.yaml" <<'EOF'
wifi_ssid: "HOMEHUB-CI-NOT-A-REAL-NETWORK"
wifi_password: "ci-only-not-a-real-password"
api_encryption_key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
EOF
esphome config "$build_dir/dashboard.yaml"
if [ "${1:-}" = "--compile" ]; then
  esphome compile "$build_dir/dashboard.yaml"
  python3 "$root/scripts/check-m5go-display-render.py" --arduinojson \
    "$build_dir/.esphome/build/qnap-m5go-proxy/managed_components/bblanchon__arduinojson/src"
fi
