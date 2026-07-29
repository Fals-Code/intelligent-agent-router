import type { SkillExecutor } from "./skill-executor.js";

export class ExecutorRegistry {
  private readonly executors = new Map<string, SkillExecutor>();

  register(executor: SkillExecutor): this {
    if (this.executors.has(executor.skillId)) {
      throw new Error(`Executor already registered for skill ${executor.skillId}`);
    }
    this.executors.set(executor.skillId, executor);
    return this;
  }

  registerAll(executors: Iterable<SkillExecutor>): this {
    for (const executor of executors) this.register(executor);
    return this;
  }

  resolve(skillId: string): SkillExecutor | undefined {
    return this.executors.get(skillId);
  }
}
