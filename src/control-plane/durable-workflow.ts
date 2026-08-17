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
import type { WorkflowPhase, WorkflowRun, WorkflowStatus } from "./contracts.js";
import { WorkflowStateMachine, type CreateWorkflowRunInput } from "./workflow-state-machine.js";

export const WORKFLOW_CHECKPOINT_SCHEMA_VERSION = 1 as const;

const PHASE_ORDER: Readonly<Record<WorkflowPhase, number>> = {
  start: 0,
  classify: 1,
  compile_context: 2,
  execute: 3,
  verify: 4,
  review: 5,
  approval: 6,
  publish: 7,
};

const WORKFLOW_RUN_FIELDS = new Set([
  "id",
  "projectId",
  "riskClass",
  "phase",
  "status",
  "attempt",
  "approvalIds",
  "createdAt",
  "updatedAt",
  "failureReason",
]);

export interface WorkflowCheckpointStore {
  checkpoint(run: WorkflowRun): void;
  get(runId: string): WorkflowRun | undefined;
  list(): readonly WorkflowRun[];
  history(runId: string): readonly WorkflowRun[];
}

export interface JsonlWorkflowCheckpointStoreOptions {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxCheckpointBytes: number;
}

/**
 * Local, append-only, single-writer workflow checkpoint persistence.
 *
 * Every line is a versioned full WorkflowRun snapshot with a monotonic global
 * sequence number. File and checkpoint byte limits are explicit. A successful
 * checkpoint is fsync'd before it becomes visible through this instance.
 *
 * The first checkpoint for a run must equal WorkflowStateMachine.create(). Every
 * later checkpoint is replay-validated against an official state-machine
 * transition so persistence cannot silently invent a second workflow semantics.
 */
export class JsonlWorkflowCheckpointStore implements WorkflowCheckpointStore {
  readonly filePath: string;
  private readonly maxFileBytes: number;
  private readonly maxCheckpointBytes: number;
  private readonly latest = new Map<string, WorkflowRun>();
  private readonly histories = new Map<string, WorkflowRun[]>();
  private expectedFileSize = 0;
  private nextSequence = 1;

  constructor(options: JsonlWorkflowCheckpointStoreOptions) {
    if (!options.filePath.trim()) throw new Error("Workflow checkpoint filePath must not be empty");
    assertPositiveInteger(options.maxFileBytes, "Workflow checkpoint maxFileBytes");
    assertPositiveInteger(options.maxCheckpointBytes, "Workflow checkpoint maxCheckpointBytes");
    if (options.maxCheckpointBytes > options.maxFileBytes) {
      throw new Error("Workflow checkpoint maxCheckpointBytes must not exceed maxFileBytes");
    }

    this.filePath = resolve(options.filePath);
    this.maxFileBytes = options.maxFileBytes;
    this.maxCheckpointBytes = options.maxCheckpointBytes;
    mkdirSync(resolve(this.filePath, ".."), { recursive: true });
    this.load();
  }

