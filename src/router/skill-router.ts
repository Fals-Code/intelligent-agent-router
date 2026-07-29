import type { RankedCandidate, SkillProfile, TaskAnalysis } from "../domain/types.js";
import { clamp, overlapRatio, riskRank } from "../utils/rank.js";

export class SkillRouter {
  constructor(private readonly skills: SkillProfile[]) {}

  rank(task: TaskAnalysis): RankedCandidate<SkillProfile>[] {
    return this.skills
      .filter((skill) => skill.enabled)
      .map((skill) => this.score(skill, task))
      .filter((result) => result.score >= 0.35 || task.requiredSkills.includes(result.candidate.id))
      .sort((a, b) => b.score - a.score);
  }

  private score(skill: SkillProfile, task: TaskAnalysis): RankedCandidate<SkillProfile> {
    const reasons: string[] = [];
    const penalties: string[] = [];
    const required = task.requiredSkills.includes(skill.id);
    const domainFit = skill.domains.includes(task.domain) || skill.domains.includes("general") ? 1 : 0.2;
    const capabilityFit = overlapRatio(task.requiredCapabilities, skill.capabilities);
    const modalityFit = task.modalities.some((item) => skill.inputModalities.includes(item)) ? 1 : 0.25;
    const costFit = 1 - (skill.costTier - 1) / 3;
    const latencyFit = 1 - (skill.latencyTier - 1) / 3;

    let score = (required ? 0.5 : 0) + domainFit * 0.18 + capabilityFit * 0.16 + modalityFit * 0.08 + costFit * 0.04 + latencyFit * 0.04;

    if (required) reasons.push("Explicitly required by task analysis");
    if (domainFit === 1) reasons.push("Matches task domain");
    if (skill.sideEffect !== "none" && !task.requiresExternalAction) {
      score -= 0.2;
      penalties.push("Has side effects but task appears read-only");
    }
    if (riskRank[task.risk] > riskRank[skill.riskCeiling]) {
      score -= 0.45;
      penalties.push("Task risk exceeds skill ceiling");
    }
    if (skill.sideEffect === "destructive") {
      penalties.push("Destructive skill requires explicit approval");
    }

    return { candidate: skill, score: clamp(score), reasons, penalties };
  }
}
