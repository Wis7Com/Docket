#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/Library/Application Support/Docket Local"
PID_FILE="$STATE_DIR/dev-launcher.pid"
LOG_FILE="$HOME/Library/Logs/docket-local-launcher.log"
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
    if [[ "$previous_command" == *"$ROOT/scripts/launch-desktop-dev.sh"* ]]; then
      kill -TERM "$previous_pid" 2>/dev/null || true
      for _ in {1..50}; do
        kill -0 "$previous_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi
fi

child_pid=""
cleanup() {
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
  if [[ -f "$PID_FILE" ]] && [[ "$(cat "$PID_FILE" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT INT TERM

echo "$$" > "$PID_FILE"
cd "$ROOT"
export PATH="$NODE22_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

printf '\n[%s] Starting Docket from %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$ROOT" >> "$LOG_FILE"
npm run dev >> "$LOG_FILE" 2>&1 &
child_pid="$!"
wait "$child_pid"