  checkpoint(run: WorkflowRun): void {
    this.assertStorageUnchanged();
    assertWorkflowRun(run, "Workflow checkpoint");
    const previous = this.latest.get(run.id);
    if (previous) assertCheckpointTransition(previous, run);
    else assertInitialCheckpoint(run);

    const prepared = deepFreeze(cloneWorkflowRun(run));
    const line = `${JSON.stringify({
      schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
      sequence: this.nextSequence,
      run: prepared,
    })}\n`;
    const lineBytes = utf8ByteLength(line);

    if (lineBytes > this.maxCheckpointBytes) {
      throw new Error(
        `Workflow checkpoint exceeds maxCheckpointBytes: runId=${run.id} bytes=${lineBytes} max=${this.maxCheckpointBytes}`,
      );
    }
    if (this.expectedFileSize + lineBytes > this.maxFileBytes) {
      throw new Error(
        `Workflow checkpoint append would exceed maxFileBytes: current=${this.expectedFileSize} append=${lineBytes} max=${this.maxFileBytes}`,
      );
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

  get(runId: string): WorkflowRun | undefined {
    return this.latest.get(runId);
  }

  list(): readonly WorkflowRun[] {
    return [...this.latest.values()];
  }

  history(runId: string): readonly WorkflowRun[] {
    return [...(this.histories.get(runId) ?? [])];
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const size = statSync(this.filePath).size;
    if (size > this.maxFileBytes) {
      throw new Error(`Workflow checkpoint file exceeds maxFileBytes: bytes=${size} max=${this.maxFileBytes}`);
    }

    const raw = readFileSync(this.filePath, "utf8");
    this.expectedFileSize = utf8ByteLength(raw);
    if (raw.length === 0) return;
    if (!raw.endsWith("\n")) {
      throw new Error(`Workflow checkpoint file is not newline-terminated; possible partial write: ${this.filePath}`);
    }

    const lines = raw.slice(0, -1).split("\n");
    let expectedSequence = 1;
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      if (!line.trim()) throw new Error(`Workflow checkpoint file contains an empty record at line ${lineNumber}`);
      const lineBytes = utf8ByteLength(`${line}\n`);
      if (lineBytes > this.maxCheckpointBytes) {
        throw new Error(
          `Workflow checkpoint at line ${lineNumber} exceeds maxCheckpointBytes: bytes=${lineBytes} max=${this.maxCheckpointBytes}`,
        );
      }

      const parsed = parseCheckpoint(line, lineNumber);
      if (parsed.sequence !== expectedSequence) {
        throw new Error(
          `Workflow checkpoint sequence mismatch at line ${lineNumber}: expected=${expectedSequence} actual=${parsed.sequence}`,
        );
      }
      expectedSequence += 1;

      const previous = this.latest.get(parsed.run.id);
      if (previous) assertCheckpointTransition(previous, parsed.run);
      else assertInitialCheckpoint(parsed.run);
      this.admit(deepFreeze(cloneWorkflowRun(parsed.run)));
    }

    this.nextSequence = expectedSequence;
  }

  private admit(run: WorkflowRun): void {
    this.latest.set(run.id, run);
    const history = this.histories.get(run.id) ?? [];
    history.push(run);
    this.histories.set(run.id, history);
  }

  private assertStorageUnchanged(): void {
    const currentSize = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (currentSize !== this.expectedFileSize) {
      throw new Error(
        `Workflow checkpoint file changed outside this writer; reopen before checkpointing: expectedBytes=${this.expectedFileSize} actualBytes=${currentSize}`,
      );
    }
  }
}

export type WorkflowRecoveryDisposition =
  | "safe_to_start"
  | "await_approval"
  | "await_external"
  | "reconcile_runtime"
  | "reconcile_retry"
  | "explicit_retry"
  | "terminal";

export interface WorkflowRecoveryDecision {
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly phase: WorkflowPhase;
  readonly disposition: WorkflowRecoveryDisposition;
  readonly automaticResumeAllowed: boolean;
  readonly runtimeReconciliationRequired: boolean;
  readonly reason: string;
}

/**
 * Classify a persisted workflow after a process/machine restart.
 *
 * Active or retrying work is never silently resumed because the external runtime
 * may have observed side effects before the process disappeared. Only a never-
 * started queued run is classified as safe to start automatically.
 */
export function planWorkflowRecovery(run: WorkflowRun): WorkflowRecoveryDecision {
  assertWorkflowRun(run, "Workflow recovery input");

  switch (run.status) {
    case "queued":
      return recovery(run, "safe_to_start", true, false, "Run has not started; no runtime side effect needs reconciliation.");
    case "waiting_approval":
      return recovery(run, "await_approval", false, false, "Durable approval wait must remain pending after restart.");
    case "waiting_external":
      return recovery(run, "await_external", false, false, "External dependency must be re-evaluated explicitly before resume.");
    case "running":
      return recovery(run, "reconcile_runtime", false, true, "Run was active at restart; reconcile runtime/session side effects before any resume or re-dispatch.");
    case "retrying":
      return recovery(run, "reconcile_retry", false, true, "Retry state may already have interacted with an external runtime; reconcile before retry execution.");
    case "failed":
      return recovery(run, "explicit_retry", false, false, "Failed runs require an explicit retry decision; restart does not create retry authority.");
    case "cancelled":
    case "succeeded":
      return recovery(run, "terminal", false, false, "Terminal workflow requires no restart action.");
  }
}

export class DurableWorkflowStateMachine {
  constructor(
    private readonly store: WorkflowCheckpointStore,
    private readonly machine = new WorkflowStateMachine(),
  ) {}

  create(input: CreateWorkflowRunInput): WorkflowRun {
    return this.persist(this.machine.create(input));
  }

