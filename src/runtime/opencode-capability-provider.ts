import type { CapabilityProvider, ProviderHealth, ProviderVersion } from "../control-plane/contracts.js";
import { OpenCodeHttpClient, type OpenCodeHttpClientOptions } from "./opencode-http-client.js";

interface OpenCodeHealthPayload {
  readonly healthy?: unknown;
  readonly version?: unknown;
}

export interface OpenCodeCapabilityProviderOptions extends OpenCodeHttpClientOptions {
  readonly checkedAt?: () => string;
}

export class OpenCodeCapabilityProvider implements CapabilityProvider {
  readonly id = "opencode";
  readonly capabilities = ["code.interactive"] as const;
  readonly modes = ["read", "write", "execute"] as const;
  readonly transports = ["native-http"] as const;
  readonly requiredPermissions = ["filesystem:workspace"] as const;
  readonly isolationRequirements = ["isolated-worktree-for-mutation"] as const;
  readonly costProfile = {
    relativeTier: 1 as const,
    quotaAware: true,
    notes: ["Model/provider quota is observed separately from the local OpenCode runtime."],
  };
  readonly contextProfile = {
    supportsSelectiveContext: true,
    notes: ["9Router compiles bounded task context before dispatch."],
  };
  readonly sideEffectClass = "reversible" as const;
  private readonly client: OpenCodeHttpClient;
  private readonly checkedAt: () => string;

  constructor(options: OpenCodeCapabilityProviderOptions = {}) {
    this.client = new OpenCodeHttpClient(options);
    this.checkedAt = options.checkedAt ?? (() => new Date().toISOString());
  }

  async health(): Promise<ProviderHealth> {
    try {
      const payload = await this.client.request<OpenCodeHealthPayload>({
        method: "GET",
        path: "/global/health",
      });
      const healthy = payload?.healthy === true;
      const version = stringValue(payload?.version);
      return {
        status: healthy ? (version ? "healthy" : "degraded") : "unhealthy",
        checkedAt: this.checkedAt(),
        reason: healthy
          ? version
            ? undefined
            : "OpenCode health endpoint did not report a version"
          : "OpenCode health endpoint reported unhealthy",
        quotaState: "unknown",
      };
    } catch (error) {
      return {
        status: "unhealthy",
        checkedAt: this.checkedAt(),
        reason: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
        quotaState: "unknown",
      };
    }
  }

  async version(): Promise<ProviderVersion> {
    try {
      const payload = await this.client.request<OpenCodeHealthPayload>({
        method: "GET",
        path: "/global/health",
      });
      const version = stringValue(payload?.version);
      return {
        version: version ?? "unknown",
        protocolVersion: "opencode-http",
        compatible: payload?.healthy === true && Boolean(version),
      };
    } catch {
      return {
        version: "unknown",
        protocolVersion: "opencode-http",
        compatible: false,
      };
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
