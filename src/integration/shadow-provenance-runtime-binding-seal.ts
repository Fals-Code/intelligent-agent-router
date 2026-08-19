import type { RuntimeBinding } from "../reconciliation/runtime-reconciliation.js";
import type { ShadowExperimentSampleProvenance } from "../evaluation/shadow-experiment-provenance.js";

export const SHADOW_PROVENANCE_RUNTIME_BINDING_SEAL_SCHEMA_VERSION = 1 as const;

export interface ShadowProvenanceRuntimeBindingSealPayload {
  readonly provenanceId: string;
  readonly provenanceSha256: string;
  readonly experimentId: string;
  readonly sampleId: string;
  readonly referenceRunId: string;
  readonly candidateRunId: string;
  readonly referenceBindingSha256: string;
  readonly candidateBindingSha256: string;
  readonly referenceWorkflowAttempt: number;
  readonly candidateWorkflowAttempt: number;
  readonly referenceSessionId: string;
  readonly candidateSessionId: string;
  readonly candidateOutputExternallyVisible: false;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface ShadowProvenanceRuntimeBindingSeal {
  readonly schemaVersion: typeof SHADOW_PROVENANCE_RUNTIME_BINDING_SEAL_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly sealId: string;
  readonly sealSha256: string;
  readonly payload: ShadowProvenanceRuntimeBindingSealPayload;
}

export interface ShadowProvenanceRuntimeBindingSealSources {
  readonly provenance: ShadowExperimentSampleProvenance;
  readonly referenceBinding: RuntimeBinding;
  readonly candidateBinding: RuntimeBinding;
}

export async function prepareShadowProvenanceRuntimeBindingSeal(
  sources: ShadowProvenanceRuntimeBindingSealSources,
): Promise<ShadowProvenanceRuntimeBindingSeal> {
  await verifyStandaloneProvenanceEnvelope(sources.provenance);
  const provenance = sources.provenance.payload;
  if (provenance.exposure !== "shadow" || provenance.liveAssignment !== "none") {
    throw new Error("Runtime binding provenance seal requires shadow-only provenance");
  }
  if (provenance.candidateOutputExternallyVisible !== false
    || provenance.automaticRedispatchAllowed !== false
    || provenance.productionRoutingMutationAllowed !== false) {
    throw new Error("Runtime binding provenance seal cannot originate from live visibility, redispatch, or production routing authority");
  }

  const reference = prepareBinding(sources.referenceBinding, "reference");
  const candidate = prepareBinding(sources.candidateBinding, "candidate");
  if (reference.workflowRunId === candidate.workflowRunId) {
    throw new Error("Runtime binding provenance seal requires distinct reference/candidate workflow runs");
  }
  if (reference.sessionId === candidate.sessionId) {
    throw new Error("Runtime binding provenance seal requires distinct reference/candidate runtime sessions");
  }
  if (reference.projectId !== candidate.projectId) {
    throw new Error("Runtime binding provenance seal requires reference/candidate bindings for the same projectId");
  }
  if (normalizePath(reference.workspace) !== normalizePath(candidate.workspace)) {
    throw new Error("Runtime binding provenance seal requires reference/candidate bindings for the same workspace");
  }
  if (provenance.referenceRunId !== reference.workflowRunId || provenance.candidateRunId !== candidate.workflowRunId) {
    throw new Error("Runtime binding provenance seal workflowRunId does not match shadow provenance Run Ledger identities");
  }

  const expectedReference = runtimeBindingReference("reference", reference);
  const expectedCandidate = runtimeBindingReference("candidate", candidate);
  if (provenance.referenceExecutionReference !== expectedReference) {
    throw new Error("Runtime binding provenance seal reference execution reference does not exactly match durable RuntimeBinding");
  }
  if (provenance.candidateExecutionReference !== expectedCandidate) {
    throw new Error("Runtime binding provenance seal candidate execution reference does not exactly match durable RuntimeBinding");
  }

  const referenceBindingSha256 = await sha256Canonical(reference);
  const candidateBindingSha256 = await sha256Canonical(candidate);
  const payload: ShadowProvenanceRuntimeBindingSealPayload = deepFreeze({
    provenanceId: sources.provenance.provenanceId,
    provenanceSha256: sources.provenance.provenanceSha256,
    experimentId: provenance.experimentId,
    sampleId: provenance.sampleId,
    referenceRunId: provenance.referenceRunId,
    candidateRunId: provenance.candidateRunId,
    referenceBindingSha256,
    candidateBindingSha256,
    referenceWorkflowAttempt: reference.workflowAttempt,
    candidateWorkflowAttempt: candidate.workflowAttempt,
    referenceSessionId: reference.sessionId,
    candidateSessionId: candidate.sessionId,
    candidateOutputExternallyVisible: false as const,
    automaticRedispatchAllowed: false as const,
    productionRoutingMutationAllowed: false as const,
  });
  const sealSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: SHADOW_PROVENANCE_RUNTIME_BINDING_SEAL_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    sealId: `m5shadowbind:${sealSha256.slice(0, 32).toLowerCase()}`,
    sealSha256,
    payload,
  });
}

