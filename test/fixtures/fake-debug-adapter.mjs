let buffer = Buffer.alloc(0);
let startRequest;

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function response(request, body = {}) {
  send({ body, command: request.command, request_seq: request.seq, seq: 1_000 + request.seq, success: true, type: "response" });
}

function handle(request) {
  if (request.command === "initialize") return response(request, {
    supportsConfigurationDoneRequest: true,
    supportsDisassembleRequest: true,
    supportsInstructionBreakpoints: true,
    supportsReadMemoryRequest: true,
    supportsSetVariable: true,
    supportsWriteMemoryRequest: true,
  });
  if (request.command === "launch" || request.command === "attach") {
    startRequest = request;
    send({ event: "initialized", seq: 20, type: "event" });
    return;
  }
  if (request.command === "configurationDone") {
    response(request);
    response(startRequest);
    setTimeout(() => send({ body: { reason: "breakpoint", threadId: 1 }, event: "stopped", seq: 21, type: "event" }), 120);
    return;
  }
  if (request.command === "threads") return response(request, { threads: [{ id: 1, name: "main" }] });
  if (request.command === "stackTrace") return response(request, { stackFrames: [{ id: 1, instructionPointerReference: "0x1000", line: 1, name: "main", source: { path: process.env.AGENT_K_E2E_SOURCE } }] });
  if (request.command === "scopes") return response(request, { scopes: [{ expensive: false, name: "Locals", variablesReference: 3 }] });
  if (request.command === "variables") {
    if (request.arguments.variablesReference === 2) return response(request, { variables: [{ name: "rax", type: "uint64", value: "0x2a", variablesReference: 0 }] });
    if (request.arguments.variablesReference === 4) return response(request, { variables: [{ memoryReference: "0x3000", name: "*$1", type: "int", value: "42", variablesReference: 0 }] });
    return response(request, { variables: [
      { evaluateName: "answer", memoryReference: "0x2000", name: "answer", type: "int", value: "42", variablesReference: 0 },
      { evaluateName: "pointer", memoryReference: "0x3000", name: "pointer", type: "int *", value: "42", variablesReference: 4 },
      { name: "General Purpose Registers", value: "{rax: 0x2a}", variablesReference: 2 },
    ] });
  }
  if (request.command === "evaluate") {
    if (request.arguments.expression === "pointer") return response(request, { memoryReference: "0x3000", result: "42", type: "int *", variablesReference: 4 });
    if (request.arguments.expression === "&(pointer)") return response(request, { memoryReference: "0x4000", result: "0x3000", type: "int **", variablesReference: 0 });
    if (request.arguments.expression === "&answer") return response(request, { memoryReference: "0x2000", result: "42", type: "int *", variablesReference: 0 });
    return response(request, { memoryReference: "0x2000", result: "42", type: "int", variablesReference: 0 });
  }
  if (request.command === "readMemory") return response(request, { address: request.arguments.memoryReference, data: Buffer.alloc(request.arguments.count, 0x41).toString("base64") });
  if (request.command === "disassemble") return response(request, { instructions: [{ address: "0x1000", instruction: "ret", instructionBytes: "c3", symbol: "main" }] });
  if (request.command === "setVariable") return response(request, { value: request.arguments.value });
  if (request.command === "setBreakpoints" || request.command === "setFunctionBreakpoints" || request.command === "setInstructionBreakpoints") return response(request, { breakpoints: [] });
  if (request.command === "disconnect") { response(request); setTimeout(() => process.exit(0), 5); return; }
  response(request);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"))?.[1]);
    const end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const request = JSON.parse(buffer.subarray(headerEnd + 4, end).toString("utf8"));
    buffer = buffer.subarray(end);
    handle(request);
  }
});
