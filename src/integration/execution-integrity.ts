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
import type { EvidenceRecord, RunLedgerRecord, WorkflowRun } from "../control-plane/contracts.js";
import type { WorkflowCheckpointStore } from "../control-plane/durable-workflow.js";
import type { RunLedger } from "../control-plane/run-ledger.js";
import type { RuntimeBinding, RuntimeBindingStore } from "../reconciliation/runtime-reconciliation.js";
import type { RuntimeVerificationOutcome } from "./runtime-run-integration.js";

export const EXECUTION_INTEGRITY_SCHEMA_VERSION = 1 as const;

export type ExecutionIntegrityStage =
  | "runtime_bound"
  | "verification_recorded"
  | "workflow_terminal"
  | "ledger_finalized";

interface IntegrityEntryBase {
  readonly runId: string;
  readonly projectId: string;
  readonly attempt: number;
  readonly stage: ExecutionIntegrityStage;
  readonly recordedAt: string;
}

export interface RuntimeBoundIntegrityEntry extends IntegrityEntryBase {
  readonly stage: "runtime_bound";
  readonly binding: RuntimeBinding;
}

export interface VerificationRecordedIntegrityEntry extends IntegrityEntryBase {
  readonly stage: "verification_recorded";
  readonly verification: RuntimeVerificationOutcome;
}

export interface WorkflowTerminalIntegrityEntry extends IntegrityEntryBase {
  readonly stage: "workflow_terminal";
  readonly terminalStatus: "failed" | "cancelled" | "succeeded";
  readonly workflowUpdatedAt: string;
}

export interface LedgerFinalizedIntegrityEntry extends IntegrityEntryBase {
  readonly stage: "ledger_finalized";
  readonly ledgerOutcome: "failed" | "cancelled" | "succeeded";
  readonly traceId: string;
}

export type ExecutionIntegrityEntry =
  | RuntimeBoundIntegrityEntry
  | VerificationRecordedIntegrityEntry
  | WorkflowTerminalIntegrityEntry
  | LedgerFinalizedIntegrityEntry;

export interface ExecutionIntegrityJournal {
  append(entry: ExecutionIntegrityEntry): void;
  history(runId: string): readonly ExecutionIntegrityEntry[];
  list(): readonly ExecutionIntegrityEntry[];
}

export interface JsonlExecutionIntegrityJournalOptions {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxEntryBytes: number;
}

/** Local, append-only, single-writer cross-store integrity journal. */
export class JsonlExecutionIntegrityJournal implements ExecutionIntegrityJournal {
  readonly filePath: string;
  private readonly entries: ExecutionIntegrityEntry[] = [];
  private readonly histories = new Map<string, ExecutionIntegrityEntry[]>();
  private expectedFileSize = 0;
  private nextSequence = 1;

  constructor(private readonly options: JsonlExecutionIntegrityJournalOptions) {
    if (!options.filePath.trim()) throw new Error("Execution integrity filePath must not be empty");
    assertPositiveInteger(options.maxFileBytes, "Execution integrity maxFileBytes");
    assertPositiveInteger(options.maxEntryBytes, "Execution integrity maxEntryBytes");
    if (options.maxEntryBytes > options.maxFileBytes) {
      throw new Error("Execution integrity maxEntryBytes must not exceed maxFileBytes");
    }
    this.filePath = resolve(options.filePath);
    mkdirSync(resolve(this.filePath, ".."), { recursive: true });
    this.load();
  }

