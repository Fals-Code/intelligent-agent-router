import type { EvidenceRecord, RunLedgerRecord, WorkflowRun } from "../control-plane/contracts.js";
import type { RunLedger } from "../control-plane/run-ledger.js";
import type {
  RuntimeBinding,
  RuntimeBindingStore,
  RuntimeObservation,
  RuntimeReconciliationReport,
} from "../reconciliation/runtime-reconciliation.js";
import type {
  AgentRuntimeAdapter,
  CreateRuntimeSessionRequest,
  RuntimeSession,
} from "../runtime/agent-runtime-adapter.js";

export interface RuntimeSessionBindingCoordinatorOptions {
  readonly now?: () => string;
}

export interface CreateBoundRuntimeSessionInput {
  readonly run: WorkflowRun;
  readonly workspace: string;
  readonly adapter: AgentRuntimeAdapter;
  readonly bindingStore: RuntimeBindingStore;
  readonly metadata?: CreateRuntimeSessionRequest["metadata"];
}

export interface BoundRuntimeSession {
  readonly session: RuntimeSession;
  readonly binding: RuntimeBinding;
}

/**
 * Creates a provider runtime session at the execute phase and immediately binds
 * that side effect to durable 9Router control-plane identity.
 *
 * If binding cannot be persisted, the newly created session is best-effort
 * aborted and destroyed before the original failure is rethrown. The cleanup is
 * compensating, not a distributed transaction.
 */
export class RuntimeSessionBindingCoordinator {
  private readonly now: () => string;

  constructor(options: RuntimeSessionBindingCoordinatorOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createBoundSession(input: CreateBoundRuntimeSessionInput): Promise<BoundRuntimeSession> {
    assertExecutableWorkflow(input.run);
    if (!input.workspace.trim()) throw new Error("Runtime binding workspace must not be empty");
    if (!input.adapter.runtimeId.trim()) throw new Error("Runtime adapter runtimeId must not be empty");

    const existing = input.bindingStore.get(input.run.id);
    if (existing && existing.workflowAttempt >= input.run.attempt) {
      throw new Error(
        `Workflow ${input.run.id} attempt ${input.run.attempt} already has an equal-or-newer runtime binding`,
      );
    }

    let session: RuntimeSession | undefined;
    try {
      session = await input.adapter.createSession({
        projectId: input.run.projectId,
        workspace: input.workspace,
        riskClass: input.run.riskClass,
        metadata: {
          ...(input.metadata ?? {}),
          "9router.workflowRunId": input.run.id,
          "9router.workflowAttempt": input.run.attempt,
        },
      });
      assertSessionMatchesRequest(session, input.run, input.workspace, input.adapter.runtimeId);

      const binding = Object.freeze({
        workflowRunId: input.run.id,
        projectId: input.run.projectId,
        workflowAttempt: input.run.attempt,
        runtimeId: session.runtimeId,
        sessionId: session.id,
        workspace: session.workspace,
        boundAt: this.now(),
      } satisfies RuntimeBinding);
      input.bindingStore.bind(binding);
      return Object.freeze({ session, binding });
    } catch (error) {
      if (session) {
        const cleanupError = await cleanupCreatedSession(input.adapter, session.id);
        if (cleanupError) {
          throw new Error(
            `${safeErrorMessage(error)}; compensating runtime cleanup also failed: ${cleanupError}`,
          );
        }
      }
      throw error;
    }
  }
}

export interface DeterministicRuntimeVerificationInput {
  readonly run: WorkflowRun;
  readonly binding: RuntimeBinding;
  readonly observation: RuntimeObservation;
}

export interface DeterministicRuntimeVerificationResult {
  readonly passed: boolean;
  readonly reference: string;
  readonly collectedAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DeterministicRuntimeVerifier {
  readonly id: string;
  verify(input: DeterministicRuntimeVerificationInput): Promise<DeterministicRuntimeVerificationResult>;
}

export interface RuntimeVerificationCoordinatorOptions {
  readonly now?: () => string;
}

export interface RuntimeVerificationOutcome {
  readonly workflowRunId: string;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly verifierId: string;
  readonly passed: boolean;
  readonly evidence: readonly EvidenceRecord[];
}

/**
 * Converts a completed-provider reconciliation result into evidence. Provider
 * completion never advances the workflow by itself; a deterministic verifier is
 * mandatory and its result becomes a deterministic_check EvidenceRecord.
 */
export class RuntimeVerificationCoordinator {
  private readonly now: () => string;

  constructor(options: RuntimeVerificationCoordinatorOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async verify(
    run: WorkflowRun,
    report: RuntimeReconciliationReport,
    verifier: DeterministicRuntimeVerifier,
  ): Promise<RuntimeVerificationOutcome> {
    if (report.workflowRunId !== run.id) {
      throw new Error(`Runtime reconciliation report does not belong to workflow ${run.id}`);
    }
    if (report.disposition !== "verify_runtime_result" || !report.verificationRequired) {
      throw new Error(
        `Workflow ${run.id} runtime reconciliation is ${report.disposition}; deterministic result verification is not authorized`,
      );
    }
    if (!report.binding || !report.observation) {
      throw new Error(`Workflow ${run.id} completed-runtime verification requires binding and observation evidence`);
    }
    assertBindingMatchesWorkflow(report.binding, run);
    assertObservationMatchesBinding(report.observation, report.binding);
    if (!verifier.id.trim()) throw new Error("Deterministic runtime verifier id must not be empty");

    const runtimeEvidence = runtimeObservationEvidence(report.observation);
    let result: DeterministicRuntimeVerificationResult;
    try {
      result = await verifier.verify({
        run,
        binding: report.binding,
        observation: report.observation,
      });
      assertVerificationResult(result);
    } catch (error) {
      const failedEvidence: EvidenceRecord = Object.freeze({
        kind: "deterministic_check",
        status: "failed",
        reference: `verifier:${verifier.id}:execution-error`,
        producer: verifier.id,
        collectedAt: this.now(),
        metadata: Object.freeze({ error: safeErrorMessage(error) }),
      });
      return Object.freeze({
        workflowRunId: run.id,
        runtimeId: report.binding.runtimeId,
        sessionId: report.binding.sessionId,
        verifierId: verifier.id,
        passed: false,
        evidence: Object.freeze([runtimeEvidence, failedEvidence]),
      });
    }

    const verificationEvidence: EvidenceRecord = Object.freeze({
      kind: "deterministic_check",
      status: result.passed ? "passed" : "failed",
      reference: result.reference,
      producer: verifier.id,
      collectedAt: result.collectedAt,
      metadata: sanitizeEvidenceMetadata({
        runtimeId: report.binding.runtimeId,
        sessionId: report.binding.sessionId,
        ...(result.metadata ?? {}),
      }),
    });

    return Object.freeze({
      workflowRunId: run.id,
      runtimeId: report.binding.runtimeId,
      sessionId: report.binding.sessionId,
      verifierId: verifier.id,
      passed: result.passed,
      evidence: Object.freeze([runtimeEvidence, verificationEvidence]),
    });
  }
}

export interface AppendRuntimeRunLedgerInput {
  readonly run: WorkflowRun;
  readonly binding: RuntimeBinding;
  readonly ledger: RunLedger;
  readonly task: string;
  readonly modelRoute: readonly string[];
  readonly contextCompilerVersion: string;
  readonly skills: readonly string[];
  readonly toolsets: readonly string[];
  readonly policyDecisions: readonly string[];
  readonly changeReferences: readonly string[];
  readonly evidence: readonly EvidenceRecord[];
  readonly verification?: RuntimeVerificationOutcome;
  readonly resourceMetrics: Readonly<Record<string, number>>;
  readonly traceId: string;
}

/**
 * Writes one immutable terminal runtime-backed record to the existing RunLedger.
 * Successful workflows require an explicit deterministic verification PASS even
 * when the generic risk-class EvidenceGate would not otherwise require one.
 *
 * This append is not atomic with the preceding durable workflow checkpoint; a
 * future transaction coordinator must reconcile a terminal workflow if ledger
 * persistence fails after the workflow checkpoint succeeds.
 */
export class RuntimeRunLedgerFinalizer {
  appendTerminal(input: AppendRuntimeRunLedgerInput): RunLedgerRecord {
    assertTerminalWorkflow(input.run);
    assertBindingMatchesWorkflow(input.binding, input.run);
    if (!input.task.trim()) throw new Error("Run ledger task must not be empty");
    if (!input.contextCompilerVersion.trim()) throw new Error("Run ledger contextCompilerVersion must not be empty");
    if (!input.traceId.trim()) throw new Error("Run ledger traceId must not be empty");

    if (input.verification) assertVerificationMatchesBinding(input.verification, input.run, input.binding);
    if (input.run.status === "succeeded" && input.verification?.passed !== true) {
      throw new Error(
        `Successful runtime-backed workflow ${input.run.id} requires deterministic runtime verification PASS`,
      );
    }

    const verificationEvidence = input.verification?.evidence ?? [];
    if (
      input.run.status === "succeeded" &&
      !verificationEvidence.some(
        (item) =>
          item.kind === "deterministic_check" &&
          item.status === "passed" &&
          item.producer === input.verification?.verifierId,
      )
    ) {
      throw new Error(
        `Successful runtime-backed workflow ${input.run.id} is missing verifier-owned passed deterministic_check evidence`,
      );
    }

    const record: RunLedgerRecord = {
      runId: input.run.id,
      projectId: input.run.projectId,
      task: input.task,
      riskClass: input.run.riskClass,
      runtimeId: input.binding.runtimeId,
      modelRoute: [...input.modelRoute],
      contextCompilerVersion: input.contextCompilerVersion,
      skills: [...input.skills],
      toolsets: [...input.toolsets],
      workspace: input.binding.workspace,
      policyDecisions: [...input.policyDecisions],
      approvalIds: [...input.run.approvalIds],
      changeReferences: [...input.changeReferences],
      evidence: deduplicateEvidence([...input.evidence, ...verificationEvidence]),
      resourceMetrics: { ...input.resourceMetrics },
      traceId: input.traceId,
      outcome: input.run.status,
      failureReason: input.run.status === "failed" ? input.run.failureReason : undefined,
      createdAt: input.run.createdAt,
    };

    input.ledger.append(record);
    const persisted = input.ledger.get(input.run.id);
    if (!persisted) throw new Error(`Run ledger append did not persist workflow ${input.run.id}`);
    return persisted;
  }
}

function assertExecutableWorkflow(run: WorkflowRun): void {
  if (run.phase !== "execute") {
    throw new Error(`Runtime session can only be created during execute phase; workflow ${run.id} is ${run.phase}`);
  }
  if (run.status !== "running" && run.status !== "retrying") {
    throw new Error(`Runtime session requires running or retrying workflow; ${run.id} is ${run.status}`);
  }
  if (!Number.isInteger(run.attempt) || run.attempt < 1) {
    throw new Error(`Runtime session requires workflow attempt >= 1 for ${run.id}`);
  }
}

function assertTerminalWorkflow(
  run: WorkflowRun,
): asserts run is WorkflowRun & { readonly status: "failed" | "cancelled" | "succeeded" } {
  if (run.status !== "failed" && run.status !== "cancelled" && run.status !== "succeeded") {
    throw new Error(`Run ledger finalization requires terminal workflow; ${run.id} is ${run.status}`);
  }
  if (run.status === "succeeded" && run.phase !== "publish") {
    throw new Error(`Successful workflow ${run.id} must be in publish phase`);
  }
  if (run.status === "failed" && !run.failureReason?.trim()) {
    throw new Error(`Failed workflow ${run.id} requires failureReason`);
  }
}

function assertSessionMatchesRequest(
  session: RuntimeSession,
  run: WorkflowRun,
  workspace: string,
  runtimeId: string,
): void {
  if (!session.id.trim()) throw new Error("Runtime createSession returned an empty session id");
  if (session.runtimeId !== runtimeId) {
    throw new Error(`Runtime session runtimeId mismatch: expected=${runtimeId} actual=${session.runtimeId}`);
  }
  if (session.projectId !== run.projectId) {
    throw new Error(`Runtime session projectId mismatch for workflow ${run.id}`);
  }
  if (normalizePath(session.workspace) !== normalizePath(workspace)) {
    throw new Error(`Runtime session workspace mismatch for workflow ${run.id}`);
  }
}

function assertBindingMatchesWorkflow(binding: RuntimeBinding, run: WorkflowRun): void {
  if (binding.workflowRunId !== run.id) throw new Error(`Runtime binding workflowRunId mismatch for ${run.id}`);
  if (binding.projectId !== run.projectId) throw new Error(`Runtime binding projectId mismatch for ${run.id}`);
  if (binding.workflowAttempt !== run.attempt) {
    throw new Error(
      `Runtime binding attempt mismatch for ${run.id}: binding=${binding.workflowAttempt} workflow=${run.attempt}`,
    );
  }
}

function assertObservationMatchesBinding(observation: RuntimeObservation, binding: RuntimeBinding): void {
  if (observation.runtimeId !== binding.runtimeId) {
    throw new Error(`Runtime observation runtimeId mismatch: expected=${binding.runtimeId} actual=${observation.runtimeId}`);
  }
  if (observation.sessionId !== binding.sessionId) {
    throw new Error(`Runtime observation sessionId mismatch: expected=${binding.sessionId} actual=${observation.sessionId}`);
  }
  if (!Number.isFinite(Date.parse(observation.observedAt))) {
    throw new Error("Runtime observation observedAt must be a valid timestamp");
  }
}

function assertVerificationMatchesBinding(
  verification: RuntimeVerificationOutcome,
  run: WorkflowRun,
  binding: RuntimeBinding,
): void {
  if (verification.workflowRunId !== run.id) {
    throw new Error(`Runtime verification workflowRunId mismatch for ${run.id}`);
  }
  if (verification.runtimeId !== binding.runtimeId || verification.sessionId !== binding.sessionId) {
    throw new Error(`Runtime verification does not match durable binding for ${run.id}`);
  }
}

function assertVerificationResult(result: DeterministicRuntimeVerificationResult): void {
  if (typeof result.passed !== "boolean") throw new Error("Deterministic verification passed must be boolean");
  if (!result.reference.trim()) throw new Error("Deterministic verification reference must not be empty");
  if (!Number.isFinite(Date.parse(result.collectedAt))) {
    throw new Error("Deterministic verification collectedAt must be a valid timestamp");
  }
  if (result.metadata !== undefined) {
    for (const [key, value] of Object.entries(result.metadata)) {
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(`Deterministic verification metadata.${key} must be a scalar value`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`Deterministic verification metadata.${key} must be finite`);
      }
    }
  }
}

function runtimeObservationEvidence(observation: RuntimeObservation): EvidenceRecord {
  return Object.freeze({
    kind: "other",
    status: "passed",
    reference: `runtime:${observation.runtimeId}:${observation.sessionId}`,
    producer: `runtime-reconciliation:${observation.runtimeId}`,
    collectedAt: observation.observedAt,
    metadata: Object.freeze({
      runtimeStatus: observation.status,
      eventCount: observation.events.count,
      filesChangedCount: observation.diff.filesChanged.length,
      patchObserved: observation.diff.patchObserved,
    }),
  });
}

function deduplicateEvidence(evidence: readonly EvidenceRecord[]): readonly EvidenceRecord[] {
  const seen = new Set<string>();
  const result: EvidenceRecord[] = [];
  for (const item of evidence) {
    const key = `${item.kind}\u0000${item.status}\u0000${item.producer}\u0000${item.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function sanitizeEvidenceMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): Readonly<Record<string, string | number | boolean | null>> {
  const entries = Object.entries(metadata).map(([key, value]) => {
    if (isSensitiveKey(key)) return [key, "[redacted]"] as const;
    if (typeof value === "string") return [key, sanitizeString(value)] as const;
    return [key, value] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

async function cleanupCreatedSession(adapter: AgentRuntimeAdapter, sessionId: string): Promise<string | undefined> {
  const failures: string[] = [];
  try {
    await adapter.abort(sessionId, "9Router durable runtime binding failed");
  } catch (error) {
    failures.push(`abort=${safeErrorMessage(error)}`);
  }
  try {
    await adapter.destroy(sessionId);
  } catch (error) {
    failures.push(`destroy=${safeErrorMessage(error)}`);
  }
  return failures.length > 0 ? failures.join("; ") : undefined;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[_\-\s]+/g, "").toLowerCase();
  return (
    normalized.includes("apikey") ||
    normalized.includes("accesstoken") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized === "authorization" ||
    normalized.includes("token")
  );
}

function sanitizeString(value: string): string {
  const redacted = value.replace(
    /(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi,
    "$1=[redacted]",
  );
  return redacted.slice(0, 1_000);
}

function safeErrorMessage(error: unknown): string {
  return sanitizeString(error instanceof Error ? error.message : String(error));
}
