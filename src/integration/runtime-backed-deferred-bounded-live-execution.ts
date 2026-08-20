import type { WorkflowRun } from "../control-plane/contracts.js";
import type { ControlledExperimentDefinition } from "../evaluation/controlled-experiment.js";
import type { BoundedLiveSampleAuthorization } from "../evaluation/bounded-live-sample-authorization.js";
import { verifyBoundedLiveSampleAuthorizationEnvelope } from "../evaluation/bounded-live-sample-authorization.js";
import type { RuntimeBinding, RuntimeBindingStore } from "../reconciliation/runtime-reconciliation.js";
import type { AgentRuntimeAdapter, RuntimeTask } from "../runtime/agent-runtime-adapter.js";
import { RuntimeSessionBindingCoordinator } from "./runtime-run-integration.js";

export const DEFERRED_BOUNDED_LIVE_RUNTIME_DISPATCH_SCHEMA_VERSION = 1 as const;
export type DeferredBoundedLiveRuntimeRole = "reference" | "candidate";

export interface DeferredBoundedLiveRuntimeTarget {
  readonly subjectId: string;
  readonly run: WorkflowRun;
  readonly workspace: string;
  readonly adapter: AgentRuntimeAdapter;
  readonly bindingStore: RuntimeBindingStore;
  readonly task: RuntimeTask;
}
export interface DeferredBoundedLiveRuntimeTargetResolver {
  resolve(input: { readonly role: DeferredBoundedLiveRuntimeRole; readonly subjectId: string; readonly sampleAuthorizationId: string; readonly sampleId: string }): Promise<DeferredBoundedLiveRuntimeTarget>;
}
export interface DeferredBoundedLiveRuntimeDispatchPayload {
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly sampleAuthorizationId: string;
  readonly sampleAuthorizationSha256: string;
  readonly sampleId: string;
  readonly selectedRole: "reference" | "candidate";
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly referenceExecutionReference: string;
  readonly candidateExecutionReference: string;
  readonly referenceSessionId: string;
  readonly candidateSessionId: string;
  readonly referenceWorkflowAttempt: number;
  readonly candidateWorkflowAttempt: number;
  readonly zeroRuntimeTools: true;
  readonly candidateOutputExternallyVisible: false;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
  readonly dispatchedAt: string;
}
export interface DeferredBoundedLiveRuntimeDispatch {
  readonly schemaVersion: typeof DEFERRED_BOUNDED_LIVE_RUNTIME_DISPATCH_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly dispatchId: string;
  readonly dispatchSha256: string;
  readonly payload: DeferredBoundedLiveRuntimeDispatchPayload;
}

