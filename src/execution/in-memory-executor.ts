import type { RouteStep } from "../domain/types.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ExecutionAttemptResult } from "./execution-result.js";
import type { SkillExecutor } from "./skill-executor.js";

export class InMemorySkillExecutor implements SkillExecutor {
  constructor(
    public readonly skillId: string,
    private readonly handler: (step: RouteStep, context: ExecutionContext) => Promise<ExecutionAttemptResult> | ExecutionAttemptResult,
  ) {}

  canHandle(step: RouteStep): boolean {
    return step.skillIds.includes(this.skillId);
  }

  async execute(step: RouteStep, context: ExecutionContext): Promise<ExecutionAttemptResult> {
    return this.handler(step, context);
  }
}
