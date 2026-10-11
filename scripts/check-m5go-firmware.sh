#!/bin/sh
# Build only a throwaway configuration with deliberately unusable credentials.
# Never read or overwrite the operator's secrets.yaml, never publish firmware.
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/homehub-m5go-ci.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM
cp "$root/firmware/m5go/ble-proxy.yaml" "$build_dir/ble-proxy.yaml"
cat > "$build_dir/secrets.yaml" <<'EOF'
wifi_ssid: "HOMEHUB-CI-NOT-A-REAL-NETWORK"
wifi_password: "ci-only-not-a-real-password"
api_encryption_key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
EOF
esphome config "$build_dir/ble-proxy.yaml"
if [ "${1:-}" = "--compile" ]; then
  esphome compile "$build_dir/ble-proxy.yaml"
fi
