#!/bin/bash
# gdb-core.sh - Analyze a core dump
# Usage: gdb-core.sh <binary> <core-file>

set -e

BINARY="$1"
CORE="$2"

if [ -z "$BINARY" ] || [ -z "$CORE" ]; then
    echo "Usage: $0 <binary> <core-file>"
    exit 1
fi

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary '$BINARY' not found"
    exit 1
fi

if [ ! -f "$CORE" ]; then
    echo "Error: Core file '$CORE' not found"
    exit 1
fi

echo "=== Core Dump Analysis ==="
echo "Binary: $BINARY"
echo "Core: $CORE"
echo "Time: $(date)"
echo "========================="
echo ""

gdb -batch \
    -ex "set pagination off" \
    -ex "set print pretty on" \
    -ex "core-file $CORE" \
    -ex "info signals" \
    -ex "info registers" \
    -ex "bt full" \
    -ex "info threads" \
    -ex "thread apply all bt" \
    -ex "list" \
    -ex "info locals" \
    -ex "info args" \
    "$BINARY" 2>&1
