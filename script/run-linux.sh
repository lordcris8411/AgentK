#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm was not found. Install Node.js 22.19 or newer." >&2
  exit 1
fi

if [[ ! -x node_modules/.bin/electron || ! -f node_modules/node-pty/package.json ]]; then
  echo "Installing npm dependencies..."
  npm ci --ignore-scripts
fi

if [[ ! -x node_modules/electron/dist/electron ]]; then
  echo "Installing the reviewed Electron runtime..."
  node node_modules/electron/install.js
fi

echo "Starting Agent K in Electron development mode..."
exec npm run dev -- "$@"
