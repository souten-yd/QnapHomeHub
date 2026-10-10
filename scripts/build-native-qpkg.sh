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
cp "$root/native/migration.py" "$work/shared/migration.py"
cp -R "$root/server/public" "$work/shared/public"
cp "$root/native/native-ui.js" "$work/shared/public/native-ui.js"
# Keep the upstream HomeHub UI; append only QPKG-specific presentation fixes.
python3 - "$work/shared/public/manage.html" <<'PY'
from pathlib import Path
import sys
page = Path(sys.argv[1])
text = page.read_text()
assert '<script type="module" src="/update.js"></script>' in text
text = text.replace('</body>', '  <script src="/native-ui.js"></script>\n</body>')
page.write_text(text)
PY
# QDK icons are compiled from existing HomeHub artwork (no extra binary dependencies).
# QDK expects GIF service icons; Pillow is a build-host dependency only.
python3 - "$root/server/public/apple-touch-icon.png" "$work/icons" <<'PY'
from pathlib import Path
import sys
try:
    from PIL import Image, ImageOps
except ImportError:
    raise SystemExit("Build-host Pillow is required: python3 -m pip install Pillow")
source = Image.open(sys.argv[1]).convert('RGB')
icons = Path(sys.argv[2])
source.resize((64, 64)).save(icons / 'QnapHomeHub.gif')
ImageOps.grayscale(source).resize((64, 64)).save(icons / 'QnapHomeHub_gray.gif')
source.resize((80, 80)).save(icons / 'QnapHomeHub_80.gif')
PY
chmod 755 "$work/shared/homehub.sh"
qbuild --root "$work" --build-arch "$arch" --build-dir "$work/build"
mapfile -t pkgs < <(find "$work/build" -maxdepth 1 -type f -name '*.qpkg')
[[ ${#pkgs[@]} -eq 1 ]] || { echo 'Expected exactly one QPKG' >&2; exit 1; }
qbuild --query info "${pkgs[0]}"
. "$work/qpkg.cfg"
cp "${pkgs[0]}" "$output/QnapHomeHub_${QPKG_VER}_${arch}.qpkg"
