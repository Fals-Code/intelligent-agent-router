import type { RiskClass } from "../control-plane/contracts.js";

export type RuntimeStatus =
  | "created"
  | "running"
  | "interrupted"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "aborted"
  | "destroyed";

export interface CreateRuntimeSessionRequest {
  readonly projectId: string;
  readonly workspace: string;
  readonly riskClass: RiskClass;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RuntimeSession {
  readonly id: string;
  readonly runtimeId: string;
  readonly projectId: string;
  readonly workspace: string;
  readonly status: RuntimeStatus;
  readonly createdAt: string;
}

export interface RuntimeSessionReference {
  readonly id: string;
  readonly runtimeId: string;
  readonly projectId: string;
  readonly workspace: string;
  readonly createdAt?: string;
}

export interface RuntimeTask {
  readonly taskId: string;
  readonly prompt: string;
  readonly context: readonly string[];
  readonly toolIds: readonly string[];
}

export interface RuntimeEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly type:
    | "session_created"
    | "task_started"
    | "task_completed"
    | "interrupted"
    | "resumed"
    | "approval_requested"
    | "approval_responded"
    | "failed"
    | "aborted"
    | "destroyed";
  readonly timestamp: string;
  readonly message?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RuntimeDiff {
  readonly sessionId: string;
  readonly filesChanged: readonly string[];
  readonly patch?: string;
  readonly commitSha?: string;
}

export interface ApprovalResponse {
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
  readonly actor: string;
}

export interface AgentRuntimeAdapter {
  readonly runtimeId: string;
  createSession(request: CreateRuntimeSessionRequest): Promise<RuntimeSession>;
  sendTask(sessionId: string, task: RuntimeTask): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<RuntimeStatus>;
  getEvents(sessionId: string, afterEventId?: string): Promise<readonly RuntimeEvent[]>;
  getDiff(sessionId: string): Promise<RuntimeDiff>;
  respondToApproval(sessionId: string, response: ApprovalResponse): Promise<void>;
  abort(sessionId: string, reason?: string): Promise<void>;
  destroy(sessionId: string): Promise<void>;
}

export interface RecoverableAgentRuntimeAdapter extends AgentRuntimeAdapter {
  attachSession(reference: RuntimeSessionReference): Promise<RuntimeSession>;
}

export function supportsRuntimeSessionAttach(
  adapter: AgentRuntimeAdapter,
): adapter is RecoverableAgentRuntimeAdapter {
  return typeof (adapter as Partial<RecoverableAgentRuntimeAdapter>).attachSession === "function";
}
