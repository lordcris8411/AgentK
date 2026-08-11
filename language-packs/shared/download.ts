function retryableStatus(status: number): boolean { return status === 408 || status === 429 || status >= 500; }

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Download cancelled")); return; }
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, delayMs);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Download cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    init.signal?.throwIfAborted();
    try {
      const response = await fetch(url, init);
      if (!retryableStatus(response.status) || attempt === attempts - 1) return response;
      await response.body?.cancel().catch(() => undefined);
      lastError = new Error(`Transient download response: HTTP ${response.status}`);
    } catch (cause) {
      if (init.signal?.aborted || attempt === attempts - 1) throw cause;
      lastError = cause;
    }
    await wait(500 * 2 ** attempt, init.signal ?? undefined);
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed");
}

function transientNetworkError(cause: unknown): boolean {
  if (cause instanceof TypeError) return true;
  if (!cause || typeof cause !== "object") return false;
  const value = cause as { cause?: unknown; code?: unknown };
  return typeof value.code === "string" && /^(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|UND_ERR_)/u.test(value.code)
    || transientNetworkError(value.cause);
}

export async function withNetworkRetry<T>(operation: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (cause) {
      if (signal?.aborted || attempt >= attempts - 1 || !transientNetworkError(cause)) throw cause;
      await wait(500 * 2 ** attempt, signal);
    }
  }
}
