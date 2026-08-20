import type { RunLedgerRecord } from "../control-plane/contracts.js";
import type { BoundedLiveAssignment, BoundedLiveSampleAuthorization } from "../evaluation/bounded-live-sample-authorization.js";
import { verifyBoundedLiveSampleAuthorizationEnvelope } from "../evaluation/bounded-live-sample-authorization.js";
import type { RuntimeBinding } from "../reconciliation/runtime-reconciliation.js";
import type { JsonlBoundedLiveSideEffectJournal } from "./bounded-live-side-effect-journal.js";

export const VERIFIED_BOUNDED_LIVE_RUNTIME_RESULT_SCHEMA_VERSION = 1 as const;
export const BOUNDED_LIVE_PUBLICATION_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface VerifiedBoundedLiveRuntimeResultInput { readonly role: BoundedLiveAssignment; readonly authorization: BoundedLiveSampleAuthorization; readonly run: RunLedgerRecord; readonly binding: RuntimeBinding; readonly verificationReference: string; readonly outputSha256: string; readonly outputBytes: number; readonly verifiedAt: string; }
export interface VerifiedBoundedLiveRuntimeResultPayload { readonly sampleAuthorizationId: string; readonly sampleAuthorizationSha256: string; readonly sampleId: string; readonly role: BoundedLiveAssignment; readonly selectedSubjectId: string; readonly runId: string; readonly projectId: string; readonly runtimeId: string; readonly workflowAttempt: number; readonly sessionId: string; readonly workspace: string; readonly verificationReference: string; readonly outputSha256: string; readonly outputBytes: number; readonly verifiedAt: string; readonly runLedgerOutcome: "succeeded"; readonly candidateOutputMayBeExternallyVisible: boolean; readonly rawOutputPersisted: false; readonly productionRoutingMutationAllowed: false; }
export interface VerifiedBoundedLiveRuntimeResult { readonly schemaVersion: typeof VERIFIED_BOUNDED_LIVE_RUNTIME_RESULT_SCHEMA_VERSION; readonly algorithm: "sha256"; readonly resultId: string; readonly resultSha256: string; readonly payload: VerifiedBoundedLiveRuntimeResultPayload; }
export interface BoundedLiveOutputReader { read(input: { readonly runtimeId: string; readonly sessionId: string; readonly runId: string }): Promise<string>; }
export interface BoundedLivePublicationSink {
  readonly id: string;
  publish(input: { readonly idempotencyKey: string; readonly sampleAuthorizationId: string; readonly sampleId: string; readonly selectedSubjectId: string; readonly selectedRole: BoundedLiveAssignment; readonly output: string; readonly outputSha256: string }): Promise<{ readonly sinkId: string; readonly idempotencyKey: string; readonly publicationReference: string; readonly publishedAt: string; readonly selectedRole: BoundedLiveAssignment; readonly outputSha256: string; readonly externallyVisible: true }>;
}
export interface BoundedLivePublicationReceiptPayload { readonly sampleAuthorizationId: string; readonly sampleAuthorizationSha256: string; readonly runtimeResultId: string; readonly runtimeResultSha256: string; readonly sampleId: string; readonly selectedSubjectId: string; readonly selectedRole: BoundedLiveAssignment; readonly sinkId: string; readonly publicationReference: string; readonly publicationIdempotencyKey: string; readonly sideEffectOperationId: string; readonly sideEffectCommitEventId: string; readonly outputSha256: string; readonly outputBytes: number; readonly verifiedAt: string; readonly publishedAt: string; readonly externallyVisible: true; readonly candidateOutputExternallyVisible: boolean; readonly rawOutputPersisted: false; readonly automaticRetryAllowed: false; readonly automaticRollbackAllowed: false; readonly productionRoutingMutationAllowed: false; }
export interface BoundedLivePublicationReceipt { readonly schemaVersion: typeof BOUNDED_LIVE_PUBLICATION_RECEIPT_SCHEMA_VERSION; readonly algorithm: "sha256"; readonly receiptId: string; readonly receiptSha256: string; readonly payload: BoundedLivePublicationReceiptPayload; }

