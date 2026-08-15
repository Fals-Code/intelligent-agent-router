import type {
  CapabilityBinding,
  CapabilityId,
  CapabilityProvider,
  ProviderRole,
} from "./contracts.js";

const ROLE_ORDER: Record<ProviderRole, number> = {
  PRIMARY: 0,
  FALLBACK: 1,
  SHADOW: 2,
};

export class CapabilityRegistry {
  private readonly providers = new Map<string, CapabilityProvider>();
  private readonly bindings: CapabilityBinding[] = [];

  registerProvider(provider: CapabilityProvider): this {
    const id = provider.id.trim();
    if (!id) throw new Error("Provider id must not be empty");
    if (this.providers.has(id)) throw new Error(`Capability provider already registered: ${id}`);
    if (provider.capabilities.length === 0) throw new Error(`Provider ${id} must declare at least one capability`);
    if (provider.modes.length === 0) throw new Error(`Provider ${id} must declare at least one mode`);
    if (provider.transports.length === 0) throw new Error(`Provider ${id} must declare at least one transport`);

    this.providers.set(id, provider);
    return this;
  }

  bind(binding: CapabilityBinding): this {
    const provider = this.providers.get(binding.providerId);
    if (!provider) throw new Error(`Unknown capability provider: ${binding.providerId}`);
    if (!provider.capabilities.includes(binding.capability)) {
      throw new Error(`Provider ${binding.providerId} does not implement capability ${binding.capability}`);
    }
    if (
      this.bindings.some(
        (item) =>
          item.providerId === binding.providerId &&
          item.capability === binding.capability &&
          item.role === binding.role,
      )
    ) {
      throw new Error(
        `Duplicate capability binding: ${binding.providerId}/${binding.capability}/${binding.role}`,
      );
    }

    this.assertSingleWriter(binding, provider);
    this.bindings.push({ ...binding });
    return this;
  }

  getProvider(providerId: string): CapabilityProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): readonly CapabilityProvider[] {
    return [...this.providers.values()];
  }

  routesFor(capability: CapabilityId): readonly CapabilityBinding[] {
    return this.bindings
      .filter((item) => item.enabled && item.capability === capability)
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  }

  primaryFor(capability: CapabilityId): CapabilityBinding | undefined {
    return this.routesFor(capability).find((item) => item.role === "PRIMARY");
  }

  private assertSingleWriter(binding: CapabilityBinding, provider: CapabilityProvider): void {
    if (binding.role !== "PRIMARY" || !binding.enabled || !binding.canonicalWriteDomain) return;
    const canWrite = provider.modes.includes("write") || provider.modes.includes("execute");
    if (!canWrite) return;

    const conflict = this.bindings.find((item) => {
      if (
        !item.enabled ||
        item.role !== "PRIMARY" ||
        item.canonicalWriteDomain !== binding.canonicalWriteDomain
      ) {
        return false;
      }
      const existingProvider = this.providers.get(item.providerId);
      return Boolean(
        existingProvider &&
          (existingProvider.modes.includes("write") || existingProvider.modes.includes("execute")),
      );
    });

    if (conflict) {
      throw new Error(
        `Single-writer violation for ${binding.canonicalWriteDomain}: ${conflict.providerId} is already PRIMARY`,
      );
    }
  }
}
