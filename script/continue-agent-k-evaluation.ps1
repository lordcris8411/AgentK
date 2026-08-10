param([int]$WindowsAuthoringProcessId = 0)

$ErrorActionPreference = "Continue"
$repository = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$evaluation = Join-Path $repository ".agent-k-evaluation"
$log = Join-Path $evaluation "orchestrator.log"

function Mark([string]$message) {
  "$(Get-Date -Format o) $message" | Add-Content -LiteralPath $log
}

function Run([string]$name, [scriptblock]$action) {
  Mark "START $name"
  & $action *>> $log
  Mark "END $name exit=$LASTEXITCODE"
}

if ($WindowsAuthoringProcessId -gt 0) {
  Mark "waiting for Windows authoring PID $WindowsAuthoringProcessId"
  Wait-Process -Id $WindowsAuthoringProcessId -ErrorAction SilentlyContinue
}

Set-Location $repository
$env:AGENT_K_EVAL_CLIENT_SETTINGS_PATH = Join-Path $env:APPDATA "com.lordcris8411.agentk/client-settings.json"
$env:AGENT_K_EVAL_AUTH_PATH = Join-Path $env:USERPROFILE ".pi/agent/auth.json"
$env:AGENT_K_EVAL_MODELS_PATH = Join-Path $env:USERPROFILE ".pi/agent/models.json"
$env:AGENT_K_EVAL_PI_SETTINGS_PATH = Join-Path $env:USERPROFILE ".pi/agent/settings.json"
$env:AGENT_K_EVAL_ALLOW_DOWNLOADS = "1"

