#!/usr/bin/env bash
# Desktop launcher (production frontend).
#
# Serves the frontend from a production Next.js build (standalone server)
# instead of `next dev`, which removes dev-mode latency: on-demand route
# compilation and the unminified React development build. The Electron main
# process and backend still run in the dev configuration (tsx + system
# node), which keeps native modules (better-sqlite3) on the system-node ABI
# — a full NODE_ENV=production Electron run would need an Electron-ABI
# rebuild of those modules on every launch.
#
# The frontend is rebuilt automatically when frontend sources changed since
# the last build, so the launcher still always opens the latest code. A
# launch right after editing frontend code pays one build (~1-2 min); every
# other launch starts at production speed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/Library/Application Support/Docket Local"
# Shared with launch-desktop-dev.sh so either launcher replaces a running
# instance of the other.
PID_FILE="$STATE_DIR/dev-launcher.pid"
LOG_FILE="$HOME/Library/Logs/docket-local-launcher.log"
STAMP="$STATE_DIR/frontend-build.stamp"
NODE22_BIN=""

if [[ -x "/opt/homebrew/opt/node@22/bin/node" ]]; then
  NODE22_BIN="/opt/homebrew/opt/node@22/bin"
elif [[ -x "/usr/local/opt/node@22/bin/node" ]]; then
  NODE22_BIN="/usr/local/opt/node@22/bin"
fi

if [[ -z "$NODE22_BIN" ]]; then
  echo "node@22 is required. Install it with: brew install node@22" >> "$LOG_FILE"
  exit 1
fi

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"

if [[ -f "$PID_FILE" ]]; then
  previous_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$previous_pid" =~ ^[0-9]+$ ]] && kill -0 "$previous_pid" 2>/dev/null; then
    previous_command="$(ps -p "$previous_pid" -o command= 2>/dev/null || true)"
    if [[ "$previous_command" == *"$ROOT/scripts/launch-desktop-dev.sh"* ]] ||
       [[ "$previous_command" == *"$ROOT/scripts/launch-desktop-prod.sh"* ]]; then
      kill -TERM "$previous_pid" 2>/dev/null || true
      for _ in {1..50}; do
        kill -0 "$previous_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi
fi

frontend_pid=""
electron_pid=""
cleanup() {
  for pid in "$electron_pid" "$frontend_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  if [[ -f "$PID_FILE" ]] && [[ "$(cat "$PID_FILE" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT INT TERM

echo "$$" > "$PID_FILE"
cd "$ROOT"
export PATH="$NODE22_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

printf '\n[%s] Starting Docket (production frontend) from %s\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "$ROOT" >> "$LOG_FILE"

# Next.js may place the standalone entry at either location depending on
# workspace shape — probe both (same candidates as electron/paths.ts).
standalone_server() {
  local candidate
  for candidate in \
    "$ROOT/frontend/.next/standalone/server.js" \
    "$ROOT/frontend/.next/standalone/frontend/server.js"; do
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

needs_build=0
if ! standalone_server >/dev/null; then
  needs_build=1
elif [[ ! -f "$STAMP" ]]; then
  needs_build=1
elif [[ -n "$(find \
    "$ROOT/frontend/src" \
    "$ROOT/frontend/public" \
    "$ROOT/frontend/package.json" \
    "$ROOT/frontend/next.config.ts" \
    "$ROOT/frontend/tsconfig.json" \
    -newer "$STAMP" -print -quit 2>/dev/null)" ]]; then
  needs_build=1
fi

if (( needs_build )); then
  printf '[%s] Frontend changed since last build — rebuilding (this takes a minute or two)\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
  npm run build:frontend >> "$LOG_FILE" 2>&1
  touch "$STAMP"
fi

server_js="$(standalone_server)"
server_dir="$(dirname "$server_js")"

(
  cd "$server_dir"
  PORT=3000 HOSTNAME=127.0.0.1 NODE_ENV=production exec node "$server_js"
) >> "$LOG_FILE" 2>&1 &
frontend_pid="$!"

# Same preflight `npm run dev` performs via predev.
node scripts/check-node-version.js >> "$LOG_FILE" 2>&1
node scripts/ensure-dev-native-modules.js >> "$LOG_FILE" 2>&1

# dev:electron waits for :3000 (our standalone server above), compiles the
# Electron main process fresh, then launches the app.
npm run dev:electron >> "$LOG_FILE" 2>&1 &
electron_pid="$!"
wait "$electron_pid"
