const commonSkillContract = `Create the Skill inside .pi/skills/<skill-name>. Include a substantive SKILL.md body in addition to YAML frontmatter containing only name and description, scripts/run.mjs, and scripts/run.test.mjs. The runner interface is: node scripts/run.mjs <operation> '<json-input>'. Treat the operation and JSON shapes below as a public API and implement them exactly, including wrapper objects and property names. Document the command, schemas, example, and errors in SKILL.md. Print exactly one JSON value to stdout on success; print errors to stderr and exit non-zero for invalid input. Use only Node.js built-ins and make it work on Windows and Linux. Test the public example plus different valid data and invalid cases, run the tests, and execute the public example through the real runner before finishing.`;

const themeBriefs = [
  ["abyss-blue", "Abyss Blue", "dark", "deep navy application canvas, slightly lighter blue panels, cyan primary actions, and cool blue syntax accents"],
  ["paper-amber", "Paper Amber", "light", "warm paper surfaces, dark brown text, amber actions, and restrained ink-like syntax colors"],
  ["mist-sage", "Mist Sage", "soft-light", "soft gray-green surfaces, forest accents, low-glare panels, and readable muted syntax"],
  ["retro-phosphor", "Retro Phosphor", "dark", "near-black surfaces, green phosphor accents, a distinct terminal palette, and a two-tone green logo"],
  ["high-contrast-night", "High Contrast Night", "dark", "black surfaces, near-white primary text, vivid yellow actions, and strongly separated selection states"],
  ["arctic-violet", "Arctic Violet", "light", "cool white surfaces, violet actions, blue-violet active items, and crisp code syntax"],
  ["ember-forge", "Ember Forge", "dark", "charcoal surfaces, orange-red actions, warm raised panels, and ember syntax accents"],
  ["ocean-glass", "Ocean Glass", "soft-light", "pale aqua application canvas, translucent-looking blue panels expressed with opaque colors, teal actions, and navy text"],
  ["graphite-rose", "Graphite Rose", "dark", "graphite surfaces, rose actions, mauve active items, and a subdued rose logo secondary layer"],
  ["solar-sand", "Solar Sand", "light", "sand-colored surfaces, indigo actions, terracotta status accents, and a warm independent terminal palette"],
];

export const themeDevelopment = themeBriefs.map(([id, name, base, brief], index) => ({
  category: "theme-development",
  id: `theme-${String(index + 1).padStart(2, "0")}`,
  artifact: `.pi/agent/k_themes/${id}.json`,
  expected: { base, themeId: id },
  prompt: `Create an Agent K theme named ${JSON.stringify(name)} with id ${JSON.stringify(id)} and base ${JSON.stringify(base)}. Visual brief: ${brief}. Include a deliberate two-color Agent K logo, complete Monaco UI and terminal palettes, and intentional syntax overrides. Preserve readable text and selection contrast. Save it to the required Agent K custom-theme directory, but do not activate it.`,
}));

