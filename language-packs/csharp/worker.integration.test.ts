import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CSharpService } from "./worker.ts";

const enabled = process.env.AGENT_K_CSHARP_COLD_INTEGRATION === "1";

test(`cold C# load, semantics, private build and CoreCLR debug on ${process.platform} x64`, { skip: !enabled, timeout: 900_000 }, async (context) => {
  assert.ok(process.platform === "win32" || process.platform === "linux");
  assert.equal(process.arch, "x64");
  const parent = await mkdtemp(join(tmpdir(), "agent-k-csharp-integration-"));
  const root = join(parent, "source");
  const cache = process.env.AGENT_K_CSHARP_INTEGRATION_CACHE ? resolve(process.env.AGENT_K_CSHARP_INTEGRATION_CACHE) : join(parent, "agent-k-cache");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(root));
  context.after(async () => { await service?.shutdown(); await rm(parent, { force: true, recursive: true }); });
  await writeFile(join(root, "Clean.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n');
  await writeFile(join(root, "Program.cs"), "using System.Threading; public static class Program { public static int Value => 42; public static void Main() { Thread.Sleep(30_000); } }\n");
  const original = (await readdir(root)).sort();
  let service: CSharpService | undefined;
  service = new CSharpService(cache, (event) => {
    if (event.type === "language_pack_confirmation_request" && typeof event.requestId === "string") service?.respondConfirmation(event.requestId, true);
  });
  const loaded = await service.load(root);
  assert.notEqual(loaded.status, "failed", loaded.error);
  assert.equal(loaded.status, "ready");
  const file = join(root, "Program.cs");
  const uri = pathToFileURL(file).href;
  await service.notify(file, "textDocument/didOpen", { textDocument: { uri, languageId: "csharp", version: 1, text: await readFile(file, "utf8") } });
  await service.lsp(file, "textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 20 } });
  const built = await service.build(root);
  assert.equal(built.code, 0, String(built.stderr));
  const configurations = await service.debugConfigurations(root);
  const target = configurations.find((item) => item.name === "Clean");
  assert.ok(target, "private .NET output did not produce a debug target");
  const debug = await service.debugStart({ mode: "launch", root, stopOnEntry: true, targetId: target.id });
  assert.ok(["running", "stopped"].includes(debug.state), debug.error);
  await service.debugStop(debug.sessionId);
  await service.unload(root);
  assert.deepEqual((await readdir(root)).sort(), original, "source tree acquired generated output");
  const cacheEntries = await readdir(cache);
  assert.ok(cacheEntries.includes("archives"));
  assert.ok(cacheEntries.includes("projects"));
  await service.shutdown();
  service = undefined;
});
