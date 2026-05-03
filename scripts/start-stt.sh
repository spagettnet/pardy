#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

if [ ! -d ".venv" ]; then
  uv sync
fi

exec uv run python stt_server.py
