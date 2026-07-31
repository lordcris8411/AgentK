#!/usr/bin/env bash
# Cross-platform launcher for the bundled weather script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${AGENT_K_NODE_EXECUTABLE:-}" ]]; then
    ELECTRON_RUN_AS_NODE=1 "$AGENT_K_NODE_EXECUTABLE" "$SCRIPT_DIR/weather.mjs" "$@"
elif command -v node >/dev/null 2>&1; then
    node "$SCRIPT_DIR/weather.mjs" "$@"
else
    echo "Error: Agent K's JavaScript runtime is unavailable." >&2
    exit 1
fi
