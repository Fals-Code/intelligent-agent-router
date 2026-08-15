import type { ModelProviderRequest } from "./provider-request.js";
import type { ModelProviderResponse } from "./provider-response.js";
import type { ProviderError } from "./provider-errors.js";

export type ModelProviderResult = ModelProviderResponse | { readonly error: ProviderError };

export interface ModelProvider {
  readonly providerId: string;
  supportsModel(internalModelId: string): boolean;
  supportsRequest(request: ModelProviderRequest): boolean;
  generate(request: ModelProviderRequest): Promise<ModelProviderResult>;
}
