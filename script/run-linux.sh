#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm was not found. Install Node.js 22.19 or newer." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  # rustup writes this file so non-login shells can load Cargo into PATH.
  source "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: cargo was not found. Install the Rust stable toolchain with rustup." >&2
  exit 1
fi

if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]] \
  && [[ -e /sys/module/nvidia ]] \
  && command -v nvidia-smi >/dev/null 2>&1 \
  && ! nvidia-smi -L >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Warning: the loaded NVIDIA kernel driver does not match the installed
userspace libraries. AgentK will use WebKitGTK's compatibility renderer for
this session, which is slower. Reboot into the updated kernel before judging
Linux rendering performance.
EOF
fi

if [[ ! -x node_modules/.bin/tauri ]]; then
  echo "Installing npm dependencies..."
  npm ci --ignore-scripts
fi

if ! command -v pkg-config >/dev/null 2>&1 \
  || ! pkg-config --exists webkit2gtk-4.1 dbus-1; then
  PREBUILT_BINARY="src-tauri/target/debug/agent-k"
  if [[ ! -x "$PREBUILT_BINARY" ]]; then
    cat >&2 <<'EOF'
Error: the Linux libraries required by Tauri were not found and no prebuilt
debug executable is available. Install the packages listed in README.md under
"前置条件 > Linux", then retry.
EOF
    exit 1
  fi

  STALE_SOURCE="$({
    find src-tauri/src -type f -newer "$PREBUILT_BINARY" -print
    find src-tauri/capabilities -type f -newer "$PREBUILT_BINARY" -print
    find src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs \
      src-tauri/tauri.conf.json agent-k-permissions.ts \
      -newer "$PREBUILT_BINARY" -print
  } | head -n 1)"
  if [[ -n "$STALE_SOURCE" ]]; then
    cat >&2 <<EOF
Error: the existing Tauri executable is older than $STALE_SOURCE.
Running it with the current frontend would mix incompatible backend and
frontend versions. Rebuild AgentK in a Linux environment with the Tauri
development packages listed in README.md, then retry.
EOF
    exit 1
  fi

  echo "Warning: Tauri development headers are unavailable; using the existing debug executable."
  echo "The executable matches the current Rust and Tauri sources."

  # Start Vite directly so VITE_PID is the server itself. Starting through
  # `npm run` leaves its child alive when this script receives SIGTERM.
  node_modules/.bin/vite --host 127.0.0.1 &
  VITE_PID=$!
  cleanup() {
    kill "$VITE_PID" >/dev/null 2>&1 || true
    wait "$VITE_PID" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  for _ in {1..50}; do
    if curl --silent --fail http://127.0.0.1:1420/ >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "Error: the Vite development server failed to start." >&2
    exit 1
  fi

  export PATH="$PROJECT_ROOT/node_modules/.bin:$PATH"
  "$PREBUILT_BINARY"
  exit $?
fi

echo "Starting AgentK in Linux development mode..."
exec npm run tauri -- dev "$@"
