import type { NormalizedExecutionError } from "./execution-result.js";

export interface RetryPolicy {
  shouldRetry(error: NormalizedExecutionError, attempt: number, maxAttempts: number): boolean;
  getDelayMs(attempt: number): number;
}

export interface RetryPolicyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export class DefaultRetryPolicy implements RetryPolicy {
  constructor(private readonly options: RetryPolicyOptions = {}) {}

  shouldRetry(error: NormalizedExecutionError, attempt: number, maxAttempts: number): boolean {
    if (!error.retryable) return false;
    if (attempt >= maxAttempts) return false;
    return true;
  }

  getDelayMs(attempt: number): number {
    const base = this.options.baseDelayMs ?? 50;
    const max = this.options.maxDelayMs ?? 1_000;
    return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  }
}
