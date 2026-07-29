import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { DebugSession, type DebugSnapshot } from "./debug-session.ts";
import { DebugSessionManager } from "./debug-session-manager.ts";

function stoppedSession(session: DebugSession): Promise<DebugSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error("The debugger did not reach a fully populated stopped state")); }, 20_000);
    const timer = setInterval(() => {
      const snapshot = session.snapshot();
      if (snapshot.state === "stopped" && snapshot.threads[0]?.frames[0]?.scopes.length) { clearInterval(timer); clearTimeout(timeout); resolve(snapshot); }
    }, 20);
  });
}

test("real CodeLLDB reads memory, registers and disassembly and reopens a core", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const adapter = process.env.AGENT_K_REAL_DEBUG_ADAPTER;
  if (!adapter || !existsSync(adapter)) throw new Error("AGENT_K_REAL_DEBUG_ADAPTER must point to the CodeLLDB adapter");
  const compiler = ["c++", "g++", "clang++"].find((command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0);
  if (!compiler) throw new Error("A C++ compiler is required for real debugger integration tests");
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-real-debug-"));
  const source = join(temporary, "main.cpp");
  const program = join(temporary, "program");
  const core = join(temporary, "program.core");
  await writeFile(source, "int marker = 41;\nint main() {\n  marker += 1;\n  return marker == 42 ? 0 : 1;\n}\n");
  const compiled = spawnSync(compiler, ["-g", "-O0", source, "-o", program], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const launch = () => ({ adapter: "lldb" as const, args: [], command: adapter });
  let session = new DebugSession(() => undefined, launch);
  try {
    await session.setBreakpoints(source, [3]);
    const stopped = stoppedSession(session);
    await session.start({ program, root: temporary });
    const snapshot = await stopped;
    assert.equal(snapshot.state, "stopped");
    const frame = snapshot.threads.flatMap((thread) => thread.frames).find((item) => item.id === snapshot.selectedFrameId);
    assert.ok(frame?.instructionPointerReference);
    assert.ok(frame.scopes.some((scope) => scope.presentationHint === "registers" || /register/i.test(scope.name) || scope.variables.some((variable) => /register|vector extension/i.test(variable.name))), JSON.stringify(frame.scopes));
    const evaluation = await session.evaluate("&marker", "watch");
    assert.ok(evaluation.memoryReference);
    const memory = await session.readMemory(evaluation.memoryReference, 0, 4);
    assert.equal(memory.bytes.length, 4);
    const written = await session.writeMemory(evaluation.memoryReference, 0, memory.bytes);
    assert.equal(written.bytesWritten, 4);
    const instructions = await session.disassemble(frame.instructionPointerReference, -8, 16);
    assert.ok(instructions.length > 0);
    if (snapshot.capabilities.supportsInstructionBreakpoints === true)
      assert.equal((await session.setInstructionBreakpoints([frame.instructionPointerReference])).instructionBreakpoints.length, 1);
    await session.evaluate(`process save-core ${core}`, "repl");
    assert.ok(existsSync(core), "CodeLLDB did not create the requested core file");
    await session.stop();

    session = new DebugSession(() => undefined, launch);
    const dumpStopped = stoppedSession(session);
    await session.start({ dumpPath: core, mode: "dump", program, root: temporary });
    const dump = await dumpStopped;
    assert.equal(dump.sessionKind, "dump");
    assert.ok(dump.threads[0]?.frames.length);
    await assert.rejects(() => session.command("continue"), /read-only/);
  } finally {
    session.shutdown();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("real CodeLLDB keeps two attached processes in independent sessions", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const adapter = process.env.AGENT_K_REAL_DEBUG_ADAPTER;
  if (!adapter || !existsSync(adapter)) throw new Error("AGENT_K_REAL_DEBUG_ADAPTER must point to the CodeLLDB adapter");
  const compiler = ["c++", "g++", "clang++"].find((command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0);
  if (!compiler) throw new Error("A C++ compiler is required for real debugger integration tests");
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-real-multi-attach-"));
  const source = join(temporary, "wait.cpp");
  const program = join(temporary, "wait-program");
  await writeFile(source, "#include <sys/prctl.h>\n#include <unistd.h>\nint main(){ prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY); for (;;) sleep(1); }\n");
  const compiled = spawnSync(compiler, ["-g", "-O0", source, "-o", program], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const firstProcess = spawn(program, [], { stdio: "ignore" });
  const secondProcess = spawn(program, [], { stdio: "ignore" });
  const manager = new DebugSessionManager(() => undefined, () => ({ adapter: "lldb", args: [], command: adapter }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!firstProcess.pid || !secondProcess.pid) throw new Error("Attach fixtures did not start");
    const first = await manager.start({ mode: "attach", processId: firstProcess.pid, root: temporary, sessionName: "First" });
    const second = await manager.start({ mode: "attach", processId: secondProcess.pid, root: temporary, sessionName: "Second" });
    assert.notEqual(first.sessionId, second.sessionId);
    assert.deepEqual(manager.list().map((item) => item.sessionLabel), ["First", "Second"]);
    await Promise.all([manager.command("pause", first.sessionId), manager.command("pause", second.sessionId)]);
    const waitStopped = async (sessionId: string) => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const snapshot = manager.list().find((item) => item.sessionId === sessionId);
        if (snapshot?.state === "stopped") return snapshot;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Attached session ${sessionId} did not stop`);
    };
    const stopped = await Promise.all([waitStopped(first.sessionId), waitStopped(second.sessionId)]);
    assert.ok(stopped.every((snapshot) => snapshot.threads.length > 0));
  } finally {
    manager.shutdown();
    firstProcess.kill("SIGKILL");
    secondProcess.kill("SIGKILL");
    await rm(temporary, { force: true, recursive: true });
  }
});
