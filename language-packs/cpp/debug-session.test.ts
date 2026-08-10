import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { boundedDebugOutput, DebugSession, type DebugSnapshot } from "../shared/debug-session.ts";

const adapterSource = String.raw`
import { appendFileSync } from 'node:fs';
let buffer = Buffer.alloc(0);
let launch;
let pendingThreads;
let memory = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const send = (message) => {
  const json = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json) + '\r\n\r\n' + json);
};
const sendAfterRawOutput = (message, output) => {
  const json = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json) + '\r\n\r\n');
  process.stdout.write(output);
  process.stdout.write(json);
};
const response = (request, body = {}) => send({ body, command: request.command, request_seq: request.seq, seq: 1000 + request.seq, success: true, type: 'response' });
const failedResponse = (request, message) => send({ command: request.command, message, request_seq: request.seq, seq: 1000 + request.seq, success: false, type: 'response' });
const handle = (request) => {
  if (request.command === 'initialize') { response(request, { exceptionBreakpointFilters: [{ default: true, filter: 'cpp_throw', label: 'C++ throw' }], supportsConfigurationDoneRequest: true, supportsDisassembleRequest: true, supportsFunctionBreakpoints: true, supportsInstructionBreakpoints: true, supportsReadMemoryRequest: true, supportsSetVariable: true, supportsWriteMemoryRequest: true }); return; }
  if (request.command === 'launch' || request.command === 'attach') { launch = request; if (process.env.FAKE_REQUEST_LOG) appendFileSync(process.env.FAKE_REQUEST_LOG, JSON.stringify(request) + '\n'); send({ event: 'initialized', seq: 20, type: 'event' }); return; }
  if (request.command === 'setBreakpoints') { response(request, { breakpoints: request.arguments.breakpoints.map((item) => ({ line: item.line, message: JSON.stringify(item), verified: true })) }); return; }
  if (request.command === 'setFunctionBreakpoints') { response(request, { breakpoints: request.arguments.breakpoints.map((item) => ({ message: JSON.stringify(item), verified: true })) }); return; }
  if (request.command === 'setInstructionBreakpoints') { response(request, { breakpoints: request.arguments.breakpoints.map(() => ({ verified: true })) }); return; }
  if (request.command === 'configurationDone') {
    response(request); response(launch);
    if (process.env.FAKE_INTERLEAVED_STDOUT) {
      sendAfterRawOutput({ event: 'terminated', body: {}, seq: 23, type: 'event' }, 'Hello, World!\r\n');
      return;
    }
    send({ event: 'output', body: { category: 'console', output: 'warning: (x86_64) /lib64/libstdc++.so.6 No LZMA support found for reading .gnu_debugdata section\n' }, seq: 20, type: 'event' });
    send({ event: 'output', body: { category: 'stdout', output: 'ready\n' }, seq: 21, type: 'event' });
    send({ event: 'stopped', body: { reason: 'breakpoint', threadId: 7 }, seq: 22, type: 'event' });
    return;
  }
  if (request.command === 'threads') {
    if (process.env.FAKE_CANCEL_PAUSE_REFRESH) { pendingThreads = request; return; }
    response(request, { threads: [{ id: 7, name: 'main' }] }); return;
  }
  if (request.command === 'continue' && process.env.FAKE_CANCEL_PAUSE_REFRESH) {
    response(request);
    if (pendingThreads) { failedResponse(pendingThreads, '<cancelled>'); pendingThreads = undefined; }
    send({ event: 'continued', body: { threadId: 7 }, seq: 24, type: 'event' });
    setTimeout(() => send({ event: 'terminated', body: {}, seq: 25, type: 'event' }), 5);
    return;
  }
  if (request.command === 'stackTrace') { response(request, { stackFrames: [{ id: 11, instructionPointerReference: '0x1000', line: 3, column: 1, name: 'main', source: { path: process.env.FAKE_SOURCE } }] }); return; }
  if (request.command === 'scopes') { response(request, { scopes: [{ expensive: false, name: 'Locals', variablesReference: 9 }, { expensive: false, name: 'CPU Registers', presentationHint: 'registers', variablesReference: 12 }] }); return; }
  if (request.command === 'variables') {
    response(request, { variables: request.arguments.variablesReference === 9
      ? [{ evaluateName: 'answer', memoryReference: '0x2000', name: 'answer', type: 'int', value: '42', variablesReference: 10 }]
      : request.arguments.variablesReference === 12 ? [{ name: 'rax', type: 'uint64', value: '0x2a', variablesReference: 0 }]
      : [{ name: 'member', type: 'int', value: '7', variablesReference: 0 }] });
    return;
  }
  if (request.command === 'evaluate') {
    const native = launch.arguments.expressions === 'native';
    response(request, { memoryReference: '0x2000', result: native ? '1' : '1065353216', type: 'int', variablesReference: 0 });
    return;
  }
  if (request.command === 'readMemory') { const offset = request.arguments.offset ?? 0; const data = memory.subarray(offset, offset + request.arguments.count); response(request, { address: request.arguments.memoryReference, data: data.toString('base64'), unreadableBytes: Math.max(0, request.arguments.count - data.length) }); return; }
  if (request.command === 'writeMemory') { const data = Buffer.from(request.arguments.data, 'base64'); data.copy(memory, request.arguments.offset ?? 0); response(request, { bytesWritten: data.length }); return; }
  if (request.command === 'disassemble') { response(request, { instructions: [{ address: '0x1000', instruction: 'mov eax, 42', instructionBytes: 'b8 2a 00 00 00', line: 3, location: { name: 'main.cpp', path: process.env.FAKE_SOURCE }, symbol: 'main' }] }); return; }
  if (request.command === 'setVariable') { response(request, { value: request.arguments.value }); return; }
  if (request.command === 'disconnect') { if (process.env.FAKE_REQUEST_LOG) appendFileSync(process.env.FAKE_REQUEST_LOG, JSON.stringify(request) + '\n'); response(request); setTimeout(() => process.exit(0), 5); return; }
  response(request);
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n'); if (headerEnd < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
    const end = headerEnd + 4 + length; if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString('utf8'));
    buffer = buffer.subarray(end); handle(message);
  }
});
`;

