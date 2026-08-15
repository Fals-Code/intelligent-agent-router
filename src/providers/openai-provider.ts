import type { ModelProvider } from "./model-provider.js";
import type { ModelProviderRequest } from "./provider-request.js";
import type { ModelProviderResult } from "./model-provider.js";
import { normalizeProviderError, sanitizeMessage } from "./provider-errors.js";

interface OpenAIResponsesPayload {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  id?: string;
  model?: string;
  status?: string;
}

export interface OpenAIProviderOptions {
  readonly providerId?: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly supportedModels?: ReadonlySet<string>;
}

export class OpenAIModelProvider implements ModelProvider {
  readonly providerId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.providerId = options.providerId ?? "openai";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1/responses";
  }

  supportsModel(internalModelId: string): boolean {
    return this.options.supportedModels ? this.options.supportedModels.has(internalModelId) : true;
  }

  supportsRequest(request: ModelProviderRequest): boolean {
    return request.providerId === this.providerId && this.supportsModel(request.internalModelId);
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResult> {
    const started = Date.now();
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        signal: request.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.providerModelId,
          input: this.buildInput(request),
          ...(request.structuredOutputSchema
            ? { text: { format: { type: "json_schema", name: request.structuredOutputSchema.name, schema: request.structuredOutputSchema.schema, strict: request.structuredOutputSchema.strict ?? true } } }
            : {}),
          ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
          ...(typeof request.maxOutputTokens === "number" ? { max_output_tokens: request.maxOutputTokens } : {}),
        }),
      });

      const latencyMs = Date.now() - started;
      if (!response.ok) return { error: this.mapHttpError(response.status, await this.safeText(response), request, response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? response.headers.get("openai-request-id") ?? undefined) };
      const payload = this.parsePayload(await response.json());
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? response.headers.get("openai-request-id") ?? payload.id ?? undefined;
      const outputText = this.extractOutputText(payload);
      const structuredOutput = request.structuredOutputSchema ? this.parseStructuredOutput(outputText) : undefined;
      return {
        providerId: this.providerId,
        internalModelId: request.internalModelId,
        providerModelId: typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : request.providerModelId,
        outputText,
        structuredOutput,
        finishReason: typeof payload.status === "string" && payload.status.trim() ? payload.status.trim() : undefined,
        usage: this.normalizeUsage(payload.usage),
        latencyMs,
        requestId,
      };
    } catch (error) {
      return { error: normalizeProviderError({ error, providerId: this.providerId, internalModelId: request.internalModelId, providerModelId: request.providerModelId }) };
    }
  }

  private buildInput(request: ModelProviderRequest): Array<{ role: string; content: string }> {
    const system = request.systemInstruction ? [{ role: "system", content: request.systemInstruction }] : [];
    return [...system, ...request.messages];
  }

  private parsePayload(payload: unknown): OpenAIResponsesPayload {
    if (!payload || typeof payload !== "object") throw new Error("OpenAI provider returned an invalid payload");
    return payload as OpenAIResponsesPayload;
  }

  private extractOutputText(payload: OpenAIResponsesPayload): string {
    if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
    const chunks = Array.isArray(payload.output)
      ? payload.output.flatMap((item) =>
          Array.isArray(item.content)
            ? item.content.filter((content): content is { type?: string; text?: string } => Boolean(content && typeof content === "object"))
            : [],
        )
      : [];
    const texts = chunks
      .filter((item) => item.type === "output_text" || typeof item.text === "string")
      .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
      .filter(Boolean);
    if (!texts.length) throw new Error("OpenAI provider returned no output text");
    return texts.join("\n");
  }

  private parseStructuredOutput(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("OpenAI provider returned malformed structured output");
    }
  }

  private async safeText(response: Response): Promise<string> {
    const text = await response.text();
    return sanitizeMessage(text);
  }

  private normalizeUsage(usage: OpenAIResponsesPayload["usage"]): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
    if (!usage) return undefined;
    const inputTokens = this.normalizeCount(usage.input_tokens);
    const outputTokens = this.normalizeCount(usage.output_tokens);
    const totalTokens = this.normalizeCount(usage.total_tokens);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
    return {
      inputTokens,
      outputTokens,
      totalTokens: totalTokens ?? this.sumDefined(inputTokens, outputTokens),
    };
  }

  private normalizeCount(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return Math.trunc(value);
  }

  private sumDefined(...values: Array<number | undefined>): number | undefined {
    const defined = values.filter((value): value is number => typeof value === "number");
    return defined.length > 0 ? defined.reduce((sum, value) => sum + value, 0) : undefined;
  }

  private mapHttpError(status: number, body: string, request: ModelProviderRequest, requestId?: string) {
    const message = sanitizeMessage(`OpenAI request failed with HTTP ${status}: ${body}`);
    const base = {
      name: "OpenAIError",
      message,
      code: `HTTP_${status}`,
      httpStatus: status,
      providerId: this.providerId,
      internalModelId: request.internalModelId,
      providerModelId: request.providerModelId,
      requestId,
    } as const;
    if (status === 400) return { ...base, retryable: false, category: "invalid_request" as const };
    if (status === 401) return { ...base, retryable: false, category: "authentication" as const };
    if (status === 403) return { ...base, retryable: false, category: "authorization" as const };
    if (status === 404) return { ...base, retryable: true, category: "model_unavailable" as const };
    if (status === 408) return { ...base, retryable: true, category: "timeout" as const };
    if (status === 422) return { ...base, retryable: false, category: "content_policy" as const };
    if (status === 429) return { ...base, retryable: true, category: "rate_limit" as const };
    if (status >= 500) return { ...base, retryable: true, category: status === 503 ? ("model_unavailable" as const) : ("provider_error" as const) };
    return { ...base, retryable: false, category: "unknown" as const };
  }
}
