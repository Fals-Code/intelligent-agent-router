import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { WorkflowRun } from "../control-plane/contracts.js";
import { planWorkflowRecovery, type WorkflowRecoveryDecision } from "../control-plane/durable-workflow.js";
import type { RuntimeStatus } from "../runtime/agent-runtime-adapter.js";

export const RUNTIME_BINDING_SCHEMA_VERSION = 1 as const;

export interface RuntimeBinding {
  readonly workflowRunId: string;
  readonly projectId: string;
  readonly workflowAttempt: number;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly boundAt: string;
}

export interface RuntimeBindingStore {
  bind(binding: RuntimeBinding): void;
  get(workflowRunId: string): RuntimeBinding | undefined;
  history(workflowRunId: string): readonly RuntimeBinding[];
}

export interface JsonlRuntimeBindingStoreOptions {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxBindingBytes: number;
}

export class JsonlRuntimeBindingStore implements RuntimeBindingStore {
  readonly filePath: string;
  private readonly maxFileBytes: number;
  private readonly maxBindingBytes: number;
  private readonly latest = new Map<string, RuntimeBinding>();
  private readonly histories = new Map<string, RuntimeBinding[]>();
  private expectedFileSize = 0;
  private nextSequence = 1;

  constructor(options: JsonlRuntimeBindingStoreOptions) {
    if (!options.filePath.trim()) throw new Error("Runtime binding filePath must not be empty");
    assertPositiveInteger(options.maxFileBytes, "Runtime binding maxFileBytes");
    assertPositiveInteger(options.maxBindingBytes, "Runtime binding maxBindingBytes");
    if (options.maxBindingBytes > options.maxFileBytes) {
      throw new Error("Runtime binding maxBindingBytes must not exceed maxFileBytes");
    }
    this.filePath = resolve(options.filePath);
    this.maxFileBytes = options.maxFileBytes;
    this.maxBindingBytes = options.maxBindingBytes;
    mkdirSync(resolve(this.filePath, ".."), { recursive: true });
    this.load();
  }

