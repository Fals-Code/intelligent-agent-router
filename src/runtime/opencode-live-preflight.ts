import type { ProviderHealth, ProviderVersion } from "../control-plane/contracts.js";
import { OpenCodeCapabilityProvider } from "./opencode-capability-provider.js";
import { OpenCodeHttpClient } from "./opencode-http-client.js";
import { OpenCodeRuntimeAdapter } from "./opencode-runtime-adapter.js";

export interface OpenCodeLivePreflightOptions {
  readonly baseUrl?: string;
  readonly projectDir: string;
  readonly username?: string;
  readonly password?: string;
  readonly allowRemote?: boolean;
  readonly sessionSmoke?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface OpenCodeLivePreflightResult {
  readonly ready: boolean;
  readonly baseUrl: string;
  readonly projectDir: string;
  readonly health: ProviderHealth;
  readonly version: ProviderVersion;
  readonly scopedStatusReadable: boolean;
  readonly pathInfo?: Readonly<Record<string, unknown>>;
  readonly sessionSmoke: {
    readonly requested: boolean;
    readonly created: boolean;
    readonly destroyed: boolean;
    readonly initialStatus?: string;
  };
}

export async function runOpenCodeLivePreflight(
  options: OpenCodeLivePreflightOptions,
): Promise<OpenCodeLivePreflightResult> {
  const projectDir = options.projectDir.trim();
  if (!projectDir) throw new Error("OpenCode live preflight requires an explicit projectDir");
  const baseUrl = assertSafeOpenCodeBaseUrl(options.baseUrl ?? "http://127.0.0.1:4096", options.allowRemote === true);
  const connection = {
    baseUrl,
    username: options.username,
    password: options.password,
    fetchImpl: options.fetchImpl,
  };
  const provider = new OpenCodeCapabilityProvider(connection);
  const [health, version] = await Promise.all([provider.health(), provider.version()]);
  const client = new OpenCodeHttpClient(connection);

  let scopedStatusReadable = false;
  let pathInfo: Readonly<Record<string, unknown>> | undefined;
  if (health.status === "healthy" || health.status === "degraded") {
    if (version.compatible) {
      const status = await client.request<unknown>({
        method: "GET",
        path: "/session/status",
        directory: projectDir,
      });
      if (!isRecord(status)) throw new Error("OpenCode scoped session status response is not an object");
      scopedStatusReadable = true;

      const rawPath = await client.request<unknown>({
        method: "GET",
        path: "/path",
        directory: projectDir,
      });
      if (isRecord(rawPath)) pathInfo = Object.freeze({ ...rawPath });
    }
  }

  const smoke = {
    requested: options.sessionSmoke === true,
    created: false,
    destroyed: false,
    initialStatus: undefined as string | undefined,
  };

  if (options.sessionSmoke === true && scopedStatusReadable) {
    const runtime = new OpenCodeRuntimeAdapter(connection);
    let sessionId: string | undefined;
    try {
      const session = await runtime.createSession({
        projectId: "9router-live-preflight",
        workspace: projectDir,
        riskClass: "R0",
        metadata: { purpose: "adapter-live-preflight" },
      });
      sessionId = session.id;
      smoke.created = true;
      smoke.initialStatus = await runtime.getStatus(session.id);
    } finally {
      if (sessionId) {
        await runtime.destroy(sessionId);
        smoke.destroyed = true;
      }
    }
  }

  return Object.freeze({
    ready:
      health.status === "healthy" &&
      version.compatible &&
      scopedStatusReadable &&
      (!smoke.requested || (smoke.created && smoke.destroyed)),
    baseUrl,
    projectDir,
    health,
    version,
    scopedStatusReadable,
    pathInfo,
    sessionSmoke: Object.freeze({ ...smoke }),
  });
}

export function assertSafeOpenCodeBaseUrl(value: string, allowRemote = false): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`OpenCode base URL must use http or https, received ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
  if (!loopback && !allowRemote) {
    throw new Error(
      `Refusing non-loopback OpenCode server ${url.origin}; set allowRemote only when network and credential policy explicitly permits it`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
