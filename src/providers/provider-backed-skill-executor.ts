import type { RouteStep } from "../domain/types.js";
import type { ExecutionContext } from "../execution/execution-context.js";
import type { ExecutionAttemptResult } from "../execution/execution-result.js";
import type { SkillExecutor } from "../execution/skill-executor.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { ModelResolver } from "./model-resolution.js";
import type { ModelProviderRequest } from "./provider-request.js";
import { isProviderError } from "./provider-errors.js";

export class ProviderBackedSkillExecutor implements SkillExecutor {
  constructor(
    public readonly skillId: string,
    private readonly providerRegistry: ProviderRegistry,
    private readonly modelResolver: ModelResolver,
    private readonly supportedSkillIds: ReadonlySet<string> = new Set([skillId]),
  ) {}

  canHandle(step: RouteStep): boolean {
    return step.skillIds.some((id) => this.supportedSkillIds.has(id));
  }

  async execute(step: RouteStep, context: ExecutionContext): Promise<ExecutionAttemptResult> {
    if (!context.currentModelId) {
      return { error: { name: "ModelResolutionError", message: "currentModelId is required for provider execution", retryable: false, code: "MISSING_CURRENT_MODEL_ID" } };
    }
    const internalModelId = context.currentModelId;
    try {
      const resolved = this.modelResolver.resolve(internalModelId);
      const providerRequest: ModelProviderRequest = {
        providerId: resolved.providerId,
        internalModelId,
        providerModelId: resolved.providerModelId,
        messages: [{ role: "user", content: context.prompt }],
        systemInstruction: "Respond only with the requested result.",
        traceId: context.traceId,
        stepId: step.id,
        skillId: this.skillId,
        signal: context.signal,
        metadata: {
          traceId: context.traceId,
          stepId: step.id,
          skillId: this.skillId,
        },
      };
      const provider = this.providerRegistry.resolveSupporting(providerRequest);
      const result = await provider.generate(providerRequest);
      if ("error" in result) return { error: result.error };
      return {
        output: {
          providerId: result.providerId,
          internalModelId: result.internalModelId,
          providerModelId: result.providerModelId,
          outputText: result.outputText,
          structuredOutput: result.structuredOutput,
          finishReason: result.finishReason,
          usage: result.usage,
          latencyMs: result.latencyMs,
          requestId: result.requestId,
        },
      };
    } catch (error) {
      if (isProviderError(error)) return { error };
      return {
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          code: "PROVIDER_EXECUTION_ERROR",
        },
      };
    }
  }
}
