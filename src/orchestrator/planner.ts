import type { RankedCandidate, RouteStep, SkillProfile, TaskAnalysis, ModelProfile } from "../domain/types.js";

export class Planner {
  build(
    task: TaskAnalysis,
    primaryModel: RankedCandidate<ModelProfile>,
    selectedSkills: RankedCandidate<SkillProfile>[],
    verifierModel: RankedCandidate<ModelProfile>,
  ): RouteStep[] {
    const steps: RouteStep[] = [];
    const retrievalSkills = selectedSkills.filter((item) =>
      ["web-search", "file-search", "github"].includes(item.candidate.id),
    );
    const executionSkills = selectedSkills.filter(
      (item) => !["web-search", "file-search", "github", "human-approval"].includes(item.candidate.id),
    );

    if (task.requiresExternalAction && task.constraints.requireHumanApprovalForWrites) {
      steps.push({
        id: "approval",
        purpose: "analyze",
        skillIds: ["human-approval"],
        modelId: primaryModel.candidate.id,
        dependsOn: [],
        humanApprovalRequired: true,
        instructions: "Confirm the exact target, scope, and irreversible effects before any write action.",
      });
    }

    if (retrievalSkills.length > 0) {
      steps.push({
        id: "retrieve",
        purpose: "retrieve",
        skillIds: retrievalSkills.map((item) => item.candidate.id),
        modelId: primaryModel.candidate.id,
        dependsOn: steps.some((item) => item.id === "approval") ? ["approval"] : [],
        parallelGroup: task.canParallelize ? "evidence" : undefined,
        humanApprovalRequired: false,
        instructions: "Collect only task-relevant evidence. Preserve provenance and freshness metadata.",
      });
    }

    steps.push({
      id: "execute",
      purpose: "execute",
      skillIds: executionSkills.map((item) => item.candidate.id),
      modelId: primaryModel.candidate.id,
      dependsOn: retrievalSkills.length > 0 ? ["retrieve"] : steps.some((item) => item.id === "approval") ? ["approval"] : [],
      humanApprovalRequired: false,
      instructions: `Perform the ${task.intent} task and produce ${task.outputFormat}.`,
    });

    if (task.requiresVerification) {
      steps.push({
        id: "verify",
        purpose: "verify",
        skillIds: executionSkills.some((item) => item.candidate.id === "code-execution") ? ["code-execution"] : [],
        modelId: verifierModel.candidate.id,
        dependsOn: ["execute"],
        humanApprovalRequired: false,
        instructions: "Independently check correctness, evidence coverage, constraints, safety, and unsupported claims.",
      });
    }

    steps.push({
      id: "synthesize",
      purpose: "synthesize",
      skillIds: [],
      modelId: primaryModel.candidate.id,
      dependsOn: task.requiresVerification ? ["verify"] : ["execute"],
      humanApprovalRequired: false,
      instructions: "Return the final answer with uncertainties and actions clearly separated.",
    });

    return steps;
  }
}
