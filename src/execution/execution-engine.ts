import type { RoutingDecision, RouteStep } from "../domain/types.js";
import type { ExecutionContext } from "./execution-context.js";
import { createExecutionContext } from "./execution-context.js";
import type { ExecutionAttemptResult, ExecutionResult, ExecutionStepTrace, ExecutionStepStatus, NormalizedExecutionError } from "./execution-result.js";
import type { RetryPolicy } from "./retry-policy.js";
import { DefaultRetryPolicy } from "./retry-policy.js";
import type { SkillExecutor } from "./skill-executor.js";
import { ExecutorRegistry } from "./executor-registry.js";

export interface ExecutionEngineOptions {
  registry: ExecutorRegistry;
  retryPolicy?: RetryPolicy;
  now?: () => number;
  createTraceId?: () => string;
  maxAttempts?: number;
}

export interface RunPlanInput {
  prompt: string;
  decision: RoutingDecision;
  metadata?: Record<string, string | number | boolean | null>;
  signal?: AbortSignal;
  approvedStepIds?: Iterable<string>;
}

export class ExecutionEngine {
  private readonly retryPolicy: RetryPolicy;
  constructor(private readonly options: ExecutionEngineOptions) {
    this.retryPolicy = options.retryPolicy ?? new DefaultRetryPolicy();
  }

  async run(input: RunPlanInput): Promise<ExecutionResult> {
    const traceId = this.resolveTraceId(input.decision.traceId);
    const outputs = new Map<string, unknown>();
    const trace: ExecutionStepTrace[] = [];
    const context = createExecutionContext({
      prompt: input.prompt,
      traceId,
      decision: input.decision,
      metadata: input.metadata,
      signal: input.signal,
      approvedStepIds: input.approvedStepIds,
    });
    const steps = input.decision.plan;
    const completed = new Set<string>();
    const failed = new Set<string>();
    const timedOut = new Set<string>();
    const blocked = new Set<string>();
    const skipped = new Set<string>();

    while (completed.size + failed.size + timedOut.size + blocked.size + skipped.size < steps.length) {
      const ready = steps.filter((step) => !completed.has(step.id) && !failed.has(step.id) && !timedOut.has(step.id) && !blocked.has(step.id) && !skipped.has(step.id) && step.dependsOn.every((id) => completed.has(id)));
      if (ready.length === 0) {
        for (const step of steps) {
          if (completed.has(step.id) || failed.has(step.id) || timedOut.has(step.id) || blocked.has(step.id) || skipped.has(step.id)) continue;
          if (step.dependsOn.some((id) => failed.has(id) || blocked.has(id))) {
            skipped.add(step.id);
            trace.push(this.skippedTrace(step, "dependency-failed", context));
          }
        }
        break;
      }
      const groups = this.groupReadySteps(ready);
      for (const group of groups) {
        const batch = await Promise.all(group.map(async (step) => ({ step, result: await this.runStep(step, context, outputs) })));
        for (const item of batch) {
          trace.push(item.result.trace);
          if (item.result.status === "succeeded") {
            completed.add(item.step.id);
            outputs.set(item.step.id, item.result.output);
          } else if (item.result.status === "blocked") {
            blocked.add(item.step.id);
          } else if (item.result.status === "timed_out") {
            timedOut.add(item.step.id);
          } else if (item.result.status === "failed") {
            failed.add(item.step.id);
          }
        }
      }
    }

    const finalStatus = blocked.size > 0 ? "blocked" : timedOut.size > 0 ? "timed_out" : failed.size > 0 ? "failed" : "succeeded";
    return { traceId: context.traceId, status: finalStatus, outputs: Object.fromEntries(outputs), trace };
  }

  private groupReadySteps(steps: RouteStep[]): RouteStep[][] {
    const groups = new Map<string, RouteStep[]>();
    for (const step of steps) {
      const key = step.parallelGroup ?? `__${step.id}`;
      const group = groups.get(key);
      if (group) group.push(step);
      else groups.set(key, [step]);
    }
    return [...groups.values()];
  }

