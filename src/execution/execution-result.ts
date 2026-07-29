import type { RouteStepExecutionMetadata } from "../domain/types.js";

export type ExecutionStepStatus = "pending" | "running" | "succeeded" | "failed" | "timed_out" | "blocked" | "skipped";

export interface NormalizedExecutionError {
  name: string;
  message: string;
  code?: string;
  retryable: boolean;
  reason?: string;
}

export interface ExecutionAttemptResult {
  output?: unknown;
  error?: NormalizedExecutionError;
}

export interface ExecutionAttemptTrace {
  attempt: number;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: ExecutionStepStatus;
  output?: unknown;
  error?: NormalizedExecutionError;
}

export interface ExecutionStepTrace {
  stepId: string;
  skillId: string;
  modelId: string;
  status: ExecutionStepStatus;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output?: unknown;
  error?: NormalizedExecutionError;
  attempts: ExecutionAttemptTrace[];
  metadata: Readonly<RouteStepExecutionMetadata>;
}

export interface ExecutionResult {
  traceId: string;
  status: "succeeded" | "failed" | "blocked" | "timed_out";
  outputs: Record<string, unknown>;
  trace: ExecutionStepTrace[];
}
