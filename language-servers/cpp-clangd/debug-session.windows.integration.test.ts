import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DebugSession, type DebugSnapshot } from "./debug-session.ts";

function stoppedSession(session: DebugSession): Promise<DebugSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const snapshot = session.snapshot();
      if (snapshot.state === "stopped" && snapshot.threads[0]?.frames[0]?.scopes.length) {
        clearInterval(timer); clearTimeout(timeout); resolve(snapshot);
      }
    }, 20);
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error("OpenDebugAD7 did not populate the minidump stack")); }, 30_000);
  });
}

test("real OpenDebugAD7 opens a full-memory native minidump", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const adapter = process.env.AGENT_K_REAL_DEBUG_ADAPTER;
  if (!adapter || !existsSync(adapter)) throw new Error("AGENT_K_REAL_DEBUG_ADAPTER must point to OpenDebugAD7.exe");
  if (spawnSync("cl.exe", ["/?"], { stdio: "ignore" }).error) throw new Error("Run this test from a Visual Studio C++ developer environment containing cl.exe");
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-windbg-"));
  const source = join(temporary, "dump.cpp");
  const program = join(temporary, "dump.exe");
  const dump = join(temporary, "program.dmp");
  await writeFile(source, `#include <windows.h>\n#include <dbghelp.h>\nint marker = 41;\nint main() {\n  HANDLE file = CreateFileW(L"${dump.replaceAll("\\", "\\\\")}", GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);\n  BOOL saved = MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file, MiniDumpWithFullMemory, nullptr, nullptr, nullptr);\n  CloseHandle(file);\n  marker += 1;\n  return saved && marker == 42 ? 0 : 1;\n}\n`);
  const compiled = spawnSync("cl.exe", ["/nologo", "/Zi", "/EHsc", source, `/Fe:${program}`, "/link", "/debug", "dbghelp.lib"], { cwd: temporary, encoding: "utf8" });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = spawnSync(program, [], { cwd: temporary, encoding: "utf8" });
  assert.equal(executed.status, 0, executed.stderr);
  assert.ok(existsSync(dump));
  const session = new DebugSession(() => undefined, () => ({ adapter: "windbg", args: [], command: adapter }));
  try {
    const stopped = stoppedSession(session);
    await session.start({ dumpPath: dump, mode: "dump", program, root: temporary, symbolPaths: [temporary] });
    const snapshot = await stopped;
    assert.equal(snapshot.sessionKind, "dump");
    assert.ok(snapshot.threads[0]?.frames.length);
    await assert.rejects(() => session.command("continue"), /read-only/);
    const frame = snapshot.threads.flatMap((thread) => thread.frames).find((item) => item.id === snapshot.selectedFrameId);
    if (frame?.instructionPointerReference && snapshot.capabilities.supportsDisassembleRequest === true)
      assert.ok((await session.disassemble(frame.instructionPointerReference, -8, 16)).length);
  } finally {
    session.shutdown();
    await rm(temporary, { force: true, recursive: true });
  }
});
