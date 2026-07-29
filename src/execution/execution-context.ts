import type { RoutingDecision, RouteStepExecutionMetadata } from "../domain/types.js";

export interface ExecutionContext {
  readonly prompt: string;
  readonly traceId: string;
  readonly decision: RoutingDecision;
  readonly executionPlan: RoutingDecision["plan"];
  readonly currentModelId?: string;
  readonly previousOutput?: unknown;
  readonly metadata: Readonly<RouteStepExecutionMetadata>;
  readonly signal: AbortSignal;
  readonly approvedStepIds: ReadonlySet<string>;
}

export interface ExecutionContextFactoryInput {
  readonly prompt: string;
  readonly traceId: string;
  readonly decision: RoutingDecision;
  readonly currentModelId?: string;
  readonly previousOutput?: unknown;
  readonly metadata?: RouteStepExecutionMetadata;
  readonly signal?: AbortSignal;
  readonly approvedStepIds?: Iterable<string>;
}

export function createExecutionContext(input: ExecutionContextFactoryInput): ExecutionContext {
  const controller = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason);
    else input.signal.addEventListener("abort", () => controller.abort(input.signal?.reason), { once: true });
  }

  return {
    prompt: input.prompt,
    traceId: input.traceId,
    decision: input.decision,
    executionPlan: input.decision.plan,
    currentModelId: input.currentModelId,
    previousOutput: input.previousOutput,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    signal: controller.signal,
    approvedStepIds: new Set(input.approvedStepIds ?? []),
  };
}
