import type { Complexity, RiskLevel, TaskAnalysis } from "../domain/types.js";

interface SemanticPatch {
  intent: string;
  domain: string;
  complexity: Complexity;
  risk: RiskLevel;
  requiredCapabilities: string[];
  preferredCapabilities: string[];
  requiredSkills: string[];
  outputFormat: string;
  requiresFreshData: boolean;
  requiresExternalAction: boolean;
  requiresVerification: boolean;
  canParallelize: boolean;
  confidence: number;
  ambiguities: string[];
}

interface ResponsesApiPayload {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

export class OpenAISemanticAnalyzer {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly endpoint = "https://api.openai.com/v1/responses",
  ) {}

  async enrich(base: TaskAnalysis): Promise<TaskAnalysis> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: "system",
            content:
              "You are a routing classifier. Return only valid JSON, without markdown. Never execute the task. " +
              "Analyze capabilities, risk, freshness, external side effects, and verification needs. " +
              "Use these skill IDs when relevant: web-search, github, code-execution, file-search, " +
              "image-generation, document-builder, spreadsheet-builder, human-approval. " +
              "Required JSON keys: intent, domain, complexity, risk, requiredCapabilities, preferredCapabilities, " +
              "requiredSkills, outputFormat, requiresFreshData, requiresExternalAction, requiresVerification, " +
              "canParallelize, confidence, ambiguities.",
          },
          {
            role: "user",
            content: JSON.stringify({ prompt: base.rawPrompt, heuristicAnalysis: base }),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI semantic analyzer failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as ResponsesApiPayload;
    const outputText = payload.output_text ?? this.extractOutputText(payload);
    const parsed = this.validate(JSON.parse(outputText));

    return {
      ...base,
      ...parsed,
      requiredCapabilities: [...new Set([...base.requiredCapabilities, ...parsed.requiredCapabilities])],
      preferredCapabilities: [...new Set([...base.preferredCapabilities, ...parsed.preferredCapabilities])],
      requiredSkills: [...new Set([...base.requiredSkills, ...parsed.requiredSkills])],
      confidence: Math.max(base.confidence, parsed.confidence),
    };
  }

  private extractOutputText(payload: ResponsesApiPayload): string {
    const chunks = payload.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text" || typeof item.text === "string")
      .map((item) => item.text ?? "")
      .filter(Boolean);

    if (!chunks?.length) throw new Error("Responses API returned no output text");
    return chunks.join("\n");
  }

  private validate(value: unknown): SemanticPatch {
    if (!value || typeof value !== "object") throw new Error("Semantic analysis is not an object");
    const data = value as Record<string, unknown>;

    const complexity = this.enumValue(data.complexity, ["simple", "moderate", "complex", "expert"] as const);
    const risk = this.enumValue(data.risk, ["low", "medium", "high", "critical"] as const);
    const confidence = typeof data.confidence === "number" ? Math.max(0, Math.min(1, data.confidence)) : 0.5;

    return {
      intent: this.stringValue(data.intent, "answer"),
      domain: this.stringValue(data.domain, "general"),
      complexity,
      risk,
      requiredCapabilities: this.stringArray(data.requiredCapabilities),
      preferredCapabilities: this.stringArray(data.preferredCapabilities),
      requiredSkills: this.stringArray(data.requiredSkills),
      outputFormat: this.stringValue(data.outputFormat, "text"),
      requiresFreshData: Boolean(data.requiresFreshData),
      requiresExternalAction: Boolean(data.requiresExternalAction),
      requiresVerification: Boolean(data.requiresVerification),
      canParallelize: Boolean(data.canParallelize),
      confidence,
      ambiguities: this.stringArray(data.ambiguities),
    };
  }

  private stringValue(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  private enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] {
    return typeof value === "string" && allowed.includes(value) ? (value as T[number]) : allowed[0];
  }
}