  bind(binding: RuntimeBinding): void {
    this.assertStorageUnchanged();
    assertRuntimeBinding(binding, "Runtime binding");
    const previous = this.latest.get(binding.workflowRunId);
    if (previous) assertBindingProgression(previous, binding);
    const prepared = deepFreeze({ ...binding });
    const line = `${JSON.stringify({ schemaVersion: RUNTIME_BINDING_SCHEMA_VERSION, sequence: this.nextSequence, binding: prepared })}\n`;
    const lineBytes = utf8ByteLength(line);
    if (lineBytes > this.maxBindingBytes) {
      throw new Error(`Runtime binding exceeds maxBindingBytes: runId=${binding.workflowRunId} bytes=${lineBytes} max=${this.maxBindingBytes}`);
    }
    if (this.expectedFileSize + lineBytes > this.maxFileBytes) {
      throw new Error(`Runtime binding append would exceed maxFileBytes: current=${this.expectedFileSize} append=${lineBytes} max=${this.maxFileBytes}`);
    }
    const handle = openSync(this.filePath, "a", 0o600);
    try {
      writeFileSync(handle, line, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    this.expectedFileSize += lineBytes;
    this.nextSequence += 1;
    this.admit(prepared);
  }

  get(workflowRunId: string): RuntimeBinding | undefined {
    return this.latest.get(workflowRunId);
  }

  history(workflowRunId: string): readonly RuntimeBinding[] {
    return [...(this.histories.get(workflowRunId) ?? [])];
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const size = statSync(this.filePath).size;
    if (size > this.maxFileBytes) throw new Error(`Runtime binding file exceeds maxFileBytes: bytes=${size} max=${this.maxFileBytes}`);
    const raw = readFileSync(this.filePath, "utf8");
    this.expectedFileSize = utf8ByteLength(raw);
    if (!raw) return;
    if (!raw.endsWith("\n")) throw new Error(`Runtime binding file is not newline-terminated; possible partial write: ${this.filePath}`);
    const lines = raw.slice(0, -1).split("\n");
    let expectedSequence = 1;
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      if (!line.trim()) throw new Error(`Runtime binding file contains an empty record at line ${lineNumber}`);
      const lineBytes = utf8ByteLength(`${line}\n`);
      if (lineBytes > this.maxBindingBytes) throw new Error(`Runtime binding at line ${lineNumber} exceeds maxBindingBytes: bytes=${lineBytes} max=${this.maxBindingBytes}`);
      const parsed = parseBinding(line, lineNumber);
      if (parsed.sequence !== expectedSequence) throw new Error(`Runtime binding sequence mismatch at line ${lineNumber}: expected=${expectedSequence} actual=${parsed.sequence}`);
      expectedSequence += 1;
      const previous = this.latest.get(parsed.binding.workflowRunId);
      if (previous) assertBindingProgression(previous, parsed.binding);
      this.admit(deepFreeze({ ...parsed.binding }));
    }
    this.nextSequence = expectedSequence;
  }

  private admit(binding: RuntimeBinding): void {
    this.latest.set(binding.workflowRunId, binding);
    const history = this.histories.get(binding.workflowRunId) ?? [];
    history.push(binding);
    this.histories.set(binding.workflowRunId, history);
  }

  private assertStorageUnchanged(): void {
    const currentSize = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (currentSize !== this.expectedFileSize) throw new Error(`Runtime binding file changed outside this writer; reopen before binding: expectedBytes=${this.expectedFileSize} actualBytes=${currentSize}`);
  }
}

export interface RuntimeEventSummary {
  readonly count: number;
  readonly types: readonly string[];
  readonly lastEventId?: string;
  readonly lastEventAt?: string;
}

export interface RuntimeDiffSummary {
  readonly filesChanged: readonly string[];
  readonly commitSha?: string;
  readonly patchObserved: boolean;
}

export interface RuntimeObservation {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly status: RuntimeStatus;
  readonly observedAt: string;
  readonly events: RuntimeEventSummary;
  readonly diff: RuntimeDiffSummary;
}

export interface RuntimeReconciliationProbe {
  readonly runtimeId: string;
  inspect(binding: RuntimeBinding): Promise<RuntimeObservation>;
}

export type RuntimeReconciliationDisposition =
  | "workflow_does_not_require_runtime_reconciliation"
  | "wait_runtime"
  | "await_runtime_approval"
  | "verify_runtime_result"
  | "explicit_resume_or_retry"
  | "explicit_failure_or_retry"
  | "manual_intervention"
  | "observation_failed";

export interface RuntimeReconciliationReport {
  readonly workflowRunId: string;
  readonly recovery: WorkflowRecoveryDecision;
  readonly binding?: RuntimeBinding;
  readonly observation?: RuntimeObservation;
  readonly disposition: RuntimeReconciliationDisposition;
  readonly automaticRedispatchAllowed: false;
  readonly verificationRequired: boolean;
  readonly reason: string;
  readonly observationError?: string;
}

export class RuntimeReconciliationCoordinator {
  async reconcile(run: WorkflowRun, binding: RuntimeBinding | undefined, probe: RuntimeReconciliationProbe | undefined): Promise<RuntimeReconciliationReport> {
    const recovery = planWorkflowRecovery(run);
    if (!recovery.runtimeReconciliationRequired) {
      return report(run, recovery, undefined, undefined, "workflow_does_not_require_runtime_reconciliation", false, recovery.reason);
    }
    if (!binding) {
      return report(run, recovery, undefined, undefined, "manual_intervention", false, "Active workflow has no durable runtime binding; automatic re-dispatch is forbidden.");
    }
    assertBindingMatchesWorkflow(binding, run);
    if (!probe) {
      return report(run, recovery, binding, undefined, "manual_intervention", false, `No reconciliation probe is registered for runtime ${binding.runtimeId}.`);
    }
    if (probe.runtimeId !== binding.runtimeId) throw new Error(`Runtime reconciliation probe mismatch: binding=${binding.runtimeId} probe=${probe.runtimeId}`);

    let observation: RuntimeObservation;
    try {
      observation = await probe.inspect(binding);
    } catch (error) {
      return Object.freeze({
        ...report(run, recovery, binding, undefined, "observation_failed", false, "Runtime observation failed; fail closed and require explicit intervention."),
        observationError: safeErrorMessage(error),
      });
    }
    assertObservationMatchesBinding(observation, binding);

    switch (observation.status) {
      case "running":
        return report(run, recovery, binding, observation, "wait_runtime", false, "Runtime is still active; do not re-dispatch.");
      case "waiting_approval":
        return report(run, recovery, binding, observation, "await_runtime_approval", false, "Runtime reports a pending approval; restart must not bypass it.");
      case "completed":
        return report(run, recovery, binding, observation, "verify_runtime_result", true, "Runtime appears completed, but provider status is evidence only; deterministic verification is required before workflow advancement.");
      case "interrupted":
        return report(run, recovery, binding, observation, "explicit_resume_or_retry", false, "Runtime was interrupted; resume or retry requires an explicit control-plane decision.");
      case "failed":
      case "aborted":
      case "destroyed":
        return report(run, recovery, binding, observation, "explicit_failure_or_retry", false, `Runtime is ${observation.status}; workflow failure/retry remains an explicit control-plane transition.`);
      case "created":
        return report(run, recovery, binding, observation, "manual_intervention", false, "Runtime session exists but no active/completed task can be proven; do not re-dispatch automatically.");
    }
  }
}

function report(run: WorkflowRun, recovery: WorkflowRecoveryDecision, binding: RuntimeBinding | undefined, observation: RuntimeObservation | undefined, disposition: RuntimeReconciliationDisposition, verificationRequired: boolean, reason: string): RuntimeReconciliationReport {
  return Object.freeze({ workflowRunId: run.id, recovery, binding, observation, disposition, automaticRedispatchAllowed: false as const, verificationRequired, reason });
}

function parseBinding(line: string, lineNumber: number): { sequence: number; binding: RuntimeBinding } {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Runtime binding contains invalid JSON at line ${lineNumber}: ${safeErrorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Runtime binding at line ${lineNumber} must be an object`);
  if (value.schemaVersion !== RUNTIME_BINDING_SCHEMA_VERSION) throw new Error(`Unsupported runtime binding schema version at line ${lineNumber}: ${String(value.schemaVersion)}`);
  if (!Number.isInteger(value.sequence) || Number(value.sequence) <= 0) throw new Error(`Runtime binding sequence at line ${lineNumber} must be a positive integer`);
  assertRuntimeBinding(value.binding, `Runtime binding at line ${lineNumber}`);
  return { sequence: Number(value.sequence), binding: value.binding };
}

function assertRuntimeBinding(value: unknown, label: string): asserts value is RuntimeBinding {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set(["workflowRunId", "projectId", "workflowAttempt", "runtimeId", "sessionId", "workspace", "boundAt"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const field of ["workflowRunId", "projectId", "runtimeId", "sessionId", "workspace", "boundAt"] as const) assertNonEmptyString(value[field], `${label}.${field}`);
  if (!Number.isInteger(value.workflowAttempt) || Number(value.workflowAttempt) < 1) throw new Error(`${label}.workflowAttempt must be a positive integer`);
  if (!Number.isFinite(Date.parse(String(value.boundAt)))) throw new Error(`${label}.boundAt must be a valid timestamp`);
}

function assertBindingProgression(previous: RuntimeBinding, next: RuntimeBinding): void {
  if (previous.projectId !== next.projectId) throw new Error(`Runtime binding projectId is immutable for ${next.workflowRunId}`);
  if (next.workflowAttempt <= previous.workflowAttempt) throw new Error(`Runtime binding workflowAttempt must increase for ${next.workflowRunId}`);
  if (Date.parse(next.boundAt) < Date.parse(previous.boundAt)) throw new Error(`Runtime binding boundAt cannot move backwards for ${next.workflowRunId}`);
}

function assertBindingMatchesWorkflow(binding: RuntimeBinding, run: WorkflowRun): void {
  if (binding.workflowRunId !== run.id) throw new Error(`Runtime binding workflowRunId does not match workflow ${run.id}`);
  if (binding.projectId !== run.projectId) throw new Error(`Runtime binding projectId does not match workflow ${run.id}`);
  if (binding.workflowAttempt !== run.attempt) throw new Error(`Runtime binding attempt does not match workflow ${run.id}: binding=${binding.workflowAttempt} workflow=${run.attempt}`);
}

function assertObservationMatchesBinding(observation: RuntimeObservation, binding: RuntimeBinding): void {
  if (observation.runtimeId !== binding.runtimeId) throw new Error(`Runtime observation runtimeId mismatch: expected=${binding.runtimeId} actual=${observation.runtimeId}`);
  if (observation.sessionId !== binding.sessionId) throw new Error(`Runtime observation sessionId mismatch: expected=${binding.sessionId} actual=${observation.sessionId}`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]").slice(0, 1_000);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