  append(entry: ExecutionIntegrityEntry): void {
    this.assertStorageUnchanged();
    assertIntegrityEntry(entry, "Execution integrity entry");
    const history = this.histories.get(entry.runId) ?? [];
    assertIntegrityProgression(history, entry);
    const prepared = deepFreeze(cloneIntegrityEntry(entry));
    const line = `${JSON.stringify({
      schemaVersion: EXECUTION_INTEGRITY_SCHEMA_VERSION,
      sequence: this.nextSequence,
      entry: prepared,
    })}\n`;
    const bytes = utf8ByteLength(line);
    if (bytes > this.options.maxEntryBytes) {
      throw new Error(`Execution integrity entry exceeds maxEntryBytes: runId=${entry.runId} bytes=${bytes} max=${this.options.maxEntryBytes}`);
    }
    if (this.expectedFileSize + bytes > this.options.maxFileBytes) {
      throw new Error(`Execution integrity append would exceed maxFileBytes: current=${this.expectedFileSize} append=${bytes} max=${this.options.maxFileBytes}`);
    }

    const handle = openSync(this.filePath, "a", 0o600);
    try {
      writeFileSync(handle, line, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    this.expectedFileSize += bytes;
    this.nextSequence += 1;
    this.admit(prepared);
  }

  history(runId: string): readonly ExecutionIntegrityEntry[] {
    return [...(this.histories.get(runId) ?? [])];
  }

  list(): readonly ExecutionIntegrityEntry[] {
    return [...this.entries];
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const size = statSync(this.filePath).size;
    if (size > this.options.maxFileBytes) {
      throw new Error(`Execution integrity file exceeds maxFileBytes: bytes=${size} max=${this.options.maxFileBytes}`);
    }
    const raw = readFileSync(this.filePath, "utf8");
    this.expectedFileSize = utf8ByteLength(raw);
    if (!raw) return;
    if (!raw.endsWith("\n")) {
      throw new Error(`Execution integrity file is not newline-terminated; possible partial write: ${this.filePath}`);
    }

    const lines = raw.slice(0, -1).split("\n");
    let expectedSequence = 1;
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      if (!line.trim()) throw new Error(`Execution integrity file contains an empty record at line ${lineNumber}`);
      const bytes = utf8ByteLength(`${line}\n`);
      if (bytes > this.options.maxEntryBytes) {
        throw new Error(`Execution integrity entry at line ${lineNumber} exceeds maxEntryBytes: bytes=${bytes} max=${this.options.maxEntryBytes}`);
      }
      const parsed = parseIntegrityEntry(line, lineNumber);
      if (parsed.sequence !== expectedSequence) {
        throw new Error(`Execution integrity sequence mismatch at line ${lineNumber}: expected=${expectedSequence} actual=${parsed.sequence}`);
      }
      expectedSequence += 1;
      const history = this.histories.get(parsed.entry.runId) ?? [];
      assertIntegrityProgression(history, parsed.entry);
      this.admit(deepFreeze(cloneIntegrityEntry(parsed.entry)));
    }
    this.nextSequence = expectedSequence;
  }

  private admit(entry: ExecutionIntegrityEntry): void {
    this.entries.push(entry);
    const history = this.histories.get(entry.runId) ?? [];
    history.push(entry);
    this.histories.set(entry.runId, history);
  }

  private assertStorageUnchanged(): void {
    const actual = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (actual !== this.expectedFileSize) {
      throw new Error(`Execution integrity file changed outside this writer; reopen before appending: expectedBytes=${this.expectedFileSize} actualBytes=${actual}`);
    }
  }
}

export type ExecutionIntegrityDisposition =
  | "not_found"
  | "consistent_pre_runtime"
  | "record_runtime_binding_milestone"
  | "reconcile_runtime"
  | "verification_available"
  | "verification_failed"
  | "record_terminal_milestone"
  | "finalize_run_ledger"
  | "record_ledger_finalized_milestone"
  | "consistent_terminal"
  | "manual_intervention";

export interface ExecutionIntegrityReport {
  readonly runId: string;
  readonly disposition: ExecutionIntegrityDisposition;
  readonly automaticMutationAllowed: false;
  readonly reason: string;
  readonly workflow?: WorkflowRun;
  readonly binding?: RuntimeBinding;
  readonly verification?: RuntimeVerificationOutcome;
  readonly ledgerRecord?: RunLedgerRecord;
  readonly journalStages: readonly ExecutionIntegrityStage[];
}

export interface ExecutionIntegrityCoordinatorOptions {
  readonly workflowStore: WorkflowCheckpointStore;
  readonly bindingStore: RuntimeBindingStore;
  readonly runLedger: RunLedger;
  readonly journal: ExecutionIntegrityJournal;
  readonly now?: () => string;
}

/**
 * Records cross-store milestones and classifies partial durable state.
 * It never contacts a provider, advances workflow state, retries work, or writes
 * missing terminal state automatically.
 */
export class ExecutionIntegrityCoordinator {
  private readonly now: () => string;