const skillDefinitions = [
  { name: "summarize-jsonl", operation: "summarize", description: "Summarize JSON Lines and report valid and invalid counts plus alphabetically sorted unique top-level keys.", inputShape: '{"lines":"string[]"}', outputShape: '{"valid":"number","invalid":"number","uniqueKeys":"string[]"}', example: { input: { lines: ['{"name":"Ada"}', "bad"] }, output: { valid: 1, invalid: 1, uniqueKeys: ["name"] } }, input: { lines: ['{"a":1}', "bad", '{"b":2,"a":3}'] }, output: { valid: 2, invalid: 1, uniqueKeys: ["a", "b"] } },
  { name: "validate-csv-columns", operation: "validate", description: "Validate row objects against required columns and return one-based missing row numbers.", inputShape: '{"rows":"object[]","required":"string[]"}', outputShape: '{"valid":"boolean","missingRows":"number[]"}', example: { input: { rows: [{ id: "1" }, { id: "2", name: "B" }], required: ["id", "name"] }, output: { valid: false, missingRows: [1] } }, input: { rows: [{ a: "1", b: "2" }, { a: "3" }], required: ["a", "b"] }, output: { valid: false, missingRows: [2] } },
  { name: "normalize-slugs", operation: "transform", description: "Normalize values to lowercase ASCII kebab-case, collapse separators, and trim separators.", inputShape: '{"values":"string[]"}', outputShape: '{"slugs":"string[]"}', example: { input: { values: ["Hello There", "Already-Slug"] }, output: { slugs: ["hello-there", "already-slug"] } }, input: { values: [" Hello, World! ", "Agent__K", "two  spaces"] }, output: { slugs: ["hello-world", "agent-k", "two-spaces"] } },
  { name: "convert-timestamps", operation: "convert", description: "Convert integer Unix seconds to UTC ISO-8601 strings in the original order.", inputShape: '{"values":"integer[]"}', outputShape: '{"values":"string[]"}', example: { input: { values: [60] }, output: { values: ["1970-01-01T00:01:00.000Z"] } }, input: { values: [0, 946684800] }, output: { values: ["1970-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"] } },
  { name: "merge-env-maps", operation: "merge", description: "Merge base and override string maps; override wins and null override values delete keys.", inputShape: '{"base":"Record<string,string>","override":"Record<string,string|null>"}', outputShape: '{"result":"Record<string,string> with sorted keys"}', example: { input: { base: { A: "1" }, override: { A: "2", B: "3" } }, output: { result: { A: "2", B: "3" } } }, input: { base: { A: "1", B: "2" }, override: { B: "3", A: null, C: "4" } }, output: { result: { B: "3", C: "4" } } },
  { name: "sort-semver", operation: "sort", description: "Sort valid stable semantic versions numerically ascending and reject invalid versions.", inputShape: '{"versions":"string[]"}', outputShape: '{"versions":"string[]"}', example: { input: { versions: ["1.0.1", "1.0.0"] }, output: { versions: ["1.0.0", "1.0.1"] } }, input: { versions: ["2.0.0", "1.10.0", "1.2.9"] }, output: { versions: ["1.2.9", "1.10.0", "2.0.0"] } },
  { name: "remap-logical-paths", operation: "map", description: "Replace an exact leading segment sequence in slash-separated logical paths.", inputShape: '{"paths":"string[]","from":"string","to":"string"}', outputShape: '{"paths":"string[]"}', example: { input: { paths: ["lib/a.ts", "src/b.ts"], from: "lib", to: "pkg" }, output: { paths: ["pkg/a.ts", "src/b.ts"] } }, input: { paths: ["src/a.ts", "src/lib/b.ts", "test/a.ts"], from: "src", to: "app" }, output: { paths: ["app/a.ts", "app/lib/b.ts", "test/a.ts"] } },
  { name: "count-text-terms", operation: "count", description: "Count case-insensitive Unicode word tokens and return frequencies with sorted keys.", inputShape: '{"text":"string"}', outputShape: '{"frequencies":"Record<string,number> with sorted keys"}', example: { input: { text: "One one TWO" }, output: { frequencies: { one: 2, two: 1 } } }, input: { text: "Agent agent K skill skill skill" }, output: { frequencies: { agent: 2, k: 1, skill: 3 } } },
  { name: "filter-records", operation: "filter", description: "Filter record objects by strict equality of a field and value while preserving order.", inputShape: '{"records":"object[]","field":"string","value":"any JSON value"}', outputShape: '{"records":"object[]"}', example: { input: { records: [{ id: 1, active: true }, { id: 2, active: false }], field: "active", value: true }, output: { records: [{ id: 1, active: true }] } }, input: { records: [{ kind: "a", n: 1 }, { kind: "b", n: 2 }, { kind: "a", n: 3 }], field: "kind", value: "a" }, output: { records: [{ kind: "a", n: 1 }, { kind: "a", n: 3 }] } },
  { name: "sum-durations", operation: "sum", description: "Parse durations containing integer ms, s, m, or h values and return total milliseconds.", inputShape: '{"values":"string[]"}', outputShape: '{"totalMilliseconds":"number"}', example: { input: { values: ["1m", "500ms"] }, output: { totalMilliseconds: 60500 } }, input: { values: ["250ms", "2s", "3m", "1h"] }, output: { totalMilliseconds: 3782250 } },
];

export const skillDevelopment = skillDefinitions.map((definition, index) => ({
  category: "skill-development",
  id: `skill-${String(index + 1).padStart(2, "0")}`,
  artifact: `.pi/skills/${definition.name}`,
  contract: { operation: definition.operation, inputShape: definition.inputShape, outputShape: definition.outputShape, example: definition.example },
  expected: { name: definition.name, operation: definition.operation, input: definition.input, output: definition.output },
  prompt: `Create a reusable Pi Skill named ${definition.name}. ${definition.description}\n\nRequired public runner contract:\n- Operation argument: ${JSON.stringify(definition.operation)}\n- Input JSON shape: ${definition.inputShape}\n- Output JSON shape: ${definition.outputShape}\n- Public example input: ${JSON.stringify(definition.example.input)}\n- Required public example output: ${JSON.stringify(definition.example.output)}\n\n${commonSkillContract}`,
}));

