#!/usr/bin/env bash
set -euo pipefail

windows=/mnt/c/Users/cris/Documents/pi-agent/pi
source_root=/home/cris/agent-k-eval-src-sol-medium
output_root=/home/cris/agent-k-eval-output-sol-medium-v2

cd "$windows"
paths=(
  agent-k-permissions.ts
  .github/workflows/ci.yml .gitignore docs/language-pack.md
  editor/extensions/text/editor.css editor/extensions/text/editor.ts editor/sdk/index.ts
  electron/agent/rpc.ts electron/resources.test.mjs electron/resources.ts package.json
  skills/create-agent-k-extensions/SKILL.md src/components/layout/InspectorPanel.tsx
  test/agentKSkillBridge.test.ts test/cppProjectOverview.test.mjs
  .github/workflows/agent-k-skill-evaluation.yml docs/agent-k-skill-evaluation.md evaluation
  playwright.skill-eval.config.ts script/agent-k-skill-eval.mjs
  script/continue-agent-k-evaluation.ps1 script/prepare-agent-k-eval-secrets.mjs
  skills/create-pi-skill src/features/extensions/projectMarkers.ts
  src/features/extensions/ExtensionUiContext.tsx src/features/file-formats/PluginEditorFrame.tsx
  test/agentKSkillEvaluation.test.mjs test/e2e/agent-k-skill-eval.spec.mjs test/projectMarkers.test.ts
)
for path in "${paths[@]}"; do cp -a --parents "$path" "$source_root/"; done

mkdir -p "$output_root/artifacts" "$output_root/fixtures"
cp -a "$windows/.agent-k-evaluation-sol-medium-v2/artifacts/." "$output_root/artifacts/"
cp -a "$windows/.agent-k-evaluation-sol-medium-v2/fixtures/." "$output_root/fixtures/"
cp "$windows/.agent-k-evaluation-sol-medium-v2/manifest.json" "$output_root/manifest.json"
echo sync-complete
