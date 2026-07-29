export interface ProviderMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ProviderStructuredOutputSchema {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly strict?: boolean;
}

export interface ProviderRequestMetadata {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export interface ModelProviderRequest {
  readonly providerId: string;
  readonly internalModelId: string;
  readonly providerModelId: string;
  readonly messages: readonly ProviderMessage[];
  readonly systemInstruction?: string;
  readonly structuredOutputSchema?: ProviderStructuredOutputSchema;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly metadata?: ProviderRequestMetadata;
  readonly traceId?: string;
  readonly stepId?: string;
  readonly skillId?: string;
  readonly signal?: AbortSignal;
}