  private async runStep(step: RouteStep, context: ExecutionContext, outputs: Map<string, unknown>): Promise<{ status: ExecutionStepStatus; output?: unknown; trace: ExecutionStepTrace }> {
    const startedAt = this.nowIso();
    const stepNow = this.options.now ?? Date.now;
    const maxAttempts = step.maxAttempts ?? this.options.maxAttempts ?? 3;
    const attempts: ExecutionStepTrace["attempts"] = [];
    const approved = !step.humanApprovalRequired || context.approvedStepIds.has(step.id);
    if (!approved) {
      const error = this.normalizeError(new Error("Human approval required"), false, "APPROVAL_REQUIRED");
      const finishedAt = this.nowIso();
      const trace = this.buildTrace(step, "blocked", 0, startedAt, finishedAt, error, attempts, context);
      return { status: "blocked", trace };
    }
    const executor = this.resolveExecutor(step, context);
    if (!executor) {
      const error = this.normalizeError(new Error(`No executor available for skill ${step.skillIds[0] ?? "unknown"}`), false, "EXECUTOR_NOT_FOUND");
      const finishedAt = this.nowIso();
      const trace = this.buildTrace(step, "failed", 0, startedAt, finishedAt, error, attempts, context);
      return { status: "failed", trace };
    }
    const modelIds = this.resolveModelIds(step, context.decision);
    let attempt = 0;
    let lastError: NormalizedExecutionError | undefined;
    while (attempt < maxAttempts) {
      attempt += 1;
      const modelId = modelIds[Math.min(attempt - 1, modelIds.length - 1)] ?? step.modelId;
      const attemptedStep: RouteStep = { ...step, modelId };
      const attemptStarted = stepNow();
      const attemptStartedIso = new Date(attemptStarted).toISOString();
      const timeoutState = this.createTimeoutSignal(step.timeoutMs, context.signal);
      try {
        const executionPromise = executor.execute(attemptedStep, { ...context, currentModelId: modelId, previousOutput: this.buildPreviousOutput(outputs), signal: timeoutState.signal });
        const wrappedExecution = executionPromise.then((value) => ({ kind: "result" as const, value })).catch((error) => ({ kind: "error" as const, error }));
        const outcome = timeoutState.timeoutPromise ? await Promise.race([wrappedExecution, timeoutState.timeoutPromise]) : await wrappedExecution;
        timeoutState.cleanup();
        const attemptFinished = stepNow();
        const elapsed = attemptFinished - attemptStarted;
        if (typeof step.timeoutMs === "number" && step.timeoutMs > 0 && elapsed >= step.timeoutMs) {
          const normalized = this.normalizeError(new Error("Step timed out"), false, "TIMEOUT");
          lastError = normalized;
          attempts.push(this.buildAttempt(attempt, modelId, "timed_out", attemptStartedIso, new Date(attemptFinished).toISOString(), elapsed, undefined, normalized));
          const finishedAt = this.nowIso();
          const trace = this.buildTrace(attemptedStep, "timed_out", attempt, startedAt, finishedAt, normalized, attempts, context);
          return { status: "timed_out", trace };
        }
        if ("kind" in outcome && outcome.kind === "timeout") {
          const normalized = this.normalizeError(new Error("Step timed out"), false, "TIMEOUT");
          lastError = normalized;
          attempts.push(this.buildAttempt(attempt, modelId, "timed_out", attemptStartedIso, new Date(attemptFinished).toISOString(), elapsed, undefined, normalized));
          const finishedAt = this.nowIso();
          const trace = this.buildTrace(attemptedStep, "timed_out", attempt, startedAt, finishedAt, normalized, attempts, context);
          return { status: "timed_out", trace };
        }
        if ("kind" in outcome && outcome.kind === "result") {
          const stepResult = outcome.value as ExecutionAttemptResult;
          if (stepResult.error) {
            const normalized = this.normalizeError(stepResult.error, stepResult.error.retryable, stepResult.error.code);
            lastError = normalized;
            const status = normalized.code === "TIMEOUT" ? "timed_out" : "failed";
            attempts.push(this.buildAttempt(attempt, modelId, status, attemptStartedIso, new Date(attemptFinished).toISOString(), elapsed, stepResult.output, normalized));
            if (status === "timed_out") {
              const finishedAt = this.nowIso();
              const trace = this.buildTrace(attemptedStep, "timed_out", attempt, startedAt, finishedAt, normalized, attempts, context, stepResult.output);
              return { status: "timed_out", trace };
            }
            if (!this.retryPolicy.shouldRetry(normalized, attempt, maxAttempts)) break;
            await this.delay(this.retryPolicy.getDelayMs(attempt));
            continue;
          }
          attempts.push(this.buildAttempt(attempt, modelId, "succeeded", attemptStartedIso, new Date(attemptFinished).toISOString(), elapsed, stepResult.output, undefined));
          const finishedAt = this.nowIso();
          const trace = this.buildTrace(attemptedStep, "succeeded", attempt, startedAt, finishedAt, undefined, attempts, context, stepResult.output);
          return { status: "succeeded", output: stepResult.output, trace };
        }
        if ("kind" in outcome && outcome.kind === "error") {
          const timedOut = timeoutState.timedOut || timeoutState.signal.aborted || this.isTimeoutError(outcome.error) || this.elapsedExceedsDeadline(attemptStarted, step.timeoutMs, stepNow);
          const normalized = this.normalizeError(outcome.error, !timedOut, timedOut ? "TIMEOUT" : undefined);
          lastError = normalized;
          const status = normalized.code === "TIMEOUT" ? "timed_out" : "failed";
          attempts.push(this.buildAttempt(attempt, modelId, status, attemptStartedIso, new Date(attemptFinished).toISOString(), attemptFinished - attemptStarted, undefined, normalized));
          if (status === "timed_out") {
            const finishedAt = this.nowIso();
            const trace = this.buildTrace(attemptedStep, "timed_out", attempt, startedAt, finishedAt, normalized, attempts, context);
            return { status: "timed_out", trace };
          }
          if (!this.retryPolicy.shouldRetry(normalized, attempt, maxAttempts)) break;
          await this.delay(this.retryPolicy.getDelayMs(attempt));
        }
      } catch (error) {
        timeoutState.cleanup();
        const timedOut = timeoutState.timedOut || timeoutState.signal.aborted || this.isTimeoutError(error) || this.elapsedExceedsDeadline(attemptStarted, step.timeoutMs, stepNow);
        const normalized = this.normalizeError(error, !timedOut, timedOut ? "TIMEOUT" : undefined);
        lastError = normalized;
        const attemptFinished = stepNow();
        const status = timedOut ? "timed_out" : "failed";
        attempts.push(this.buildAttempt(attempt, modelId, status, attemptStartedIso, new Date(attemptFinished).toISOString(), attemptFinished - attemptStarted, undefined, normalized));
        if (timedOut) {
          const finishedAt = this.nowIso();
          const trace = this.buildTrace(attemptedStep, "timed_out", attempt, startedAt, finishedAt, normalized, attempts, context);
          return { status: "timed_out", trace };
        }
        if (!this.retryPolicy.shouldRetry(normalized, attempt, maxAttempts)) break;
        await this.delay(this.retryPolicy.getDelayMs(attempt));
      }
    }
    const finishedAt = this.nowIso();
    const trace = this.buildTrace(step, "failed", attempt, startedAt, finishedAt, lastError, attempts, context);
    return { status: "failed", trace };
  }

