import type { ProviderRequestMetadata } from "./provider-request.js";

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ModelProviderResponse {
  readonly providerId: string;
  readonly internalModelId: string;
  readonly providerModelId: string;
  readonly outputText?: string;
  readonly structuredOutput?: unknown;
  readonly finishReason?: string;
  readonly usage?: ProviderUsage;
  readonly latencyMs: number;
  readonly requestId?: string;
  readonly metadata?: ProviderRequestMetadata;
}
