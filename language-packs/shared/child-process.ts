import type { ChildProcessWithoutNullStreams } from "node:child_process";

function exited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(exited(child)), timeoutMs);
    child.once("close", onClose);
  });
}

export async function stopChildProcess(child: ChildProcessWithoutNullStreams, label: string): Promise<void> {
  if (exited(child)) return;
  child.stdin.end();
  if (await waitForExit(child, 1_000)) return;
  child.kill();
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (await waitForExit(child, 5_000)) return;
  throw new Error(`${label} did not exit after shutdown`);
}
