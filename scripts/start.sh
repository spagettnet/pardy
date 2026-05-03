#!/usr/bin/env bash
# Boot the full Pardy stack: Kokoro TTS + faster-whisper STT (from voice_xw)
# plus the pardy dev server. Ctrl-C kills all three.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VOICE="${VOICE_XW_DIR:-$ROOT/../voice_xw}"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

if [ ! -d "$VOICE" ]; then
  echo "voice_xw not found at $VOICE"
  echo "set VOICE_XW_DIR=/path/to/voice_xw or clone it next to pardy"
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
  # Best-effort: kill any leftover children spawned by pnpm (uvicorn, tsx, etc.)
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

start_one tts bash -c "cd '$VOICE' && pnpm tts:start"
start_one stt bash -c "cd '$VOICE' && pnpm stt:start"

# Wait for both voice services to come up before starting pardy so the first
# clue read doesn't fail.
echo "[start] waiting for voice services…"
for i in $(seq 1 60); do
  tts_ok=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health 2>/dev/null || echo 0)
  stt_ok=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:8001/health 2>/dev/null || echo 0)
  if [ "$tts_ok" = "200" ] && [ "$stt_ok" = "200" ]; then
    echo "[start] voice services ready"
    break
  fi
  sleep 1
  if [ "$i" = "60" ]; then
    echo "[start] WARNING: voice services not ready after 60s; starting pardy anyway"
  fi
done

start_one pardy bash -c "cd '$ROOT' && pnpm dev"

echo ""
echo "[start] all services up. open http://localhost:${PORT:-3030}/host"
echo "[start] logs:   tail -f $LOG_DIR/{tts,stt,pardy}.log"
echo "[start] Ctrl-C to stop everything."
echo ""

wait
