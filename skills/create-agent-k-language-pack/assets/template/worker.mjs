const projects = new Map();
function agent(input) {
  if (input.action === "project.list") return [...projects.values()];
  if (typeof input.workspace !== "string") throw new Error("workspace is required");
  if (input.action === "project.status") return projects.get(input.workspace) ?? { root: input.workspace, status: "stopped" };
  if (input.action === "project.load") { const project = { root: input.workspace, status: "ready" }; projects.set(input.workspace, project); return project; }
  if (input.action === "project.unload") return projects.delete(input.workspace);
  throw new Error(`Action is scaffolded but not implemented: ${input.action}`);
}
process.on("message", (message) => {
  if (message?.type !== "request" || typeof message.id !== "number") return;
  try {
    const argument = message.args?.[0] ?? {};
    const result = message.method === "initialize" || message.method === "shutdown" ? undefined : message.method === "list" ? [...projects.values()] : message.method === "agent" ? agent(argument) : (() => { throw new Error(`Unknown worker method: ${message.method}`); })();
    process.send?.({ type: "response", id: message.id, result });
    if (message.method === "shutdown") process.disconnect?.();
  } catch (cause) { process.send?.({ type: "response", id: message.id, error: cause instanceof Error ? cause.message : String(cause) }); }
});
