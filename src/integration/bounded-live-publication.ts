import type { RunLedgerRecord } from "../control-plane/contracts.js";
import type { BoundedLiveAssignment, BoundedLiveSampleAuthorization } from "../evaluation/bounded-live-sample-authorization.js";
import { verifyBoundedLiveSampleAuthorizationEnvelope } from "../evaluation/bounded-live-sample-authorization.js";
import type { RuntimeBinding } from "../reconciliation/runtime-reconciliation.js";

export const VERIFIED_BOUNDED_LIVE_RUNTIME_RESULT_SCHEMA_VERSION = 1 as const;
export const BOUNDED_LIVE_PUBLICATION_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface VerifiedBoundedLiveRuntimeResultInput {
  readonly role: BoundedLiveAssignment;
  readonly authorization: BoundedLiveSampleAuthorization;
  readonly run: RunLedgerRecord;
  readonly binding: RuntimeBinding;
  readonly verificationReference: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly verifiedAt: string;
}

export interface VerifiedBoundedLiveRuntimeResultPayload {
  readonly sampleAuthorizationId: string;
  readonly sampleAuthorizationSha256: string;
  readonly sampleId: string;
  readonly role: BoundedLiveAssignment;
  readonly selectedSubjectId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly runtimeId: string;
  readonly workflowAttempt: number;
  readonly sessionId: string;
  readonly workspace: string;
  readonly verificationReference: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly verifiedAt: string;
  readonly runLedgerOutcome: "succeeded";
  readonly candidateOutputMayBeExternallyVisible: boolean;
  readonly rawOutputPersisted: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface VerifiedBoundedLiveRuntimeResult {
  readonly schemaVersion: typeof VERIFIED_BOUNDED_LIVE_RUNTIME_RESULT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly resultId: string;
  readonly resultSha256: string;
  readonly payload: VerifiedBoundedLiveRuntimeResultPayload;
}

export interface BoundedLiveOutputReader {
  read(input: { readonly runtimeId: string; readonly sessionId: string; readonly runId: string }): Promise<string>;
}

export interface BoundedLivePublicationSink {
  readonly id: string;
  publish(input: {
    readonly idempotencyKey: string;
    readonly sampleAuthorizationId: string;
    readonly sampleId: string;
    readonly selectedSubjectId: string;
    readonly selectedRole: BoundedLiveAssignment;
    readonly output: string;
    readonly outputSha256: string;
  }): Promise<{
    readonly sinkId: string;
    readonly idempotencyKey: string;
    readonly publicationReference: string;
    readonly publishedAt: string;
    readonly selectedRole: BoundedLiveAssignment;
    readonly outputSha256: string;
    readonly externallyVisible: true;
  }>;
}

export interface BoundedLivePublicationReceiptPayload {
  readonly sampleAuthorizationId: string;
  readonly sampleAuthorizationSha256: string;
  readonly runtimeResultId: string;
  readonly runtimeResultSha256: string;
  readonly sampleId: string;
  readonly selectedSubjectId: string;
  readonly selectedRole: BoundedLiveAssignment;
  readonly sinkId: string;
  readonly publicationReference: string;
  readonly publicationIdempotencyKey: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly verifiedAt: string;
  readonly publishedAt: string;
  readonly externallyVisible: true;
  readonly candidateOutputExternallyVisible: boolean;
  readonly rawOutputPersisted: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface BoundedLivePublicationReceipt {
  readonly schemaVersion: typeof BOUNDED_LIVE_PUBLICATION_RECEIPT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly receiptId: string;
  readonly receiptSha256: string;
  readonly payload: BoundedLivePublicationReceiptPayload;
}

export async function prepareVerifiedBoundedLiveRuntimeResult(input: VerifiedBoundedLiveRuntimeResultInput): Promise<VerifiedBoundedLiveRuntimeResult> {
  await verifyBoundedLiveSampleAuthorizationEnvelope(input.authorization);
  const authorization = input.authorization;
  if (input.role !== authorization.payload.liveAssignment) throw new Error("Bounded-live runtime result role does not match sample authorization liveAssignment");
  if (input.run.outcome !== "succeeded") throw new Error("Bounded-live runtime result requires succeeded canonical Run Ledger outcome");
  if (input.run.runId !== input.binding.workflowRunId || input.run.projectId !== input.binding.projectId || input.run.runtimeId !== input.binding.runtimeId) {
    throw new Error("Bounded-live runtime result Run Ledger identity does not match durable RuntimeBinding");
  }
  if (normalizePath(input.run.workspace) !== normalizePath(input.binding.workspace)) {
    throw new Error("Bounded-live runtime result Run Ledger workspace does not match durable RuntimeBinding");
  }
  if (input.run.projectId !== authorization.payload.projectId) throw new Error("Bounded-live runtime result projectId does not match sample authorization");
  if (!input.run.modelRoute.includes(authorization.payload.selectedSubjectId)) {
    throw new Error("Bounded-live Run Ledger modelRoute does not contain the authorized selected subject");
  }
  if (!Number.isInteger(input.binding.workflowAttempt) || input.binding.workflowAttempt <= 0) throw new Error("Bounded-live RuntimeBinding workflowAttempt is invalid");
  prepareIdentity(input.binding.sessionId, "Bounded-live RuntimeBinding sessionId");
  const verificationReference = prepareIdentity(input.verificationReference, "Bounded-live verification reference");
  const verificationEvidence = input.run.evidence.find((item) => item.kind === "deterministic_check" && item.status === "passed" && item.reference === verificationReference);
  if (!verificationEvidence) throw new Error("Bounded-live runtime result lacks exact passed deterministic verification evidence in Run Ledger");
  const outputSha256 = prepareSha256(input.outputSha256, "Bounded-live outputSha256");
  if (!Number.isInteger(input.outputBytes) || input.outputBytes <= 0) throw new Error("Bounded-live outputBytes must be a positive integer");
  const verifiedAt = prepareTimestamp(input.verifiedAt, "Bounded-live verifiedAt");
  if (Date.parse(verifiedAt) < Date.parse(authorization.payload.approvedAt)) {
    throw new Error("Bounded-live runtime verification cannot predate sample authorization approval");
  }
  const payload: VerifiedBoundedLiveRuntimeResultPayload = deepFreeze({
    sampleAuthorizationId: authorization.authorizationId,
    sampleAuthorizationSha256: authorization.authorizationSha256,
    sampleId: authorization.payload.sampleId,
    role: input.role,
    selectedSubjectId: authorization.payload.selectedSubjectId,
    runId: input.run.runId,
    projectId: input.run.projectId,
    runtimeId: input.run.runtimeId,
    workflowAttempt: input.binding.workflowAttempt,
    sessionId: input.binding.sessionId,
    workspace: input.binding.workspace,
    verificationReference,
    outputSha256,
    outputBytes: input.outputBytes,
    verifiedAt,
    runLedgerOutcome: "succeeded" as const,
    candidateOutputMayBeExternallyVisible: input.role === "candidate",
    rawOutputPersisted: false as const,
    productionRoutingMutationAllowed: false as const,
  });
  const resultSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: VERIFIED_BOUNDED_LIVE_RUNTIME_RESULT_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    resultId: `m5liveresult:${resultSha256.slice(0, 32).toLowerCase()}`,
    resultSha256,
    payload,
  });
}

