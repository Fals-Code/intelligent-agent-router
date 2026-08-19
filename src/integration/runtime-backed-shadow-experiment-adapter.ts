import type { WorkflowRun } from "../control-plane/contracts.js";
import type {
  ControlledExperimentExecutionAdapter,
  ControlledExperimentExecutionDispatchRequest,
  ControlledExperimentExecutionReceipt,
} from "../evaluation/controlled-experiment-execution-adapter.js";
import type { RuntimeBinding, RuntimeBindingStore } from "../reconciliation/runtime-reconciliation.js";
import type { AgentRuntimeAdapter, RuntimeTask } from "../runtime/agent-runtime-adapter.js";
import { RuntimeSessionBindingCoordinator } from "./runtime-run-integration.js";

export type ShadowRuntimeExperimentRole = "reference" | "candidate";

export interface ShadowRuntimeExecutionTarget {
  readonly subjectId: string;
  readonly run: WorkflowRun;
  readonly workspace: string;
  readonly adapter: AgentRuntimeAdapter;
  readonly bindingStore: RuntimeBindingStore;
  readonly task: RuntimeTask;
}

export interface ResolveShadowRuntimeExecutionTargetInput {
  readonly request: ControlledExperimentExecutionDispatchRequest;
  readonly role: ShadowRuntimeExperimentRole;
  readonly subjectId: string;
}

export interface ShadowRuntimeExecutionTargetResolver {
  resolve(input: ResolveShadowRuntimeExecutionTargetInput): Promise<ShadowRuntimeExecutionTarget>;
}

export interface RuntimeBackedShadowExperimentExecutionAdapterOptions {
  readonly id?: string;
  readonly now?: () => string;
}

/**
 * R0-only shadow execution bridge from the controlled-experiment boundary into
 * the canonical AgentRuntimeAdapter + durable RuntimeSessionBindingCoordinator
 * path.
 *
 * This adapter deliberately has no output sink. It submits the same no-tool task
 * to reference and candidate runtimes and returns only durable runtime-binding
 * references. It cannot execute bounded-live exposure or publish provider output.
 */
export class RuntimeBackedShadowExperimentExecutionAdapter implements ControlledExperimentExecutionAdapter {
  readonly id: string;
  private readonly now: () => string;
  private readonly bindingCoordinator: RuntimeSessionBindingCoordinator;

  constructor(
    private readonly resolver: ShadowRuntimeExecutionTargetResolver,
    options: RuntimeBackedShadowExperimentExecutionAdapterOptions = {},
  ) {
    this.id = prepareIdentity(options.id ?? "runtime-backed-shadow-experiment", "Shadow runtime experiment adapter id");
    this.now = options.now ?? (() => new Date().toISOString());
    this.bindingCoordinator = new RuntimeSessionBindingCoordinator({ now: this.now });
  }

  async dispatch(request: ControlledExperimentExecutionDispatchRequest): Promise<ControlledExperimentExecutionReceipt> {
    assertShadowRequest(request);

    // Resolve and validate both targets before the first provider side effect.
    const [reference, candidate] = await Promise.all([
      this.resolver.resolve({ request, role: "reference", subjectId: request.referenceSubjectId }),
      this.resolver.resolve({ request, role: "candidate", subjectId: request.candidateSubjectId }),
    ]);
    assertTarget(reference, "reference", request.referenceSubjectId);
    assertTarget(candidate, "candidate", request.candidateSubjectId);
    assertComparableTargets(reference, candidate);
    assertNoExistingBinding(reference, "reference");
    assertNoExistingBinding(candidate, "candidate");

    const referenceBound = await this.createBoundShadowSession(request, "reference", reference);
    const candidateBound = await this.createBoundShadowSession(request, "candidate", candidate);

    // No automatic compensation is attempted after durable binding. If either
    // send fails, the outer durable experiment journal records an uncertain side
    // effect and blocks redispatch until explicit reconciliation.
    await reference.adapter.sendTask(referenceBound.binding.sessionId, reference.task);
    await candidate.adapter.sendTask(candidateBound.binding.sessionId, candidate.task);

    return Object.freeze({
      adapterId: this.id,
      experimentId: request.experimentId,
      sampleId: request.sampleId,
      acceptedAt: this.now(),
      referenceExecutionReference: runtimeBindingReference("reference", referenceBound.binding),
      candidateExecutionReference: runtimeBindingReference("candidate", candidateBound.binding),
      candidateOutputExternallyVisible: false,
    });
  }