export async function verifyShadowProvenanceRuntimeBindingSeal(
  seal: ShadowProvenanceRuntimeBindingSeal,
  sources: ShadowProvenanceRuntimeBindingSealSources,
): Promise<void> {
  if (!isRecord(seal)
    || seal.schemaVersion !== SHADOW_PROVENANCE_RUNTIME_BINDING_SEAL_SCHEMA_VERSION
    || seal.algorithm !== "sha256") {
    throw new Error("Runtime binding provenance seal envelope is invalid");
  }
  const expected = await prepareShadowProvenanceRuntimeBindingSeal(sources);
  if (seal.sealId !== expected.sealId || seal.sealSha256 !== expected.sealSha256) {
    throw new Error("Runtime binding provenance seal digest does not match authoritative sources");
  }
  if (stableStringify(seal.payload) !== stableStringify(expected.payload)) {
    throw new Error("Runtime binding provenance seal payload does not match authoritative sources");
  }
}

async function verifyStandaloneProvenanceEnvelope(provenance: ShadowExperimentSampleProvenance): Promise<void> {
  if (!isRecord(provenance) || provenance.schemaVersion !== 1 || provenance.algorithm !== "sha256" || !isRecord(provenance.payload)) {
    throw new Error("Shadow experiment provenance envelope is invalid");
  }
  const expectedSha = await sha256Canonical(provenance.payload);
  if (provenance.provenanceSha256 !== expectedSha) throw new Error("Shadow experiment provenance digest is invalid");
  if (provenance.provenanceId !== `m5shadowprov:${expectedSha.slice(0, 32).toLowerCase()}`) {
    throw new Error("Shadow experiment provenanceId is invalid");
  }
}

function prepareBinding(binding: RuntimeBinding, role: string): RuntimeBinding {
  if (!isRecord(binding)) throw new Error(`Runtime binding provenance ${role} binding must be an object`);
  const prepared: RuntimeBinding = {
    workflowRunId: prepareIdentity(binding.workflowRunId, `${role} workflowRunId`),
    projectId: prepareIdentity(binding.projectId, `${role} projectId`),
    workflowAttempt: preparePositiveInteger(binding.workflowAttempt, `${role} workflowAttempt`),
    runtimeId: prepareIdentity(binding.runtimeId, `${role} runtimeId`),
    sessionId: prepareIdentity(binding.sessionId, `${role} sessionId`),
    workspace: prepareIdentity(binding.workspace, `${role} workspace`),
    boundAt: prepareTimestamp(binding.boundAt, `${role} boundAt`),
  };
  return deepFreeze(prepared);
}

function runtimeBindingReference(role: "reference" | "candidate", binding: RuntimeBinding): string {
  return `shadow-runtime:${role}:${binding.runtimeId}:${binding.workflowRunId}:${binding.workflowAttempt}:${binding.sessionId}`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runtime binding provenance ${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`Runtime binding provenance ${label} must be single-line`);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`Runtime binding provenance ${label} contains secret-like material`);
  return prepared;
}

function preparePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`Runtime binding provenance ${label} must be a positive integer`);
  return Number(value);
}

function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Runtime binding provenance ${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}

function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value)
    || /\bghp_[A-Za-z0-9]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
}

async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
