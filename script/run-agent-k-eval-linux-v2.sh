#!/usr/bin/env bash
set -euo pipefail

phase=${1:?phase required}
case_id=${2:-}
source_root=/home/cris/agent-k-eval-src-sol-medium
output_root=/home/cris/agent-k-eval-output-sol-medium-v2
export PATH=/home/cris/.cache/agent-k-eval-host/node-v24.18.1/bin:/home/cris/.cache/agent-k-eval-host/pi-runtime/bin:/usr/bin:/bin
export AGENT_K_EVAL_CLIENT_SETTINGS_PATH=/mnt/c/Users/cris/Documents/pi-agent/pi/.agent-k-smoke/sol-medium-config/client-settings.json
export AGENT_K_EVAL_AUTH_PATH=/mnt/c/Users/cris/.pi/agent/auth.json
export AGENT_K_EVAL_MODELS_PATH=/mnt/c/Users/cris/.pi/agent/models.json
export AGENT_K_EVAL_PI_SETTINGS_PATH=/mnt/c/Users/cris/Documents/pi-agent/pi/.agent-k-smoke/sol-medium-config/settings.json
export AGENT_K_EVAL_ALLOW_DOWNLOADS=1
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export http_proxy=$HTTP_PROXY
export https_proxy=$HTTPS_PROXY
export NODE_USE_ENV_PROXY=1

cd "$source_root"
case_args=()
if [[ -n "$case_id" ]]; then case_args=(--case "$case_id"); fi
case "$phase" in
  replay) xvfb-run -a node script/agent-k-skill-eval.mjs run-replay --output "$output_root" "${case_args[@]}" ;;
  invocation) xvfb-run -a node script/agent-k-skill-eval.mjs run-live --phase invocation --output "$output_root" "${case_args[@]}" ;;
  *) echo "unknown phase: $phase" >&2; exit 2 ;;
esac
