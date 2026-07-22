#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm was not found. Install Node.js 22.19 or newer." >&2
  exit 1
fi

run npm ci --ignore-scripts
run npm run prepare:native
run npm run check
run npm test
run npm run build

printf '\nAll Agent K Linux tests passed.\n'
