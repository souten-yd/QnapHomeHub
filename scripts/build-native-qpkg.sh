#!/bin/bash
set -euo pipefail
[[ $# -eq 2 ]] || { echo 'Usage: build-native-qpkg.sh <x86_64|arm_64> <output-dir>' >&2; exit 2; }
arch=$1
output=$2
case "$arch" in x86_64|arm_64) ;; *) echo 'Unsupported architecture' >&2; exit 2;; esac
root=$(cd "$(dirname "$0")/.." && pwd)
command -v qbuild >/dev/null || { echo 'QDK qbuild required' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/shared" "$work/icons" "$output"
cp "$root/qpkg/qpkg.cfg" "$work/qpkg.cfg"
cp "$root/qpkg/package_routines" "$work/package_routines"
cp "$root/qpkg/shared/homehub.sh" "$work/shared/homehub.sh"
cp "$root/native/webapp.py" "$work/shared/webapp.py"
cp -R "$root/server/public" "$work/shared/public"
# QDK icons are compiled from existing HomeHub artwork (no extra binary dependencies).
cp "$root/server/public/favicon.png" "$work/icons/QnapHomeHub.png"
cp "$root/server/public/apple-touch-icon.png" "$work/icons/QnapHomeHub_80.png"
chmod 755 "$work/shared/homehub.sh"
qbuild --root "$work" --build-arch "$arch" --build-dir "$work/build"
mapfile -t pkgs < <(find "$work/build" -maxdepth 1 -type f -name '*.qpkg')
[[ ${#pkgs[@]} -eq 1 ]] || { echo 'Expected exactly one QPKG' >&2; exit 1; }
qbuild --query info "${pkgs[0]}"
. "$work/qpkg.cfg"
cp "${pkgs[0]}" "$output/QnapHomeHub_${QPKG_VER}_${arch}.qpkg"
