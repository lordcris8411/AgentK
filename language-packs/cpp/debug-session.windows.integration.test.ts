import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { DebugSession, type DebugSnapshot } from "../shared/debug-session.ts";

async function waitForSession(session: DebugSession, predicate: (snapshot: DebugSnapshot) => boolean, message: string): Promise<DebugSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = session.snapshot();
    if (predicate(snapshot)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const stable = session.snapshot();
      if (predicate(stable)) return stable;
    }
    if (snapshot.state === "failed" || snapshot.state === "terminated")
      throw new Error(`${message}: ${snapshot.error ?? snapshot.output.slice(-1_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const snapshot = session.snapshot();
  throw new Error(`${message}: state=${snapshot.state}; breakpoints=${JSON.stringify(snapshot.breakpoints)}; output=${snapshot.output.slice(-1_000)}`);
}

test("real CodeLLDB debugs MSVC PDBs and opens a Windows minidump", { skip: process.platform !== "win32", timeout: 90_000 }, async () => {
  const adapter = process.env.AGENT_K_REAL_DEBUG_ADAPTER;
  if (!adapter || !existsSync(adapter)) throw new Error("AGENT_K_REAL_DEBUG_ADAPTER must point to codelldb.exe");
  if (spawnSync("cl.exe", ["/?"], { stdio: "ignore" }).error) throw new Error("Run this test from a Visual Studio C++ developer environment containing cl.exe");
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-codelldb-win-"));
  const source = join(temporary, "debug.cpp");
  const program = join(temporary, "debug.exe");
  const dump = join(temporary, "debug.dmp");
  await writeFile(source, `#include <windows.h>\n#include <dbghelp.h>\nint marker = 41;\nint main() {\n  Sleep(500);\n  HANDLE file = CreateFileW(L"${dump.replaceAll("\\", "\\\\")}", GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);\n  BOOL saved = MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file, MiniDumpWithFullMemory, nullptr, nullptr, nullptr);\n  CloseHandle(file);\n  marker += 1;\n  return saved && marker == 42 ? 0 : 1;\n}\n`);
  const compiled = spawnSync("cl.exe", ["/nologo", "/Zi", "/Od", "/EHsc", source, `/Fe:${program}`, "/link", "/debug:full", "/incremental:no", "dbghelp.lib"], { cwd: temporary, encoding: "utf8" });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const launch = () => ({ adapter: "lldb" as const, args: [], command: adapter });
  let session = new DebugSession(() => undefined, launch);
  try {
    await session.setBreakpoints(source, [9]);
    await session.start({ program, root: temporary });
    const stopped = await waitForSession(session, (snapshot) => snapshot.state === "stopped" && snapshot.stopReasonKind === "breakpoint" && snapshot.threads.some((thread) => thread.frames.some((frame) => frame.file === source && frame.line === 9)), "CodeLLDB did not stop at the MSVC source breakpoint");
    assert.equal(stopped.adapter, "lldb");
    assert.ok(stopped.breakpoints.some((breakpoint) => breakpoint.line === 9 && breakpoint.verified), JSON.stringify(stopped.breakpoints));
    assert.match((await session.evaluate("marker", "watch")).result, /41/);
    await session.command("continue");
    await waitForSession(session, (snapshot) => snapshot.state === "terminated", "The MSVC debuggee did not terminate");
    assert.ok(existsSync(dump), "The debuggee did not create its minidump");
    await session.stop();

    session = new DebugSession(() => undefined, launch);
    await session.start({ dumpPath: dump, mode: "dump", program, root: temporary, symbolPaths: [temporary] });
    const dumpSnapshot = await waitForSession(session, (snapshot) => snapshot.state === "stopped" && Boolean(snapshot.threads[0]?.frames.length), "CodeLLDB did not populate the minidump stack");
    assert.equal(dumpSnapshot.sessionKind, "dump");
    await assert.rejects(() => session.command("continue"), /read-only/);
  } finally {
    session.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(temporary, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 });
  }
});

test("real CodeLLDB launches an LLVM-MinGW executable with its isolated runtime path", {
  skip: process.platform !== "win32" || !process.env.AGENT_K_REAL_DEBUG_PROGRAM || !process.env.AGENT_K_REAL_DEBUG_RUNTIME_PATH,
  timeout: 30_000,
}, async () => {
  const adapter = process.env.AGENT_K_REAL_DEBUG_ADAPTER;
  const program = process.env.AGENT_K_REAL_DEBUG_PROGRAM;
  const runtimePath = process.env.AGENT_K_REAL_DEBUG_RUNTIME_PATH;
  if (!adapter || !existsSync(adapter)) throw new Error("AGENT_K_REAL_DEBUG_ADAPTER must point to codelldb.exe");
  if (!program || !existsSync(program)) throw new Error("AGENT_K_REAL_DEBUG_PROGRAM must point to a Windows executable");
  if (!runtimePath || !existsSync(runtimePath)) throw new Error("AGENT_K_REAL_DEBUG_RUNTIME_PATH must point to the compiler runtime directory");
  const session = new DebugSession(() => undefined, () => ({ adapter: "lldb", args: [], command: adapter }));
  try {
    await session.start({
      environment: { PATH: `${runtimePath}${delimiter}${process.env.PATH ?? ""}` },
      program,
      root: dirname(program),
    });
    const terminated = await waitForSession(session, (snapshot) => snapshot.state === "terminated", "The LLVM-MinGW debuggee did not terminate");
    assert.equal(terminated.error, undefined);
  } finally {
    session.shutdown();
  }
});
