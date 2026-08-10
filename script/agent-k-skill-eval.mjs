import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allCases, categories } from "../evaluation/agent-k/specs.mjs";
import { mergeResultFiles } from "../evaluation/agent-k/report.mjs";
import { listFiles, summarizeCase, validateEditor, validateInvocationEvidence, validateLanguage, validateSkill, validateTheme } from "../evaluation/agent-k/validators.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function selectedCases() {
  const category = option("category");
  const id = option("case");
  const phase = option("phase");
  if (category && !categories[category]) throw new Error(`Unknown category: ${category}`);
  if (phase && !["development", "invocation"].includes(phase)) throw new Error("--phase must be development or invocation");
  return (category ? categories[category] : allCases).filter((item) => (!id || item.id === id) && (!phase || item.category.endsWith(`-${phase}`)));
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() || result.stderr.trim() : "unavailable";
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listCommand() {
  const output = { schemaVersion: 1, total: allCases.length, categories: Object.fromEntries(Object.entries(categories).map(([name, cases]) => [name, cases.map(({ id, prompt, expected }) => ({ id, prompt, expected }))])) };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function prepareCommand() {
  const output = resolve(option("output", join(repository, ".agent-k-evaluation")));
  const fixtures = resolve(repository, "evaluation", "agent-k", "fixtures");
  await mkdir(join(output, "artifacts"), { recursive: true });
  await cp(fixtures, join(output, "fixtures"), { recursive: true, force: true });
  const commit = commandVersion("git", ["rev-parse", "HEAD"]);
  let piVersion = "unavailable";
  try {
    const piPackage = JSON.parse(await readFile(join(repository, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
    if (typeof piPackage.version === "string") piVersion = piPackage.version;
  } catch { /* The dependency may not be installed when only listing cases. */ }
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    repository,
    commit,
    piVersion,
    limits: { agentSettlementMs: { default: 15 * 60_000, languageDevelopment: 30 * 60_000 }, caseMs: 40 * 60_000 },
    platforms: ["win32", "linux"],
    cases: selectedCases(),
  };
  await writeJson(join(output, "manifest.json"), manifest);
  process.stdout.write(`${join(output, "manifest.json")}\n`);
}

async function validateCommand() {
  const artifactRoot = resolve(option("artifact-root", join(repository, ".agent-k-evaluation", "artifacts")));
  const evidenceRoot = resolve(option("evidence-root", join(repository, ".agent-k-evaluation", "evidence")));
  const platform = option("platform", process.platform);
  if (!["win32", "linux"].includes(platform)) throw new Error("--platform must be win32 or linux");
  const template = JSON.parse(await readFile(join(repository, "skills", "create-agent-k-theme", "assets", "theme.template.json"), "utf8"));
  let runManifest = {};
  try { runManifest = JSON.parse(await readFile(join(dirname(artifactRoot), "manifest.json"), "utf8")); } catch { /* Optional for focused validation. */ }
  const results = [];
  for (const specification of selectedCases()) {
    const caseRoot = join(artifactRoot, specification.id);
    let recordedEvidence;
    let checks;
    if (specification.category === "theme-development") checks = await validateTheme(caseRoot, specification, template);
    else if (specification.category === "skill-development") checks = await validateSkill(caseRoot, specification);
    else if (specification.category === "editor-development") checks = await validateEditor(caseRoot, specification);
    else if (specification.category === "language-development") checks = await validateLanguage(caseRoot, specification);
    else {
      const platformPath = join(evidenceRoot, specification.id, `evidence-${platform}.json`);
      const legacyPath = join(evidenceRoot, specification.id, "evidence.json");
      let evidencePath = platformPath;
      try { await readFile(evidencePath, "utf8"); } catch { evidencePath = legacyPath; }
      try {
        recordedEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
        checks = recordedEvidence?.passed === false && recordedEvidence.failure
          ? [{ name: "invocation completed successfully", passed: false, detail: recordedEvidence.failure.message ?? JSON.stringify(recordedEvidence.failure) }]
          : validateInvocationEvidence(specification, recordedEvidence);
      } catch (cause) {
        const playwrightReport = join(dirname(artifactRoot), "runs", `${specification.id}-${platform}`, "playwright-results.json");
        let detail = `${evidencePath}: ${String(cause)}`;
        try {
          const source = await readFile(playwrightReport, "utf8");
          const failure = /(?:TimeoutError|Error):[^"\r\n]*/u.exec(source)?.[0];
          if (failure) detail = `${failure} (${playwrightReport})`;
        } catch { /* The missing evidence path remains the primary detail. */ }
        checks = [{ name: "evidence exists and is valid JSON", passed: false, detail }];
      }
    }
    if (specification.category.endsWith("-development")) {
      const replayPath = join(evidenceRoot, specification.id, `replay-${platform}.json`);
      try {
        const replay = JSON.parse(await readFile(replayPath, "utf8"));
        checks.push({ name: "artifact was installed and exercised in Agent K", passed: replay.passed === true, detail: replayPath });
      } catch (cause) {
        checks.push({ name: "artifact was installed and exercised in Agent K", passed: false, detail: `${replayPath}: ${String(cause)}` });
      }
    }
    if (!recordedEvidence) {
      try { recordedEvidence = JSON.parse(await readFile(join(evidenceRoot, specification.id, `evidence-${platform}.json`), "utf8")); } catch { /* Replayed Linux development has no model session. */ }
    }
    if (platform === "win32" && specification.category.endsWith("-development") && !recordedEvidence) {
      const playwrightReport = join(dirname(artifactRoot), "runs", `${specification.id}-${platform}`, "playwright-results.json");
      let detail = playwrightReport;
      try {
        const source = await readFile(playwrightReport, "utf8");
        const timeout = /TimeoutError:[^"\r\n]*/u.exec(source)?.[0];
        if (timeout) detail = `${timeout} (${playwrightReport})`;
      } catch { /* The missing evidence path remains the primary detail. */ }
      checks.push({ name: "development session completed and produced evidence", passed: false, detail });
    }
    if (platform === "win32" && specification.category.endsWith("-development") && recordedEvidence?.passed === false) {
      checks.push({
        name: "development session completed and produced evidence",
        passed: false,
        detail: recordedEvidence.failure?.message ?? JSON.stringify(recordedEvidence.failure ?? "development failed"),
      });
    }
    const started = Date.parse(recordedEvidence?.startedAt ?? ""); const finished = Date.parse(recordedEvidence?.finishedAt ?? "");
    const model = recordedEvidence?.state?.model;
    results.push(summarizeCase(specification, platform, checks, {
      evaluatedAt: new Date().toISOString(),
      run: {
        commit: runManifest.commit ?? "unavailable",
        piVersion: runManifest.piVersion ?? "unavailable",
        ...(Number.isFinite(started) && Number.isFinite(finished) ? { durationMs: Math.max(0, finished - started) } : {}),
        ...(model && typeof model === "object" ? { model: model.id ?? model.model, provider: model.provider } : {}),
        ...(typeof recordedEvidence?.state?.thinkingLevel === "string" ? { thinkingLevel: recordedEvidence.state.thinkingLevel } : {}),
        ...(recordedEvidence?.stats?.tokens ? { tokens: recordedEvidence.stats.tokens } : {}),
      },
    }));
  }
  const output = resolve(option("output", join(repository, ".agent-k-evaluation", `results-${platform}.json`)));
  await writeJson(output, { schemaVersion: 1, platform, results });
  process.stdout.write(`${output}\n`);
  if (results.some((item) => !item.passed)) process.exitCode = 1;
}

async function mergeCommand() {
  const inputs = option("inputs");
  if (!inputs) throw new Error("merge requires --inputs <comma-separated-result-files>");
  const report = await mergeResultFiles(inputs.split(",").map((item) => item.trim()).filter(Boolean), option("output", join(repository, ".agent-k-evaluation", "report")));
  process.stdout.write(`${report.success ? "PASS" : "FAIL"}\n`);
  if (!report.success) process.exitCode = 1;
}

async function materializeCommand() {
  const artifactRoot = resolve(option("artifact-root", join(repository, ".agent-k-evaluation", "artifacts")));
  const target = resolve(option("target", repository));
  let copied = 0;
  for (const specification of allCases.filter((item) => ["editor-development", "language-development"].includes(item.category))) {
    const source = join(artifactRoot, specification.id, specification.artifact);
    try { await readFile(join(source, specification.category === "editor-development" ? "editor.json" : "agent-k.language-pack.json"), "utf8"); }
    catch { continue; }
    const destination = join(target, specification.artifact);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
    copied += 1;
  }
  process.stdout.write(`Materialized ${copied} generated extension packages into ${target}\n`);
  if (!copied) throw new Error("No generated Editor or language extension artifacts were found");
}

async function inventoryCacheCommand() {
  const root = resolve(option("root", join(repository, ".agent-k-evaluation", "cache", process.platform)));
  const output = resolve(option("output", join(repository, ".agent-k-evaluation", `toolchain-hashes-${process.platform}.json`)));
  const candidates = (await listFiles(root)).filter((path) => /(?:^|\/)(?:SHASUMS[^/]*|package-lock\.json|[^/]*(?:marker|manifest)[^/]*)$|\.(?:zip|tgz|tar\.gz|tar\.xz|tar\.bz2)$/iu.test(path));
  const files = [];
  for (const path of candidates) {
    const content = await readFile(join(root, path));
    files.push({ bytes: content.length, path, sha256: createHash("sha256").update(content).digest("hex") });
  }
  await writeJson(output, { schemaVersion: 1, generatedAt: new Date().toISOString(), root, files });
  process.stdout.write(`${output}\n`);
}

async function liveCommand() {
  const output = resolve(option("output", join(repository, ".agent-k-evaluation")));
  const artifactRoot = resolve(option("artifact-root", join(output, "artifacts")));
  const playwright = join(repository, "node_modules", "@playwright", "test", "cli.js");
  const cases = selectedCases();
  const resume = option("resume", "0") === "1";
  if (!cases.length && option("case")) { process.stdout.write("Selected case is outside the requested phase; nothing to run.\n"); return; }
  if (!cases.length) throw new Error("No evaluation cases matched the selection");
  const failures = [];
  for (const specification of cases) {
    const attemptPath = join(output, "attempts", `${specification.id}-${process.platform}.json`);
    if (resume) {
      try {
        const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
        process.stdout.write(`\n[agent-k-eval] ${specification.id} already attempted on ${process.platform} (${attempt.status ?? "recorded"})\n`);
        continue;
      } catch { /* Run cases without an attempt record. */ }
      const evidence = join(output, "evidence", specification.id, `evidence-${process.platform}.json`);
      const artifactManifest = join(artifactRoot, specification.id, "artifact-manifest.json");
      try {
        await readFile(evidence, "utf8");
        if (!specification.category.endsWith("-development")) {
          process.stdout.write(`\n[agent-k-eval] ${specification.id} already completed on ${process.platform}\n`);
          continue;
        }
        await readFile(artifactManifest, "utf8");
        process.stdout.write(`\n[agent-k-eval] ${specification.id} already completed on ${process.platform}\n`);
        continue;
      } catch { /* Run incomplete cases. */ }
    }
    process.stdout.write(`\n[agent-k-eval] ${specification.id} (${specification.category})\n`);
    const startedAt = new Date().toISOString();
    await writeJson(attemptPath, { schemaVersion: 1, caseId: specification.id, category: specification.category, platform: process.platform, startedAt, status: "running" });
    const result = spawnSync(process.execPath, [playwright, "test", "--config", "playwright.skill-eval.config.ts"], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, AGENT_K_EVAL_LIVE: "1", AGENT_K_EVAL_CASE_ID: specification.id, AGENT_K_EVAL_OUTPUT: output, AGENT_K_EVAL_ARTIFACT_ROOT: artifactRoot, AGENT_K_EVAL_PLAYWRIGHT_REPORT: join(output, "runs", `${specification.id}-${process.platform}`, "playwright-results.json") },
      maxBuffer: 16 * 1024 * 1024,
      stdio: "inherit",
    });
    await writeJson(attemptPath, { schemaVersion: 1, caseId: specification.id, category: specification.category, platform: process.platform, startedAt, finishedAt: new Date().toISOString(), status: result.status === 0 ? "completed" : "failed", exitCode: result.status });
    if (result.status !== 0) failures.push(specification.id);
  }
  if (failures.length) throw new Error(`Live evaluation failed for ${failures.length} case(s): ${failures.join(", ")}`);
}

async function replayCommand() {
  const output = resolve(option("output", join(repository, ".agent-k-evaluation")));
  const artifactRoot = resolve(option("artifact-root", join(output, "artifacts")));
  const playwright = join(repository, "node_modules", "@playwright", "test", "cli.js");
  const cases = selectedCases().filter((item) => item.category.endsWith("-development"));
  if (!cases.length) throw new Error("No development cases matched the replay selection");
  const failures = [];
  for (const specification of cases) {
    const replayEvidence = join(output, "evidence", specification.id, `replay-${process.platform}.json`);
    if (option("resume", "0") === "1") {
      try { await readFile(replayEvidence, "utf8"); process.stdout.write(`\n[agent-k-replay] ${specification.id} already completed on ${process.platform}\n`); continue; }
      catch { /* Replay incomplete cases. */ }
    }
    process.stdout.write(`\n[agent-k-replay] ${specification.id} (${specification.category})\n`);
    const result = spawnSync(process.execPath, [playwright, "test", "--config", "playwright.skill-eval.config.ts"], {
      cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: "inherit",
      env: { ...process.env, AGENT_K_EVAL_REPLAY: "1", AGENT_K_EVAL_CASE_ID: specification.id, AGENT_K_EVAL_OUTPUT: output, AGENT_K_EVAL_ARTIFACT_ROOT: artifactRoot, AGENT_K_EVAL_PLAYWRIGHT_REPORT: join(output, "runs", `replay-${specification.id}-${process.platform}`, "playwright-results.json") },
    });
    if (result.status !== 0) failures.push(specification.id);
  }
  if (failures.length) throw new Error(`Artifact replay failed for ${failures.length} case(s): ${failures.join(", ")}`);
}

const command = process.argv[2] ?? "list";
try {
  if (command === "list") await listCommand();
  else if (command === "prepare") await prepareCommand();
  else if (command === "validate") await validateCommand();
  else if (command === "merge") await mergeCommand();
  else if (command === "materialize") await materializeCommand();
  else if (command === "inventory-cache") await inventoryCacheCommand();
  else if (command === "run-live") await liveCommand();
  else if (command === "run-replay") await replayCommand();
  else throw new Error(`Unknown command: ${command}`);
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
