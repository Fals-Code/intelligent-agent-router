import type { RiskClass } from "./contracts.js";

export type ContextSourceKind =
  | "project_rule"
  | "source_code"
  | "history"
  | "skill"
  | "documentation"
  | "tool"
  | "design";

export interface ContextCandidate {
  readonly id: string;
  readonly source: ContextSourceKind;
  readonly content: string;
  readonly estimatedTokens: number;
  readonly relevance: number;
  readonly applicable: boolean;
  readonly skillId?: string;
  readonly toolId?: string;
  readonly disclosure?: "metadata" | "full";
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ContextCompileRequest {
  readonly task: string;
  readonly projectId: string;
  readonly riskClass: RiskClass;
  readonly providerId?: string;
  readonly maxContextTokens: number;
  readonly candidates: readonly ContextCandidate[];
  readonly selectedSkillIds?: readonly string[];
  readonly selectedToolIds?: readonly string[];
  readonly designInScope?: boolean;
}

export interface CompiledContextItem extends ContextCandidate {
  readonly mandatory: boolean;
}

export interface CompiledContext {
  readonly version: string;
  readonly projectId: string;
  readonly items: readonly CompiledContextItem[];
  readonly totalTokens: number;
  readonly toolCatalogSize: number;
  readonly droppedIds: readonly string[];
  readonly sourceCounts: Readonly<Record<ContextSourceKind, number>>;
}

export interface ContextCompilerOptions {
  readonly version?: string;
}

export class ContextCompiler {
  readonly version: string;

  constructor(options: ContextCompilerOptions = {}) {
    this.version = options.version ?? "context-compiler-v1";
  }

  compile(request: ContextCompileRequest): CompiledContext {
    if (!request.task.trim()) throw new Error("Context compiler task must not be empty");
    if (!request.projectId.trim()) throw new Error("Context compiler projectId must not be empty");
    if (!Number.isFinite(request.maxContextTokens) || request.maxContextTokens <= 0) {
      throw new Error("Context compiler requires a positive maxContextTokens budget");
    }

    const selectedSkillIds = new Set(request.selectedSkillIds ?? []);
    const selectedToolIds = new Set(request.selectedToolIds ?? []);
    const eligible = request.candidates
      .filter((candidate) => this.isEligible(candidate, selectedSkillIds, selectedToolIds, Boolean(request.designInScope)))
      .map((candidate) => ({ ...candidate, mandatory: candidate.source === "project_rule" }));

    const mandatory = eligible.filter((candidate) => candidate.mandatory);
    const mandatoryTokens = mandatory.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0);
    if (mandatoryTokens > request.maxContextTokens) {
      throw new Error(
        `Mandatory project rules exceed context budget: ${mandatoryTokens}/${request.maxContextTokens}`,
      );
    }

    const optional = eligible
      .filter((candidate) => !candidate.mandatory)
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        if (a.estimatedTokens !== b.estimatedTokens) return a.estimatedTokens - b.estimatedTokens;
        return a.id.localeCompare(b.id);
      });

    const included: CompiledContextItem[] = [...mandatory];
    let totalTokens = mandatoryTokens;
    for (const candidate of optional) {
      if (totalTokens + candidate.estimatedTokens > request.maxContextTokens) continue;
      included.push(candidate);
      totalTokens += candidate.estimatedTokens;
    }

    const includedIds = new Set(included.map((item) => item.id));
    const droppedIds = request.candidates
      .filter((candidate) => !includedIds.has(candidate.id))
      .map((candidate) => candidate.id);
    const sourceCounts = this.countSources(included);

    return Object.freeze({
      version: this.version,
      projectId: request.projectId,
      items: Object.freeze(included.map((item) => Object.freeze({ ...item }))),
      totalTokens,
      toolCatalogSize: included.filter((item) => item.source === "tool").length,
      droppedIds: Object.freeze(droppedIds),
      sourceCounts: Object.freeze(sourceCounts),
    });
  }

  private isEligible(
    candidate: ContextCandidate,
    selectedSkillIds: ReadonlySet<string>,
    selectedToolIds: ReadonlySet<string>,
    designInScope: boolean,
  ): boolean {
    if (!candidate.id.trim()) throw new Error("Context candidate id must not be empty");
    if (!Number.isFinite(candidate.estimatedTokens) || candidate.estimatedTokens <= 0) {
      throw new Error(`Context candidate ${candidate.id} has invalid estimatedTokens`);
    }
    if (!Number.isFinite(candidate.relevance) || candidate.relevance < 0 || candidate.relevance > 1) {
      throw new Error(`Context candidate ${candidate.id} has invalid relevance`);
    }
    if (!candidate.applicable) return false;

    if (candidate.source === "skill" && candidate.disclosure === "full") {
      return Boolean(candidate.skillId && selectedSkillIds.has(candidate.skillId));
    }
    if (candidate.source === "tool") {
      return Boolean(candidate.toolId && selectedToolIds.has(candidate.toolId));
    }
    if (candidate.source === "design") return designInScope;
    return true;
  }

  private countSources(items: readonly CompiledContextItem[]): Record<ContextSourceKind, number> {
    const counts: Record<ContextSourceKind, number> = {
      project_rule: 0,
      source_code: 0,
      history: 0,
      skill: 0,
      documentation: 0,
      tool: 0,
      design: 0,
    };
    for (const item of items) counts[item.source] += 1;
    return counts;
  }
}
