function fail(message) { throw new Error(message); }
function object(value) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("input must be an object"); return value; }
function strings(value, name) { if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) fail(`${name} must be an array of strings`); return value; }

export function execute(operation, raw) {
  const input = object(raw);
  if (operation === "summarize") {
    const keys = new Set(); let valid = 0; let invalid = 0;
    for (const line of strings(input.lines, "lines")) { try { const value = object(JSON.parse(line)); valid += 1; Object.keys(value).forEach((key) => keys.add(key)); } catch { invalid += 1; } }
    return { valid, invalid, uniqueKeys: [...keys].sort() };
  }
  if (operation === "validate") {
    const required = strings(input.required, "required");
    if (!Array.isArray(input.rows)) fail("rows must be an array");
    const missingRows = input.rows.flatMap((row, index) => required.every((key) => row && typeof row === "object" && Object.hasOwn(row, key)) ? [] : [index + 1]);
    return { valid: missingRows.length === 0, missingRows };
  }
  if (operation === "transform") return { slugs: strings(input.values, "values").map((value) => value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "")) };
  if (operation === "convert") {
    if (!Array.isArray(input.values) || !input.values.every(Number.isInteger)) fail("values must be integer Unix seconds");
    return { values: input.values.map((value) => new Date(value * 1000).toISOString()) };
  }
  if (operation === "merge") {
    const result = { ...object(input.base) };
    for (const [key, value] of Object.entries(object(input.override))) { if (value === null) delete result[key]; else if (typeof value === "string") result[key] = value; else fail("map values must be strings or null"); }
    return { result: Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))) };
  }
  if (operation === "sort") {
    const versions = strings(input.versions, "versions");
    if (!versions.every((value) => /^\d+\.\d+\.\d+$/u.test(value))) fail("versions must be stable semantic versions");
    return { versions: [...versions].sort((left, right) => { const a = left.split(".").map(Number); const b = right.split(".").map(Number); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }) };
  }
  if (operation === "map") {
    const from = strings(String(input.from).split("/"), "from"); const to = String(input.to).split("/");
    return { paths: strings(input.paths, "paths").map((value) => { const parts = value.split("/"); return from.every((part, index) => parts[index] === part) ? [...to, ...parts.slice(from.length)].join("/") : value; }) };
  }
  if (operation === "count") {
    if (typeof input.text !== "string") fail("text must be a string");
    const counts = new Map(); for (const token of input.text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { frequencies: Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))) };
  }
  if (operation === "filter") {
    if (!Array.isArray(input.records) || typeof input.field !== "string") fail("records and field are required");
    return { records: input.records.filter((record) => record && typeof record === "object" && record[input.field] === input.value) };
  }
  if (operation === "sum") {
    const factors = { ms: 1, s: 1000, m: 60000, h: 3600000 };
    const totalMilliseconds = strings(input.values, "values").reduce((total, value) => { const match = /^(\d+)(ms|s|m|h)$/u.exec(value); if (!match) fail(`invalid duration: ${value}`); return total + Number(match[1]) * factors[match[2]]; }, 0);
    return { totalMilliseconds };
  }
  fail(`unknown operation: ${operation}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  try { process.stdout.write(`${JSON.stringify(execute(process.argv[2], JSON.parse(process.argv[3] ?? "null")))}\n`); }
  catch (cause) { process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`); process.exitCode = 1; }
}