export async function verifyVerifiedBoundedLiveRuntimeResultEnvelope(result: VerifiedBoundedLiveRuntimeResult): Promise<void> {
  if (!result || typeof result !== "object" || result.schemaVersion !== VERIFIED_BOUNDED_LIVE_RUNTIME_RESULT_SCHEMA_VERSION || result.algorithm !== "sha256") {
    throw new Error("Bounded-live runtime result envelope is invalid");
  }
  const payload = result.payload;
  if (!payload || typeof payload !== "object") throw new Error("Bounded-live runtime result payload is invalid");
  if (payload.role !== "reference" && payload.role !== "candidate") throw new Error("Bounded-live runtime result role is invalid");
  if (payload.runLedgerOutcome !== "succeeded" || payload.rawOutputPersisted !== false || payload.productionRoutingMutationAllowed !== false) {
    throw new Error("Bounded-live runtime result safety flags are invalid");
  }
  if (payload.candidateOutputMayBeExternallyVisible !== (payload.role === "candidate")) throw new Error("Bounded-live runtime result candidate visibility flag mismatch");
  prepareSha256(payload.outputSha256, "Bounded-live runtime result outputSha256");
  if (!Number.isInteger(payload.outputBytes) || payload.outputBytes <= 0) throw new Error("Bounded-live runtime result outputBytes is invalid");
  prepareTimestamp(payload.verifiedAt, "Bounded-live runtime result verifiedAt");
  const expected = await sha256Canonical(payload);
  if (result.resultSha256 !== expected || result.resultId !== `m5liveresult:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Bounded-live runtime result digest is invalid");
  }
}

export async function verifyVerifiedBoundedLiveRuntimeResult(result: VerifiedBoundedLiveRuntimeResult, input: VerifiedBoundedLiveRuntimeResultInput): Promise<void> {
  await verifyVerifiedBoundedLiveRuntimeResultEnvelope(result);
  const expected = await prepareVerifiedBoundedLiveRuntimeResult(input);
  if (result.resultId !== expected.resultId || result.resultSha256 !== expected.resultSha256 || stableStringify(result.payload) !== stableStringify(expected.payload)) {
    throw new Error("Bounded-live runtime result does not match authoritative sources");
  }
}

export class BoundedLivePublicationCoordinator {
  constructor(private readonly reader: BoundedLiveOutputReader, private readonly sink: BoundedLivePublicationSink) {
    prepareIdentity(sink.id, "Bounded-live publication sink id");
  }

  async publish(input: { readonly authorization: BoundedLiveSampleAuthorization; readonly runtimeResult: VerifiedBoundedLiveRuntimeResult }): Promise<BoundedLivePublicationReceipt> {
    const { authorization, runtimeResult } = input;
    await verifyBoundedLiveSampleAuthorizationEnvelope(authorization);
    await verifyVerifiedBoundedLiveRuntimeResultEnvelope(runtimeResult);
    if (runtimeResult.payload.sampleAuthorizationId !== authorization.authorizationId
      || runtimeResult.payload.sampleAuthorizationSha256 !== authorization.authorizationSha256
      || runtimeResult.payload.sampleId !== authorization.payload.sampleId
      || runtimeResult.payload.role !== authorization.payload.liveAssignment
      || runtimeResult.payload.selectedSubjectId !== authorization.payload.selectedSubjectId) {
      throw new Error("Bounded-live publication runtime result does not match exact sample authorization");
    }
    if (authorization.payload.automaticDispatchAllowed !== false || authorization.payload.automaticRedispatchAllowed !== false
      || authorization.payload.productionRoutingMutationAllowed !== false || authorization.payload.automaticRollbackAllowed !== false) {
      throw new Error("Bounded-live sample authorization unexpectedly grants automatic or production-routing authority");
    }

    const output = await this.reader.read({ runtimeId: runtimeResult.payload.runtimeId, sessionId: runtimeResult.payload.sessionId, runId: runtimeResult.payload.runId });
    if (typeof output !== "string" || output.length === 0) throw new Error("Bounded-live output reader returned empty output");
    const outputBytes = utf8ByteLength(output);
    const outputSha256 = await sha256Text(output);
    if (outputBytes !== runtimeResult.payload.outputBytes || outputSha256 !== runtimeResult.payload.outputSha256) {
      throw new Error("Bounded-live ephemeral output does not match verified runtime result hash/size");
    }

    const idempotencyKey = `${authorization.authorizationId}:${runtimeResult.resultId}`;
    let sinkReceipt: Awaited<ReturnType<BoundedLivePublicationSink["publish"]>>;
    try {
      sinkReceipt = await this.sink.publish({
        idempotencyKey,
        sampleAuthorizationId: authorization.authorizationId,
        sampleId: authorization.payload.sampleId,
        selectedSubjectId: authorization.payload.selectedSubjectId,
        selectedRole: authorization.payload.liveAssignment,
        output,
        outputSha256,
      });
    } catch (error) {
      throw new Error(`Bounded-live publication side effect is unknown; automatic retry is forbidden: ${safeError(error)}`);
    }
    assertSinkReceipt(sinkReceipt, this.sink.id, idempotencyKey, authorization.payload.liveAssignment, outputSha256);
    const publishedAt = prepareTimestamp(sinkReceipt.publishedAt, "Bounded-live publishedAt");
    if (Date.parse(publishedAt) < Date.parse(runtimeResult.payload.verifiedAt)) {
      throw new Error("Bounded-live publication timestamp cannot predate deterministic verification");
    }

    const payload: BoundedLivePublicationReceiptPayload = deepFreeze({
      sampleAuthorizationId: authorization.authorizationId,
      sampleAuthorizationSha256: authorization.authorizationSha256,
      runtimeResultId: runtimeResult.resultId,
      runtimeResultSha256: runtimeResult.resultSha256,
      sampleId: authorization.payload.sampleId,
      selectedSubjectId: authorization.payload.selectedSubjectId,
      selectedRole: authorization.payload.liveAssignment,
      sinkId: sinkReceipt.sinkId,
      publicationReference: prepareIdentity(sinkReceipt.publicationReference, "Bounded-live publication reference"),
      publicationIdempotencyKey: idempotencyKey,
      outputSha256,
      outputBytes,
      verifiedAt: runtimeResult.payload.verifiedAt,
      publishedAt,
      externallyVisible: true as const,
      candidateOutputExternallyVisible: authorization.payload.liveAssignment === "candidate",
      rawOutputPersisted: false as const,
      automaticRetryAllowed: false as const,
      automaticRollbackAllowed: false as const,
      productionRoutingMutationAllowed: false as const,
    });
    const receiptSha256 = await sha256Canonical(payload);
    return deepFreeze({ schemaVersion: BOUNDED_LIVE_PUBLICATION_RECEIPT_SCHEMA_VERSION, algorithm: "sha256" as const, receiptId: `m5livepub:${receiptSha256.slice(0, 32).toLowerCase()}`, receiptSha256, payload });
  }
}

export async function verifyBoundedLivePublicationReceipt(receipt: BoundedLivePublicationReceipt): Promise<void> {
  if (!receipt || typeof receipt !== "object" || receipt.schemaVersion !== BOUNDED_LIVE_PUBLICATION_RECEIPT_SCHEMA_VERSION || receipt.algorithm !== "sha256") {
    throw new Error("Bounded-live publication receipt envelope is invalid");
  }
  const expected = await sha256Canonical(receipt.payload);
  if (receipt.receiptSha256 !== expected || receipt.receiptId !== `m5livepub:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Bounded-live publication receipt digest is invalid");
  if (receipt.payload.externallyVisible !== true || receipt.payload.rawOutputPersisted !== false || receipt.payload.automaticRetryAllowed !== false
    || receipt.payload.automaticRollbackAllowed !== false || receipt.payload.productionRoutingMutationAllowed !== false) {
    throw new Error("Bounded-live publication receipt safety flags are invalid");
  }
  if (receipt.payload.candidateOutputExternallyVisible !== (receipt.payload.selectedRole === "candidate")) throw new Error("Bounded-live candidate visibility flag does not match selected role");
  if (Date.parse(receipt.payload.publishedAt) < Date.parse(receipt.payload.verifiedAt)) throw new Error("Bounded-live publication receipt predates verification");
}

function assertSinkReceipt(receipt: Awaited<ReturnType<BoundedLivePublicationSink["publish"]>>, sinkId: string, idempotencyKey: string, role: BoundedLiveAssignment, outputSha256: string): void {
  if (!receipt || typeof receipt !== "object") throw new Error("Bounded-live publication sink returned invalid receipt");
  if (receipt.sinkId !== sinkId || receipt.idempotencyKey !== idempotencyKey || receipt.selectedRole !== role || receipt.outputSha256 !== outputSha256 || receipt.externallyVisible !== true) {
    throw new Error("Bounded-live publication sink receipt does not match exact requested publication");
  }
  prepareIdentity(receipt.publicationReference, "Bounded-live publication reference");
  prepareTimestamp(receipt.publishedAt, "Bounded-live publication timestamp");
}

function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/\/+$/, ""); }
function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
}
function prepareSha256(value: unknown, label: string): string {
  const prepared = prepareIdentity(value, label).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(prepared)) throw new Error(`${label} must be a SHA-256 digest`);
  return prepared;
}
function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}
function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value)
    || /\bghp_[A-Za-z0-9]{20,}\b/.test(value) || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]");
}
async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
async function sha256Canonical(value: unknown): Promise<string> { return sha256Text(stableStringify(value)); }
function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
}
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
