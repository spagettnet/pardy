#!/usr/bin/env bash
# Boot the full Pardy stack: local Kokoro TTS + faster-whisper STT
# (vendored Python services in this repo) plus the pardy dev server.
# Ctrl-C kills all three.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

if ! command -v uv >/dev/null 2>&1; then
  echo "[start] uv not found. Install via: brew install uv"
  echo "[start]   or: curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi

PIDS=()

cleanup() {
  echo ""
  echo "[start] shutting down…"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${PIDS[@]}"; do
    pkill -P "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

start_one() {
  local name="$1"; shift
  local logfile="$LOG_DIR/$name.log"
  echo "[start] starting $name → $logfile"
  ( "$@" ) >"$logfile" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  echo "[start]   pid=$pid"
}

start_one tts bash -c "cd '$ROOT' && pnpm tts:start"
start_one stt bash -c "cd '$ROOT' && pnpm stt:start"

# Wait for both voice services to come up before starting pardy so the first
# clue read doesn't fail. Cold start can take a while because Kokoro and
# faster-whisper download model weights on first run.
echo "[start] waiting for voice services (first run downloads models)…"
for i in $(seq 1 180); do
  tts_ok=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo 0)
  stt_ok=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:8001/health 2>/dev/null || echo 0)
  if [ "$tts_ok" = "200" ] && [ "$stt_ok" = "200" ]; then
    echo "[start] voice services ready"
    break
  fi
  sleep 1
  if [ "$i" = "180" ]; then
    echo "[start] WARNING: voice services not ready after 3 min; starting pardy anyway"
  fi
done

start_one pardy bash -c "cd '$ROOT' && pnpm dev"

echo ""
echo "[start] all services up. open https://localhost:${PORT:-3030}/host"
echo "[start] logs:   tail -f $LOG_DIR/{tts,stt,pardy}.log"
echo "[start] Ctrl-C to stop everything."
echo ""

wait
