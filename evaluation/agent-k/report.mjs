import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function mergePlatformResults(results) {
  const grouped = new Map();
  for (const result of results) {
    const key = `${result.category}:${result.caseId}`;
    const entry = grouped.get(key) ?? { caseId: result.caseId, category: result.category, platforms: {} };
    entry.platforms[result.platform] = result;
    grouped.set(key, entry);
  }
  const cases = [...grouped.values()].map((entry) => ({
    ...entry,
    passed: ["win32", "linux"].every((platform) => entry.platforms[platform]?.passed === true),
    missingPlatforms: ["win32", "linux"].filter((platform) => !entry.platforms[platform]),
  })).sort((left, right) => left.category.localeCompare(right.category) || left.caseId.localeCompare(right.caseId));
  const categories = Object.values(Object.groupBy(cases, (item) => item.category)).map((items) => ({
    category: items[0].category,
    passed: items.filter((item) => item.passed).length,
    total: items.length,
    success: items.length > 0 && items.every((item) => item.passed),
    durationMs: items.flatMap((item) => Object.values(item.platforms)).reduce((sum, result) => sum + (result.run?.durationMs ?? 0), 0),
    tokens: items.flatMap((item) => Object.values(item.platforms)).reduce((sum, result) => sum + (result.run?.tokens?.total ?? 0), 0),
  })).sort((left, right) => left.category.localeCompare(right.category));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    success: categories.every((item) => item.success),
    categories,
    cases,
    productGaps: [],
  };
}

export function markdownReport(report) {
  const lines = ["# Agent K Skill and Extension Evaluation", "", `Overall: **${report.success ? "PASS" : "FAIL"}**`, "", "| Capability | Result | Tokens | Duration |", "| --- | --- | ---: | ---: |"];
  for (const category of report.categories) lines.push(`| ${category.category} | ${category.passed}/${category.total} ${category.success ? "PASS" : "FAIL"} | ${category.tokens} | ${(category.durationMs / 1000).toFixed(1)}s |`);
  const runs = report.cases.flatMap((item) => Object.values(item.platforms).map((result) => result.run)).filter(Boolean);
  const values = (key) => [...new Set(runs.map((run) => run[key]).filter(Boolean))].join(", ") || "unavailable";
  lines.push("", "## Run metadata", "", `- Provider: ${values("provider")}`, `- Model: ${values("model")}`, `- Thinking level: ${values("thinkingLevel")}`, `- Pi version: ${values("piVersion")}`, `- Commit: ${values("commit")}`);
  lines.push("", "## Product gaps", "");
  if (!(report.productGaps ?? []).length) lines.push("None.");
  for (const gap of report.productGaps ?? []) lines.push(`- **${gap.id}** (${gap.status}): ${gap.detail}`);
  lines.push("", "## Failed or incomplete cases", "");
  const failed = report.cases.filter((item) => !item.passed);
  if (!failed.length) lines.push("None.");
  for (const item of failed) {
    lines.push(`- **${item.caseId}** (${item.category})`);
    if (item.missingPlatforms.length) lines.push(`  - Missing platforms: ${item.missingPlatforms.join(", ")}`);
    for (const [platform, result] of Object.entries(item.platforms)) {
      for (const check of result.checks.filter((candidate) => !candidate.passed)) lines.push(`  - ${platform}: ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function mergeResultFiles(paths, output) {
  const values = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))));
  const results = values.flatMap((value) => Array.isArray(value) ? value : value.results ?? [value]);
  const report = mergePlatformResults(results);
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, "results.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(resolve(directory, "summary.md"), markdownReport(report), "utf8"),
  ]);
  return report;
}
