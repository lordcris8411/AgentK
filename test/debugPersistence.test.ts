import assert from "node:assert/strict";
import test from "node:test";
import { appendConsoleHistory, debugLayoutGeometry, defaultDebugProject, loadDebugProject, loadDebugProviderConfiguration, mergePersistedDebugBreakpoints, navigateConsoleHistory, parseDebugProject, saveDebugProject, saveDebugProviderConfiguration } from "../src/features/debug/persistence.ts";

test("normalizes persisted project debugger configuration", () => {
  const parsed = parseDebugProject({
    args: "--port 42",
    breakpoints: [
      { condition: "count > 2", enabled: false, file: "/workspace/src/main.cpp", line: 12, logMessage: "count={count}" },
      { enabled: true, file: "", line: -1 },
      { enabled: true, file: "/workspace/src/main.cpp", line: 12 },
    ],
    buildConfiguration: "RelWithDebInfo",
    consoleHistory: ["a", "", 7, "b"],
    dumpPath: "/tmp/app.core",
    exceptionFilters: ["cpp_throw", "", 7, "cpp_throw"],
    functionBreakpoints: [{ condition: "ready", name: "main" }, { name: "" }, { name: 7 }],
    layout: { columnPercent: 95, consolePercent: 10, hidden: ["watch", "unknown", "watch"], rowPercent: 44 },
    mode: "dump",
    processId: "123",
    program: "build/app",
    providerIdentity: "cpp-clangd:cpp-native",
    sourceMap: { "/build/src": "/workspace/src", "": "ignored", broken: 7 },
    stopOnEntry: true,
    targetId: "target",
    symbolPaths: ["/symbols", "", 7],
  });
  assert.equal(parsed.buildConfiguration, "RelWithDebInfo");
  assert.equal(parsed.mode, "dump");
  assert.equal(parsed.dumpPath, "/tmp/app.core");
  assert.deepEqual(parsed.breakpoints, [{ enabled: true, file: "/workspace/src/main.cpp", line: 12 }]);
  assert.deepEqual(parsed.exceptionFilters, ["cpp_throw"]);
  assert.deepEqual(parsed.functionBreakpoints, [{ condition: "ready", name: "main" }]);
  assert.deepEqual(parsed.sourceMap, { "/build/src": "/workspace/src" });
  assert.deepEqual(parsed.symbolPaths, ["/symbols"]);
  assert.deepEqual(parsed.consoleHistory, ["a", "b"]);
  assert.deepEqual(parsed.layout.hidden, ["watch"]);
  assert.equal(parsed.layout.columnPercent, 80);
  assert.equal(parsed.layout.consolePercent, 20);
  assert.equal(parsed.layout.rowPercent, 44);
  assert.equal(parsed.targetId, "target");
  assert.equal(parsed.providerIdentity, "cpp-clangd:cpp-native");
});

test("uses safe defaults for malformed debugger configuration", () => {
  assert.deepEqual(parseDebugProject(null), defaultDebugProject());
  assert.deepEqual(parseDebugProject({ buildConfiguration: "Broken", layout: "bad", mode: "remote" }), defaultDebugProject());
});

