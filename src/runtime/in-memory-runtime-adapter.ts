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

interface SessionState {
  session: RuntimeSession;
  events: RuntimeEvent[];
  diff: RuntimeDiff;
  pendingApprovalId?: string;
}

export interface InMemoryRuntimeAdapterOptions {
  readonly runtimeId?: string;
  readonly now?: () => string;
  readonly createSessionId?: () => string;
  readonly createEventId?: () => string;
}

export class InMemoryAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeId: string;
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => string;
  private readonly createSessionId: () => string;
  private readonly createEventId: () => string;

  constructor(options: InMemoryRuntimeAdapterOptions = {}) {
    this.runtimeId = options.runtimeId ?? "in-memory-runtime";
    this.now = options.now ?? (() => new Date().toISOString());
    this.createSessionId = options.createSessionId ?? (() => globalThis.crypto.randomUUID());
    this.createEventId = options.createEventId ?? (() => globalThis.crypto.randomUUID());
  }

  async createSession(request: CreateRuntimeSessionRequest): Promise<RuntimeSession> {
    if (!request.projectId.trim()) throw new Error("Runtime session projectId must not be empty");
    if (!request.workspace.trim()) throw new Error("Runtime session workspace must not be empty");
    const id = this.createSessionId();
    if (this.sessions.has(id)) throw new Error(`Runtime session already exists: ${id}`);
    const session: RuntimeSession = Object.freeze({
      id,
      runtimeId: this.runtimeId,
      projectId: request.projectId,
      workspace: request.workspace,
      status: "created",
      createdAt: this.now(),
    });
    const state: SessionState = {
      session,
      events: [],
      diff: Object.freeze({ sessionId: id, filesChanged: Object.freeze([]) }),
    };
    this.sessions.set(id, state);
    this.pushEvent(state, "session_created");
    return state.session;
  }

  async sendTask(sessionId: string, task: RuntimeTask): Promise<void> {
    const state = this.requireSession(sessionId);
    this.assertOperational(state);
    if (!task.taskId.trim() || !task.prompt.trim()) throw new Error("Runtime task requires taskId and prompt");
    state.session = this.withStatus(state.session, "running");
    this.pushEvent(state, "task_started", task.taskId, { taskId: task.taskId });
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    this.assertStatus(state, ["running"]);
    state.session = this.withStatus(state.session, "interrupted");
    this.pushEvent(state, "interrupted");
  }

  async resume(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    this.assertStatus(state, ["interrupted"]);
    state.session = this.withStatus(state.session, "running");
    this.pushEvent(state, "resumed");
  }

  async getStatus(sessionId: string): Promise<RuntimeStatus> {
    return this.requireSession(sessionId).session.status;
  }

  async getEvents(sessionId: string, afterEventId?: string): Promise<readonly RuntimeEvent[]> {
    const events = this.requireSession(sessionId).events;
    if (!afterEventId) return [...events];
    const index = events.findIndex((event) => event.id === afterEventId);
    return index < 0 ? [...events] : events.slice(index + 1);
  }

  async getDiff(sessionId: string): Promise<RuntimeDiff> {
    return this.requireSession(sessionId).diff;
  }

  async respondToApproval(sessionId: string, response: ApprovalResponse): Promise<void> {
    const state = this.requireSession(sessionId);
    this.assertStatus(state, ["waiting_approval"]);
    if (state.pendingApprovalId !== response.approvalId) {
      throw new Error(`Approval ${response.approvalId} is not pending for session ${sessionId}`);
    }
    state.pendingApprovalId = undefined;
    state.session = this.withStatus(state.session, response.decision === "approved" ? "running" : "aborted");
    this.pushEvent(state, "approval_responded", response.decision, {
      approvalId: response.approvalId,
      actor: response.actor,
    });
  }

  async abort(sessionId: string, reason?: string): Promise<void> {
    const state = this.requireSession(sessionId);
    if (state.session.status === "destroyed") throw new Error(`Runtime session ${sessionId} is destroyed`);
    state.session = this.withStatus(state.session, "aborted");
    this.pushEvent(state, "aborted", reason);
  }

  async destroy(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    if (state.session.status === "destroyed") return;
    state.session = this.withStatus(state.session, "destroyed");
    this.pushEvent(state, "destroyed");
  }

  requestApproval(sessionId: string, approvalId: string): void {
    const state = this.requireSession(sessionId);
    this.assertStatus(state, ["running"]);
    if (!approvalId.trim()) throw new Error("approvalId must not be empty");
    state.pendingApprovalId = approvalId;
    state.session = this.withStatus(state.session, "waiting_approval");
    this.pushEvent(state, "approval_requested", undefined, { approvalId });
  }

  completeTask(sessionId: string, diff: Omit<RuntimeDiff, "sessionId"> = { filesChanged: [] }): void {
    const state = this.requireSession(sessionId);
    this.assertStatus(state, ["running"]);
    state.diff = Object.freeze({
      sessionId,
      filesChanged: Object.freeze([...diff.filesChanged]),
      patch: diff.patch,
      commitSha: diff.commitSha,
    });
    state.session = this.withStatus(state.session, "completed");
    this.pushEvent(state, "task_completed");
  }

  fail(sessionId: string, reason: string): void {
    const state = this.requireSession(sessionId);
    this.assertOperational(state);
    state.session = this.withStatus(state.session, "failed");
    this.pushEvent(state, "failed", reason);
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown runtime session: ${sessionId}`);
    return state;
  }

  private assertOperational(state: SessionState): void {
    if (["aborted", "destroyed", "failed", "completed"].includes(state.session.status)) {
      throw new Error(`Runtime session ${state.session.id} is ${state.session.status}`);
    }
  }

  private assertStatus(state: SessionState, allowed: readonly RuntimeStatus[]): void {
    if (!allowed.includes(state.session.status)) {
      throw new Error(`Runtime session ${state.session.id} is ${state.session.status}; expected ${allowed.join(" or ")}`);
    }
  }

  private withStatus(session: RuntimeSession, status: RuntimeStatus): RuntimeSession {
    return Object.freeze({ ...session, status });
  }

  private pushEvent(
    state: SessionState,
    type: RuntimeEvent["type"],
    message?: string,
    metadata?: RuntimeEvent["metadata"],
  ): void {
    state.events.push(
      Object.freeze({
        id: this.createEventId(),
        sessionId: state.session.id,
        type,
        timestamp: this.now(),
        message,
        metadata: metadata ? Object.freeze({ ...metadata }) : undefined,
      }),
    );
  }
}