  private resolveExecutor(step: RouteStep, context: ExecutionContext): SkillExecutor | undefined {
    for (const skillId of step.skillIds) {
      const executor = this.options.registry.resolve(skillId);
      if (executor && executor.canHandle(step, context)) return executor;
    }
    return undefined;
  }

  private resolveModelIds(step: RouteStep, decision: RoutingDecision): string[] {
    const fallbacks = decision.fallbackModels.map((item) => item.candidate.id);
    return [step.modelId, ...fallbacks].filter((value, index, values) => values.indexOf(value) === index);
  }

  private buildPreviousOutput(outputs: Map<string, unknown>): unknown {
    const last = [...outputs.values()].at(-1);
    return last;
  }

  private skippedTrace(step: RouteStep, reason: string, context: ExecutionContext): ExecutionStepTrace {
    const startedAt = this.nowIso();
    return this.buildTrace(step, "skipped", 0, startedAt, startedAt, { name: "DependencySkipped", message: reason, retryable: false }, [], context);
  }

  private buildTrace(
    step: RouteStep,
    status: ExecutionStepStatus,
    attempt: number,
    startedAt: string,
    finishedAt: string,
    error: NormalizedExecutionError | undefined,
    attempts: ExecutionStepTrace["attempts"],
    context: ExecutionContext,
    output?: unknown,
  ): ExecutionStepTrace {
    return {
      stepId: step.id,
      skillId: step.skillIds[0] ?? "unknown",
      modelId: step.modelId,
      status,
      attempt,
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      output: this.sanitize(output),
      error: this.sanitize(error) as NormalizedExecutionError | undefined,
      attempts,
      metadata: this.sanitize(context.metadata) as ExecutionStepTrace["metadata"],
    };
  }

