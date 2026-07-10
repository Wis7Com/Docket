#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_APP="$HOME/Desktop/Docket.app"
ICON="$ROOT/assets/icons/docket-local.icns"
# Production-frontend launcher: rebuilds the frontend only when sources
# changed, then serves the optimized build. launch-desktop-dev.sh remains
# available for hot-reload development.
DEV_LAUNCHER="$ROOT/scripts/launch-desktop-prod.sh"
NODE22_BIN=""

if [[ -x "/opt/homebrew/opt/node@22/bin/node" ]]; then
  NODE22_BIN="/opt/homebrew/opt/node@22/bin"
elif [[ -x "/usr/local/opt/node@22/bin/node" ]]; then
  NODE22_BIN="/usr/local/opt/node@22/bin"
fi

if [[ -z "$NODE22_BIN" ]]; then
  echo "node@22 is required. Install it with: brew install node@22" >&2
  exit 1
fi

if [[ ! -f "$ICON" ]]; then
  "$ROOT/scripts/generate-app-icons.sh"
fi

rm -rf "$DESKTOP_APP"
osacompile -o "$DESKTOP_APP" \
  -e 'on run' \
  -e "do shell script quoted form of \"$DEV_LAUNCHER\" & \" >/dev/null 2>&1 &\"" \
  -e 'end run'

cp "$ICON" "$DESKTOP_APP/Contents/Resources/docket-local.icns"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Docket' "$DESKTOP_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Docket' "$DESKTOP_APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Docket' "$DESKTOP_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.docket.local-launcher' "$DESKTOP_APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.docket.local-launcher' "$DESKTOP_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(date '+%Y%m%d%H%M%S')" "$DESKTOP_APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $(date '+%Y%m%d%H%M%S')" "$DESKTOP_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile docket-local' "$DESKTOP_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleIconName' "$DESKTOP_APP/Contents/Info.plist" 2>/dev/null || true

xattr -cr "$DESKTOP_APP" 2>/dev/null || true
/usr/bin/SetFile -a E "$DESKTOP_APP" 2>/dev/null || true
touch "$DESKTOP_APP"
qlmanage -r cache >/dev/null 2>&1 || true
"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" \
  -f "$DESKTOP_APP" >/dev/null 2>&1 || true

echo "Created $DESKTOP_APP"
