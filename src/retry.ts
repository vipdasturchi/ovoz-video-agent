export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  label?: string;
  /** Return false to fail immediately without retrying (e.g. a 4xx that will never succeed). Defaults to always-retryable. */
  isRetryable?: (err: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries a transient (network/5xx) failure with exponential backoff. Does not retry on the last attempt — the caller sees the real error. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 1000, label = "operation", isRetryable = () => true } = opts;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryable(err)) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.error(`[retry] ${label} muvaffaqiyatsiz (urinish ${attempt}/${attempts}), ${delay}ms dan so'ng qayta urinamiz:`, err);
      await sleep(delay);
    }
  }

  throw lastErr;
}