  private buildAttempt(
    attempt: number,
    modelId: string,
    status: ExecutionStepStatus,
    startedAt: string,
    finishedAt: string,
    durationMs: number,
    output?: unknown,
    error?: NormalizedExecutionError,
  ) {
    return { attempt, modelId, status, startedAt, finishedAt, durationMs, output: this.sanitize(output), error: this.sanitize(error) as NormalizedExecutionError | undefined };
  }

  private normalizeError(error: unknown, retryable: boolean, code?: string): NormalizedExecutionError {
    if (this.isNormalizedError(error)) return { ...error, retryable: error.retryable && retryable };
    if (error instanceof Error) return { name: error.name, message: error.message, retryable, code };
    return { name: "Error", message: String(error), retryable, code };
  }

  private isNormalizedError(value: unknown): value is NormalizedExecutionError {
    return Boolean(value && typeof value === "object" && "name" in value && "message" in value && "retryable" in value);
  }

  private sanitize(value: unknown): unknown {
    if (typeof value === "string") return this.sanitizeString(value);
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (this.isSensitiveKey(key)) return [key, "[redacted]"] as const;
      return [key, this.sanitize(item)] as const;
    });
    return Object.fromEntries(entries);
  }

  private sanitizeString(value: string): string {
    return /\b(api[_-]?key|access[_-]?token|authorization|password|secret|credential)\s*[:=]/i.test(value)
      ? "[redacted]"
      : value;
  }

  private isSensitiveKey(key: string): boolean {
    const normalized = key.replace(/[_\-\s]+/g, "").toLowerCase();
    return (
      normalized.includes("apikey") ||
      normalized.includes("accesstoken") ||
      normalized === "authorization" ||
      normalized.includes("password") ||
      normalized.includes("secret") ||
      normalized.includes("credential") ||
      normalized.includes("token")
    );
  }

  private createTimeoutSignal(timeoutMs: number | undefined, parent: AbortSignal): { signal: AbortSignal; cleanup: () => void; timedOut: boolean; timeoutPromise?: Promise<{ kind: "timeout" }> } {
    if (!timeoutMs || timeoutMs <= 0) return { signal: parent, cleanup: () => undefined, timedOut: false };
    const controller = new AbortController();
    let timedOut = false;
    const timeoutError = new Error("Step timed out");
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
    }, timeoutMs);
    let timeoutPromiseTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", onAbort, { once: true });
    return {
      signal: controller.signal,
      timeoutPromise: new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutPromiseTimer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
      cleanup: () => {
        clearTimeout(timeout);
        if (timeoutPromiseTimer) clearTimeout(timeoutPromiseTimer);
        parent.removeEventListener("abort", onAbort);
      },
      get timedOut() {
        return timedOut;
      },
    };
  }

  private isTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.message === "Step timed out";
  }

  private elapsedExceedsDeadline(startedAt: number, timeoutMs: number | undefined, now: () => number): boolean {
    return typeof timeoutMs === "number" && timeoutMs > 0 ? now() - startedAt >= timeoutMs : false;
  }

  private resolveTraceId(traceId?: string): string {
    const normalized = traceId?.trim();
    if (normalized) return normalized;
    if (this.options.createTraceId) return this.options.createTraceId();
    return globalThis.crypto.randomUUID();
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}