  private async createBoundShadowSession(
    request: ControlledExperimentExecutionDispatchRequest,
    role: ShadowRuntimeExperimentRole,
    target: ShadowRuntimeExecutionTarget,
  ): Promise<{ readonly binding: RuntimeBinding }> {
    const bound = await this.bindingCoordinator.createBoundSession({
      run: target.run,
      workspace: target.workspace,
      adapter: target.adapter,
      bindingStore: target.bindingStore,
      metadata: {
        "9router.experimentId": request.experimentId,
        "9router.experimentSampleId": request.sampleId,
        "9router.experimentRole": role,
        "9router.experimentSubjectId": target.subjectId,
        "9router.experimentExposure": "shadow",
        "9router.experimentCandidateOutputExternallyVisible": false,
        "9router.experimentIdempotencyKey": request.idempotencyKey,
      },
    });
    return Object.freeze({ binding: bound.binding });
  }
}

function assertShadowRequest(request: ControlledExperimentExecutionDispatchRequest): void {
  prepareIdentity(request.experimentId, "Shadow runtime experimentId");
  prepareIdentity(request.experimentSha256, "Shadow runtime experimentSha256");
  prepareIdentity(request.authorizationId, "Shadow runtime authorizationId");
  prepareIdentity(request.authorizationSha256, "Shadow runtime authorizationSha256");
  prepareIdentity(request.sampleId, "Shadow runtime sampleId");
  prepareIdentity(request.inputReference, "Shadow runtime inputReference");
  prepareIdentity(request.referenceSubjectId, "Shadow runtime referenceSubjectId");
  prepareIdentity(request.candidateSubjectId, "Shadow runtime candidateSubjectId");
  prepareIdentity(request.idempotencyKey, "Shadow runtime idempotencyKey");
  if (request.referenceSubjectId === request.candidateSubjectId) throw new Error("Shadow runtime reference and candidate subjects must be distinct");
  if (request.exposure !== "shadow") throw new Error("Runtime-backed shadow experiment adapter accepts shadow exposure only");
  if (request.liveAssignment !== "none") throw new Error("Runtime-backed shadow experiment adapter requires liveAssignment=none");
  if (request.candidateOutputMayBeExternallyVisible !== false) throw new Error("Runtime-backed shadow experiment adapter forbids candidate external visibility");
}

function assertTarget(target: ShadowRuntimeExecutionTarget, role: ShadowRuntimeExperimentRole, expectedSubjectId: string): void {
  if (!target || typeof target !== "object") throw new Error(`Shadow runtime ${role} target must be an object`);
  if (target.subjectId !== expectedSubjectId) throw new Error(`Shadow runtime ${role} target subjectId mismatch`);
  if (target.run.phase !== "execute" || target.run.status !== "running") throw new Error(`Shadow runtime ${role} workflow must be active in execute phase`);
  if (target.run.riskClass !== "R0") throw new Error(`Shadow runtime ${role} workflow must be R0`);
  if (!target.workspace.trim()) throw new Error(`Shadow runtime ${role} workspace must not be empty`);
  if (!target.adapter.runtimeId.trim()) throw new Error(`Shadow runtime ${role} runtimeId must not be empty`);
  if (!target.task.taskId.trim() || !target.task.prompt.trim()) throw new Error(`Shadow runtime ${role} task requires taskId and prompt`);
  if (target.task.toolIds.length !== 0) throw new Error(`Shadow runtime ${role} task must not expose tools`);
}

function assertComparableTargets(reference: ShadowRuntimeExecutionTarget, candidate: ShadowRuntimeExecutionTarget): void {
  if (reference.run.id === candidate.run.id) throw new Error("Shadow runtime reference and candidate require distinct workflow runs");
  if (reference.run.projectId !== candidate.run.projectId) throw new Error("Shadow runtime reference and candidate workflows must target the same projectId");
  if (normalizePath(reference.workspace) !== normalizePath(candidate.workspace)) throw new Error("Shadow runtime reference and candidate must use the same workspace");
  if (reference.task.prompt !== candidate.task.prompt) throw new Error("Shadow runtime reference and candidate prompts must be identical");
  if (!sameArray(reference.task.context, candidate.task.context)) throw new Error("Shadow runtime reference and candidate context must be identical");
  if (!sameArray(reference.task.toolIds, candidate.task.toolIds)) throw new Error("Shadow runtime reference and candidate tool policy must be identical");
}

function assertNoExistingBinding(target: ShadowRuntimeExecutionTarget, role: ShadowRuntimeExperimentRole): void {
  const existing = target.bindingStore.get(target.run.id);
  if (existing) throw new Error(`Shadow runtime ${role} workflow already has a durable runtime binding; automatic redispatch is forbidden`);
}

function runtimeBindingReference(role: ShadowRuntimeExperimentRole, binding: RuntimeBinding): string {
  return `shadow-runtime:${role}:${binding.runtimeId}:${binding.workflowRunId}:${binding.workflowAttempt}:${binding.sessionId}`;
}

function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const normalized = value.trim();
  if (/\r|\n/.test(normalized)) throw new Error(`${label} must be single-line`);
  if (sanitizeText(normalized) !== normalized) throw new Error(`${label} contains secret-like material`);
  return normalized;
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
