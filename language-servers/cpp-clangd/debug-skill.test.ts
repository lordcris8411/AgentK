import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { CppService } from "./dist/worker.js";

type SkillResult = Record<string, unknown>;

async function waitForStopped(service: CppService, cwd: string, workspace: string, sessionId: string): Promise<SkillResult> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await service.debugSkill({ action: "status", cwd, workspace });
    const sessions = status.sessions as Array<Record<string, unknown>>;
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (session?.state === "stopped") return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Session ${sessionId} did not stop`);
}

test("Native Debug Skill controls a workspace-owned DAP session", async (context) => {
  if (process.platform === "win32") return;
  const repository = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "agent-k-debug-skill-"));
  const source = join(root, "main.cpp");
  const program = join(root, "sample-program");
  const cache = join(root, ".cache");
  await writeFile(join(root, "CMakeLists.txt"), "project(debug_skill)\n", "utf8");
  await writeFile(source, "int main() { return 0; }\n", "utf8");
  await writeFile(program, "fake executable\n", "utf8");

  const previousE2e = process.env.AGENT_K_E2E;
  const previousAdapter = process.env.AGENT_K_E2E_DEBUG_ADAPTER;
  const previousSource = process.env.AGENT_K_E2E_SOURCE;
  process.env.AGENT_K_E2E = "1";
  process.env.AGENT_K_E2E_DEBUG_ADAPTER = join(repository, "test/fixtures/fake-debug-adapter.mjs");
  process.env.AGENT_K_E2E_SOURCE = source;
  const service = new CppService(cache, () => undefined);
  context.after(async () => {
    service.shutdown();
    if (previousE2e === undefined) delete process.env.AGENT_K_E2E;
    else process.env.AGENT_K_E2E = previousE2e;
    if (previousAdapter === undefined) delete process.env.AGENT_K_E2E_DEBUG_ADAPTER;
    else process.env.AGENT_K_E2E_DEBUG_ADAPTER = previousAdapter;
    if (previousSource === undefined) delete process.env.AGENT_K_E2E_SOURCE;
    else process.env.AGENT_K_E2E_SOURCE = previousSource;
    await rm(root, { force: true, recursive: true });
  });

  const request = { cwd: root, workspace: basename(root) };
  const idle = await service.debugSkill({ ...request, action: "status" });
  assert.deepEqual(idle.sessions, []);

  const configured = await service.debugSkill({ ...request, action: "set-breakpoints", file: "main.cpp", lines: [1] });
  assert.equal((configured.breakpoints as unknown[]).length, 1);

  const started = await service.debugSkill({ ...request, action: "start", mode: "launch", program, sessionName: "Pi test" });
  const sessionId = String((started.session as Record<string, unknown>).sessionId);
  assert.match(sessionId, /^debug-/);
  const stopped = await waitForStopped(service, root, basename(root), sessionId);
  assert.equal(stopped.stopReasonKind, "breakpoint");

  const stack = await service.debugSkill({ ...request, action: "stack", sessionId });
  assert.equal(((stack.threads as Array<{ frames: unknown[] }>)[0]?.frames.length), 1);
  const locals = await service.debugSkill({ ...request, action: "locals", sessionId });
  const scopes = locals.scopes as Array<{ variables: Array<{ memoryReference?: string; name: string }> }>;
  assert.equal(scopes[0]?.variables.some((variable) => variable.name === "answer"), true);
  assert.equal(scopes[0]?.variables.find((variable) => variable.name === "answer")?.memoryReference, "0x2000");

  const evaluation = await service.debugSkill({ ...request, action: "evaluate", expression: "answer", sessionId });
  assert.equal((evaluation.evaluation as { result: string }).result, "42");
  const memory = await service.debugSkill({ ...request, action: "read-memory", memoryReference: "0x2000", count: 16, sessionId });
  assert.deepEqual((memory.memory as { bytes: number[] }).bytes, new Array(16).fill(0x41));
  const assembly = await service.debugSkill({ ...request, action: "disassemble", memoryReference: "0x1000", instructionCount: 1, sessionId });
  assert.equal((assembly.instructions as Array<{ instruction: string }>)[0]?.instruction, "ret");

  const stoppedResult = await service.debugSkill({ ...request, action: "stop", sessionId });
  assert.equal(stoppedResult.removed, true);
  assert.deepEqual((await service.debugSkill({ ...request, action: "status" })).sessions, []);
});

test("Native Debug Skill rejects sessions owned by another workspace", async (context) => {
  if (process.platform === "win32") return;
  const repository = process.cwd();
  const parent = await mkdtemp(join(tmpdir(), "agent-k-debug-skill-roots-"));
  const first = join(parent, "first");
  const second = join(parent, "second");
  await mkdir(first);
  await mkdir(second);
  for (const root of [first, second]) {
    await writeFile(join(root, "CMakeLists.txt"), "project(debug_skill)\n", "utf8");
    await writeFile(join(root, "program"), "fake executable\n", "utf8");
  }
  const previousE2e = process.env.AGENT_K_E2E;
  const previousAdapter = process.env.AGENT_K_E2E_DEBUG_ADAPTER;
  const previousSource = process.env.AGENT_K_E2E_SOURCE;
  process.env.AGENT_K_E2E = "1";
  process.env.AGENT_K_E2E_DEBUG_ADAPTER = join(repository, "test/fixtures/fake-debug-adapter.mjs");
  process.env.AGENT_K_E2E_SOURCE = join(first, "main.cpp");
  const service = new CppService(join(parent, ".cache"), () => undefined);
  context.after(async () => {
    service.shutdown();
    if (previousE2e === undefined) delete process.env.AGENT_K_E2E;
    else process.env.AGENT_K_E2E = previousE2e;
    if (previousAdapter === undefined) delete process.env.AGENT_K_E2E_DEBUG_ADAPTER;
    else process.env.AGENT_K_E2E_DEBUG_ADAPTER = previousAdapter;
    if (previousSource === undefined) delete process.env.AGENT_K_E2E_SOURCE;
    else process.env.AGENT_K_E2E_SOURCE = previousSource;
    await rm(parent, { force: true, recursive: true });
  });

  const started = await service.debugSkill({ action: "start", cwd: parent, mode: "launch", program: join(first, "program"), workspace: "first" });
  const sessionId = String((started.session as Record<string, unknown>).sessionId);
  await assert.rejects(
    service.debugSkill({ action: "stack", cwd: parent, sessionId, workspace: "second" }),
    /does not belong to the requested workspace/,
  );
});
