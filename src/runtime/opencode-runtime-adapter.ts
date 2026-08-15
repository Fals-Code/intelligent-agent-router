import type {
  AgentRuntimeAdapter,
  ApprovalResponse,
  CreateRuntimeSessionRequest,
  RuntimeDiff,
  RuntimeEvent,
  RuntimeSession,
  RuntimeStatus,
  RuntimeTask,
} from "./agent-runtime-adapter.js";
import { OpenCodeHttpClient, type OpenCodeHttpClientOptions, OpenCodeHttpError } from "./opencode-http-client.js";

interface OpenCodeSessionInfo {
  readonly id?: unknown;
  readonly directory?: unknown;
  readonly version?: unknown;
  readonly time?: { readonly created?: unknown };
}

interface OpenCodeStatusInfo {
  readonly type?: unknown;
  readonly attempt?: unknown;
  readonly message?: unknown;
}

interface OpenCodeMessage {
  readonly info?: {
    readonly id?: unknown;
    readonly role?: unknown;
    readonly finish?: unknown;
    readonly time?: { readonly created?: unknown; readonly completed?: unknown };
  };
  readonly parts?: readonly unknown[];
}

interface OpenCodePermissionRequest {
  readonly id?: unknown;
  readonly sessionID?: unknown;
  readonly permission?: unknown;
  readonly patterns?: unknown;
}

interface OpenCodeFileDiff {
  readonly file?: unknown;
  readonly patch?: unknown;
  readonly additions?: unknown;
  readonly deletions?: unknown;
  readonly status?: unknown;
}

interface OpenCodeSessionState {
  session: RuntimeSession;
  readonly workspace: string;
  readonly projectId: string;
  readonly localEvents: RuntimeEvent[];
  localStatus: RuntimeStatus;
  lastTaskId?: string;
}

export interface OpenCodeRuntimeAdapterOptions extends OpenCodeHttpClientOptions {
  readonly agent?: string;
  readonly model?: {
    readonly providerID: string;
    readonly modelID: string;
  };
  readonly now?: () => string;
  readonly createEventId?: () => string;
}