const editorDefinitions = [
  { name: "palette", extension: "pal", action: "sort-colors", actionDescription: "Sort non-empty name=color lines by name, preserving a final newline.", example: { before: "violet=#800080\namber=#ffbf00\n", after: "amber=#ffbf00\nviolet=#800080\n" }, hidden: { before: "zeta=#ffffff\nalpha=#000000\n", after: "alpha=#000000\nzeta=#ffffff\n" } },
  { name: "todo-board", extension: "todoz", action: "complete-item", actionDescription: "Change the first '[ ] label' line to '[x] label' and leave other lines unchanged.", example: { before: "[ ] Draft\n[x] Review\n", after: "[x] Draft\n[x] Review\n" }, hidden: { before: "[ ] verify editor action\n[x] keep completed\n", after: "[x] verify editor action\n[x] keep completed\n" } },
  { name: "outline", extension: "outlinez", action: "promote-heading", actionDescription: "Remove exactly one leading # from the first heading below level one.", example: { before: "# Root\n### Detail\n", after: "# Root\n## Detail\n" }, hidden: { before: "# Root\n## Nested\n", after: "# Root\n# Nested\n" } },
  { name: "timeline", extension: "timelinez", action: "sort-events", actionDescription: "Sort non-empty 'YYYY-MM-DD text' lines chronologically ascending.", example: { before: "2027-05-01 later\n2027-02-01 earlier\n", after: "2027-02-01 earlier\n2027-05-01 later\n" }, hidden: { before: "2026-12-01 launch\n2026-01-01 start\n", after: "2026-01-01 start\n2026-12-01 launch\n" } },
  { name: "key-value", extension: "kvz", action: "sort-keys", actionDescription: "Sort non-empty key=value lines alphabetically by key.", example: { before: "beta=2\nalpha=1\n", after: "alpha=1\nbeta=2\n" }, hidden: { before: "zeta=3\nalpha=1\n", after: "alpha=1\nzeta=3\n" } },
  { name: "bookmark-list", extension: "bookmarkz", action: "deduplicate", actionDescription: "Keep the first occurrence of each non-empty URL and preserve order.", example: { before: "https://b.test\nhttps://a.test\nhttps://b.test\n", after: "https://b.test\nhttps://a.test\n" }, hidden: { before: "https://example.test/a\nhttps://example.test/a\n", after: "https://example.test/a\n" } },
  { name: "inventory", extension: "inventoryz", action: "recount", actionDescription: "Sum non-negative integer quantities in name=value lines and append or replace total=<sum>.", example: { before: "pens=2\nbooks=3\ntotal=0\n", after: "pens=2\nbooks=3\ntotal=5\n" }, hidden: { before: "apples=2\npears=3\n", after: "apples=2\npears=3\ntotal=5\n" } },
  { name: "route-map", extension: "routez", action: "reverse-route", actionDescription: "Reverse the nodes in an arrow-separated route and normalize separators to ' -> '.", example: { before: "north -> east -> south\n", after: "south -> east -> north\n" }, hidden: { before: "start -> middle -> finish\n", after: "finish -> middle -> start\n" } },
  { name: "snippet-book", extension: "snippetz", action: "sort-snippets", actionDescription: "Sort non-empty 'title: body' lines alphabetically by title.", example: { before: "Zulu: last\nAlpha: first\n", after: "Alpha: first\nZulu: last\n" }, hidden: { before: "zeta: last\nalpha: first\n", after: "alpha: first\nzeta: last\n" } },
  { name: "score-card", extension: "scorez", action: "normalize-scores", actionDescription: "Clamp every integer value in name=value lines to the inclusive range 0 through 100.", example: { before: "low=-2\nhigh=108\n", after: "low=0\nhigh=100\n" }, hidden: { before: "low=-5\nhigh=120\n", after: "low=0\nhigh=100\n" } },
];

