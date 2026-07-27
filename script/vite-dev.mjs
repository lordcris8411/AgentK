import process from "node:process";
import { createServer } from "vite";

const ownerPid = Number(process.argv[2]);
if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
  console.error("Vite development server requires its Agent K launcher PID.");
  process.exit(1);
}

const server = await createServer({
  server: { host: "127.0.0.1" },
});

let closing = false;
let ownerWatch;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  if (ownerWatch) clearInterval(ownerWatch);
  try {
    await server.close();
  } finally {
    // This process exists only to own Vite. Some development plugins retain
    // file-watcher handles briefly after close(), so do not leave an idle
    // orphan behind once the listening server has shut down.
    process.exit(code);
  }
}

for (const signal of process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.once(signal, () => void close());
}

await server.listen();
server.printUrls();

ownerWatch = setInterval(() => {
  try {
    process.kill(ownerPid, 0);
  } catch {
    void close();
    return;
  }
  // On Unix an orphan is immediately reparented. This detects PID reuse as
  // well as a launcher that disappeared between liveness probes.
  if (process.platform !== "win32" && process.ppid !== ownerPid) void close();
}, 250);
