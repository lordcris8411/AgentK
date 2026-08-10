# Agent K Skill and extension evaluation

The opt-in evaluation suite measures Agent K theme, Skill, Editor, and language-extension authoring and invocation. Its fixed catalog contains 82 logical cases:

| Category | Cases |
| --- | ---: |
| Theme development | 10 |
| Ordinary Skill development | 10 |
| Editor development | 10 |
| C# and TypeScript/JavaScript language development | 2 |
| Ordinary Skill invocation | 10 |
| Editor invocation | 10 |
| C#, TypeScript/JavaScript, and C++ language invocation | 30 |

A logical case passes only when its Windows and Linux results both pass. C++, C#, and TypeScript/JavaScript all use the same Pi-callable `agent_k` language capability; Editor-to-LSP calls and Pi-initiated structured actions are scored through that common route.

Ordinary Skill development prompts publish the required operation name, input/output JSON shapes, and one public example. Validation uses different hidden data plus invalid cases. This measures whether Agent K implements and documents a user-visible contract, rather than whether it guesses an undisclosed schema.

Editor development prompts likewise publish the format/action semantics and a before/after example while replay uses different file content. Replay waits for the isolated workspace to be ready, discovers the built package through the production project-Skill path, opens the matching file, checks the exact action result, switches themes, saves, and compares disk content. Static validation also runs the generated package's behavior tests.

## Deterministic commands

List the complete catalog or prepare a run manifest:

```text
npm run eval:agent-k-skills -- list
npm run eval:agent-k-skills -- prepare --output .agent-k-evaluation
```

Validate artifacts and evidence on each platform, then merge the results:

```text
npm run eval:agent-k-skills -- validate --platform win32 --artifact-root .agent-k-evaluation/artifacts --evidence-root .agent-k-evaluation/evidence --output .agent-k-evaluation/results-win32.json
npm run eval:agent-k-skills -- validate --platform linux --artifact-root .agent-k-evaluation/artifacts --evidence-root .agent-k-evaluation/evidence --output .agent-k-evaluation/results-linux.json
npm run eval:agent-k-skills -- merge --inputs .agent-k-evaluation/results-win32.json,.agent-k-evaluation/results-linux.json --output .agent-k-evaluation/report
```

Use `--category`, `--case`, or `--phase development|invocation` to narrow a run. `materialize` copies generated Editor and language packages into a clean checkout so the normal Agent K checks can compile the exact same artifacts on Windows and Linux.

## Live runs

Live evaluation is deliberately separate from `npm test` because it consumes model tokens and may download pinned language tools. For a local run, set `AGENT_K_EVAL_CLIENT_SETTINGS_PATH`, `AGENT_K_EVAL_AUTH_PATH`, `AGENT_K_EVAL_MODELS_PATH`, and `AGENT_K_EVAL_PI_SETTINGS_PATH` to the configuration files required by the selected provider. Then run:

```text
npm run eval:agent-k-skills:live -- --case theme-01 --output .agent-k-evaluation
```

Set `AGENT_K_EVAL_ALLOW_DOWNLOADS=1` to approve the language workers' pinned, checksum-verified private toolchains. Every case uses an isolated HOME, Agent K user-data directory, Pi session, and clean checkout. Generated files are extracted into `.agent-k-evaluation/artifacts`; prompts, events, messages, model state, usage statistics, logs, and screenshots are stored under `.agent-k-evaluation/evidence` and `.agent-k-evaluation/runs`.

Each autonomous model run has a fixed 15-minute settlement limit inside a 20-minute Playwright case limit. A run that is still working at that boundary is recorded as a timeout failure with its complete session and Playwright traces; it is not retried with hints.

After Windows authoring, run `npm run eval:agent-k-skills:replay -- --output .agent-k-evaluation` on both platforms. Replay imports and activates every generated theme, discovers every generated Skill, opens/actions/saves every generated Editor, and exercises load/list/status/unload/shutdown for both language packages. Development validation fails when platform-specific replay evidence or its screenshot is absent.

Language invocation opens the fixture in the real text Editor and sends every semantic request from the sandboxed Editor frame through the renderer language host and extension worker. The Editor renders an observable completion or error result, and evidence records that UI state. The evaluator also compares the source tree before and after each call; new build, package, runtime, or index cache directories in the project fail the case. `inventory-cache` writes a SHA-256 inventory of downloaded archives, lockfiles, and toolchain markers for each platform.

The `Agent K Skill Evaluation` workflow performs Windows authoring, reuses those artifacts on `ubuntu-latest` under Xvfb, runs invocation cases on both systems, and uploads the merged Markdown and JSON report. Configure these repository secrets before dispatching it:

- `AGENT_K_EVAL_CLIENT_SETTINGS_JSON`
- `AGENT_K_EVAL_AUTH_JSON`
- `AGENT_K_EVAL_MODELS_JSON`
- `AGENT_K_EVAL_PI_SETTINGS_JSON`

The workflow validates each JSON secret and writes it with private permissions under `RUNNER_TEMP`; only the resulting file paths are exported to Agent K. It can be started manually with `workflow_dispatch`. Pushes to an isolated `agent-k-evaluation/**` branch also start the complete run with pinned tool downloads approved, allowing a new workflow to be verified before it reaches the default branch.

The normal CI runs deterministic checks on both `ubuntu-latest` and `windows-latest`; it never invokes a paid model.
