#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${POCODEX_PROJECT_DIR:-$SCRIPT_DIR}"
DEFAULT_APP_PATH="/home/justin/git/github/pocodex/Codex.app"
DEFAULT_APP_SERVER="/home/justin/.local/share/mise/installs/node/25.8.0/bin/codex"
APP_PATH="${POCODEX_APP_PATH:-$DEFAULT_APP_PATH}"
if [[ "$APP_PATH" == "$DEFAULT_APP_PATH" && ! -d "$APP_PATH" ]]; then
  APP_PATH="$PROJECT_DIR/Codex.app"
fi
APP_SERVER_PATH="${POCODEX_APP_SERVER:-$DEFAULT_APP_SERVER}"
if [[ "$APP_SERVER_PATH" == "$DEFAULT_APP_SERVER" && ! -x "$APP_SERVER_PATH" ]]; then
  APP_SERVER_PATH="$PROJECT_DIR/Contents/Resources/codex"
fi
LISTEN="${POCODEX_LISTEN:-0.0.0.0:8787}"
TOKEN="${POCODEX_TOKEN:-}"
LOG_FILE="${POCODEX_LOG_FILE:-/tmp/pocodex.log}"
PID_FILE="${POCODEX_PID_FILE:-/tmp/pocodex.pid}"
KILL_EXISTING="${POCODEX_KILL_EXISTING:-0}"
FOREGROUND="${POCODEX_FOREGROUND:-0}"
YOLO="${POCODEX_YOLO:-1}"
NODE_BIN="${NODE_PATH:-node}"

EXTRA_ARGS=()

usage() {
  cat <<'USAGE'
Usage:
  ./pocodex.sh [options] [-- [extra args for pocodex]]

Environment:
POCODEX_PROJECT_DIR   Project root (default: script directory)
  NODE_PATH             Path to node binary (default: node)
  POCODEX_APP_PATH      Default: /home/justin/git/github/pocodex/Codex.app
  POCODEX_APP_SERVER    Default: /home/justin/.local/share/mise/installs/node/25.8.0/bin/codex
  POCODEX_LISTEN        Host:port to bind (default: 0.0.0.0:8787)
  POCODEX_TOKEN         Optional token for session auth
  POCODEX_LOG_FILE      Log file path (default: /tmp/pocodex.log)
  POCODEX_PID_FILE      PID file path (default: /tmp/pocodex.pid)
  POCODEX_KILL_EXISTING  Set to 1 to kill stale PID before start
  POCODEX_FOREGROUND    Set to 1 to run in foreground
  POCODEX_YOLO          Set to 1 to pass --yolo to codex app-server (default: 1)

Options:
  --app PATH             Override the Codex.app path
  --app-server PATH      Override the app-server binary path
  --listen HOST:PORT      Override listen address
  --token TOKEN           Optional session token
  --log-file PATH         Override log file path
  --pid-file PATH         Override PID file path
  --kill-existing         Kill any process in PID file before launch
  --foreground            Run in foreground and exit with the server status
  --yolo                  Pass --yolo to codex app-server
  --no-yolo               Do not pass --yolo to codex app-server
  --help                  Show this message
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_PATH="$2"
      shift 2
      ;;
    --app-server)
      APP_SERVER_PATH="$2"
      shift 2
      ;;
    --listen)
      LISTEN="$2"
      shift 2
      ;;
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --log-file)
      LOG_FILE="$2"
      shift 2
      ;;
    --pid-file)
      PID_FILE="$2"
      shift 2
      ;;
    --kill-existing)
      KILL_EXISTING=1
      shift 1
      ;;
    --foreground)
      FOREGROUND=1
      shift 1
      ;;
    --yolo)
      YOLO=1
      shift 1
      ;;
    --no-yolo)
      YOLO=0
      shift 1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$APP_SERVER_PATH" ]]; then
  APP_SERVER_PATH="$APP_PATH/Contents/Resources/codex"
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: Codex.app not found at $APP_PATH" >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/dist/cli.js" ]]; then
  echo "Error: dist/cli.js not found at $PROJECT_DIR/dist/cli.js. Run: pnpm run build" >&2
  exit 1
fi

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "Error: NODE_PATH is invalid: $NODE_BIN" >&2
  exit 1
fi

if [[ ! -x "$APP_SERVER_PATH" ]]; then
  echo "Error: app-server binary not found or not executable: $APP_SERVER_PATH" >&2
  exit 1
fi

if [[ "$FOREGROUND" != "1" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    EXISTING_PID="$(cat "$PID_FILE")"
    if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
      if [[ "$KILL_EXISTING" == "1" ]]; then
        echo "Killing existing Pocodex process $EXISTING_PID from $PID_FILE"
        kill -TERM "$EXISTING_PID"
        sleep 1
      else
        echo "Error: PID file exists and process is running: $EXISTING_PID" >&2
        echo "Set POCODEX_KILL_EXISTING=1 or pass --kill-existing to replace it." >&2
        exit 1
      fi
    fi
  fi
fi

cd "$PROJECT_DIR"

CMD=("$NODE_BIN" "dist/cli.js" --app "$APP_PATH" --app-server "$APP_SERVER_PATH" --listen "$LISTEN")
if [[ -n "$TOKEN" ]]; then
  CMD+=(--token "$TOKEN")
fi
if [[ "$YOLO" == "1" ]]; then
  CMD+=(--yolo)
fi
CMD+=("${EXTRA_ARGS[@]}")

if [[ "$FOREGROUND" == "1" ]]; then
  exec "${CMD[@]}"
fi

mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$PID_FILE")"

if command -v setsid >/dev/null 2>&1; then
  setsid "${CMD[@]}" >> "$LOG_FILE" 2>&1 </dev/null &
else
  nohup "${CMD[@]}" >> "$LOG_FILE" 2>&1 </dev/null &
fi
sleep 0.2
if ! kill -0 "$!" 2>/dev/null; then
  echo "Failed to start Pocodex. Check log: $LOG_FILE" >&2
  exit 1
fi
PID=$!
echo "$PID" > "$PID_FILE"

echo "Started Pocodex (PID $PID)"
echo "Log: $LOG_FILE"
echo "PID file: $PID_FILE"
echo "Listen: $LISTEN"
echo "App: $APP_PATH"
echo "App-server: $APP_SERVER_PATH"
echo "Yolo: $YOLO"
