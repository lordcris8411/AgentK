export type DebugPanelId = "breakpoints" | "console" | "locals" | "stack" | "watch";

export type PersistedDebugBreakpoint = {
  condition?: string;
  enabled: boolean;
  file: string;
  hitCondition?: string;
  line: number;
  logMessage?: string;
};

export type PersistedFunctionBreakpoint = { condition?: string; hitCondition?: string; name: string };

export type PersistedDebugProject = {
  args: string;
  buildConfiguration: "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel";
  breakpoints: PersistedDebugBreakpoint[];
  consoleHistory: string[];
  dumpPath: string;
  exceptionFilters: string[];
  functionBreakpoints: PersistedFunctionBreakpoint[];
  layout: {
    columnPercent: number;
    consolePercent: number;
    hidden: DebugPanelId[];
    rowPercent: number;
  };
  mode: "launch" | "attach" | "dump";
  processId: string;
  program: string;
  providerIdentity: string;
  sourceMap: Record<string, string>;
  stopOnEntry: boolean;
  targetId: string;
  symbolPaths: string[];
};

export type PersistedDebugConfiguration = Pick<PersistedDebugProject,
  "args" | "buildConfiguration" | "dumpPath" | "mode" | "processId" | "program" | "sourceMap" | "stopOnEntry" | "symbolPaths" | "targetId">;

const BUILD_CONFIGURATIONS = new Set<PersistedDebugProject["buildConfiguration"]>(["Debug", "Release", "RelWithDebInfo", "MinSizeRel"]);
const PANELS = new Set<DebugPanelId>(["breakpoints", "console", "locals", "stack", "watch"]);

export const defaultDebugProject = (): PersistedDebugProject => ({
  args: "",
  buildConfiguration: "Debug",
  breakpoints: [],
  consoleHistory: [],
  dumpPath: "",
  exceptionFilters: [],
  functionBreakpoints: [],
  layout: { columnPercent: 50, consolePercent: 30, hidden: [], rowPercent: 55 },
  mode: "launch",
  processId: "",
  program: "",
  providerIdentity: "",
  sourceMap: {},
  stopOnEntry: false,
  targetId: "",
  symbolPaths: [],
});

export function appendConsoleHistory(history: string[], expressionInput: string): string[] {
  const expression = expressionInput.trim();
  return expression ? [...history.filter((item) => item !== expression), expression].slice(-3_000) : history;
}

export function navigateConsoleHistory(history: string[], index: number, direction: -1 | 1): { index: number; value: string } {
  const next = Math.max(0, Math.min(history.length, index + direction));
  return { index: next, value: next === history.length ? "" : history[next] ?? "" };
}

export function mergePersistedDebugBreakpoints(
  existing: PersistedDebugBreakpoint[],
  incoming: PersistedDebugBreakpoint[],
  ownsFile: (file: string) => boolean,
): PersistedDebugBreakpoint[] {
  return [...existing.filter((item) => !ownsFile(item.file)), ...incoming];
}

