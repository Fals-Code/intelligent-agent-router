import type { RoutingDecision, TaskAnalysis } from "../domain/types.js";
import { HeuristicAnalyzer } from "../analyzers/heuristic-analyzer.js";
import { modelRegistry } from "../registry/models.js";
import { skillRegistry } from "../registry/skills.js";
import { ModelRouter } from "../router/model-router.js";
import { SkillRouter } from "../router/skill-router.js";
import { Planner } from "./planner.js";
import { OpenAISemanticAnalyzer } from "../providers/openai-semantic-analyzer.js";

export interface AgentRouterOptions {
  semanticAnalyzer?: OpenAISemanticAnalyzer;
}

export class IntelligentAgentRouter {
  private readonly heuristicAnalyzer = new HeuristicAnalyzer();
  private readonly modelRouter = new ModelRouter(modelRegistry);
  private readonly skillRouter = new SkillRouter(skillRegistry);
  private readonly planner = new Planner();

  constructor(private readonly options: AgentRouterOptions = {}) {}

  async route(prompt: string): Promise<RoutingDecision> {
    let analysis: TaskAnalysis = this.heuristicAnalyzer.analyze(prompt);

    if (this.options.semanticAnalyzer) {
      try {
        analysis = await this.options.semanticAnalyzer.enrich(analysis);
      } catch (error) {
        analysis.ambiguities.push(`Semantic analyzer failed; used deterministic fallback: ${String(error)}`);
      }
    }

    const rankedModels = this.modelRouter.rank(analysis);
    if (rankedModels.length === 0) throw new Error("No model satisfies the task constraints.");

    const rankedSkills = this.skillRouter.rank(analysis);
    const selectedSkills = rankedSkills.filter(
      (item) => analysis.requiredSkills.includes(item.candidate.id) || item.score >= 0.62,
    );

    const primaryModel = rankedModels[0];
    const verifierModel = analysis.requiresVerification
      ? rankedModels.find((item) => item.candidate.reliability >= primaryModel.candidate.reliability) ?? primaryModel
      : primaryModel;

    const plan = this.planner.build(analysis, primaryModel, selectedSkills, verifierModel);

    return {
      analysis,
      primaryModel,
      fallbackModels: rankedModels.slice(1, 4),
      selectedSkills,
      plan,
      explanation: [
        `Selected ${primaryModel.candidate.label} with score ${primaryModel.score.toFixed(3)}.`,
        `Selected skills: ${selectedSkills.map((item) => item.candidate.id).join(", ") || "none"}.`,
        analysis.requiresVerification ? "Independent verification is required." : "Single-pass execution is acceptable.",
      ],
      traceId: globalThis.crypto.randomUUID(),
    };
  }
}
