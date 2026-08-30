#!/usr/bin/env bash
# Starts the show server and opens the launcher page.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (any version 16 or newer)."
  exit 1
fi

PORT="${PORT:-8080}"
URL="http://localhost:$PORT"

( sleep 1
  if   command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v open     >/dev/null 2>&1; then open "$URL"
  fi ) >/dev/null 2>&1 &

exec node server.js --port "$PORT"