const tcpAdapterSource = adapterSource
  .replace("let buffer = Buffer.alloc(0);", "let buffer = Buffer.alloc(0);\nlet output;")
  .replaceAll("process.stdout.write", "output.write")
  .replace("process.stdin.on('data', (chunk) => {", "const receive = (chunk) => {")
  .replace(/\n\}\);\n$/u, "\n};\nconst { createServer } = await import('node:net');\ncreateServer((socket) => { output = socket; socket.on('data', receive); }).listen(Number(process.argv[2]), '127.0.0.1');\n");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => server.close((cause) => cause ? rejectClose(cause) : resolveClose()));
  return port;
}

test("debug output retains at most 3000 lines", () => {
  const output = boundedDebugOutput("", Array.from({ length: 3_005 }, (_, index) => `line ${index}\n`).join(""));
  const lines = output.trimEnd().split("\n");
  assert.equal(lines.length, 3_000);
  assert.equal(lines[0], "line 5");
  assert.equal(lines.at(-1), "line 3004");
});

test("DebugSession routes a non-LLDB adapter over TCP with its declared adapter id", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-debug-tcp-"));
  const program = join(temporary, "program.js"); const adapter = join(temporary, "adapter.mjs"); const log = join(temporary, "requests.jsonl"); const port = await availablePort();
  await Promise.all([writeFile(program, "console.log('ok');\n"), writeFile(adapter, tcpAdapterSource)]);
  const session = new DebugSession(() => undefined, () => ({ adapter: "pwa-node", args: [adapter, String(port)], command: process.execPath, env: { ...process.env, FAKE_REQUEST_LOG: log }, transport: { kind: "tcp", host: "127.0.0.1", port } }));
  try {
    await session.start({ program, root: temporary, stopOnEntry: true });
    assert.equal(session.snapshot().adapter, "pwa-node");
    const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { arguments?: Record<string, unknown>; command: string });
    assert.equal(requests[0]?.command, "launch");
    assert.equal(requests[0]?.arguments?.type, "pwa-node");
    assert.equal(requests[0]?.arguments?.program, program);
  } finally { session.shutdown(); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("DebugSession emits CoreCLR launch arguments for a .NET adapter", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-debug-coreclr-"));
  const program = join(temporary, "Example.dll"); const adapter = join(temporary, "adapter.mjs"); const log = join(temporary, "requests.jsonl");
  await Promise.all([writeFile(program, "fake\n"), writeFile(adapter, adapterSource)]);
  const session = new DebugSession(() => undefined, () => ({ adapter: "coreclr", args: [adapter], command: process.execPath, env: { ...process.env, FAKE_REQUEST_LOG: log } }));
  try {
    await session.start({ program, root: temporary, stopOnEntry: true });
    assert.equal(session.snapshot().adapter, "coreclr");
    const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { arguments?: Record<string, unknown>; command: string });
    assert.equal(requests[0]?.arguments?.type, "coreclr");
    assert.equal(requests[0]?.arguments?.stopAtEntry, true);
  } finally { session.shutdown(); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("DebugSession recovers debuggee output interleaved with a DAP frame", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-debug-interleaved-"));
  const program = join(temporary, "program.exe");
  const adapter = join(temporary, "adapter.mjs");
  await Promise.all([writeFile(program, "fake\n"), writeFile(adapter, adapterSource)]);
  const previous = process.env.FAKE_INTERLEAVED_STDOUT;
  process.env.FAKE_INTERLEAVED_STDOUT = "1";
  const session = new DebugSession(() => undefined, () => ({ adapter: "lldb", args: [adapter], command: process.execPath }));
  try {
    await session.start({ program, root: temporary });
    const deadline = Date.now() + 2_000;
    while (session.snapshot().state !== "terminated" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = session.snapshot();
    assert.equal(snapshot.state, "terminated");
    assert.match(snapshot.output, /Hello, World!/);
    assert.equal(snapshot.error, undefined);
  } finally {
    session.shutdown();
    if (previous === undefined) delete process.env.FAKE_INTERLEAVED_STDOUT;
    else process.env.FAKE_INTERLEAVED_STDOUT = previous;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("DebugSession forwards an isolated launch environment to the debuggee", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-debug-environment-"));
  const program = join(temporary, "program.exe");
  const adapter = join(temporary, "adapter.mjs");
  const log = join(temporary, "requests.jsonl");
  await Promise.all([writeFile(program, "fake\n"), writeFile(adapter, adapterSource)]);
  const previousLog = process.env.FAKE_REQUEST_LOG;
  process.env.FAKE_REQUEST_LOG = log;
  const session = new DebugSession(() => undefined, () => ({ adapter: "lldb", args: [adapter], command: process.execPath }));
  try {
    await session.start({ environment: { PATH: "managed-runtime-bin" }, program, root: temporary });
    const requests = (await readFile(log, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { arguments?: { env?: Record<string, string> }; command: string });
    assert.deepEqual(requests.find((request) => request.command === "launch")?.arguments?.env, { PATH: "managed-runtime-bin" });
  } finally {
    session.shutdown();
    if (previousLog === undefined) delete process.env.FAKE_REQUEST_LOG;
    else process.env.FAKE_REQUEST_LOG = previousLog;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("DebugSession ignores pause inspection requests cancelled by continue", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-debug-cancelled-pause-"));
  const program = join(temporary, "program.exe");
  const adapter = join(temporary, "adapter.mjs");
  await Promise.all([writeFile(program, "fake\n"), writeFile(adapter, adapterSource)]);
  const previous = process.env.FAKE_CANCEL_PAUSE_REFRESH;
  process.env.FAKE_CANCEL_PAUSE_REFRESH = "1";
  const states: string[] = [];
  const errors: Array<string | undefined> = [];
  const session = new DebugSession((snapshot) => { states.push(snapshot.state); errors.push(snapshot.error); }, () => ({ adapter: "lldb", args: [adapter], command: process.execPath }));
  try {
    await session.start({ program, root: temporary, stopOnEntry: true });
    const stoppedDeadline = Date.now() + 2_000;
    while (session.snapshot().selectedThreadId === undefined && Date.now() < stoppedDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(session.snapshot().state, "stopped");
    assert.equal(session.snapshot().selectedThreadId, 7);
    await session.command("continue");
    const deadline = Date.now() + 2_000;
    while (session.snapshot().state !== "terminated" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(session.snapshot().state, "terminated");
    assert.equal(session.snapshot().error, undefined);
    assert.equal(states.includes("failed"), false, states.join(", "));
    assert.equal(errors.some(Boolean), false, errors.filter(Boolean).join(", "));
  } finally {
    session.shutdown();
    if (previous === undefined) delete process.env.FAKE_CANCEL_PAUSE_REFRESH;
    else process.env.FAKE_CANCEL_PAUSE_REFRESH = previous;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("DebugSession performs DAP launch, breakpoint, stack, locals and watch flow", async () => {
  if (process.platform === "win32") return;
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-debug-"));
  const source = join(temporary, "main.cpp");
  const program = join(temporary, "program");
  const adapter = join(temporary, "adapter.mjs");
  await Promise.all([writeFile(source, "int main() { return 0; }\n"), writeFile(program, "fake\n"), writeFile(adapter, adapterSource)]);
  const previousSource = process.env.FAKE_SOURCE;
  process.env.FAKE_SOURCE = source;
  let complete!: (snapshot: DebugSnapshot) => void;
  const stopped = new Promise<DebugSnapshot>((resolve) => { complete = resolve; });
  const session = new DebugSession((snapshot) => {
    if (snapshot.state === "stopped" && snapshot.threads[0]?.frames[0]?.scopes[0]?.variables[0]) complete(snapshot);
  }, () => ({ adapter: "lldb", args: [adapter], command: process.execPath }));
  try {
    await session.setBreakpoints(source, [3]);
    await session.setExceptionFilters([]);
    await session.setWatches(["(int)a"]);
    await session.start({ program, root: temporary, stopOnEntry: true });
    const snapshot = await stopped;
    assert.equal(snapshot.output, "ready\n");
    assert.equal(snapshot.stopReason, "breakpoint");
    assert.equal(snapshot.stopReasonKind, "breakpoint");
    assert.equal(snapshot.threads[0]?.frames[0]?.name, "main");
    assert.equal(snapshot.threads[0]?.frames[0]?.instructionPointerReference, "0x1000");
    assert.equal(snapshot.threads[0]?.frames[0]?.scopes[0]?.variables[0]?.value, "42");
    assert.equal(snapshot.watches[0]?.value, "1");
    assert.equal(snapshot.watches[0]?.memoryReference, "0x2000");
    assert.equal(snapshot.threads[0]?.frames[0]?.scopes[1]?.presentationHint, "registers");
    assert.equal(snapshot.breakpoints[0]?.verified, true);
    assert.deepEqual(snapshot.exceptionFilters, []);
    const children = await session.expandVariables(10);
    assert.deepEqual(children.map((item) => [item.name, item.value]), [["member", "7"]]);
    const evaluation = await session.evaluate("(int)a");
    assert.equal(evaluation.result, "1");
    assert.equal(evaluation.memoryReference, "0x2000");
    const initialMemory = await session.readMemory("0x2000", 0, 10);
    assert.deepEqual(initialMemory.bytes, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(initialMemory.unreadableBytes, 2);
    const written = await session.writeMemory("0x2000", 2, [0xaa, 0xbb]);
    assert.equal(written.bytesWritten, 2);
    assert.deepEqual(written.bytes, [0xaa, 0xbb]);
    const instructions = await session.disassemble("0x1000");
    assert.equal(instructions[0]?.instruction, "mov eax, 42");
    assert.equal(instructions[0]?.location?.path, source);
    const instructionBreakpoints = await session.setInstructionBreakpoints(["0x1000"]);
    assert.equal(instructionBreakpoints.instructionBreakpoints[0]?.verified, true);
    const changed = await session.setVariable(9, "answer", "43");
    assert.equal(changed.state, "stopped");
    assert.equal(session.clearOutput().output, "");
    const advanced = await session.updateBreakpoint(source, 3, { condition: "answer > 40", hitCondition: ">= 2", logMessage: "answer={answer}" });
    assert.equal(advanced.breakpoints[0]?.condition, "answer > 40");
    assert.equal(advanced.breakpoints[0]?.hitCondition, ">= 2");
    assert.equal(advanced.breakpoints[0]?.logMessage, "answer={answer}");
    assert.match(advanced.breakpoints[0]?.message ?? "", /"condition":"answer > 40"/);
    const disabled = await session.updateBreakpoint(source, 3, { enabled: false });
    assert.equal(disabled.breakpoints[0]?.enabled, false);
    assert.equal(disabled.breakpoints[0]?.message, "Disabled");
    const functions = await session.setFunctionBreakpoints([{ condition: "answer > 0", name: "add" }]);
    assert.equal(functions.functionBreakpoints[0]?.verified, true);
    assert.match(functions.functionBreakpoints[0]?.message ?? "", /"name":"add"/);
    const exceptions = await session.setExceptionFilters(["cpp_throw", "unsupported"]);
    assert.deepEqual(exceptions.exceptionFilters, ["cpp_throw"]);
    assert.equal((await session.clearBreakpoints()).breakpoints.length, 0);
    await session.stop();
  } finally {
    session.shutdown();
    if (previousSource === undefined) delete process.env.FAKE_SOURCE;
    else process.env.FAKE_SOURCE = previousSource;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("DebugSession distinguishes terminating a target from detaching", async () => {
  if (process.platform === "win32") return;
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-debug-disconnect-"));
  const adapter = join(temporary, "adapter.mjs");
  const log = join(temporary, "requests.jsonl");
  await writeFile(adapter, adapterSource);
  const previousSource = process.env.FAKE_SOURCE;
  const previousLog = process.env.FAKE_REQUEST_LOG;
  process.env.FAKE_SOURCE = join(temporary, "main.cpp");
  process.env.FAKE_REQUEST_LOG = log;
  const waitUntilStopped = (session: DebugSession) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Debug session did not stop")), 5_000);
    const poll = setInterval(() => {
      if (session.snapshot().state === "stopped") { clearInterval(poll); clearTimeout(timeout); resolve(); }
    }, 20);
  });
  const createSession = () => new DebugSession(() => undefined, () => ({ adapter: "lldb", args: [adapter], command: process.execPath }));
  const stopped = createSession();
  const detached = createSession();
  try {
    await stopped.start({ mode: "attach", processId: 101, root: temporary, stopOnEntry: true });
    await waitUntilStopped(stopped);
    await stopped.stop();
    await detached.start({ mode: "attach", processId: 202, root: temporary, stopOnEntry: true });
    await waitUntilStopped(detached);
    await detached.detach();
    const disconnects = (await readFile(log, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { arguments?: { terminateDebuggee?: boolean }; command: string })
      .filter((request) => request.command === "disconnect");
    assert.deepEqual(disconnects.map((request) => request.arguments?.terminateDebuggee), [true, false]);
  } finally {
    stopped.shutdown();
    detached.shutdown();
    if (previousSource === undefined) delete process.env.FAKE_SOURCE; else process.env.FAKE_SOURCE = previousSource;
    if (previousLog === undefined) delete process.env.FAKE_REQUEST_LOG; else process.env.FAKE_REQUEST_LOG = previousLog;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("DebugSession maps LLDB core dumps and enforces read-only sessions", async () => {
  if (process.platform === "win32") return;
  const temporary = await mkdtemp(join(tmpdir(), "agent-k-dump-"));
  const source = join(temporary, "main.cpp");
  const program = join(temporary, "program");
  const core = join(temporary, "program.core");
  const symbols = join(temporary, "symbols");
  const adapter = join(temporary, "adapter.mjs");
  const log = join(temporary, "requests.jsonl");
  await mkdir(symbols);
  await Promise.all([writeFile(source, "int main() { return 0; }\n"), writeFile(program, "fake\n"), writeFile(core, "core\n"), writeFile(adapter, adapterSource)]);
  const previousSource = process.env.FAKE_SOURCE;
  const previousLog = process.env.FAKE_REQUEST_LOG;
  process.env.FAKE_SOURCE = source;
  process.env.FAKE_REQUEST_LOG = log;
  let complete!: (snapshot: DebugSnapshot) => void;
  const stopped = new Promise<DebugSnapshot>((resolve) => { complete = resolve; });
  const session = new DebugSession((snapshot) => {
    if (snapshot.state === "stopped" && snapshot.threads[0]?.frames[0]?.scopes.length) complete(snapshot);
  }, () => ({ adapter: "lldb", args: [adapter], command: process.execPath }));
  try {
    await session.start({ dumpPath: core, mode: "dump", program, root: temporary, sourceMap: { "/build/src": temporary }, symbolPaths: [symbols] });
    const snapshot = await stopped;
    assert.equal(snapshot.sessionKind, "dump");
    await assert.rejects(() => session.command("continue"), /read-only/);
    await assert.rejects(() => session.writeMemory("0x2000", 0, [1]), /read-only/);
    await assert.rejects(() => session.setVariable(12, "rax", "0"), /read-only/);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { arguments: Record<string, unknown>; command: string });
    const attach = requests.find((request) => request.command === "attach");
    assert.deepEqual(attach?.arguments.processCreateCommands, []);
    assert.deepEqual(attach?.arguments.sourceMap, { "/build/src": temporary });
    assert.match(String((attach?.arguments.targetCreateCommands as string[] | undefined)?.[0]), /target create --core/);
    await session.stop();
  } finally {
    session.shutdown();
    if (previousSource === undefined) delete process.env.FAKE_SOURCE; else process.env.FAKE_SOURCE = previousSource;
    if (previousLog === undefined) delete process.env.FAKE_REQUEST_LOG; else process.env.FAKE_REQUEST_LOG = previousLog;
    await rm(temporary, { recursive: true, force: true });
  }
});