export const editorDevelopment = editorDefinitions.map(({ name, extension, action, actionDescription, example, hidden }, index) => ({
  category: "editor-development",
  id: `editor-${String(index + 1).padStart(2, "0")}`,
  artifact: `editor/extensions/eval-${name}`,
  expected: { id: `agent-k.eval-${name}`, extension, action, input: hidden.before, output: hidden.after },
  prompt: `Create a first-party Agent K Editor extension in editor/extensions/eval-${name} for *.${extension} files. Use plugin id agent-k.eval-${name}. It must load, edit, save, focus, update dirty state, react to base and complete theme changes, and expose capability ${action}. Public action contract: ${actionDescription} Public before example: ${JSON.stringify(example.before)}. Required after example: ${JSON.stringify(example.after)}. Implement this contract exactly and document the format, capability, and example in SKILL.md. Include editor.json, editor.ts, editor.css, SKILL.md, behavior tests using different data, and the built dist runtime. Use only the Agent K Editor SDK and browser APIs. Run the Editor checks and build before finishing.`,
}));

const isolationContract = `Implement Windows x64 and Linux x64 support. Download only after host confirmation; emit progress and support cancellation. Store archives, tools, package caches, indexes, logs, and build output below the worker-provided Agent K cache directory. Use a staging directory, verify the pinned upstream digest before extraction, and atomically replace a completed toolchain without deleting the previous usable version. Never use a globally installed runtime or write generated data into the opened project. Spawn executables with argument arrays and a worker-local environment.`;

