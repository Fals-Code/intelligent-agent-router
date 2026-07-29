import type { RoutingDecision, RouteStep, RouteStepExecutionMetadata } from "../domain/types.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ExecutionAttemptResult } from "./execution-result.js";

export interface SkillExecutor {
  readonly skillId: string;
  canHandle(step: RouteStep, context: ExecutionContext): boolean;
  execute(step: RouteStep, context: ExecutionContext): Promise<ExecutionAttemptResult>;
}

export interface StepExecutionInput {
  readonly step: RouteStep;
  readonly decision: RoutingDecision;
  readonly context: ExecutionContext;
  readonly previousOutputs: ReadonlyMap<string, unknown>;
  readonly metadata: Readonly<RouteStepExecutionMetadata>;
}