export class OpenCodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeId = "opencode";
  private readonly client: OpenCodeHttpClient;
  private readonly sessions = new Map<string, OpenCodeSessionState>();
  private readonly now: () => string;
  private readonly createEventId: () => string;

  constructor(private readonly options: OpenCodeRuntimeAdapterOptions = {}) {
    this.client = new OpenCodeHttpClient(options);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEventId = options.createEventId ?? (() => globalThis.crypto.randomUUID());
  }

  async createSession(request: CreateRuntimeSessionRequest): Promise<RuntimeSession> {
    if (!request.projectId.trim()) throw new Error("OpenCode session projectId must not be empty");
    if (!request.workspace.trim()) throw new Error("OpenCode session workspace must not be empty");

    const payload = {
      title: `9Router · ${request.projectId}`,
      ...(this.options.agent ? { agent: this.options.agent } : {}),
      ...(this.options.model
        ? {
            model: {
              id: this.options.model.modelID,
              providerID: this.options.model.providerID,
            },
          }
        : {}),
      metadata: {
        ...(request.metadata ?? {}),
        "9router.projectId": request.projectId,
        "9router.riskClass": request.riskClass,
      },
    };
    const raw = await this.client.request<OpenCodeSessionInfo>({
      method: "POST",
      path: "/session",
      directory: request.workspace,
      body: payload,
    });
    const id = stringValue(raw?.id);
    if (!id) throw new OpenCodeHttpError("OpenCode create session response did not include a session id");
    const createdAt = timestamp(raw?.time?.created) ?? this.now();
    const session: RuntimeSession = Object.freeze({
      id,
      runtimeId: this.runtimeId,
      projectId: request.projectId,
      workspace: request.workspace,
      status: "created",
      createdAt,
    });
    const state: OpenCodeSessionState = {
      session,
      workspace: request.workspace,
      projectId: request.projectId,
      localEvents: [],
      localStatus: "created",
    };
    this.sessions.set(id, state);
    this.pushLocalEvent(state, "session_created", undefined, {
      upstreamVersion: stringValue(raw?.version) ?? "unknown",
    });
    return session;
  }

  async sendTask(sessionId: string, task: RuntimeTask): Promise<void> {
    const state = this.requireSession(sessionId);
    this.assertReusable(state);
    if (!task.taskId.trim()) throw new Error("OpenCode runtime taskId must not be empty");
    if (!task.prompt.trim()) throw new Error("OpenCode runtime prompt must not be empty");

    await this.applyToolPolicy(state, task.toolIds);
    const body = {
      ...(this.options.agent ? { agent: this.options.agent } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(task.context.length > 0 ? { system: task.context.join("\n\n") } : {}),
      noReply: false,
      parts: [{ type: "text", text: task.prompt }],
    };

    try {
      await this.client.request<void>({
        method: "POST",
        path: `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        directory: state.workspace,
        body,
      });
    } catch (error) {
      state.localStatus = "failed";
      state.session = this.withStatus(state.session, "failed");
      this.pushLocalEvent(state, "failed", safeError(error), { taskId: task.taskId });
      throw error;
    }

    state.lastTaskId = task.taskId;
    state.localStatus = "running";
    state.session = this.withStatus(state.session, "running");
    this.pushLocalEvent(state, "task_started", task.taskId, { taskId: task.taskId });
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    this.assertStatus(state, ["running", "waiting_approval"]);
    await this.client.request<boolean>({
      method: "POST",
      path: `/session/${encodeURIComponent(sessionId)}/abort`,
      directory: state.workspace,
    });
    state.localStatus = "interrupted";
    state.session = this.withStatus(state.session, "interrupted");
    this.pushLocalEvent(state, "interrupted", "OpenCode aborted the active turn; the session remains reusable.");
  }

  async resume(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    this.assertStatus(state, ["interrupted"]);
    await this.client.request<OpenCodeSessionInfo>({
      method: "GET",
      path: `/session/${encodeURIComponent(sessionId)}`,
      directory: state.workspace,
    });
    state.localStatus = "created";
    state.session = this.withStatus(state.session, "created");
    this.pushLocalEvent(
      state,
      "resumed",
      "OpenCode does not continue an aborted generation; resume marks the existing session reusable for task re-dispatch.",
    );
  }

  async getStatus(sessionId: string): Promise<RuntimeStatus> {
    const state = this.requireSession(sessionId);
    if (["destroyed", "aborted", "failed", "interrupted", "waiting_approval", "completed"].includes(state.localStatus)) {
      return state.localStatus;
    }

    const statuses = await this.client.request<Record<string, OpenCodeStatusInfo>>({
      method: "GET",
      path: "/session/status",
      directory: state.workspace,
    });
    const upstream = statuses?.[sessionId];
    const type = stringValue(upstream?.type) ?? "idle";
    if (type === "busy" || type === "retry") {
      state.localStatus = "running";
      state.session = this.withStatus(state.session, "running");
      return "running";
    }
    if (type !== "idle") {
      throw new OpenCodeHttpError(`OpenCode returned unknown session status: ${type}`);
    }

    if (state.lastTaskId && (await this.hasCompletedAssistantMessage(state))) {
      state.localStatus = "completed";
      state.session = this.withStatus(state.session, "completed");
      return "completed";
    }
    state.localStatus = "created";
    state.session = this.withStatus(state.session, "created");
    return "created";
  }

  async getEvents(sessionId: string, afterEventId?: string): Promise<readonly RuntimeEvent[]> {
    const state = this.requireSession(sessionId);
    const [messages, permissions] = await Promise.all([
      this.getMessages(state),
      this.listPendingPermissions(state).catch(() => []),
    ]);
    const providerEvents = this.messageEvents(state, messages);
    const approvalEvents = this.permissionEvents(state, permissions);
    if (approvalEvents.length > 0 && state.localStatus !== "destroyed" && state.localStatus !== "aborted") {
      state.localStatus = "waiting_approval";
      state.session = this.withStatus(state.session, "waiting_approval");
    }

    const combined = deduplicateEvents([...state.localEvents, ...providerEvents, ...approvalEvents]).sort((a, b) =>
      a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp.localeCompare(b.timestamp),
    );
    if (!afterEventId) return combined;
    const index = combined.findIndex((event) => event.id === afterEventId);
    return index < 0 ? combined : combined.slice(index + 1);
  }

  async getDiff(sessionId: string): Promise<RuntimeDiff> {
    const state = this.requireSession(sessionId);
    const raw = await this.client.request<readonly OpenCodeFileDiff[]>({
      method: "GET",
      path: `/session/${encodeURIComponent(sessionId)}/diff`,
      directory: state.workspace,
    });
    const diffs = Array.isArray(raw) ? raw : [];
    const filesChanged = diffs.map((item) => stringValue(item.file)).filter((item): item is string => Boolean(item));
    const patch = diffs
      .map((item) => stringValue(item.patch))
      .filter((item): item is string => Boolean(item))
      .join("\n");
    return Object.freeze({
      sessionId,
      filesChanged: Object.freeze([...new Set(filesChanged)]),
      patch: patch || undefined,
    });
  }

  async respondToApproval(sessionId: string, response: ApprovalResponse): Promise<void> {
    const state = this.requireSession(sessionId);
    if (!response.approvalId.trim()) throw new Error("OpenCode approvalId must not be empty");
    const reply = response.decision === "approved" ? "once" : "reject";

    try {
      await this.client.request<boolean>({
        method: "POST",
        path: `/permission/${encodeURIComponent(response.approvalId)}/reply`,
        directory: state.workspace,
        body: { reply },
      });
    } catch (error) {
      if (!(error instanceof OpenCodeHttpError) || ![404, 405].includes(error.status ?? 0)) throw error;
      await this.client.request<boolean>({
        method: "POST",
        path: `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(response.approvalId)}`,
        directory: state.workspace,
        body: { response: reply },
      });
    }

    state.localStatus = response.decision === "approved" ? "running" : "aborted";
    state.session = this.withStatus(state.session, state.localStatus);
    this.pushLocalEvent(state, "approval_responded", response.decision, {
      approvalId: response.approvalId,
      actor: response.actor,
    });
  }

  async abort(sessionId: string, reason?: string): Promise<void> {
    const state = this.requireSession(sessionId);
    if (state.localStatus === "destroyed") throw new Error(`OpenCode session ${sessionId} is destroyed`);
    await this.client.request<boolean>({
      method: "POST",
      path: `/session/${encodeURIComponent(sessionId)}/abort`,
      directory: state.workspace,
    });
    state.localStatus = "aborted";
    state.session = this.withStatus(state.session, "aborted");
    this.pushLocalEvent(state, "aborted", reason);
  }

  async destroy(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    if (state.localStatus === "destroyed") return;
    await this.client.request<boolean>({
      method: "DELETE",
      path: `/session/${encodeURIComponent(sessionId)}`,
      directory: state.workspace,
    });
    state.localStatus = "destroyed";
    state.session = this.withStatus(state.session, "destroyed");
    this.pushLocalEvent(state, "destroyed");
  }

  private async applyToolPolicy(state: OpenCodeSessionState, toolIds: readonly string[]): Promise<void> {
    const unique = [...new Set(toolIds.map((item) => item.trim()).filter(Boolean))];
    const permission = [
      { permission: "*", pattern: "*", action: "deny" },
      ...unique.map((toolId) => ({ permission: toolId, pattern: "*", action: "allow" })),
    ];
    await this.client.request<OpenCodeSessionInfo>({
      method: "PATCH",
      path: `/session/${encodeURIComponent(state.session.id)}`,
      directory: state.workspace,
      body: { permission },
    });
  }

  private async getMessages(state: OpenCodeSessionState): Promise<readonly OpenCodeMessage[]> {
    const raw = await this.client.request<readonly OpenCodeMessage[]>({
      method: "GET",
      path: `/session/${encodeURIComponent(state.session.id)}/message`,
      directory: state.workspace,
    });
    return Array.isArray(raw) ? raw : [];
  }

  private async listPendingPermissions(state: OpenCodeSessionState): Promise<readonly OpenCodePermissionRequest[]> {
    const raw = await this.client.request<readonly OpenCodePermissionRequest[]>({
      method: "GET",
      path: "/permission",
      directory: state.workspace,
    });
    return Array.isArray(raw)
      ? raw.filter((item) => stringValue(item.sessionID) === state.session.id)
      : [];
  }

  private async hasCompletedAssistantMessage(state: OpenCodeSessionState): Promise<boolean> {
    const messages = await this.getMessages(state);
    return messages.some((message) => {
      if (stringValue(message.info?.role) !== "assistant") return false;
      return message.info?.time?.completed !== undefined || Boolean(stringValue(message.info?.finish));
    });
  }

  private messageEvents(state: OpenCodeSessionState, messages: readonly OpenCodeMessage[]): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (const message of messages) {
      const id = stringValue(message.info?.id);
      const role = stringValue(message.info?.role);
      if (!id || !role) continue;
      const createdAt = timestamp(message.info?.time?.created) ?? this.now();
      if (role === "user") {
        events.push(
          Object.freeze({
            id: `opencode:message:${id}:user`,
            sessionId: state.session.id,
            type: "task_started",
            timestamp: createdAt,
            metadata: Object.freeze({ upstreamMessageId: id }),
          }),
        );
        continue;
      }
      if (role === "assistant" && (message.info?.time?.completed !== undefined || stringValue(message.info?.finish))) {
        events.push(
          Object.freeze({
            id: `opencode:message:${id}:assistant`,
            sessionId: state.session.id,
            type: "task_completed",
            timestamp: timestamp(message.info?.time?.completed) ?? createdAt,
            metadata: Object.freeze({ upstreamMessageId: id }),
          }),
        );
      }
    }
    return events;
  }

  private permissionEvents(
    state: OpenCodeSessionState,
    permissions: readonly OpenCodePermissionRequest[],
  ): RuntimeEvent[] {
    return permissions.flatMap((permission) => {
      const id = stringValue(permission.id);
      if (!id) return [];
      const permissionName = stringValue(permission.permission) ?? "unknown";
      return [
        Object.freeze({
          id: `opencode:permission:${id}`,
          sessionId: state.session.id,
          type: "approval_requested" as const,
          timestamp: this.now(),
          message: `OpenCode requested permission: ${permissionName}`,
          metadata: Object.freeze({ approvalId: id, permission: permissionName }),
        }),
      ];
    });
  }

  private requireSession(sessionId: string): OpenCodeSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown OpenCode runtime session: ${sessionId}`);
    return state;
  }

  private assertReusable(state: OpenCodeSessionState): void {
    if (["destroyed", "aborted", "failed"].includes(state.localStatus)) {
      throw new Error(`OpenCode session ${state.session.id} is ${state.localStatus}`);
    }
    if (state.localStatus === "running" || state.localStatus === "waiting_approval") {
      throw new Error(`OpenCode session ${state.session.id} is already ${state.localStatus}`);
    }
  }

  private assertStatus(state: OpenCodeSessionState, allowed: readonly RuntimeStatus[]): void {
    if (!allowed.includes(state.localStatus)) {
      throw new Error(
        `OpenCode session ${state.session.id} is ${state.localStatus}; expected ${allowed.join(" or ")}`,
      );
    }
  }

  private withStatus(session: RuntimeSession, status: RuntimeStatus): RuntimeSession {
    return Object.freeze({ ...session, status });
  }

  private pushLocalEvent(
    state: OpenCodeSessionState,
    type: RuntimeEvent["type"],
    message?: string,
    metadata?: RuntimeEvent["metadata"],
  ): void {
    state.localEvents.push(
      Object.freeze({
        id: `9router:${this.createEventId()}`,
        sessionId: state.session.id,
        type,
        timestamp: this.now(),
        message,
        metadata: metadata ? Object.freeze({ ...metadata }) : undefined,
      }),
    );
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function deduplicateEvents(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const seen = new Set<string>();
  const result: RuntimeEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    result.push(event);
  }
  return result;
}