  start(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.start(run, now));
  }

  advance(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.advance(run, now));
  }

  requestApproval(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.requestApproval(run, now));
  }

  approve(run: WorkflowRun, approvalId: string, now?: string): WorkflowRun {
    return this.persist(this.machine.approve(run, approvalId, now));
  }

  skipApproval(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.skipApproval(run, now));
  }

  pause(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.pause(run, now));
  }

  resume(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.resume(run, now));
  }

  retry(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.retry(run, now));
  }

  recover(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.recover(run, now));
  }

  fail(run: WorkflowRun, reason: string, now?: string): WorkflowRun {
    return this.persist(this.machine.fail(run, reason, now));
  }

  cancel(run: WorkflowRun, now?: string): WorkflowRun {
    return this.persist(this.machine.cancel(run, now));
  }

  succeed(run: WorkflowRun, evidenceGatePassed: boolean, now?: string): WorkflowRun {
    return this.persist(this.machine.succeed(run, evidenceGatePassed, now));
  }

  load(runId: string): WorkflowRun | undefined {
    return this.store.get(runId);
  }

  recoveryDecision(runId: string): WorkflowRecoveryDecision {
    const run = this.store.get(runId);
    if (!run) throw new Error(`Unknown durable workflow: ${runId}`);
    return planWorkflowRecovery(run);
  }

  private persist(run: WorkflowRun): WorkflowRun {
    this.store.checkpoint(run);
    return run;
  }
}

function parseCheckpoint(line: string, lineNumber: number): { sequence: number; run: WorkflowRun } {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Workflow checkpoint contains invalid JSON at line ${lineNumber}: ${safeErrorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Workflow checkpoint at line ${lineNumber} must be an object`);
  if (value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported workflow checkpoint schema version at line ${lineNumber}: ${String(value.schemaVersion)}`,
    );
  }
  if (!Number.isInteger(value.sequence) || Number(value.sequence) <= 0) {
    throw new Error(`Workflow checkpoint sequence at line ${lineNumber} must be a positive integer`);
  }
  assertWorkflowRun(value.run, `Workflow checkpoint at line ${lineNumber}`);
  return { sequence: Number(value.sequence), run: value.run };
}

function assertWorkflowRun(value: unknown, label: string): asserts value is WorkflowRun {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!WORKFLOW_RUN_FIELDS.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
  for (const field of ["id", "projectId", "createdAt", "updatedAt"] as const) {
    assertNonEmptyString(value[field], `${label}.${field}`);
  }
  assertTimestamp(value.createdAt, `${label}.createdAt`);
  assertTimestamp(value.updatedAt, `${label}.updatedAt`);
  if (timestamp(value.updatedAt) < timestamp(value.createdAt)) {
    throw new Error(`${label}.updatedAt must not precede createdAt`);
  }
  if (!["R0", "R1", "R2", "R3", "R4"].includes(String(value.riskClass))) {
    throw new Error(`${label}.riskClass is invalid`);
  }
  if (!Object.prototype.hasOwnProperty.call(PHASE_ORDER, String(value.phase))) {
    throw new Error(`${label}.phase is invalid`);
  }
  if (![
    "queued",
    "running",
    "waiting_external",
    "waiting_approval",
    "retrying",
    "failed",
    "cancelled",
    "succeeded",
  ].includes(String(value.status))) {
    throw new Error(`${label}.status is invalid`);
  }
  if (!Number.isInteger(value.attempt) || Number(value.attempt) < 0) {
    throw new Error(`${label}.attempt must be a non-negative integer`);
  }
  assertStringArray(value.approvalIds, `${label}.approvalIds`, true);
  if (value.failureReason !== undefined && (typeof value.failureReason !== "string" || !value.failureReason.trim())) {
    throw new Error(`${label}.failureReason must be a non-empty string when present`);
  }
  if (value.status === "failed" && (typeof value.failureReason !== "string" || !value.failureReason.trim())) {
    throw new Error(`${label}.failed status requires failureReason`);
  }
  if (value.status === "queued" && (value.phase !== "start" || value.attempt !== 0)) {
    throw new Error(`${label}.queued state must be phase=start attempt=0`);
  }
  if (value.status === "waiting_approval" && value.phase !== "approval") {
    throw new Error(`${label}.waiting_approval state must be phase=approval`);
  }
  if (value.status === "succeeded" && value.phase !== "publish") {
    throw new Error(`${label}.succeeded state must be phase=publish`);
  }
  if (["running", "waiting_external", "waiting_approval", "retrying"].includes(String(value.status)) && Number(value.attempt) < 1) {
    throw new Error(`${label}.${String(value.status)} state requires attempt >= 1`);
  }
}

