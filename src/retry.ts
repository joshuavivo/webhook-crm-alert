// Retry an outbound call with exponential backoff. Sleep is injected so tests run instantly.

export type RetryOptions = {
  attempts: number; // total tries, including the first
  baseDelayMs: number; // delay before the 2nd try; doubles each time
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  // Return false for errors that will never succeed on retry (a 400, a validation error).
  isRetryable?: (err: unknown) => boolean;
};

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RetriesExhausted extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  constructor(attempts: number, lastError: unknown) {
    super(`gave up after ${attempts} attempt(s): ${errorMessage(lastError)}`);
    this.name = "RetriesExhausted";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function backoffDelays(opts: Pick<RetryOptions, "attempts" | "baseDelayMs" | "maxDelayMs">): number[] {
  const delays: number[] = [];
  for (let i = 0; i < opts.attempts - 1; i++) delays.push(Math.min(opts.baseDelayMs * 2 ** i, opts.maxDelayMs));
  return delays;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const delays = backoffDelays(opts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (opts.isRetryable && !opts.isRetryable(err)) throw new RetriesExhausted(attempt, err);
      if (attempt < opts.attempts) await opts.sleep(delays[attempt - 1]);
    }
  }
  throw new RetriesExhausted(opts.attempts, lastError);
}