  constructor(private readonly options: ExecutionIntegrityCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  recordRuntimeBound(run: WorkflowRun, binding: RuntimeBinding): RuntimeBoundIntegrityEntry {
    assertWorkflowBinding(run, binding);
    const storedRun = this.options.workflowStore.get(run.id);
    if (!storedRun || !sameWorkflowIdentity(storedRun, run)) {
      throw new Error(`Workflow ${run.id} must be durably checkpointed before recording runtime binding integrity`);
    }
    const storedBinding = bindingForAttempt(this.options.bindingStore, run.id, run.attempt);
    if (!storedBinding || !sameBinding(storedBinding, binding)) {
      throw new Error(`Runtime binding for workflow ${run.id} attempt ${run.attempt} must be durable before recording integrity milestone`);
    }
    const entry: RuntimeBoundIntegrityEntry = {
      runId: run.id,
      projectId: run.projectId,
      attempt: run.attempt,
      stage: "runtime_bound",
      recordedAt: this.now(),
      binding: cloneBinding(binding),
    };
    this.options.journal.append(entry);
    return requireTypedStage(this.options.journal.history(run.id), "runtime_bound", run.attempt);
  }

  recordVerification(
    run: WorkflowRun,
    binding: RuntimeBinding,
    verification: RuntimeVerificationOutcome,
  ): VerificationRecordedIntegrityEntry {
    assertWorkflowBinding(run, binding);
    assertVerificationMatches(verification, run, binding);
    requireStage(this.options.journal.history(run.id), "runtime_bound", run.attempt);
    const storedRun = this.options.workflowStore.get(run.id);
    if (!storedRun || !sameWorkflowIdentity(storedRun, run)) throw new Error(`Durable workflow drift detected for ${run.id}`);
    const storedBinding = bindingForAttempt(this.options.bindingStore, run.id, run.attempt);
    if (!storedBinding || !sameBinding(storedBinding, binding)) throw new Error(`Durable runtime binding drift detected for workflow ${run.id}`);
    const entry: VerificationRecordedIntegrityEntry = {
      runId: run.id,
      projectId: run.projectId,
      attempt: run.attempt,
      stage: "verification_recorded",
      recordedAt: this.now(),
      verification: sanitizeVerification(verification),
    };
    this.options.journal.append(entry);
    return requireTypedStage(this.options.journal.history(run.id), "verification_recorded", run.attempt);
  }

  recordWorkflowTerminal(run: WorkflowRun): WorkflowTerminalIntegrityEntry {
    assertTerminalWorkflow(run);
    const storedRun = this.options.workflowStore.get(run.id);
    if (!storedRun || !sameWorkflowSnapshot(storedRun, run)) {
      throw new Error(`Terminal workflow ${run.id} must be durably checkpointed before recording terminal integrity`);
    }
    const binding = bindingForAttempt(this.options.bindingStore, run.id, run.attempt);
    if (!binding) throw new Error(`Runtime-backed terminal workflow ${run.id} has no durable runtime binding for attempt ${run.attempt}`);
    assertWorkflowBinding(run, binding);
    requireStage(this.options.journal.history(run.id), "runtime_bound", run.attempt);
    if (run.status === "succeeded" && !verificationFor(this.options.journal.history(run.id), run.attempt)?.passed) {
      throw new Error(`Successful workflow ${run.id} requires durable deterministic verification before terminal integrity`);
    }
    const entry: WorkflowTerminalIntegrityEntry = {
      runId: run.id,
      projectId: run.projectId,
      attempt: run.attempt,
      stage: "workflow_terminal",
      recordedAt: this.now(),
      terminalStatus: run.status,
      workflowUpdatedAt: run.updatedAt,
    };
    this.options.journal.append(entry);
    return requireTypedStage(this.options.journal.history(run.id), "workflow_terminal", run.attempt);
  }

  recordLedgerFinalized(run: WorkflowRun): LedgerFinalizedIntegrityEntry {
    assertTerminalWorkflow(run);
    const storedRun = this.options.workflowStore.get(run.id);
    if (!storedRun || !sameWorkflowSnapshot(storedRun, run)) throw new Error(`Canonical terminal workflow drift detected for ${run.id}`);
    requireStage(this.options.journal.history(run.id), "workflow_terminal", run.attempt);
    const binding = bindingForAttempt(this.options.bindingStore, run.id, run.attempt);
    if (!binding) throw new Error(`Runtime binding is missing for terminal workflow ${run.id}`);
    const record = this.options.runLedger.get(run.id);
    if (!record) throw new Error(`Run Ledger record ${run.id} must exist before finalization integrity can be recorded`);
    assertLedgerMatchesWorkflow(record, run, binding);
    const entry: LedgerFinalizedIntegrityEntry = {
      runId: run.id,
      projectId: run.projectId,
      attempt: run.attempt,
      stage: "ledger_finalized",
      recordedAt: this.now(),
      ledgerOutcome: record.outcome,
      traceId: record.traceId,
    };
    this.options.journal.append(entry);
    return requireTypedStage(this.options.journal.history(run.id), "ledger_finalized", run.attempt);
  }

  recoverVerification(runId: string, attempt?: number): RuntimeVerificationOutcome | undefined {
    const targetAttempt = attempt ?? this.options.workflowStore.get(runId)?.attempt;
    if (!targetAttempt) return undefined;
    const verification = verificationFor(this.options.journal.history(runId), targetAttempt);
    return verification ? deepFreeze(cloneVerification(verification)) : undefined;
  }

  inspect(runId: string): ExecutionIntegrityReport {
    const workflow = this.options.workflowStore.get(runId);
    const ledgerRecord = this.options.runLedger.get(runId);
    const history = this.options.journal.history(runId);
    const journalStages = Object.freeze(history.map((entry) => entry.stage));
    const latestBinding = this.options.bindingStore.get(runId);

    if (!workflow) {
      if (latestBinding || ledgerRecord || history.length > 0) {
        return report(runId, "manual_intervention", "Durable runtime/ledger/journal state exists without a canonical workflow checkpoint.", undefined, latestBinding, undefined, ledgerRecord, journalStages);
      }
      return report(runId, "not_found", "No durable state exists for this run.", undefined, undefined, undefined, undefined, journalStages);
    }

    if (latestBinding && latestBinding.workflowAttempt > workflow.attempt) {
      return report(runId, "manual_intervention", `Runtime binding attempt ${latestBinding.workflowAttempt} is ahead of canonical workflow attempt ${workflow.attempt}.`, workflow, latestBinding, undefined, ledgerRecord, journalStages);
    }

    const binding = bindingForAttempt(this.options.bindingStore, runId, workflow.attempt);
    const verification = verificationFor(history, workflow.attempt);
    const runtimeMilestone = latestStage(history, "runtime_bound", workflow.attempt);
    const terminalMilestone = latestStage(history, "workflow_terminal", workflow.attempt);
    const ledgerMilestone = latestStage(history, "ledger_finalized", workflow.attempt);

    if (binding) {
      try {
        assertWorkflowBinding(workflow, binding);
      } catch (error) {
        return report(runId, "manual_intervention", safeErrorMessage(error), workflow, binding, verification, ledgerRecord, journalStages);
      }
    }
    if (runtimeMilestone && !binding) {
      return report(runId, "manual_intervention", "Integrity journal records a current-attempt runtime binding that is missing from RuntimeBindingStore.", workflow, undefined, verification, ledgerRecord, journalStages);
    }
    if (verification && !binding) {
      return report(runId, "manual_intervention", "Durable verification exists without a matching current-attempt runtime binding.", workflow, undefined, verification, ledgerRecord, journalStages);
    }
    if (terminalMilestone && !isTerminal(workflow)) {
      return report(runId, "manual_intervention", "Integrity journal records current-attempt terminal state while canonical workflow is non-terminal.", workflow, binding, verification, ledgerRecord, journalStages);
    }
    if (ledgerMilestone && !ledgerRecord) {
      return report(runId, "manual_intervention", "Integrity journal records Run Ledger finalization but the Run Ledger record is missing.", workflow, binding, verification, undefined, journalStages);
    }

    if (ledgerRecord) {
      if (!binding) {
        return report(runId, "manual_intervention", "Run Ledger exists but the final workflow attempt has no durable runtime binding.", workflow, undefined, verification, ledgerRecord, journalStages);
      }
      try {
        assertLedgerMatchesWorkflow(ledgerRecord, workflow, binding);
      } catch (error) {
        return report(runId, "manual_intervention", safeErrorMessage(error), workflow, binding, verification, ledgerRecord, journalStages);
      }
      if (!isTerminal(workflow)) {
        return report(runId, "manual_intervention", "Run Ledger contains a terminal record for a non-terminal canonical workflow.", workflow, binding, verification, ledgerRecord, journalStages);
      }
      if (!terminalMilestone) {
        return report(runId, "record_terminal_milestone", "Workflow and Run Ledger are terminal but the integrity terminal milestone is missing.", workflow, binding, verification, ledgerRecord, journalStages);
      }
      if (!ledgerMilestone) {
        return report(runId, "record_ledger_finalized_milestone", "Run Ledger is durable; only the integrity finalization marker is missing.", workflow, binding, verification, ledgerRecord, journalStages);
      }
      return report(runId, "consistent_terminal", "Workflow, runtime binding, integrity journal, and Run Ledger agree on terminal state.", workflow, binding, verification, ledgerRecord, journalStages);
    }

    if (isTerminal(workflow)) {
      if (!binding) {
        return report(runId, "manual_intervention", "Runtime-backed terminal workflow has no durable binding for its final attempt.", workflow, undefined, verification, undefined, journalStages);
      }
      if (!runtimeMilestone) {
        return report(runId, "record_runtime_binding_milestone", "Runtime binding is durable but its current-attempt integrity milestone is missing.", workflow, binding, verification, undefined, journalStages);
      }
      if (workflow.status === "succeeded" && !verification?.passed) {
        return report(runId, "manual_intervention", "Successful terminal workflow has no durable passed verification; success evidence must not be synthesized.", workflow, binding, verification, undefined, journalStages);
      }
      if (!terminalMilestone) {
        return report(runId, "record_terminal_milestone", "Canonical workflow is terminal but terminal integrity has not yet been journaled.", workflow, binding, verification, undefined, journalStages);
      }
      return report(runId, "finalize_run_ledger", "Terminal workflow and required durable evidence exist, but the immutable Run Ledger record is missing.", workflow, binding, verification, undefined, journalStages);
    }

    if (!binding) {
      if (workflow.phase === "start" || workflow.phase === "classify" || workflow.phase === "compile_context") {
        return report(runId, "consistent_pre_runtime", "Workflow has not reached runtime execution and no current-attempt runtime state exists.", workflow, undefined, undefined, undefined, journalStages);
      }
      return report(runId, "manual_intervention", "Workflow has reached or passed execute without a current-attempt durable runtime binding; unknown side effects require explicit reconciliation.", workflow, undefined, undefined, undefined, journalStages);
    }
    if (!runtimeMilestone) {
      return report(runId, "record_runtime_binding_milestone", "Current-attempt runtime binding exists but its integrity milestone is missing.", workflow, binding, verification, undefined, journalStages);
    }
    if (verification) {
      return report(
        runId,
        verification.passed ? "verification_available" : "verification_failed",
        verification.passed
          ? "Durable deterministic verification is available for explicit workflow continuation; no automatic transition is authorized."
          : "Durable deterministic verification failed; failure/retry remains an explicit workflow decision.",
        workflow,
        binding,
        verification,
        undefined,
        journalStages,
      );
    }
    return report(runId, "reconcile_runtime", "Durable current-attempt runtime binding exists but no verification is durable; re-observe runtime before continuation or re-dispatch.", workflow, binding, undefined, undefined, journalStages);
  }
}

function report(
  runId: string,
  disposition: ExecutionIntegrityDisposition,
  reason: string,
  workflow: WorkflowRun | undefined,
  binding: RuntimeBinding | undefined,
  verification: RuntimeVerificationOutcome | undefined,
  ledgerRecord: RunLedgerRecord | undefined,
  journalStages: readonly ExecutionIntegrityStage[],
): ExecutionIntegrityReport {
  return Object.freeze({ runId, disposition, automaticMutationAllowed: false as const, reason, workflow, binding, verification, ledgerRecord, journalStages });
}

function parseIntegrityEntry(line: string, lineNumber: number): { sequence: number; entry: ExecutionIntegrityEntry } {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Execution integrity journal contains invalid JSON at line ${lineNumber}: ${safeErrorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Execution integrity entry at line ${lineNumber} must be an object`);
  if (value.schemaVersion !== EXECUTION_INTEGRITY_SCHEMA_VERSION) {
    throw new Error(`Unsupported execution integrity schema version at line ${lineNumber}: ${String(value.schemaVersion)}`);
  }
  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence <= 0) {
    throw new Error(`Execution integrity sequence at line ${lineNumber} must be a positive integer`);
  }
  assertIntegrityEntry(value.entry, `Execution integrity entry at line ${lineNumber}`);
  return { sequence: value.sequence, entry: value.entry };
}

function assertIntegrityEntry(value: unknown, label: string): asserts value is ExecutionIntegrityEntry {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const field of ["runId", "projectId", "stage", "recordedAt"] as const) assertNonEmptyString(value[field], `${label}.${field}`);
  if (typeof value.attempt !== "number") throw new Error(`${label}.attempt must be a positive integer`);
  assertPositiveInteger(value.attempt, `${label}.attempt`);
  if (!Number.isFinite(Date.parse(String(value.recordedAt)))) throw new Error(`${label}.recordedAt must be a valid timestamp`);

  switch (value.stage) {
    case "runtime_bound":
      assertAllowedKeys(value, ["runId", "projectId", "attempt", "stage", "recordedAt", "binding"], label);
      assertRuntimeBindingShape(value.binding, `${label}.binding`);
      if (value.binding.workflowRunId !== value.runId || value.binding.projectId !== value.projectId || value.binding.workflowAttempt !== value.attempt) {
        throw new Error(`${label}.binding identity does not match journal entry`);
      }
      return;
    case "verification_recorded":
      assertAllowedKeys(value, ["runId", "projectId", "attempt", "stage", "recordedAt", "verification"], label);
      assertVerificationShape(value.verification, `${label}.verification`);
      if (value.verification.workflowRunId !== value.runId) throw new Error(`${label}.verification workflowRunId mismatch`);
      return;
    case "workflow_terminal":
      assertAllowedKeys(value, ["runId", "projectId", "attempt", "stage", "recordedAt", "terminalStatus", "workflowUpdatedAt"], label);
      if (value.terminalStatus !== "failed" && value.terminalStatus !== "cancelled" && value.terminalStatus !== "succeeded") {
        throw new Error(`${label}.terminalStatus is invalid`);
      }
      assertNonEmptyString(value.workflowUpdatedAt, `${label}.workflowUpdatedAt`);
      if (!Number.isFinite(Date.parse(value.workflowUpdatedAt))) throw new Error(`${label}.workflowUpdatedAt must be a valid timestamp`);
      return;
    case "ledger_finalized":
      assertAllowedKeys(value, ["runId", "projectId", "attempt", "stage", "recordedAt", "ledgerOutcome", "traceId"], label);
      if (value.ledgerOutcome !== "failed" && value.ledgerOutcome !== "cancelled" && value.ledgerOutcome !== "succeeded") {
        throw new Error(`${label}.ledgerOutcome is invalid`);
      }
      assertNonEmptyString(value.traceId, `${label}.traceId`);
      return;
    default:
      throw new Error(`${label}.stage is invalid`);
  }
}

function assertIntegrityProgression(history: readonly ExecutionIntegrityEntry[], next: ExecutionIntegrityEntry): void {
  if (history.some((entry) => entry.stage === "ledger_finalized")) {
    throw new Error(`Execution integrity journal for ${next.runId} is already finalized`);
  }
  const last = history.at(-1);
  if (last && Date.parse(next.recordedAt) < Date.parse(last.recordedAt)) {
    throw new Error(`Execution integrity recordedAt cannot move backwards for ${next.runId}`);
  }
  const maxAttempt = history.length > 0 ? Math.max(...history.map((entry) => entry.attempt)) : 0;
  if (next.attempt < maxAttempt) throw new Error(`Execution integrity attempt cannot move backwards for ${next.runId}`);
  const sameAttempt = history.filter((entry) => entry.attempt === next.attempt);
  if (sameAttempt.some((entry) => entry.stage === next.stage)) {
    throw new Error(`Execution integrity stage ${next.stage} already exists for ${next.runId} attempt ${next.attempt}`);
  }

  if (next.stage === "runtime_bound") {
    if (sameAttempt.length > 0) throw new Error(`runtime_bound must be the first integrity stage for ${next.runId} attempt ${next.attempt}`);
    if (maxAttempt > 0 && next.attempt <= maxAttempt) throw new Error(`New runtime binding attempt must increase for ${next.runId}`);
    return;
  }
  if (!sameAttempt.some((entry) => entry.stage === "runtime_bound")) {
    throw new Error(`Execution integrity stage ${next.stage} requires runtime_bound for ${next.runId} attempt ${next.attempt}`);
  }

  const terminal = sameAttempt.find((entry): entry is WorkflowTerminalIntegrityEntry => entry.stage === "workflow_terminal");
  if (next.stage === "verification_recorded") {
    if (terminal) throw new Error(`verification_recorded cannot follow workflow_terminal for ${next.runId} attempt ${next.attempt}`);
    return;
  }
  if (next.stage === "workflow_terminal") {
    if (next.terminalStatus === "succeeded") {
      const verification = sameAttempt.find((entry): entry is VerificationRecordedIntegrityEntry => entry.stage === "verification_recorded");
      if (!verification?.verification.passed) throw new Error(`Successful workflow_terminal requires passed verification for ${next.runId} attempt ${next.attempt}`);
    }
    return;
  }
  if (!terminal) throw new Error(`ledger_finalized requires workflow_terminal for ${next.runId} attempt ${next.attempt}`);
  if (terminal.terminalStatus !== next.ledgerOutcome) throw new Error(`ledger_finalized outcome must match workflow_terminal for ${next.runId}`);
}

function verificationFor(history: readonly ExecutionIntegrityEntry[], attempt: number): RuntimeVerificationOutcome | undefined {
  return [...history]
    .reverse()
    .find((entry): entry is VerificationRecordedIntegrityEntry => entry.stage === "verification_recorded" && entry.attempt === attempt)
    ?.verification;
}

function latestStage(history: readonly ExecutionIntegrityEntry[], stage: ExecutionIntegrityStage, attempt: number): ExecutionIntegrityEntry | undefined {
  return [...history].reverse().find((entry) => entry.stage === stage && entry.attempt === attempt);
}

function requireStage(history: readonly ExecutionIntegrityEntry[], stage: ExecutionIntegrityStage, attempt: number): void {
  if (!latestStage(history, stage, attempt)) throw new Error(`Execution integrity stage ${stage} is required for attempt ${attempt}`);
}

function requireTypedStage<T extends ExecutionIntegrityStage>(
  history: readonly ExecutionIntegrityEntry[],
  stage: T,
  attempt: number,
): Extract<ExecutionIntegrityEntry, { stage: T }> {
  const entry = latestStage(history, stage, attempt);
  if (!entry) throw new Error(`Execution integrity stage ${stage} was not persisted for attempt ${attempt}`);
  return entry as Extract<ExecutionIntegrityEntry, { stage: T }>;
}

function bindingForAttempt(store: RuntimeBindingStore, runId: string, attempt: number): RuntimeBinding | undefined {
  return [...store.history(runId)].reverse().find((binding) => binding.workflowAttempt === attempt);
}

function assertWorkflowBinding(run: WorkflowRun, binding: RuntimeBinding): void {
  if (binding.workflowRunId !== run.id || binding.projectId !== run.projectId || binding.workflowAttempt !== run.attempt) {
    throw new Error(`Runtime binding does not match workflow ${run.id} attempt ${run.attempt}`);
  }
}

function assertVerificationMatches(verification: RuntimeVerificationOutcome, run: WorkflowRun, binding: RuntimeBinding): void {
  assertVerificationShape(verification, "Runtime verification");
  if (verification.workflowRunId !== run.id) throw new Error(`Runtime verification workflowRunId mismatch for ${run.id}`);
  if (verification.runtimeId !== binding.runtimeId || verification.sessionId !== binding.sessionId) {
    throw new Error(`Runtime verification identity does not match durable binding for ${run.id}`);
  }
}

function assertTerminalWorkflow(
  run: WorkflowRun,
): asserts run is WorkflowRun & { readonly status: "failed" | "cancelled" | "succeeded" } {
  if (!isTerminal(run)) throw new Error(`Workflow ${run.id} must be terminal`);
  if (run.status === "succeeded" && run.phase !== "publish") throw new Error(`Successful workflow ${run.id} must be in publish phase`);
  if (run.status === "failed" && !run.failureReason?.trim()) throw new Error(`Failed workflow ${run.id} requires failureReason`);
}

function isTerminal(run: WorkflowRun): run is WorkflowRun & { readonly status: "failed" | "cancelled" | "succeeded" } {
  return run.status === "failed" || run.status === "cancelled" || run.status === "succeeded";
}

function assertLedgerMatchesWorkflow(record: RunLedgerRecord, run: WorkflowRun, binding: RuntimeBinding): void {
  if (record.runId !== run.id || record.projectId !== run.projectId || record.riskClass !== run.riskClass) throw new Error(`Run Ledger identity does not match workflow ${run.id}`);
  if (record.outcome !== run.status) throw new Error(`Run Ledger outcome does not match workflow ${run.id}`);
  if (record.runtimeId !== binding.runtimeId || normalizePath(record.workspace) !== normalizePath(binding.workspace)) {
    throw new Error(`Run Ledger runtime identity does not match durable binding for ${run.id}`);
  }
  if (run.status === "failed" && record.failureReason !== run.failureReason) throw new Error(`Run Ledger failureReason does not match workflow ${run.id}`);
}

function sameWorkflowIdentity(left: WorkflowRun, right: WorkflowRun): boolean {
  return left.id === right.id && left.projectId === right.projectId && left.riskClass === right.riskClass && left.attempt === right.attempt;
}

function sameWorkflowSnapshot(left: WorkflowRun, right: WorkflowRun): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBinding(left: RuntimeBinding, right: RuntimeBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRuntimeBindingShape(value: unknown, label: string): asserts value is RuntimeBinding {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, ["workflowRunId", "projectId", "workflowAttempt", "runtimeId", "sessionId", "workspace", "boundAt"], label);
  for (const field of ["workflowRunId", "projectId", "runtimeId", "sessionId", "workspace", "boundAt"] as const) assertNonEmptyString(value[field], `${label}.${field}`);
  if (typeof value.workflowAttempt !== "number") throw new Error(`${label}.workflowAttempt must be a positive integer`);
  assertPositiveInteger(value.workflowAttempt, `${label}.workflowAttempt`);
  if (!Number.isFinite(Date.parse(String(value.boundAt)))) throw new Error(`${label}.boundAt must be a valid timestamp`);
}

function assertVerificationShape(value: unknown, label: string): asserts value is RuntimeVerificationOutcome {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, ["workflowRunId", "runtimeId", "sessionId", "verifierId", "passed", "evidence"], label);
  for (const field of ["workflowRunId", "runtimeId", "sessionId", "verifierId"] as const) assertNonEmptyString(value[field], `${label}.${field}`);
  if (typeof value.passed !== "boolean") throw new Error(`${label}.passed must be boolean`);
  if (!Array.isArray(value.evidence)) throw new Error(`${label}.evidence must be an array`);
  value.evidence.forEach((item, index) => assertEvidenceRecord(item, `${label}.evidence[${index}]`));
  const deterministic = value.evidence.filter((item): item is EvidenceRecord => isRecord(item) && item.kind === "deterministic_check");
  if (deterministic.length === 0) throw new Error(`${label} must include deterministic_check evidence`);
  if (value.passed && !deterministic.some((item) => item.status === "passed" && item.producer === value.verifierId)) {
    throw new Error(`${label} passed=true requires verifier-owned passed deterministic_check evidence`);
  }
  const runtimeProducer = `runtime-reconciliation:${value.runtimeId}`;
  const runtimeReference = `runtime:${value.runtimeId}:${value.sessionId}`;
  if (!value.evidence.some((item) => isRecord(item) && item.kind === "other" && item.status === "passed" && item.producer === runtimeProducer && item.reference === runtimeReference)) {
    throw new Error(`${label} must include matching runtime reconciliation evidence`);
  }
}

function assertEvidenceRecord(value: unknown, label: string): asserts value is EvidenceRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const kinds = new Set(["policy", "isolation", "deterministic_check", "test", "browser", "review", "independent_review", "approval", "backup", "rollback", "other"]);
  if (!kinds.has(String(value.kind))) throw new Error(`${label}.kind is invalid`);
  if (value.status !== "passed" && value.status !== "failed" && value.status !== "not_applicable") throw new Error(`${label}.status is invalid`);
  for (const field of ["reference", "producer", "collectedAt"] as const) assertNonEmptyString(value[field], `${label}.${field}`);
  if (!Number.isFinite(Date.parse(String(value.collectedAt)))) throw new Error(`${label}.collectedAt must be a valid timestamp`);
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) throw new Error(`${label}.metadata must be an object`);
    for (const [key, item] of Object.entries(value.metadata)) {
      if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new Error(`${label}.metadata.${key} must be scalar`);
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`${label}.metadata.${key} must be finite`);
    }
  }
}

function cloneIntegrityEntry(entry: ExecutionIntegrityEntry): ExecutionIntegrityEntry {
  if (entry.stage === "runtime_bound") return { ...entry, binding: cloneBinding(entry.binding) };
  if (entry.stage === "verification_recorded") return { ...entry, verification: sanitizeVerification(entry.verification) };
  return { ...entry };
}

function cloneBinding(binding: RuntimeBinding): RuntimeBinding {
  return { ...binding };
}

function cloneVerification(verification: RuntimeVerificationOutcome): RuntimeVerificationOutcome {
  return {
    ...verification,
    evidence: verification.evidence.map((item) => ({ ...item, metadata: item.metadata ? { ...item.metadata } : undefined })),
  };
}

function sanitizeVerification(verification: RuntimeVerificationOutcome): RuntimeVerificationOutcome {
  return {
    ...verification,
    evidence: verification.evidence.map((item) => ({
      ...item,
      metadata: item.metadata ? sanitizeMetadata(item.metadata) : undefined,
    })),
  };
}

function sanitizeMetadata(metadata: Readonly<Record<string, string | number | boolean | null>>): Readonly<Record<string, string | number | boolean | null>> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => {
    if (isSensitiveKey(key)) return [key, "[redacted]"];
    return [key, typeof value === "string" ? sanitizeString(value) : value];
  }));
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[_\-\s]+/g, "").toLowerCase();
  return normalized.includes("apikey") || normalized.includes("accesstoken") || normalized === "authorization" || normalized.includes("password") || normalized.includes("secret") || normalized.includes("credential") || normalized.includes("token");
}

function sanitizeString(value: string): string {
  return value.replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]").slice(0, 1_000);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new Error(`${label}.${key} is not allowed`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeErrorMessage(error: unknown): string {
  return sanitizeString(error instanceof Error ? error.message : String(error));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