function assertInitialCheckpoint(run: WorkflowRun): void {
  const machine = new WorkflowStateMachine();
  const expected = machine.create({
    id: run.id,
    projectId: run.projectId,
    riskClass: run.riskClass,
    now: run.createdAt,
  });
  if (!sameWorkflowRun(expected, run)) {
    throw new Error(`Workflow ${run.id} initial checkpoint must equal canonical WorkflowStateMachine.create() state`);
  }
}

function assertCheckpointTransition(previous: WorkflowRun, next: WorkflowRun): void {
  if (previous.projectId !== next.projectId) throw new Error(`Workflow ${next.id} projectId is immutable`);
  if (previous.riskClass !== next.riskClass) throw new Error(`Workflow ${next.id} riskClass is immutable`);
  if (previous.createdAt !== next.createdAt) throw new Error(`Workflow ${next.id} createdAt is immutable`);
  if (timestamp(next.updatedAt) < timestamp(previous.updatedAt)) {
    throw new Error(`Workflow ${next.id} updatedAt cannot move backwards`);
  }
  if (!isPrefix(previous.approvalIds, next.approvalIds)) {
    throw new Error(`Workflow ${next.id} approvalIds are append-only`);
  }

  const machine = new WorkflowStateMachine();
  const candidates: WorkflowRun[] = [];
  const collect = (transition: () => WorkflowRun): void => {
    try {
      candidates.push(transition());
    } catch {
      // An invalid transition from this previous state is simply not a candidate.
    }
  };

  collect(() => machine.start(previous, next.updatedAt));
  collect(() => machine.advance(previous, next.updatedAt));
  collect(() => machine.requestApproval(previous, next.updatedAt));
  if (
    next.approvalIds.length === previous.approvalIds.length + 1 &&
    isPrefix(previous.approvalIds, next.approvalIds)
  ) {
    const approvalId = next.approvalIds[previous.approvalIds.length];
    if (approvalId) collect(() => machine.approve(previous, approvalId, next.updatedAt));
  }
  collect(() => machine.skipApproval(previous, next.updatedAt));
  collect(() => machine.pause(previous, next.updatedAt));
  collect(() => machine.resume(previous, next.updatedAt));
  collect(() => machine.retry(previous, next.updatedAt));
  collect(() => machine.recover(previous, next.updatedAt));
  const failureReason = next.failureReason;
  if (failureReason) collect(() => machine.fail(previous, failureReason, next.updatedAt));
  collect(() => machine.cancel(previous, next.updatedAt));
  collect(() => machine.succeed(previous, true, next.updatedAt));

  if (!candidates.some((candidate) => sameWorkflowRun(candidate, next))) {
    throw new Error(
      `Workflow ${next.id} checkpoint does not match any valid WorkflowStateMachine transition from ${previous.status}/${previous.phase}`,
    );
  }
}

function sameWorkflowRun(left: WorkflowRun, right: WorkflowRun): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.riskClass === right.riskClass &&
    left.phase === right.phase &&
    left.status === right.status &&
    left.attempt === right.attempt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.failureReason === right.failureReason &&
    left.approvalIds.length === right.approvalIds.length &&
    left.approvalIds.every((item, index) => right.approvalIds[index] === item)
  );
}

function recovery(
  run: WorkflowRun,
  disposition: WorkflowRecoveryDisposition,
  automaticResumeAllowed: boolean,
  runtimeReconciliationRequired: boolean,
  reason: string,
): WorkflowRecoveryDecision {
  return Object.freeze({
    runId: run.id,
    status: run.status,
    phase: run.phase,
    disposition,
    automaticResumeAllowed,
    runtimeReconciliationRequired,
    reason,
  });
}

function cloneWorkflowRun(run: WorkflowRun): WorkflowRun {
  return { ...run, approvalIds: [...run.approvalIds] };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
}

function assertStringArray(value: unknown, label: string, requireUnique = false): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (requireUnique && new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function isPrefix(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length <= next.length && previous.every((item, index) => next[index] === item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
