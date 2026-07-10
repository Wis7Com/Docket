#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_DIR="$ROOT/assets/icons"
SVG="$ICON_DIR/docket-local.svg"
PNG="$ICON_DIR/docket-local.png"
ICONSET="$ICON_DIR/docket-local.iconset"
ICNS="$ICON_DIR/docket-local.icns"

if ! command -v qlmanage >/dev/null 2>&1; then
  echo "qlmanage is required to render the SVG icon on macOS." >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "sips is required to create iconset PNG sizes on macOS." >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required to create the macOS .icns file." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR" "$ICONSET"' EXIT

qlmanage -t -s 1024 -o "$TMP_DIR" "$SVG" >/dev/null 2>&1
mv "$TMP_DIR/$(basename "$SVG").png" "$PNG"

mkdir -p "$ICONSET"
sips -z 16 16 "$PNG" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$PNG" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$PNG" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$PNG" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$PNG" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$PNG" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$PNG" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$PNG" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$PNG" --out "$ICONSET/icon_512x512.png" >/dev/null
cp "$PNG" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$ICNS"
echo "Generated $PNG and $ICNS"
