#!/bin/bash
# gdb-run.sh - Launch GDB and run a binary, outputting crash info
# Usage: gdb-run.sh <binary> [args...]

set -e

BINARY="$1"
shift || true

if [ -z "$BINARY" ]; then
    echo "Usage: $0 <binary> [args...]"
    exit 1
fi

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary '$BINARY' not found"
    exit 1
fi

# Check for debug symbols
if ! nm "$BINARY" 2>/dev/null | grep -q '.debug_'; then
    echo "Warning: '$BINARY' may lack debug symbols. Recompile with -g -O0"
fi

echo "=== GDB Run Report ==="
echo "Binary: $BINARY"
echo "Args: $*"
echo "Time: $(date)"
echo "====================="
echo ""

# Run GDB non-interactively, capture crash info
gdb -batch \
    -ex "set pagination off" \
    -ex "set print pretty on" \
    -ex "run $*" \
    -ex "info registers" \
    -ex "bt full" \
    -ex "info threads" \
    -ex "thread apply all bt" \
    "$BINARY" 2>&1