export async function prepareVerifiedBoundedLiveRuntimeResult(input: VerifiedBoundedLiveRuntimeResultInput): Promise<VerifiedBoundedLiveRuntimeResult> {
  await verifyBoundedLiveSampleAuthorizationEnvelope(input.authorization);
  const auth = input.authorization.payload;
  if (input.role !== auth.liveAssignment) throw new Error("Bounded-live runtime result role does not match sample authorization liveAssignment");
  if (input.run.outcome !== "succeeded") throw new Error("Bounded-live runtime result requires succeeded canonical Run Ledger outcome");
  if (input.run.runId !== input.binding.workflowRunId || input.run.projectId !== input.binding.projectId || input.run.runtimeId !== input.binding.runtimeId) throw new Error("Bounded-live runtime result Run Ledger identity does not match durable RuntimeBinding");
  if (normalizePath(input.run.workspace) !== normalizePath(input.binding.workspace)) throw new Error("Bounded-live runtime result Run Ledger workspace does not match durable RuntimeBinding");
  if (input.run.projectId !== auth.projectId) throw new Error("Bounded-live runtime result projectId does not match sample authorization");
  if (!input.run.modelRoute.includes(auth.selectedSubjectId)) throw new Error("Bounded-live Run Ledger modelRoute does not contain the authorized selected subject");
  if (!Number.isInteger(input.binding.workflowAttempt) || input.binding.workflowAttempt <= 0) throw new Error("Bounded-live RuntimeBinding workflowAttempt is invalid");
  const sessionId = prepareIdentity(input.binding.sessionId, "Bounded-live RuntimeBinding sessionId");
  const verificationReference = prepareIdentity(input.verificationReference, "Bounded-live verification reference");
  if (!input.run.evidence.some((item) => item.kind === "deterministic_check" && item.status === "passed" && item.reference === verificationReference)) throw new Error("Bounded-live runtime result lacks exact passed deterministic verification evidence in Run Ledger");
  const outputSha256 = prepareSha256(input.outputSha256, "Bounded-live outputSha256");
  if (!Number.isInteger(input.outputBytes) || input.outputBytes <= 0) throw new Error("Bounded-live outputBytes must be a positive integer");
  const verifiedAt = prepareTimestamp(input.verifiedAt, "Bounded-live verifiedAt");
  if (Date.parse(verifiedAt) < Date.parse(auth.approvedAt)) throw new Error("Bounded-live runtime verification cannot predate sample authorization approval");
  const payload: VerifiedBoundedLiveRuntimeResultPayload = deepFreeze({ sampleAuthorizationId: input.authorization.authorizationId, sampleAuthorizationSha256: input.authorization.authorizationSha256, sampleId: auth.sampleId, role: input.role, selectedSubjectId: auth.selectedSubjectId, runId: input.run.runId, projectId: input.run.projectId, runtimeId: input.run.runtimeId, workflowAttempt: input.binding.workflowAttempt, sessionId, workspace: input.binding.workspace, verificationReference, outputSha256, outputBytes: input.outputBytes, verifiedAt, runLedgerOutcome: "succeeded", candidateOutputMayBeExternallyVisible: input.role === "candidate", rawOutputPersisted: false, productionRoutingMutationAllowed: false });
  const resultSha256 = await sha256Canonical(payload);
  return deepFreeze({ schemaVersion: VERIFIED_BOUNDED_LIVE_RUNTIME_RESULT_SCHEMA_VERSION, algorithm: "sha256", resultId: `m5liveresult:${resultSha256.slice(0, 32).toLowerCase()}`, resultSha256, payload });
}

