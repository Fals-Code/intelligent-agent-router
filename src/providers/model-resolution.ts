import type { ModelProfile } from "../domain/types.js";

export interface ResolvedModelIdentity {
  readonly internalModelId: string;
  readonly providerId: string;
  readonly providerModelId: string;
}

export interface ModelResolver {
  resolve(internalModelId: string): ResolvedModelIdentity;
}

export interface EnvironmentReader {
  readonly get: (name: string) => string | undefined;
}

export class RegistryModelResolver implements ModelResolver {
  constructor(
    private readonly models: readonly ModelProfile[],
    private readonly env: EnvironmentReader = { get: (name) => process.env[name] },
  ) {}

  resolve(internalModelId: string): ResolvedModelIdentity {
    const model = this.models.find((item) => item.id === internalModelId);
    if (!model) throw new Error(`Unknown model ${internalModelId}`);
    if (!model.enabled) throw new Error(`Model ${internalModelId} is disabled`);
    const providerModelId = this.env.get(model.apiModelEnv)?.trim();
    if (!providerModelId) throw new Error(`Missing environment variable ${model.apiModelEnv} for model ${internalModelId}`);
    return { internalModelId: model.id, providerId: model.provider, providerModelId };
  }
}