export function debugLayoutGeometry(hidden: DebugPanelId[], columnPercent: number, rowPercent: number, consolePercent: number) {
  const visible = (panel: DebugPanelId) => !hidden.includes(panel);
  const locals = visible("locals");
  const watch = visible("watch");
  const stack = visible("stack");
  const breakpoints = visible("breakpoints");
  const console = visible("console");
  const top = locals || watch;
  const bottom = stack || breakpoints;
  const tools = top || bottom;
  const effectiveConsole = console ? tools ? consolePercent : 100 : 0;
  const work = 100 - effectiveConsole;
  const first = top ? bottom ? work * rowPercent / 100 : work : 0;
  const second = bottom ? top ? work - first : work : 0;
  const rowDivider = top && bottom ? 4 : 0;
  const consoleDivider = console && tools ? 4 : 0;
  return {
    columns: `${columnPercent}% 4px calc(${100 - columnPercent}% - 4px)`,
    rows: console
      ? `calc(${first}% - ${rowDivider / 2}px) ${rowDivider}px calc(${second}% - ${rowDivider / 2}px) ${consoleDivider}px calc(${effectiveConsole}% - ${consoleDivider}px)`
      : `calc(${first}% - ${rowDivider / 2}px) ${rowDivider}px calc(${second}% - ${rowDivider / 2}px) 0 0`,
    visible: { bottom, breakpoints, console, locals, stack, tools, top, watch },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function bounded(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(20, Math.min(80, value)) : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBreakpoints(value: unknown): PersistedDebugBreakpoint[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, PersistedDebugBreakpoint>();
  for (const item of value) {
    const source = record(item);
    const file = optionalText(source.file);
    const line = typeof source.line === "number" && Number.isInteger(source.line) && source.line > 0 ? source.line : undefined;
    if (!file || line === undefined) continue;
    unique.set(`${file}\0${line}`, {
      enabled: source.enabled !== false,
      file,
      line,
      ...(optionalText(source.condition) ? { condition: optionalText(source.condition) } : {}),
      ...(optionalText(source.hitCondition) ? { hitCondition: optionalText(source.hitCondition) } : {}),
      ...(optionalText(source.logMessage) ? { logMessage: optionalText(source.logMessage) } : {}),
    });
  }
  return [...unique.values()];
}

function parseFunctionBreakpoints(value: unknown): PersistedFunctionBreakpoint[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, PersistedFunctionBreakpoint>();
  for (const item of value) {
    const source = record(item);
    const name = optionalText(source.name);
    if (!name) continue;
    unique.set(name, {
      name,
      ...(optionalText(source.condition) ? { condition: optionalText(source.condition) } : {}),
      ...(optionalText(source.hitCondition) ? { hitCondition: optionalText(source.hitCondition) } : {}),
    });
  }
  return [...unique.values()];
}

export function parseDebugProject(value: unknown): PersistedDebugProject {
  const source = record(value);
  const layout = record(source.layout);
  const defaults = defaultDebugProject();
  return {
    args: typeof source.args === "string" ? source.args : "",
    buildConfiguration: BUILD_CONFIGURATIONS.has(source.buildConfiguration as PersistedDebugProject["buildConfiguration"])
      ? source.buildConfiguration as PersistedDebugProject["buildConfiguration"] : "Debug",
    breakpoints: parseBreakpoints(source.breakpoints),
    consoleHistory: Array.isArray(source.consoleHistory)
      ? source.consoleHistory.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(-3_000)
      : [],
    dumpPath: typeof source.dumpPath === "string" ? source.dumpPath : "",
    exceptionFilters: Array.isArray(source.exceptionFilters)
      ? [...new Set(source.exceptionFilters.flatMap((item): string[] => optionalText(item) ? [optionalText(item)!] : []))]
      : [],
    functionBreakpoints: parseFunctionBreakpoints(source.functionBreakpoints),
    layout: {
      columnPercent: bounded(layout.columnPercent, defaults.layout.columnPercent),
      consolePercent: bounded(layout.consolePercent, defaults.layout.consolePercent),
      hidden: Array.isArray(layout.hidden)
        ? [...new Set(layout.hidden.filter((item): item is DebugPanelId => typeof item === "string" && PANELS.has(item as DebugPanelId)))]
        : [],
      rowPercent: bounded(layout.rowPercent, defaults.layout.rowPercent),
    },
    mode: source.mode === "attach" || source.mode === "dump" ? source.mode : "launch",
    processId: typeof source.processId === "string" ? source.processId : "",
    program: typeof source.program === "string" ? source.program : "",
    providerIdentity: typeof source.providerIdentity === "string" ? source.providerIdentity : "",
    sourceMap: Object.fromEntries(Object.entries(record(source.sourceMap)).filter((entry): entry is [string, string] => Boolean(entry[0].trim()) && typeof entry[1] === "string" && Boolean(entry[1].trim()))),
    stopOnEntry: source.stopOnEntry === true,
    targetId: typeof source.targetId === "string" ? source.targetId : "",
    symbolPaths: Array.isArray(source.symbolPaths) ? source.symbolPaths.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [],
  };
}

const STORAGE_KEY = "agent-k-debug-projects-v1";
const PROVIDER_STORAGE_KEY = "agent-k-debug-provider-configurations-v1";

function projects(): Record<string, unknown> {
  try { return record(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")); }
  catch { return {}; }
}

export function loadDebugProject(root: string): PersistedDebugProject {
  return parseDebugProject(projects()[root]);
}

export function saveDebugProject(root: string, state: PersistedDebugProject): void {
  try {
    const all = projects();
    all[root] = parseDebugProject(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch { /* Persistence is best-effort when browser storage is unavailable. */ }
}

function configuration(project: PersistedDebugProject): PersistedDebugConfiguration {
  const { args, buildConfiguration, dumpPath, mode, processId, program, sourceMap, stopOnEntry, symbolPaths, targetId } = project;
  return { args, buildConfiguration, dumpPath, mode, processId, program, sourceMap, stopOnEntry, symbolPaths, targetId };
}

export function loadDebugProviderConfiguration(root: string, providerIdentity: string): PersistedDebugConfiguration {
  try {
    const stored = record(JSON.parse(localStorage.getItem(PROVIDER_STORAGE_KEY) ?? "{}"));
    const workspace = record(stored[root]);
    if (providerIdentity in workspace) return configuration(parseDebugProject(workspace[providerIdentity]));
  } catch { /* Fall through to migration from the workspace-wide v1 configuration. */ }
  const legacy = loadDebugProject(root);
  return legacy.providerIdentity === providerIdentity || !legacy.providerIdentity ? configuration(legacy) : configuration(defaultDebugProject());
}

export function saveDebugProviderConfiguration(root: string, providerIdentity: string, state: PersistedDebugConfiguration): void {
  try {
    const stored = record(JSON.parse(localStorage.getItem(PROVIDER_STORAGE_KEY) ?? "{}"));
    const workspace = record(stored[root]);
    workspace[providerIdentity] = configuration(parseDebugProject(state));
    stored[root] = workspace;
    localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(stored));
  } catch { /* Persistence is best-effort when browser storage is unavailable. */ }
}