export class RuntimeBackedDeferredBoundedLiveExecutionCoordinator {
  private readonly bindingCoordinator: RuntimeSessionBindingCoordinator;
  private readonly now: () => string;
  constructor(private readonly resolver: DeferredBoundedLiveRuntimeTargetResolver, options: { readonly now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.bindingCoordinator = new RuntimeSessionBindingCoordinator({ now: this.now });
  }

  async dispatch(input: { readonly experiment: ControlledExperimentDefinition; readonly authorization: BoundedLiveSampleAuthorization }): Promise<DeferredBoundedLiveRuntimeDispatch> {
    await verifyBoundedLiveSampleAuthorizationEnvelope(input.authorization);
    const experiment = input.experiment, auth = input.authorization;
    if (auth.payload.experimentId !== experiment.experimentId || auth.payload.experimentSha256 !== experiment.experimentSha256) throw new Error("Deferred bounded-live runtime authorization does not match exact experiment");
    if (experiment.payload.referenceSubjectId === experiment.payload.candidateSubjectId) throw new Error("Deferred bounded-live runtime requires distinct reference/candidate subjects");
    const expectedSelected = auth.payload.liveAssignment === "candidate" ? experiment.payload.candidateSubjectId : experiment.payload.referenceSubjectId;
    if (auth.payload.selectedSubjectId !== expectedSelected) throw new Error("Deferred bounded-live runtime selected subject mismatch");

    const [reference, candidate] = await Promise.all([
      this.resolver.resolve({ role: "reference", subjectId: experiment.payload.referenceSubjectId, sampleAuthorizationId: auth.authorizationId, sampleId: auth.payload.sampleId }),
      this.resolver.resolve({ role: "candidate", subjectId: experiment.payload.candidateSubjectId, sampleAuthorizationId: auth.authorizationId, sampleId: auth.payload.sampleId }),
    ]);
    assertTarget(reference, "reference", experiment.payload.referenceSubjectId, experiment.payload.projectId);
    assertTarget(candidate, "candidate", experiment.payload.candidateSubjectId, experiment.payload.projectId);
    assertComparable(reference, candidate);
    assertNoExistingBinding(reference, "reference"); assertNoExistingBinding(candidate, "candidate");

    const referenceBinding = await this.createBound(input, "reference", reference);
    const candidateBinding = await this.createBound(input, "candidate", candidate);
    try {
      await reference.adapter.sendTask(referenceBinding.sessionId, reference.task);
      await candidate.adapter.sendTask(candidateBinding.sessionId, candidate.task);
    } catch (error) {
      throw new Error(`Deferred bounded-live runtime send side effect is uncertain after durable binding; manual reconciliation is required and automatic redispatch is forbidden: ${safeError(error)}`);
    }

    const payload: DeferredBoundedLiveRuntimeDispatchPayload = deepFreeze({
      experimentId: experiment.experimentId,
      experimentSha256: experiment.experimentSha256,
      sampleAuthorizationId: auth.authorizationId,
      sampleAuthorizationSha256: auth.authorizationSha256,
      sampleId: auth.payload.sampleId,
      selectedRole: auth.payload.liveAssignment,
      referenceSubjectId: experiment.payload.referenceSubjectId,
      candidateSubjectId: experiment.payload.candidateSubjectId,
      referenceExecutionReference: runtimeReference("reference", referenceBinding),
      candidateExecutionReference: runtimeReference("candidate", candidateBinding),
      referenceSessionId: referenceBinding.sessionId,
      candidateSessionId: candidateBinding.sessionId,
      referenceWorkflowAttempt: referenceBinding.workflowAttempt,
      candidateWorkflowAttempt: candidateBinding.workflowAttempt,
      zeroRuntimeTools: true,
      candidateOutputExternallyVisible: false,
      automaticRedispatchAllowed: false,
      productionRoutingMutationAllowed: false,
      dispatchedAt: prepareTimestamp(this.now(), "Deferred bounded-live runtime dispatchedAt"),
    });
    const dispatchSha256 = await sha256Canonical(payload);
    return deepFreeze({ schemaVersion: DEFERRED_BOUNDED_LIVE_RUNTIME_DISPATCH_SCHEMA_VERSION, algorithm: "sha256", dispatchId: `m5livedispatch:${dispatchSha256.slice(0, 32).toLowerCase()}`, dispatchSha256, payload });
  }

  private async createBound(input: { readonly experiment: ControlledExperimentDefinition; readonly authorization: BoundedLiveSampleAuthorization }, role: DeferredBoundedLiveRuntimeRole, target: DeferredBoundedLiveRuntimeTarget): Promise<RuntimeBinding> {
    const bound = await this.bindingCoordinator.createBoundSession({
      run: target.run,
      workspace: target.workspace,
      adapter: target.adapter,
      bindingStore: target.bindingStore,
      metadata: {
        "9router.experimentId": input.experiment.experimentId,
        "9router.liveSampleAuthorizationId": input.authorization.authorizationId,
        "9router.experimentSampleId": input.authorization.payload.sampleId,
        "9router.experimentRole": role,
        "9router.experimentExposure": "bounded_live",
        "9router.experimentSelectedRole": input.authorization.payload.liveAssignment,
        "9router.candidateOutputExternallyVisibleBeforePublication": false,
      },
    });
    return bound.binding;
  }
}

export async function verifyDeferredBoundedLiveRuntimeDispatchEnvelope(dispatch: DeferredBoundedLiveRuntimeDispatch): Promise<void> {
  if (!dispatch || typeof dispatch !== "object" || dispatch.schemaVersion !== DEFERRED_BOUNDED_LIVE_RUNTIME_DISPATCH_SCHEMA_VERSION || dispatch.algorithm !== "sha256" || !dispatch.payload) throw new Error("Deferred bounded-live runtime dispatch envelope is invalid");
  const p = dispatch.payload;
  if (p.selectedRole !== "reference" && p.selectedRole !== "candidate") throw new Error("Deferred bounded-live runtime dispatch selectedRole is invalid");
  if (p.referenceSubjectId === p.candidateSubjectId || p.referenceSessionId === p.candidateSessionId) throw new Error("Deferred bounded-live runtime dispatch identities must be distinct");
  if (p.zeroRuntimeTools !== true || p.candidateOutputExternallyVisible !== false || p.automaticRedispatchAllowed !== false || p.productionRoutingMutationAllowed !== false) throw new Error("Deferred bounded-live runtime dispatch safety flags are invalid");
  const expected = await sha256Canonical(p); if (dispatch.dispatchSha256 !== expected || dispatch.dispatchId !== `m5livedispatch:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Deferred bounded-live runtime dispatch digest is invalid");
}

function assertTarget(target: DeferredBoundedLiveRuntimeTarget, role: DeferredBoundedLiveRuntimeRole, subjectId: string, projectId: string): void {
  if (!target || typeof target !== "object" || target.subjectId !== subjectId) throw new Error(`Deferred bounded-live ${role} target subject mismatch`);
  if (target.run.projectId !== projectId || target.run.phase !== "execute" || target.run.status !== "running" || target.run.riskClass !== "R0") throw new Error(`Deferred bounded-live ${role} workflow must be active R0 execute for exact project`);
  if (!target.workspace.trim() || !target.adapter.runtimeId.trim()) throw new Error(`Deferred bounded-live ${role} target workspace/runtime is invalid`);
  if (!target.task.taskId.trim() || !target.task.prompt.trim()) throw new Error(`Deferred bounded-live ${role} task is invalid`);
  if (target.task.toolIds.length !== 0) throw new Error(`Deferred bounded-live ${role} runtime task must expose zero tools`);
}
function assertComparable(reference: DeferredBoundedLiveRuntimeTarget, candidate: DeferredBoundedLiveRuntimeTarget): void {
  if (reference.run.id === candidate.run.id) throw new Error("Deferred bounded-live runtimes require distinct workflow runs");
  if (normalizePath(reference.workspace) !== normalizePath(candidate.workspace)) throw new Error("Deferred bounded-live runtimes require same workspace");
  if (reference.task.prompt !== candidate.task.prompt || !sameArray(reference.task.context, candidate.task.context) || !sameArray(reference.task.toolIds, candidate.task.toolIds)) throw new Error("Deferred bounded-live runtimes require identical prompt/context/tool policy");
}
function assertNoExistingBinding(target: DeferredBoundedLiveRuntimeTarget, role: DeferredBoundedLiveRuntimeRole): void { if (target.bindingStore.get(target.run.id)) throw new Error(`Deferred bounded-live ${role} workflow already has durable binding; automatic redispatch is forbidden`); }
function runtimeReference(role: DeferredBoundedLiveRuntimeRole, binding: RuntimeBinding): string { return `bounded-live-runtime:${role}:${binding.runtimeId}:${binding.workflowRunId}:${binding.workflowAttempt}:${binding.sessionId}`; }
function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/\/+$/, ""); }
function sameArray(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function prepareTimestamp(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`); return new Date(value).toISOString(); }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 2048); }
async function sha256Canonical(value: unknown): Promise<string> { if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime"); const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase(); }
function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)])); }
function deepFreeze<T>(value: T): T { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); return value; }