export const languageDevelopment = [
  {
    category: "language-development",
    id: "language-csharp",
    artifact: "language-packs/eval-csharp",
    expected: { id: "agent-k.eval-csharp", languages: ["csharp"], markers: ["*.sln", "*.csproj"], versions: ["10.0.302", "0.26.0"] },
    prompt: `Create a new Agent K C# Language Pack with id agent-k.eval-csharp in language-packs/eval-csharp. Do not copy or rename an existing first-party Language Pack; use the author Skill scaffold and protocol references, then implement and test the new package. The single package must contribute its core text Editor integration, embedded Skill, csharp-ls semantics, isolated .NET toolchain, build/test/run actions, and .NET debugging. Use agent-k.language-pack.json and the standard project.*, language.*, build/test/run, and debug.* actions through capability language. Recognize projects with *.sln and *.csproj direct children. Provision the official .NET SDK 10.0.302 and csharp-ls 0.26.0 privately when compatible system tools are unavailable. Set DOTNET_ROOT, DOTNET_CLI_HOME, NUGET_PACKAGES, DOTNET_MULTILEVEL_LOOKUP=0, and a private PATH only for child processes. Both csharp-ls design-time MSBuild and explicit builds must redirect BaseOutputPath, BaseIntermediateOutputPath, and MSBuildProjectExtensionsPath to project-specific directories under the private language cache; a cold load plus semantic request must leave no bin, obj, NuGet, index, log, or temporary output in the source tree. Test this from a clean project on Windows and Linux. Do not launch tool shims from staging when a process or cache can retain absolute paths. Complete the atomic switch first, then run final probes from final paths; roll back on failure. Support diagnostics, definition, references, hover, symbols, completion, rename, and formatting. ${isolationContract} Include the manifest, worker source, embedded Skill, Editor contribution, tests, and built dist/worker.js. Run all Language Pack and desktop checks.`,
  },
  {
    category: "language-development",
    id: "language-typescript",
    artifact: "language-packs/eval-typescript-javascript",
    expected: { id: "agent-k.eval-typescript-javascript", languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"], markers: ["tsconfig.json", "jsconfig.json", "package.json"], versions: ["24.18.1", "5.3.0", "6.0.3"] },
    prompt: `Create a new Agent K TypeScript/JavaScript Language Pack with id agent-k.eval-typescript-javascript in language-packs/eval-typescript-javascript. Do not copy or rename an existing first-party Language Pack; use the author Skill scaffold and protocol references, then implement and test the new package. The single package must contribute its core text Editor integration, embedded Skill, TypeScript language service, isolated Node/TypeScript toolchain, package build/test/run actions, and JavaScript debugging. Use agent-k.language-pack.json and the standard project.*, language.*, build/test/run, and debug.* actions through capability language. Recognize tsconfig.json, jsconfig.json, and package.json projects; support .ts, .tsx, .js, and .jsx with the exact Agent K language IDs ["typescript", "typescriptreact", "javascript", "javascriptreact"]. Provision Node.js 24.18.1 LTS, typescript-language-server 5.3.0, and TypeScript 6.0.3 privately when compatible system tools are unavailable. Verify the Node SHASUMS256 digest and npm lockfile integrity, install with lifecycle scripts disabled, launch the resolved Node executable directly, and explicitly select the private TypeScript server. Verify official archive layouts and run Node --version before npm installation. Support diagnostics, definition, references, hover, symbols, completion, rename, formatting, organize imports, and cross-language navigation. ${isolationContract} Include the manifest, worker source, embedded Skill, Editor contribution, tests, and built dist/worker.js. Run all Language Pack and desktop checks.`,
  },
];

const skillInputs = skillDefinitions.map((definition, index) => ({
  category: "skill-invocation",
  id: `skill-call-${String(index + 1).padStart(2, "0")}`,
  expected: { skill: index >= 7 ? definition.name : "agent-k-eval-record-tools", ...(index >= 7 ? { artifactCase: `skill-${String(index + 1).padStart(2, "0")}`, artifact: `.pi/skills/${definition.name}` } : {}), operation: definition.operation, input: definition.input, output: definition.output },
  prompt: `${index >= 7 ? `Use the generated ${definition.name} Skill` : "Use the available record-processing capability"} to run operation ${definition.operation} on this input and report only the resulting JSON: ${JSON.stringify(definition.input)}`,
}));

export const skillInvocation = skillInputs;

export const editorInvocation = editorDefinitions.map(({ name, extension, action }, index) => ({
  category: "editor-invocation",
  id: `editor-call-${String(index + 1).padStart(2, "0")}`,
  fixture: `sample.${extension}`,
  expected: { skill: index >= 7 ? `agent-k.eval-${name}` : "agent-k-eval-editor-actions", ...(index >= 7 ? { artifactCase: `editor-${String(index + 1).padStart(2, "0")}`, artifact: `editor/extensions/eval-${name}` } : {}), capability: "file-editor", action },
  prompt: `Use the action exposed by the currently open ${name} editor to update this document as described by that action, then report what changed.`,
}));

const semanticLanguageMethods = [
  ["diagnostics", "Report the diagnostic intentionally present in the fixture."],
  ["definition", "Find the definition of the marked symbol."],
  ["references", "List all references to the marked symbol."],
  ["hover", "Report hover information for the marked symbol."],
  ["document-symbols", "List symbols in the active fixture document."],
  ["workspace-symbols", "Find the marked symbol in the workspace index."],
  ["completion", "Request completion at the marked cursor."],
  ["rename", "Compute a rename edit for the marked symbol without applying it."],
  ["formatting", "Return formatting edits for the active fixture document."],
];

function languageCalls(prefix, language, pluginId, methods) {
  return methods.map(([method, prompt], index) => ({
    category: `${prefix}-invocation`,
    id: `${prefix}-call-${String(index + 1).padStart(2, "0")}`,
    expected: { language, method, pluginId },
    prompt,
  }));
}

export const csharpInvocation = languageCalls("csharp", "csharp", "agent-k.csharp", [
  ...semanticLanguageMethods,
  ["build", "Build the fixture with the extension's private .NET SDK and report the structured result."],
]);
export const typescriptInvocation = languageCalls("typescript", "typescript", "agent-k.typescript-javascript", [
  ...semanticLanguageMethods,
  ["organize-imports", "Return the organize-imports workspace edit for the active TypeScript fixture."],
]);
const cppMethods = [
  ["definition", "Find the definition of the marked symbol."],
  ["references", "List all references to the marked symbol."],
  ["hover", "Report hover information for the marked symbol."],
  ["diagnostics", "Report diagnostics for the active fixture file."],
  ["symbols", "Search workspace symbols for the marked symbol."],
  ["document-symbols", "List symbols in the active fixture document."],
  ["incoming-calls", "Find incoming calls to the marked function."],
  ["outgoing-calls", "Find outgoing calls from the marked function."],
  ["supertypes", "Find supertypes of the marked derived type."],
  ["subtypes", "Find subtypes of the marked base type."],
];
export const cppInvocation = languageCalls("cpp", "cpp", "agent-k.cpp", cppMethods).map((item) => ({
  ...item,
  expected: { ...item.expected, capability: "language", requiresStatus: true },
  prompt: `${item.prompt} Use Agent K's semantic C++ project service rather than text search.`,
}));

export const categories = {
  "theme-development": themeDevelopment,
  "skill-development": skillDevelopment,
  "editor-development": editorDevelopment,
  "language-development": languageDevelopment,
  "skill-invocation": skillInvocation,
  "editor-invocation": editorInvocation,
  "csharp-invocation": csharpInvocation,
  "typescript-invocation": typescriptInvocation,
  "cpp-invocation": cppInvocation,
};

export const allCases = Object.values(categories).flat();
