#!/bin/bash
# gdb-debug.sh - Automated GDB debugging with common actions
# Usage: gdb-debug.sh <action> <binary> [args...]
# Actions: run, crash-report, vars, threads, trace

set -e

ACTION="$1"
BINARY="$2"
shift 2 || true

if [ -z "$ACTION" ] || [ -z "$BINARY" ]; then
    echo "Usage: $0 <action> <binary> [args...]"
    echo "Actions: run, crash-report, vars, threads, trace"
    exit 1
fi

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary '$BINARY' not found"
    exit 1
fi

case "$ACTION" in
    run)
        # Simple run with backtrace on crash
        gdb -batch \
            -ex "set pagination off" \
            -ex "run $*" \
            -ex "bt" \
            "$BINARY" 2>&1
        ;;
    crash-report)
        # Full crash report with registers and memory
        gdb -batch \
            -ex "set pagination off" \
            -ex "set print pretty on" \
            -ex "run $*" \
            -ex "info registers" \
            -ex "bt full" \
            -ex "info locals" \
            -ex "info args" \
            -ex "x/16xw \$rsp" \
            "$BINARY" 2>&1
        ;;
    vars)
        # Print all variables at a breakpoint (default: main)
        FUNC="${3:-main}"
        gdb -batch \
            -ex "set pagination off" \
            -ex "break $FUNC" \
            -ex "run $*" \
            -ex "info locals" \
            -ex "info args" \
            -ex "list" \
            "$BINARY" 2>&1
        ;;
    threads)
        # Thread analysis
        gdb -batch \
            -ex "set pagination off" \
            -ex "run $*" \
            -ex "info threads" \
            -ex "thread apply all bt" \
            "$BINARY" 2>&1
        ;;
    trace)
        # Function call trace (trace all calls in a function)
        FUNC="${3:-main}"
        gdb -batch \
            -ex "set pagination off" \
            -ex "break $FUNC" \
            -ex "run $*" \
            -ex "set logging on" \
            -ex "step 20" \
            -ex "set logging off" \
            -ex "bt" \
            "$BINARY" 2>&1
        ;;
    *)
        echo "Unknown action: $ACTION"
        echo "Valid actions: run, crash-report, vars, threads, trace"
        exit 1
        ;;
esac
