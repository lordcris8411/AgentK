import assert from "node:assert/strict";
import test from "node:test";
import { debugProviderForFile, debugProviderIdentity, debugProviders, rankDebugProviders } from "../src/features/debug/providers.ts";
import type { LanguageServerPlugin } from "../src/lib/desktop.ts";

const plugin = (id: string, providerId: string, extension: string, priority: number, enabled = true): LanguageServerPlugin => ({
  apiVersion: 1, displayName: id, enabled, id, languages: [], projectMarkers: [],
  debugServer: { adapters: [], protocol: "dap", providers: [{ fileExtensions: [extension], id: providerId, label: providerId, languages: [], modes: ["launch"], priority, projectMarkers: [] }] },
});

test("ranks debug providers by active file while preserving an explicit project choice", () => {
  const providers = debugProviders([plugin("native", "cpp", ".cpp", 100), plugin("web", "browser", ".ts", 20), plugin("disabled", "lua", ".lua", 500, false)]);
  assert.deepEqual(providers.map(debugProviderIdentity), ["native:cpp", "web:browser"]);
  assert.equal(debugProviderIdentity(rankDebugProviders(providers, "/workspace/site/app.ts")[0]!), "web:browser");
  assert.equal(debugProviderIdentity(rankDebugProviders(providers, "/workspace/site/app.ts", "native:cpp")[0]!), "native:cpp");
  assert.equal(debugProviderIdentity(debugProviderForFile(providers, "/workspace/site/app.ts")!), "web:browser");
  assert.equal(debugProviderForFile(providers, "/workspace/README.md"), undefined);
});
