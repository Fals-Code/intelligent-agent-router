import type { ModelProfile, RankedCandidate, TaskAnalysis } from "../domain/types.js";
import { clamp, complexityRank, overlapRatio, privacyRank } from "../utils/rank.js";

export class ModelRouter {
  constructor(private readonly models: ModelProfile[]) {}

  rank(task: TaskAnalysis): RankedCandidate<ModelProfile>[] {
    return this.models
      .filter((model) => model.enabled)
      .map((model) => this.score(model, task))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private score(model: ModelProfile, task: TaskAnalysis): RankedCandidate<ModelProfile> {
    const reasons: string[] = [];
    const penalties: string[] = [];

    const missingModalities = task.modalities.filter((item) => !model.modalities.includes(item));
    if (missingModalities.length > 0) {
      return { candidate: model, score: 0, reasons, penalties: [`Missing modalities: ${missingModalities.join(", ")}`] };
    }

    if (task.estimatedContextTokens > model.maxContextTokens) {
      return { candidate: model, score: 0, reasons, penalties: ["Context window is too small"] };
    }

    const privacy = task.constraints.privacy ?? "public";
    if (!model.privacySupport.includes(privacy)) {
      return { candidate: model, score: 0, reasons, penalties: [`Does not support ${privacy} data`] };
    }

    if (task.constraints.disallowedProviders?.includes(model.provider)) {
      return { candidate: model, score: 0, reasons, penalties: ["Provider is disallowed"] };
    }

    const requiredFit = overlapRatio(task.requiredCapabilities, model.capabilities);
    const preferredFit = overlapRatio(task.preferredCapabilities, model.capabilities);
    const requiredReasoning = complexityRank[task.complexity];
    const modelReasoning = complexityRank[model.reasoningLevel];
    const reasoningFit = clamp(modelReasoning / requiredReasoning);
    const reliabilityFit = model.reliability;
    const costFit = 1 - (model.costTier - 1) / 3;
    const latencyFit = 1 - (model.latencyTier - 1) / 3;
    const toolFit = task.requiredSkills.length === 0 || model.toolUse ? 1 : 0.15;
    const providerFit = task.constraints.preferredProvider
      ? task.constraints.preferredProvider === model.provider
        ? 1
        : 0.4
      : 1;

    let score =
      requiredFit * 0.34 +
      preferredFit * 0.08 +
      reasoningFit * 0.18 +
      reliabilityFit * 0.15 +
      costFit * 0.1 +
      latencyFit * 0.07 +
      toolFit * 0.05 +
      providerFit * 0.03;

    if (requiredFit === 1) reasons.push("Covers every required capability");
    else penalties.push(`Capability coverage ${(requiredFit * 100).toFixed(0)}%`);
    if (modelReasoning >= requiredReasoning) reasons.push("Reasoning capacity fits task complexity");
    if (task.requiredSkills.length > 0 && model.toolUse) reasons.push("Supports tool use");
    if (model.costTier <= (task.constraints.maxCostTier ?? 4)) reasons.push("Within cost constraint");
    else {
      score -= 0.22;
      penalties.push("Above preferred cost tier");
    }
    if (model.latencyTier > (task.constraints.maxLatencyTier ?? 4)) {
      score -= 0.12;
      penalties.push("Above preferred latency tier");
    }
    if (task.risk === "high" || task.risk === "critical") {
      score += model.reliability * 0.08;
      if (model.reliability < 0.9) penalties.push("Reliability is weak for a high-risk task");
    }

    return { candidate: model, score: clamp(score), reasons, penalties };
  }
}