Run "Windows pre-agent infrastructure retry cpp-call-10" {
  $failedReport = Join-Path $evaluation "runs/cpp-call-10-win32/playwright-results.json"
  if (Test-Path -LiteralPath $failedReport) {
    Copy-Item -LiteralPath $failedReport -Destination (Join-Path $evaluation "runs/cpp-call-10-win32/playwright-results-pre-agent-failure.json") -Force
  }
  node script/agent-k-skill-eval.mjs run-live --case cpp-call-10 --output .agent-k-evaluation
}
Run "Windows artifact replay" { node script/agent-k-skill-eval.mjs run-replay --resume 1 --output .agent-k-evaluation }
Run "Windows validation" { node script/agent-k-skill-eval.mjs validate --platform win32 --artifact-root .agent-k-evaluation/artifacts --evidence-root .agent-k-evaluation/evidence --output .agent-k-evaluation/results-win32.json }
Run "Windows generated artifact build and tests" {
  $target = Join-Path $evaluation "platform-build-win32"
  if (Test-Path -LiteralPath $target) {
    $resolvedTarget = (Resolve-Path -LiteralPath $target).Path
    if ($resolvedTarget.StartsWith($evaluation, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedTarget -Leaf) -eq "platform-build-win32") {
      Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
  }
  git clone --local --no-checkout $repository $target
  git -C $target checkout --detach HEAD
  New-Item -ItemType Junction -Path (Join-Path $target "node_modules") -Target (Join-Path $repository "node_modules") | Out-Null
  node script/agent-k-skill-eval.mjs materialize --artifact-root .agent-k-evaluation/artifacts --target $target
  Push-Location $target
  npm run check
  npm test
  npm run build
  Pop-Location
}
Run "Windows toolchain hash inventory" { node script/agent-k-skill-eval.mjs inventory-cache --root .agent-k-evaluation/cache/win32 --output .agent-k-evaluation/toolchain-hashes-win32.json }
Run "copy artifacts to Linux" { wsl -d Ubuntu-24.04 -- bash -lc "mkdir -p /home/cris/agent-k-eval-output/artifacts && cp -a /mnt/c/Users/cris/Documents/pi-agent/pi/.agent-k-evaluation/artifacts/. /home/cris/agent-k-eval-output/artifacts/" }

$linuxEnvironment = "PATH=/home/cris/.cache/agent-k-eval-host/node-v24.18.1/bin:/home/cris/.cache/agent-k-eval-host/pi-runtime/bin:/usr/bin:/bin HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 AGENT_K_EVAL_CLIENT_SETTINGS_PATH=/mnt/c/Users/cris/AppData/Roaming/com.lordcris8411.agentk/client-settings.json AGENT_K_EVAL_AUTH_PATH=/mnt/c/Users/cris/.pi/agent/auth.json AGENT_K_EVAL_MODELS_PATH=/mnt/c/Users/cris/.pi/agent/models.json AGENT_K_EVAL_PI_SETTINGS_PATH=/mnt/c/Users/cris/.pi/agent/settings.json AGENT_K_EVAL_ALLOW_DOWNLOADS=1"
Run "Linux invocation suite" { wsl -d Ubuntu-24.04 -- bash -lc "cd /home/cris/agent-k-eval-src && xvfb-run -a env $linuxEnvironment node script/agent-k-skill-eval.mjs run-live --resume 1 --phase invocation --output /home/cris/agent-k-eval-output" }
Run "Linux artifact replay" { wsl -d Ubuntu-24.04 -- bash -lc "cd /home/cris/agent-k-eval-src && xvfb-run -a env $linuxEnvironment node script/agent-k-skill-eval.mjs run-replay --resume 1 --output /home/cris/agent-k-eval-output" }
Run "Linux generated artifact build and tests" { wsl -d Ubuntu-24.04 -- bash -lc "cd /home/cris/agent-k-eval-src && env PATH=/home/cris/.cache/agent-k-eval-host/node-v24.18.1/bin:/usr/bin:/bin node script/agent-k-skill-eval.mjs materialize --artifact-root /home/cris/agent-k-eval-output/artifacts --target /home/cris/agent-k-eval-src && env PATH=/home/cris/.cache/agent-k-eval-host/node-v24.18.1/bin:/usr/bin:/bin npm run check && env PATH=/home/cris/.cache/agent-k-eval-host/node-v24.18.1/bin:/usr/bin:/bin npm test && env PATH=/home/cris/.cache/agent-k-eval-host/node-v24.18.1/bin:/usr/bin:/bin npm run build" }
Run "Linux toolchain hash inventory" { wsl -d Ubuntu-24.04 -- bash -lc "cd /home/cris/agent-k-eval-src && env PATH=/home/cris/.cache/agent-k-eval-host/node-v24.18.1/bin:/usr/bin:/bin node script/agent-k-skill-eval.mjs inventory-cache --root /home/cris/agent-k-eval-output/cache/linux --output /home/cris/agent-k-eval-output/toolchain-hashes-linux.json" }
Run "Linux validation" { wsl -d Ubuntu-24.04 -- bash -lc "cd /home/cris/agent-k-eval-src && env PATH=/home/cris/.cache/agent-k-eval-host/node-v24.18.1/bin:/usr/bin:/bin node script/agent-k-skill-eval.mjs validate --platform linux --artifact-root /home/cris/agent-k-eval-output/artifacts --evidence-root /home/cris/agent-k-eval-output/evidence --output /home/cris/agent-k-eval-output/results-linux.json" }
Run "copy Linux evidence and result" { wsl -d Ubuntu-24.04 -- bash -lc "mkdir -p /mnt/c/Users/cris/Documents/pi-agent/pi/.agent-k-evaluation/evidence && cp -a /home/cris/agent-k-eval-output/evidence/. /mnt/c/Users/cris/Documents/pi-agent/pi/.agent-k-evaluation/evidence/ && cp /home/cris/agent-k-eval-output/results-linux.json /mnt/c/Users/cris/Documents/pi-agent/pi/.agent-k-evaluation/results-linux.json && cp /home/cris/agent-k-eval-output/toolchain-hashes-linux.json /mnt/c/Users/cris/Documents/pi-agent/pi/.agent-k-evaluation/toolchain-hashes-linux.json" }
Run "merge report" { node script/agent-k-skill-eval.mjs merge --inputs .agent-k-evaluation/results-win32.json,.agent-k-evaluation/results-linux.json --output .agent-k-evaluation/report }

@{
  completedAt = Get-Date -Format o
  linux = Test-Path (Join-Path $evaluation "results-linux.json")
  report = Test-Path (Join-Path $evaluation "report/results.json")
  windows = Test-Path (Join-Path $evaluation "results-win32.json")
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evaluation "orchestration-complete.json") -Encoding utf8
Mark "COMPLETE"
