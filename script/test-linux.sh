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

if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  # rustup writes this file so non-login shells can load Cargo into PATH.
  source "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: cargo was not found. Install the Rust stable toolchain with rustup." >&2
  exit 1
fi

if ! command -v pkg-config >/dev/null 2>&1 \
  || ! pkg-config --exists webkit2gtk-4.1 dbus-1; then
  cat >&2 <<'EOF'
Error: the Linux libraries required by Tauri were not found.
Install the packages listed in README.md under "前置条件 > Linux", then retry.
EOF
  exit 1
fi

run npm ci --ignore-scripts
run npm run check
run npm test
run npm run build
run cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
run cargo check --manifest-path src-tauri/Cargo.toml
run cargo test --manifest-path src-tauri/Cargo.toml --lib

printf '\nAll AgentK Linux tests passed.\n'
