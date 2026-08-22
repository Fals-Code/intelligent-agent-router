import type { EvidenceRecord } from "../control-plane/contracts.js";
import type {
  IsolatedRoutingMutationReceipt,
  IsolatedRoutingMutationReceiptPayload,
  JsonFileIsolatedRoutingTarget,
  JsonlRoutingMutationJournal,
  RoutingMutationAuthoritySources,
} from "./isolated-routing-mutation.js";
import {
  verifiedIsolatedRoutingMutationReceiptToEvidence,
  verifyIsolatedRoutingMutationReceipt,
} from "./isolated-routing-mutation.js";

export * from "./runtime-run-integration.js";
export * from "./execution-integrity.js";
export * from "./runtime-backed-shadow-experiment-adapter.js";
export * from "./shadow-provenance-runtime-binding-seal.js";
export * from "./bounded-live-publication.js";
export * from "./bounded-live-reference-restore.js";
export * from "./deferred-bounded-live-execution.js";
export * from "./bounded-live-side-effect-journal.js";
export * from "./runtime-backed-deferred-bounded-live-execution.js";
export * from "./opencode-bounded-live-output-reader.js";
export * from "./isolated-loopback-bounded-live-sink-client.js";
export * from "./isolated-routing-mutation.js";

/**
 * Reconstructs the exact mutation receipt only from a durable recovered commit.
 * This closes the restart boundary without creating a second evidence store: the
 * journal event remains the authority and the current isolated target must still
 * equal the content-addressed after-state before the receipt is returned.
 */
export async function recoverCommittedIsolatedRoutingMutationReceipt(
  authority: RoutingMutationAuthoritySources,
  target: JsonFileIsolatedRoutingTarget,
  journal: JsonlRoutingMutationJournal,
): Promise<IsolatedRoutingMutationReceipt> {
  const authorization = authority.authorization;
  const proposal = authority.proposal;
  const snapshot = authority.preconditionSnapshot;
  const operationId = `routing-mutation:${authorization.authorizationId}`;
  const event = journal.latest(operationId);

  if (!event || event.payload.eventType !== "mutation_committed") {
    throw new Error("Recovered routing mutation evidence requires an exact durable committed journal event");
  }
  if (event.payload.recoveredAfterRestart !== true) {
    throw new Error("Recovered routing mutation evidence requires a restart-reconciled durable commit");
  }

  const current = await target.read();
  const p = event.payload;
  const expectedTargetId = `isolated-router:${authorization.payload.projectId}:${authorization.payload.routeId}`;
  const expectedIdempotencyKey = operationId;

  if (
    p.operationId !== operationId ||
    p.idempotencyKey !== expectedIdempotencyKey ||
    p.targetKind !== "isolated_local_test_router" ||
    p.targetId !== expectedTargetId ||
    p.targetId !== target.descriptor.targetId ||
    p.projectId !== authorization.payload.projectId ||
    p.routeId !== authorization.payload.routeId ||
    p.capability !== authorization.payload.capability ||
    p.authorizationId !== authorization.authorizationId ||
    p.authorizationSha256 !== authorization.authorizationSha256 ||
    p.proposalId !== proposal.proposalId ||
    p.proposalSha256 !== proposal.proposalSha256 ||
    p.preconditionSnapshotId !== snapshot.snapshotId ||
    p.preconditionSnapshotSha256 !== snapshot.snapshotSha256 ||
    p.beforeSubjectId !== proposal.payload.referenceSubjectId ||
    p.afterSubjectId !== proposal.payload.candidateSubjectId ||
    p.beforeRouteRevision !== snapshot.payload.routeRevision ||
    current.payload.targetKind !== "isolated_local_test_router" ||
    current.payload.productionRouter !== false ||
    current.payload.targetId !== p.targetId ||
    current.payload.projectId !== p.projectId ||
    current.payload.routeId !== p.routeId ||
    current.payload.capability !== p.capability ||
    current.stateId !== p.afterStateId ||
    current.stateSha256 !== p.afterStateSha256 ||
    current.payload.currentSubjectId !== p.afterSubjectId ||
    current.payload.routeRevision !== p.afterRouteRevision
  ) {
    throw new Error("Recovered routing mutation durable commit is not bound to the exact authorization/proposal/precondition/target state");
  }

  const payload: IsolatedRoutingMutationReceiptPayload = Object.freeze({
    operationId: p.operationId,
    idempotencyKey: p.idempotencyKey,
    authorizationId: p.authorizationId,
    authorizationSha256: p.authorizationSha256,
    proposalId: p.proposalId,
    proposalSha256: p.proposalSha256,
    preconditionSnapshotId: p.preconditionSnapshotId,
    preconditionSnapshotSha256: p.preconditionSnapshotSha256,
    targetKind: "isolated_local_test_router" as const,
    targetId: p.targetId,
    projectId: p.projectId,
    routeId: p.routeId,
    capability: p.capability,
    beforeStateId: p.beforeStateId,
    beforeStateSha256: p.beforeStateSha256,
    afterStateId: p.afterStateId,
    afterStateSha256: p.afterStateSha256,
    beforeSubjectId: p.beforeSubjectId,
    afterSubjectId: p.afterSubjectId,
    beforeRouteRevision: p.beforeRouteRevision,
    afterRouteRevision: p.afterRouteRevision,
    mutationJournalCommitEventId: event.eventId,
    mutationJournalCommitEventSha256: event.eventSha256,
    committedAt: p.committedAt,
    recoveredAfterRestart: true,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    productionRoutingMutationAllowed: false,
  });
  const receiptSha256 = await sha256Canonical(payload);
  const receipt: IsolatedRoutingMutationReceipt = Object.freeze({
    schemaVersion: 1,
    algorithm: "sha256" as const,
    receiptId: `m5routemutation:${receiptSha256.slice(0, 32).toLowerCase()}`,
    receiptSha256,
    payload,
  });

  await verifyIsolatedRoutingMutationReceipt(receipt, authority, target, journal);
  return receipt;
}

/**
 * Converts only a context-bound restart-recovered receipt into canonical
 * EvidenceRecord form. A recovery report by itself is intentionally insufficient.
 */
export async function recoveredIsolatedRoutingMutationToEvidence(
  authority: RoutingMutationAuthoritySources,
  target: JsonFileIsolatedRoutingTarget,
  journal: JsonlRoutingMutationJournal,
  collectedAt: string,
): Promise<EvidenceRecord> {
  const receipt = await recoverCommittedIsolatedRoutingMutationReceipt(authority, target, journal);
  return verifiedIsolatedRoutingMutationReceiptToEvidence(
    receipt,
    authority,
    target,
    journal,
    collectedAt,
  );
}

async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sortJson(value))),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
