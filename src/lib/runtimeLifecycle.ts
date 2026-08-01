export type RuntimeShutdownOperations = {
  abort(runtimeId: string): Promise<void>;
  cancelPending(runtimeId: string): Promise<void>;
  clearSessionUi(runtimeId: string): void;
  close(runtimeId: string): Promise<void>;
};

export function isClosedPiRpcError(cause: unknown): boolean {
  return /Pi RPC connection (?:is )?closed/i.test(String(cause));
}

/**
 * Stops a renderer-owned Pi runtime without racing an in-flight abort request
 * against closing its RPC transport.
 */
export async function shutdownRuntime(
  runtimeId: string,
  operations: RuntimeShutdownOperations,
): Promise<void> {
  await operations.cancelPending(runtimeId);
  operations.clearSessionUi(runtimeId);

  let abortFailure: unknown;
  try {
    await operations.abort(runtimeId);
  } catch (cause) {
    // The worker may already have exited by the time an explicit teardown
    // starts. Closing an already-dead runtime is still a successful teardown.
    if (!isClosedPiRpcError(cause)) abortFailure = cause;
  }

  await operations.close(runtimeId);
  if (abortFailure !== undefined) throw abortFailure;
}