export async function verifyVerifiedBoundedLiveRuntimeResultEnvelope(result: VerifiedBoundedLiveRuntimeResult): Promise<void> {
  if (!result || typeof result !== "object" || result.schemaVersion !== VERIFIED_BOUNDED_LIVE_RUNTIME_RESULT_SCHEMA_VERSION || result.algorithm !== "sha256" || !result.payload) throw new Error("Bounded-live runtime result envelope is invalid");
  const p = result.payload;
  if (p.role !== "reference" && p.role !== "candidate") throw new Error("Bounded-live runtime result role is invalid");
  if (p.runLedgerOutcome !== "succeeded" || p.rawOutputPersisted !== false || p.productionRoutingMutationAllowed !== false || p.candidateOutputMayBeExternallyVisible !== (p.role === "candidate")) throw new Error("Bounded-live runtime result safety flags are invalid");
  prepareSha256(p.outputSha256, "Bounded-live runtime result outputSha256"); if (!Number.isInteger(p.outputBytes) || p.outputBytes <= 0) throw new Error("Bounded-live runtime result outputBytes is invalid"); prepareTimestamp(p.verifiedAt, "Bounded-live runtime result verifiedAt");
  const expected = await sha256Canonical(p); if (result.resultSha256 !== expected || result.resultId !== `m5liveresult:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Bounded-live runtime result digest is invalid");
}
export async function verifyVerifiedBoundedLiveRuntimeResult(result: VerifiedBoundedLiveRuntimeResult, input: VerifiedBoundedLiveRuntimeResultInput): Promise<void> { await verifyVerifiedBoundedLiveRuntimeResultEnvelope(result); const expected = await prepareVerifiedBoundedLiveRuntimeResult(input); if (stableStringify(result) !== stableStringify(expected)) throw new Error("Bounded-live runtime result does not match authoritative sources"); }

export class BoundedLivePublicationCoordinator {
  constructor(private readonly reader: BoundedLiveOutputReader, private readonly sink: BoundedLivePublicationSink, private readonly sideEffects: JsonlBoundedLiveSideEffectJournal) { prepareIdentity(sink.id, "Bounded-live publication sink id"); }

  async publish(input: { readonly authorization: BoundedLiveSampleAuthorization; readonly runtimeResult: VerifiedBoundedLiveRuntimeResult }): Promise<BoundedLivePublicationReceipt> {
    await verifyBoundedLiveSampleAuthorizationEnvelope(input.authorization); await verifyVerifiedBoundedLiveRuntimeResultEnvelope(input.runtimeResult);
    const auth = input.authorization.payload, result = input.runtimeResult.payload;
    if (result.sampleAuthorizationId !== input.authorization.authorizationId || result.sampleAuthorizationSha256 !== input.authorization.authorizationSha256 || result.sampleId !== auth.sampleId || result.role !== auth.liveAssignment || result.selectedSubjectId !== auth.selectedSubjectId) throw new Error("Bounded-live publication runtime result does not match exact sample authorization");
    const output = await this.reader.read({ runtimeId: result.runtimeId, sessionId: result.sessionId, runId: result.runId });
    if (typeof output !== "string" || output.length === 0) throw new Error("Bounded-live output reader returned empty output");
    const outputBytes = utf8ByteLength(output), outputSha256 = await sha256Text(output);
    if (outputBytes !== result.outputBytes || outputSha256 !== result.outputSha256) throw new Error("Bounded-live ephemeral output does not match verified runtime result hash/size");
    const idempotencyKey = `${input.authorization.authorizationId}:${input.runtimeResult.resultId}`;
    const operationId = `publication:${input.authorization.authorizationId}:${input.runtimeResult.resultId}`;
    await this.sideEffects.reserve({ kind: "publication", operationId, idempotencyKey, sinkId: this.sink.id, authorityId: input.authorization.authorizationId, subjectId: auth.selectedSubjectId, sampleId: auth.sampleId, outputSha256, reservedAt: result.verifiedAt });

    let sinkReceipt: Awaited<ReturnType<BoundedLivePublicationSink["publish"]>>;
    let publishedAt: string;
    try {
      sinkReceipt = await this.sink.publish({ idempotencyKey, sampleAuthorizationId: input.authorization.authorizationId, sampleId: auth.sampleId, selectedSubjectId: auth.selectedSubjectId, selectedRole: auth.liveAssignment, output, outputSha256 });
      assertSinkReceipt(sinkReceipt, this.sink.id, idempotencyKey, auth.liveAssignment, outputSha256);
      publishedAt = prepareTimestamp(sinkReceipt.publishedAt, "Bounded-live publishedAt");
      if (Date.parse(publishedAt) < Date.parse(result.verifiedAt)) throw new Error("Bounded-live publication timestamp cannot predate deterministic verification");
    } catch (error) {
      const message = safeError(error);
      try { const event = await this.sideEffects.recordError({ operationId, observedAt: result.verifiedAt, error: message }); throw new Error(`Bounded-live publication side effect is unknown; manual reconciliation is required and automatic retry is forbidden; journal=${event.eventId}: ${message}`); }
      catch (journalError) { if (journalError instanceof Error && journalError.message.includes("manual reconciliation is required")) throw journalError; throw new Error(`Bounded-live publication side effect is unknown and error persistence failed; manual reconciliation is required and automatic retry is forbidden: ${message}; journalError=${safeError(journalError)}`); }
    }

    let commitEvent;
    try { commitEvent = await this.sideEffects.recordCommit({ operationId, externalReference: sinkReceipt.publicationReference, committedAt: publishedAt }); }
    catch (error) { throw new Error(`Bounded-live publication sink accepted output but durable side-effect commit failed; external side effect may have occurred, manual reconciliation is required, and automatic retry is forbidden: ${safeError(error)}`); }
    const payload: BoundedLivePublicationReceiptPayload = deepFreeze({ sampleAuthorizationId: input.authorization.authorizationId, sampleAuthorizationSha256: input.authorization.authorizationSha256, runtimeResultId: input.runtimeResult.resultId, runtimeResultSha256: input.runtimeResult.resultSha256, sampleId: auth.sampleId, selectedSubjectId: auth.selectedSubjectId, selectedRole: auth.liveAssignment, sinkId: sinkReceipt.sinkId, publicationReference: prepareIdentity(sinkReceipt.publicationReference, "Bounded-live publication reference"), publicationIdempotencyKey: idempotencyKey, sideEffectOperationId: operationId, sideEffectCommitEventId: commitEvent.eventId, outputSha256, outputBytes, verifiedAt: result.verifiedAt, publishedAt, externallyVisible: true, candidateOutputExternallyVisible: auth.liveAssignment === "candidate", rawOutputPersisted: false, automaticRetryAllowed: false, automaticRollbackAllowed: false, productionRoutingMutationAllowed: false });
    const receiptSha256 = await sha256Canonical(payload);
    return deepFreeze({ schemaVersion: BOUNDED_LIVE_PUBLICATION_RECEIPT_SCHEMA_VERSION, algorithm: "sha256", receiptId: `m5livepub:${receiptSha256.slice(0, 32).toLowerCase()}`, receiptSha256, payload });
  }
}

export async function verifyBoundedLivePublicationReceipt(receipt: BoundedLivePublicationReceipt): Promise<void> {
  if (!receipt || typeof receipt !== "object" || receipt.schemaVersion !== BOUNDED_LIVE_PUBLICATION_RECEIPT_SCHEMA_VERSION || receipt.algorithm !== "sha256" || !receipt.payload) throw new Error("Bounded-live publication receipt envelope is invalid");
  const p = receipt.payload, expected = await sha256Canonical(p);
  if (receipt.receiptSha256 !== expected || receipt.receiptId !== `m5livepub:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Bounded-live publication receipt digest is invalid");
  if (p.externallyVisible !== true || p.rawOutputPersisted !== false || p.automaticRetryAllowed !== false || p.automaticRollbackAllowed !== false || p.productionRoutingMutationAllowed !== false || p.candidateOutputExternallyVisible !== (p.selectedRole === "candidate")) throw new Error("Bounded-live publication receipt safety flags are invalid");
  prepareIdentity(p.sideEffectOperationId, "Bounded-live side-effect operationId"); prepareIdentity(p.sideEffectCommitEventId, "Bounded-live side-effect commit eventId");
  if (Date.parse(p.publishedAt) < Date.parse(p.verifiedAt)) throw new Error("Bounded-live publication receipt predates verification");
}

function assertSinkReceipt(receipt: Awaited<ReturnType<BoundedLivePublicationSink["publish"]>>, sinkId: string, idempotencyKey: string, role: BoundedLiveAssignment, outputSha256: string): void { if (!receipt || typeof receipt !== "object" || receipt.sinkId !== sinkId || receipt.idempotencyKey !== idempotencyKey || receipt.selectedRole !== role || receipt.outputSha256 !== outputSha256 || receipt.externallyVisible !== true) throw new Error("Bounded-live publication sink receipt does not match exact requested publication"); prepareIdentity(receipt.publicationReference, "Bounded-live publication reference"); prepareTimestamp(receipt.publishedAt, "Bounded-live publication timestamp"); }
function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/\/+$/, ""); }
function prepareIdentity(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`); const prepared = value.trim(); if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`); if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`); return prepared; }
function prepareSha256(value: unknown, label: string): string { const prepared = prepareIdentity(value, label).toUpperCase(); if (!/^[0-9A-F]{64}$/.test(prepared)) throw new Error(`${label} must be a SHA-256 digest`); return prepared; }
function prepareTimestamp(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`); return new Date(value).toISOString(); }
function containsSecretLikeMaterial(value: string): boolean { return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value) || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value) || /\bghp_[A-Za-z0-9]{20,}\b/.test(value) || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value); }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]").replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]"); }
async function sha256Text(value: string): Promise<string> { if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime"); const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase(); }
async function sha256Canonical(value: unknown): Promise<string> { return sha256Text(stableStringify(value)); }
function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)])); }
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function deepFreeze<T>(value: T): T { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); return value; }
