import type { ModelProvider } from "./model-provider.js";
import type { ModelProviderRequest } from "./provider-request.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): this {
    if (this.providers.has(provider.providerId)) {
      throw new Error(`Provider already registered for provider ${provider.providerId}`);
    }
    this.providers.set(provider.providerId, provider);
    return this;
  }

  resolve(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  resolveForRequest(request: Pick<ModelProviderRequest, "providerId" | "internalModelId">): ModelProvider {
    const provider = this.resolve(request.providerId);
    if (!provider) throw new Error(`Provider not available for provider ${request.providerId}`);
    if (!provider.supportsModel(request.internalModelId)) {
      throw new Error(`Provider ${request.providerId} does not support model ${request.internalModelId}`);
    }
    return provider;
  }

  resolveSupporting(request: ModelProviderRequest): ModelProvider {
    const providers = [...this.providers.values()];
    const matching = providers.find((provider) => provider.supportsRequest(request) && provider.supportsModel(request.internalModelId));
    if (!matching) throw new Error(`No provider available for provider ${request.providerId} and model ${request.internalModelId}`);
    return matching;
  }
}
