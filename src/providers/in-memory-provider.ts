import type { ModelProvider } from "./model-provider.js";
import type { ModelProviderRequest } from "./provider-request.js";
import type { ModelProviderResult } from "./model-provider.js";
import type { ProviderError } from "./provider-errors.js";
import { sanitizeMessage } from "./provider-errors.js";

export class InMemoryModelProvider implements ModelProvider {
  constructor(
    public readonly providerId: string,
    private readonly handler: (request: ModelProviderRequest) => Promise<ModelProviderResult> | ModelProviderResult,
    private readonly supportedModels: ReadonlySet<string> = new Set(),
  ) {}

  supportsModel(internalModelId: string): boolean {
    return this.supportedModels.size === 0 || this.supportedModels.has(internalModelId);
  }

  supportsRequest(request: ModelProviderRequest): boolean {
    return request.providerId === this.providerId && this.supportsModel(request.internalModelId);
  }

  async generate(request: ModelProviderRequest): Promise<ModelProviderResult> {
    return this.handler(request);
  }
}

export function createRetryableProviderError(message: string, providerId: string, internalModelId: string, providerModelId: string, category: ProviderError["category"] = "provider_error"): ProviderError {
  return {
    name: "ProviderError",
    message: sanitizeMessage(message),
    retryable: true,
    category,
    providerId,
    internalModelId,
    providerModelId,
  };
}

export function createNonRetryableProviderError(message: string, providerId: string, internalModelId: string, providerModelId: string, category: ProviderError["category"] = "invalid_request"): ProviderError {
  return {
    name: "ProviderError",
    message: sanitizeMessage(message),
    retryable: false,
    category,
    providerId,
    internalModelId,
    providerModelId,
  };
}
