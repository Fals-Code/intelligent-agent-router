import type {
  RuntimeBinding,
  RuntimeObservation,
  RuntimeReconciliationProbe,
} from "../reconciliation/runtime-reconciliation.js";
import { OpenCodeHttpClient, type OpenCodeHttpClientOptions, OpenCodeHttpError } from "./opencode-http-client.js";

interface OpenCodeSessionInfo {
  readonly id?: unknown;
  readonly directory?: unknown;
}

interface OpenCodeStatusInfo {
  readonly type?: unknown;
}

interface OpenCodeMessage {
  readonly info?: {
    readonly id?: unknown;
    readonly role?: unknown;
    readonly finish?: unknown;
    readonly time?: { readonly created?: unknown; readonly completed?: unknown };
  };
}

interface OpenCodePermissionRequest {
  readonly id?: unknown;
  readonly sessionID?: unknown;
}

interface OpenCodeFileDiff {
  readonly file?: unknown;
  readonly patch?: unknown;
}

export interface OpenCodeReconciliationProbeOptions extends OpenCodeHttpClientOptions {
  readonly now?: () => string;
}

/**
 * Read-only OpenCode probe for process-restart reconciliation.
 * It does not register the session in OpenCodeRuntimeAdapter and never calls a
 * mutating OpenCode endpoint.
 */
export class OpenCodeRuntimeReconciliationProbe implements RuntimeReconciliationProbe {
  readonly runtimeId = "opencode";
  private readonly client: OpenCodeHttpClient;
  private readonly now: () => string;

  constructor(options: OpenCodeReconciliationProbeOptions = {}) {
    this.client = new OpenCodeHttpClient(options);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async inspect(binding: RuntimeBinding): Promise<RuntimeObservation> {
    if (binding.runtimeId !== this.runtimeId) {
      throw new Error(`OpenCode probe cannot inspect runtime ${binding.runtimeId}`);
    }

    const session = await this.client.request<OpenCodeSessionInfo>({
      method: "GET",
      path: `/session/${encodeURIComponent(binding.sessionId)}`,
      directory: binding.workspace,
    });
    const upstreamId = stringValue(session?.id);
    if (!upstreamId || upstreamId !== binding.sessionId) {
      throw new OpenCodeHttpError(
        `OpenCode session identity mismatch: expected=${binding.sessionId} actual=${upstreamId ?? "missing"}`,
      );
    }
    const upstreamDirectory = stringValue(session?.directory);
    if (upstreamDirectory && normalizePath(upstreamDirectory) !== normalizePath(binding.workspace)) {
      throw new OpenCodeHttpError("OpenCode session workspace does not match the durable runtime binding");
    }

    const [statuses, messages, permissions, rawDiff] = await Promise.all([
      this.client.request<Record<string, OpenCodeStatusInfo>>({
        method: "GET",
        path: "/session/status",
        directory: binding.workspace,
      }),
      this.client.request<readonly OpenCodeMessage[]>({
        method: "GET",
        path: `/session/${encodeURIComponent(binding.sessionId)}/message`,
        directory: binding.workspace,
      }),
      this.client.request<readonly OpenCodePermissionRequest[]>({
        method: "GET",
        path: "/permission",
        directory: binding.workspace,
      }),
      this.client.request<readonly OpenCodeFileDiff[]>({
        method: "GET",
        path: `/session/${encodeURIComponent(binding.sessionId)}/diff`,
        directory: binding.workspace,
      }),
    ]);

    const safeMessages = Array.isArray(messages) ? messages : [];
    const safePermissions = Array.isArray(permissions)
      ? permissions.filter((item) => stringValue(item.sessionID) === binding.sessionId)
      : [];
    const safeDiff = Array.isArray(rawDiff) ? rawDiff : [];
    const statusType = stringValue(statuses?.[binding.sessionId]?.type) ?? "idle";
    if (!["idle", "busy", "retry"].includes(statusType)) {
      throw new OpenCodeHttpError(`OpenCode returned unknown session status: ${statusType}`);
    }

    const status = deriveStatus(statusType, safeMessages, safePermissions);
    const events = summarizeEvents(binding.sessionId, safeMessages, safePermissions);
    const filesChanged = [
      ...new Set(
        safeDiff
          .map((item) => stringValue(item.file))
          .filter((item): item is string => Boolean(item)),
      ),
    ].sort();
    const patchObserved = safeDiff.some((item) => Boolean(stringValue(item.patch)));

    return Object.freeze({
      runtimeId: this.runtimeId,
      sessionId: binding.sessionId,
      status,
      observedAt: this.now(),
      events: Object.freeze({
        count: events.length,
        types: Object.freeze([...new Set(events.map((event) => event.type))].sort()),
        lastEventId: events.at(-1)?.id,
        lastEventAt: events.at(-1)?.timestamp,
      }),
      diff: Object.freeze({
        filesChanged: Object.freeze(filesChanged),
        patchObserved,
      }),
    });
  }
}

function deriveStatus(
  statusType: string,
  messages: readonly OpenCodeMessage[],
  permissions: readonly OpenCodePermissionRequest[],
): RuntimeObservation["status"] {
  if (permissions.length > 0) return "waiting_approval";
  if (statusType === "busy" || statusType === "retry") return "running";
  return hasTerminalAssistantAfterLatestUser(messages) ? "completed" : "created";
}

function hasTerminalAssistantAfterLatestUser(messages: readonly OpenCodeMessage[]): boolean {
  let latestUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (stringValue(messages[index]?.info?.role) === "user") latestUserIndex = index;
  }
  if (latestUserIndex < 0) return false;
  for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (stringValue(message?.info?.role) === "assistant" && isTerminalAssistantFinish(message?.info?.finish)) {
      return true;
    }
  }
  return false;
}

function summarizeEvents(
  sessionId: string,
  messages: readonly OpenCodeMessage[],
  permissions: readonly OpenCodePermissionRequest[],
): readonly { id: string; type: string; timestamp: string }[] {
  const events: { id: string; type: string; timestamp: string }[] = [];
  for (const message of messages) {
    const id = stringValue(message.info?.id);
    const role = stringValue(message.info?.role);
    if (!id || !role) continue;
    const createdAt = timestamp(message.info?.time?.created) ?? "1970-01-01T00:00:00.000Z";
    if (role === "user") {
      events.push({ id: `opencode:message:${id}:user`, type: "task_started", timestamp: createdAt });
    } else if (role === "assistant" && isTerminalAssistantFinish(message.info?.finish)) {
      events.push({
        id: `opencode:message:${id}:assistant`,
        type: "task_completed",
        timestamp: timestamp(message.info?.time?.completed) ?? createdAt,
      });
    }
  }
  for (const permission of permissions) {
    const id = stringValue(permission.id);
    if (!id) continue;
    events.push({
      id: `opencode:permission:${sessionId}:${id}`,
      type: "approval_requested",
      timestamp: "9999-12-31T23:59:59.999Z",
    });
  }
  return events.sort((a, b) =>
    a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp.localeCompare(b.timestamp),
  );
}

function isTerminalAssistantFinish(value: unknown): boolean {
  const finish = stringValue(value);
  return Boolean(finish && !["tool-calls", "unknown"].includes(finish));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
