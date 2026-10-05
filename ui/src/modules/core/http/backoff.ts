export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  random?: () => number;
};

export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 30_000;
  const jitter = options.jitter ?? 0.2;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, Math.floor(attempt));
  const exponential = Math.min(maxMs, baseMs * 2 ** exponent);
  const spread = exponential * Math.max(0, jitter);
  return Math.max(0, Math.round(exponential - spread + random() * spread * 2));
}

export function waitForBackoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