test("persists debugger configuration independently for each workspace", () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const first = defaultDebugProject();
    first.args = "--first";
    first.consoleHistory = ["counter", "point.x"];
    first.breakpoints = [{ condition: "counter > 3", enabled: true, file: "/workspace/one/main.cpp", line: 8 }];
    first.exceptionFilters = ["cpp_throw"];
    first.functionBreakpoints = [{ name: "main" }];
    first.layout.hidden = ["watch"];
    const second = defaultDebugProject();
    second.buildConfiguration = "Release";
    saveDebugProject("/workspace/one", first);
    saveDebugProject("/workspace/two", second);
    assert.equal(loadDebugProject("/workspace/one").args, "--first");
    assert.deepEqual(loadDebugProject("/workspace/one").consoleHistory, ["counter", "point.x"]);
    assert.deepEqual(loadDebugProject("/workspace/one").breakpoints, first.breakpoints);
    assert.deepEqual(loadDebugProject("/workspace/one").exceptionFilters, ["cpp_throw"]);
    assert.deepEqual(loadDebugProject("/workspace/one").functionBreakpoints, [{ name: "main" }]);
    assert.deepEqual(loadDebugProject("/workspace/one").layout.hidden, ["watch"]);
    assert.equal(loadDebugProject("/workspace/two").buildConfiguration, "Release");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("persists launch configuration independently for each debug provider", () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
  });
  try {
    const native = loadDebugProviderConfiguration("/workspace", "native:cpp");
    saveDebugProviderConfiguration("/workspace", "native:cpp", { ...native, args: "--native", program: "build/app" });
    const browser = loadDebugProviderConfiguration("/workspace", "web:browser");
    saveDebugProviderConfiguration("/workspace", "web:browser", { ...browser, args: "--inspect", program: "site/index.ts" });
    assert.equal(loadDebugProviderConfiguration("/workspace", "native:cpp").program, "build/app");
    assert.equal(loadDebugProviderConfiguration("/workspace", "web:browser").program, "site/index.ts");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("replaces one provider's persisted breakpoints without deleting another provider's breakpoints", () => {
  const cpp = { enabled: true, file: "/workspace/main.cpp", line: 8 };
  const ts = { enabled: true, file: "/workspace/site.ts", line: 12 };
  assert.deepEqual(mergePersistedDebugBreakpoints([cpp, ts], [{ ...cpp, line: 15 }], (file) => file.endsWith(".cpp")), [{ ...ts }, { ...cpp, line: 15 }]);
  assert.deepEqual(mergePersistedDebugBreakpoints([cpp, ts], [], (file) => file.endsWith(".cpp")), [ts]);
});

test("restores source breakpoints after a workspace reload and persists their removal", () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
  });
  try {
    const root = "/workspace/reload";
    const breakpoint = { condition: "ready", enabled: true, file: `${root}/main.cpp`, line: 9 };
    saveDebugProject(root, { ...defaultDebugProject(), breakpoints: [breakpoint] });
    assert.deepEqual(loadDebugProject(root).breakpoints, [breakpoint]);
    const reloaded = loadDebugProject(root);
    saveDebugProject(root, { ...reloaded, breakpoints: mergePersistedDebugBreakpoints(reloaded.breakpoints, [], (file) => file.endsWith(".cpp")) });
    assert.deepEqual(loadDebugProject(root).breakpoints, []);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("navigates a bounded, de-duplicated debugger console history", () => {
  assert.deepEqual(appendConsoleHistory(["a", "b", "a"], " a "), ["b", "a"]);
  assert.deepEqual(navigateConsoleHistory(["a", "b"], 2, -1), { index: 1, value: "b" });
  assert.deepEqual(navigateConsoleHistory(["a", "b"], 0, -1), { index: 0, value: "a" });
  assert.deepEqual(navigateConsoleHistory(["a", "b"], 1, 1), { index: 2, value: "" });
  const bounded = appendConsoleHistory(Array.from({ length: 3_000 }, (_, index) => String(index)), "3000");
  assert.equal(bounded.length, 3_000);
  assert.equal(bounded[0], "1");
  assert.equal(bounded.at(-1), "3000");
});

test("expands remaining debugger panes when their neighbors are hidden", () => {
  const defaultLayout = debugLayoutGeometry([], 50, 55, 30);
  assert.equal(defaultLayout.visible.top, true);
  assert.match(defaultLayout.rows, /30%/);
  const noTop = debugLayoutGeometry(["locals", "watch"], 50, 55, 30);
  assert.equal(noTop.visible.top, false);
  assert.match(noTop.rows, /^calc\(0%/);
  const consoleOnly = debugLayoutGeometry(["locals", "watch", "stack", "breakpoints"], 50, 55, 30);
  assert.equal(consoleOnly.visible.tools, false);
  assert.match(consoleOnly.rows, /calc\(100% - 0px\)$/);
  const toolsOnly = debugLayoutGeometry(["console"], 42, 60, 30);
  assert.equal(toolsOnly.visible.console, false);
  assert.equal(toolsOnly.columns, "42% 4px calc(58% - 4px)");
});
