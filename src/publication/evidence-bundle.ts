import type { EvidenceRecord, RunLedgerRecord, WorkflowRun } from "../control-plane/contracts.js";
import { EvidenceGate } from "../control-plane/run-ledger.js";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1 as const;

export type EvidenceBundleStage = "candidate" | "sealed_terminal";

export interface SourceDiffEvidence {
  readonly repository: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedFiles: readonly string[];
  readonly diffSha256: string;
  readonly diffBytes: number;
  readonly reference?: string;
}

export interface CiEvidence {
  readonly provider: "github";
  readonly workflow: string;
  readonly runId: string;
  readonly commitSha: string;
  readonly conclusion: "success" | "failure" | "cancelled" | "skipped";
  readonly reference: string;
}

export interface EvidenceArtifactDigest {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly reference?: string;
}

export interface EvidenceBundlePayload {
  readonly stage: EvidenceBundleStage;
  readonly runId: string;
  readonly projectId: string;
  readonly riskClass: WorkflowRun["riskClass"];
  readonly workflowAttempt: number;
  readonly taskSha256: string;
  readonly workspaceSha256: string;
  readonly runtimeId: string;
  readonly modelRoute: readonly string[];
  readonly contextCompilerVersion: string;
  readonly skills: readonly string[];
  readonly toolsets: readonly string[];
  readonly policyDecisions: readonly string[];
  readonly approvalIds: readonly string[];
  readonly changeReferences: readonly string[];
  readonly evidence: readonly EvidenceRecord[];
  readonly resourceMetrics: Readonly<Record<string, number>>;
  readonly traceId: string;
  readonly source?: SourceDiffEvidence;
  readonly ci: readonly CiEvidence[];
  readonly artifacts: readonly EvidenceArtifactDigest[];
  readonly candidateDigest?: string;
  readonly runLedgerSha256?: string;
  readonly outcome?: RunLedgerRecord["outcome"];
  readonly failureReasonSha256?: string;
}

export interface EvidenceBundle {
  readonly schemaVersion: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly bundleId: string;
  readonly bundleSha256: string;
  readonly payload: EvidenceBundlePayload;
}

export interface CreateEvidenceBundleCandidateInput {
  readonly run: WorkflowRun;
  readonly task: string;
  readonly runtimeId: string;
  readonly modelRoute: readonly string[];
  readonly contextCompilerVersion: string;
  readonly skills: readonly string[];
  readonly toolsets: readonly string[];
  readonly workspace: string;
  readonly policyDecisions: readonly string[];
  readonly changeReferences: readonly string[];
  readonly evidence: readonly EvidenceRecord[];
  readonly resourceMetrics: Readonly<Record<string, number>>;
  readonly traceId: string;
  readonly source?: SourceDiffEvidence;
  readonly ci?: readonly CiEvidence[];
  readonly artifacts?: readonly EvidenceArtifactDigest[];
}

export interface SealEvidenceBundleInput {
  readonly candidate: EvidenceBundle;
  readonly runLedger: RunLedgerRecord;
  readonly ci?: readonly CiEvidence[];
  readonly artifacts?: readonly EvidenceArtifactDigest[];
}

export interface EvidenceBundleBuilderOptions {
  readonly maxBundleBytes: number;
  readonly maxCiRecords: number;
  readonly maxArtifactDigests: number;
  readonly maxChangedFiles: number;
}

/**
 * Builds a content-addressed publication candidate during workflow publish and
 * later seals the same bundle identity with a terminal Run Ledger digest.
 *
 * Raw task text, workspace paths and source patches are deliberately excluded.
 */
export class EvidenceBundleBuilder {
  private readonly evidenceGate: EvidenceGate;

  constructor(
    private readonly options: EvidenceBundleBuilderOptions,
    evidenceGate = new EvidenceGate(),
  ) {
    assertPositiveInteger(options.maxBundleBytes, "Evidence bundle maxBundleBytes");
    assertPositiveInteger(options.maxCiRecords, "Evidence bundle maxCiRecords");
    assertPositiveInteger(options.maxArtifactDigests, "Evidence bundle maxArtifactDigests");
    assertPositiveInteger(options.maxChangedFiles, "Evidence bundle maxChangedFiles");
    this.evidenceGate = evidenceGate;
  }

  async createCandidate(input: CreateEvidenceBundleCandidateInput): Promise<EvidenceBundle> {
    assertPublishWorkflow(input.run);
    assertNonEmptyString(input.task, "Evidence bundle task");
    assertNonEmptyString(input.runtimeId, "Evidence bundle runtimeId");
    assertNonEmptyString(input.contextCompilerVersion, "Evidence bundle contextCompilerVersion");
    assertNonEmptyString(input.workspace, "Evidence bundle workspace");
    assertNonEmptyString(input.traceId, "Evidence bundle traceId");

    const evidence = prepareEvidence(input.evidence);
    const gate = this.evidenceGate.evaluate(input.run.riskClass, evidence);
    if (!gate.passed) {
      const details = [
        gate.missing.length > 0 ? `missing=${gate.missing.join(",")}` : "",
        gate.failed.length > 0 ? `failed=${gate.failed.join(",")}` : "",
      ].filter(Boolean).join(" ");
      throw new Error(`Evidence bundle candidate rejected by evidence gate for ${input.run.id}: ${details}`);
    }
    if ((input.run.riskClass === "R3" || input.run.riskClass === "R4") && input.run.approvalIds.length === 0) {
      throw new Error(`Evidence bundle candidate for ${input.run.riskClass} requires durable workflow approval`);
    }

    const source = input.source ? prepareSource(input.source, this.options.maxChangedFiles) : undefined;
    const ci = prepareCi(input.ci ?? [], this.options.maxCiRecords, source);
    const artifacts = prepareArtifacts(input.artifacts ?? [], this.options.maxArtifactDigests);
    const taskSha256 = await sha256Text(input.task);
    const workspaceSha256 = await sha256Text(input.workspace);
    const traceId = safeReference(input.traceId, "Evidence bundle traceId");
    const payload: EvidenceBundlePayload = deepFreeze({
      stage: "candidate",
      runId: safeReference(input.run.id, "Evidence bundle runId"),
      projectId: safeReference(input.run.projectId, "Evidence bundle projectId"),
      riskClass: input.run.riskClass,
      workflowAttempt: input.run.attempt,
      taskSha256,
      workspaceSha256,
      runtimeId: safeReference(input.runtimeId, "Evidence bundle runtimeId"),
      modelRoute: normalizeReferences(input.modelRoute, "Evidence bundle modelRoute"),
      contextCompilerVersion: safeReference(input.contextCompilerVersion, "Evidence bundle contextCompilerVersion"),
      skills: normalizeReferences(input.skills, "Evidence bundle skills"),
      toolsets: normalizeReferences(input.toolsets, "Evidence bundle toolsets"),
      policyDecisions: normalizePublishText(input.policyDecisions),
      approvalIds: normalizeReferences(input.run.approvalIds, "Evidence bundle approvalIds"),
      changeReferences: normalizeReferences(input.changeReferences, "Evidence bundle changeReferences"),
      evidence,
      resourceMetrics: prepareMetrics(input.resourceMetrics),
      traceId,
      source,
      ci,
      artifacts,
    });

    return this.wrap(payload);
  }

  async sealTerminal(input: SealEvidenceBundleInput): Promise<EvidenceBundle> {
    await verifyEvidenceBundle(input.candidate, this.options.maxBundleBytes);
    if (input.candidate.payload.stage !== "candidate") {
      throw new Error("Only an evidence bundle candidate can be terminally sealed");
    }
    await assertLedgerMatchesCandidate(input.runLedger, input.candidate.payload);

    const source = input.candidate.payload.source;
    const ci = mergeCi(
      input.candidate.payload.ci,
      prepareCi(input.ci ?? [], this.options.maxCiRecords, source),
      this.options.maxCiRecords,
    );
    const artifacts = mergeArtifacts(
      input.candidate.payload.artifacts,
      prepareArtifacts(input.artifacts ?? [], this.options.maxArtifactDigests),
      this.options.maxArtifactDigests,
    );
    if (input.runLedger.outcome === "succeeded" && ci.some((item) => item.conclusion !== "success")) {
      throw new Error("Succeeded terminal bundle cannot attach non-success CI evidence");
    }

    const runLedgerSha256 = await sha256Canonical(input.runLedger);
    const failureReasonSha256 = input.runLedger.failureReason
      ? await sha256Text(input.runLedger.failureReason)
      : undefined;
    const payload: EvidenceBundlePayload = deepFreeze({
      ...clonePayload(input.candidate.payload),
      stage: "sealed_terminal",
      ci,
      artifacts,
      candidateDigest: input.candidate.bundleSha256,
      runLedgerSha256,
      outcome: input.runLedger.outcome,
      failureReasonSha256,
    });
    const sealed = await this.wrap(payload, input.candidate.bundleId);
    if (sealed.bundleId !== input.candidate.bundleId) {
      throw new Error("Terminal seal changed evidence bundle identity");
    }
    return sealed;
  }

  private async wrap(payload: EvidenceBundlePayload, existingBundleId?: string): Promise<EvidenceBundle> {
    const bundleId = existingBundleId ?? await bundleIdentity(payload.runId, payload.projectId, payload.traceId);
    const bundleSha256 = await sha256Canonical(payload);
    const bundle = deepFreeze({
      schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
      algorithm: "sha256" as const,
      bundleId,
      bundleSha256,
      payload,
    });
    const bytes = utf8ByteLength(stableStringify(bundle));
    if (bytes > this.options.maxBundleBytes) {
      throw new Error(
        `Evidence bundle exceeds maxBundleBytes: runId=${payload.runId} bytes=${bytes} max=${this.options.maxBundleBytes}`,
      );
    }
    return bundle;
  }
}

export async function verifyEvidenceBundle(bundle: EvidenceBundle, maxBundleBytes?: number): Promise<void> {
  if (bundle.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported evidence bundle schema version: ${String(bundle.schemaVersion)}`);
  }
  if (bundle.algorithm !== "sha256") throw new Error("Evidence bundle algorithm must be sha256");
  assertBundlePayload(bundle.payload);
  const expectedId = await bundleIdentity(bundle.payload.runId, bundle.payload.projectId, bundle.payload.traceId);
  if (bundle.bundleId !== expectedId) throw new Error("Evidence bundle identity does not match canonical payload identity");
  const expectedDigest = await sha256Canonical(bundle.payload);
  if (bundle.bundleSha256 !== expectedDigest) throw new Error("Evidence bundle SHA-256 does not match canonical payload");
  if (maxBundleBytes !== undefined) {
    assertPositiveInteger(maxBundleBytes, "Evidence bundle verify maxBundleBytes");
    const bytes = utf8ByteLength(stableStringify(bundle));
    if (bytes > maxBundleBytes) throw new Error(`Evidence bundle exceeds verification byte bound: ${bytes} > ${maxBundleBytes}`);
  }
}

function assertPublishWorkflow(run: WorkflowRun): void {
  if (run.status !== "running" || run.phase !== "publish") {
    throw new Error(`Evidence bundle candidate requires running publish workflow; ${run.id} is ${run.status}/${run.phase}`);
  }
  if (run.riskClass === "R0" || run.riskClass === "R1") {
    throw new Error(`External GitHub publication requires R2-R4 workflow; ${run.id} is ${run.riskClass}`);
  }
  if (!Number.isInteger(run.attempt) || run.attempt < 1) {
    throw new Error(`Evidence bundle workflow attempt must be >= 1 for ${run.id}`);
  }
}

async function assertLedgerMatchesCandidate(record: RunLedgerRecord, payload: EvidenceBundlePayload): Promise<void> {
  if (record.runId !== payload.runId) throw new Error("Run Ledger runId does not match evidence candidate");
  if (record.projectId !== payload.projectId) throw new Error("Run Ledger projectId does not match evidence candidate");
  if (record.riskClass !== payload.riskClass) throw new Error("Run Ledger riskClass does not match evidence candidate");
  if (record.runtimeId !== payload.runtimeId) throw new Error("Run Ledger runtimeId does not match evidence candidate");
  if (record.contextCompilerVersion !== payload.contextCompilerVersion) {
    throw new Error("Run Ledger contextCompilerVersion does not match evidence candidate");
  }
  if (record.traceId !== payload.traceId) throw new Error("Run Ledger traceId does not match evidence candidate");
  if (await sha256Text(record.task) !== payload.taskSha256) throw new Error("Run Ledger task digest does not match evidence candidate");
  if (await sha256Text(record.workspace) !== payload.workspaceSha256) {
    throw new Error("Run Ledger workspace digest does not match evidence candidate");
  }

  const arrays: readonly [string, readonly string[], readonly string[]][] = [
    ["modelRoute", normalizeReferences(record.modelRoute, "Run Ledger modelRoute"), payload.modelRoute],
    ["skills", normalizeReferences(record.skills, "Run Ledger skills"), payload.skills],
    ["toolsets", normalizeReferences(record.toolsets, "Run Ledger toolsets"), payload.toolsets],
    ["approvalIds", normalizeReferences(record.approvalIds, "Run Ledger approvalIds"), payload.approvalIds],
    ["changeReferences", normalizeReferences(record.changeReferences, "Run Ledger changeReferences"), payload.changeReferences],
    ["policyDecisions", normalizePublishText(record.policyDecisions), payload.policyDecisions],
  ];
  for (const [field, actual, expected] of arrays) {
    if (!sameArray(actual, expected)) throw new Error(`Run Ledger ${field} does not match evidence candidate`);
  }
  if (stableStringify(prepareMetrics(record.resourceMetrics)) !== stableStringify(payload.resourceMetrics)) {
    throw new Error("Run Ledger resourceMetrics do not match evidence candidate");
  }

  const ledgerEvidence = prepareEvidence(record.evidence).map(stableStringify);
  for (const item of payload.evidence) {
    if (!ledgerEvidence.includes(stableStringify(item))) {
      throw new Error("Run Ledger is missing evidence contained in the publication candidate");
    }
  }
}

function assertBundlePayload(payload: EvidenceBundlePayload): void {
  if (payload.stage !== "candidate" && payload.stage !== "sealed_terminal") {
    throw new Error("Evidence bundle stage is invalid");
  }
  if (payload.riskClass === "R0" || payload.riskClass === "R1") {
    throw new Error("Evidence bundle publication riskClass must be R2-R4");
  }
  if (!Number.isInteger(payload.workflowAttempt) || payload.workflowAttempt < 1) {
    throw new Error("Evidence bundle workflowAttempt must be >= 1");
  }
  assertSha256(payload.taskSha256, "Evidence bundle taskSha256");
  assertSha256(payload.workspaceSha256, "Evidence bundle workspaceSha256");
  if (payload.stage === "candidate") {
    if (payload.candidateDigest || payload.runLedgerSha256 || payload.outcome || payload.failureReasonSha256) {
      throw new Error("Candidate bundle cannot contain terminal seal fields");
    }
  } else {
    assertSha256(payload.candidateDigest ?? "", "Evidence bundle candidateDigest");
    assertSha256(payload.runLedgerSha256 ?? "", "Evidence bundle runLedgerSha256");
    if (!payload.outcome) throw new Error("Sealed terminal evidence bundle requires outcome");
    if (payload.failureReasonSha256) assertSha256(payload.failureReasonSha256, "Evidence bundle failureReasonSha256");
  }
}

function prepareSource(source: SourceDiffEvidence, maxChangedFiles: number): SourceDiffEvidence {
  const repository = safeReference(source.repository, "Evidence source repository");
  assertGitSha(source.baseSha, "Evidence source baseSha");
  assertGitSha(source.headSha, "Evidence source headSha");
  if (source.baseSha.toLowerCase() === source.headSha.toLowerCase()) {
    throw new Error("Evidence source baseSha and headSha must differ");
  }
  assertSha256(source.diffSha256, "Evidence source diffSha256");
  assertNonNegativeInteger(source.diffBytes, "Evidence source diffBytes");
  const changedFiles = [...new Set(source.changedFiles.map(normalizeGitPath))].sort();
  if (changedFiles.length === 0) throw new Error("Evidence source changedFiles must not be empty");
  if (changedFiles.length > maxChangedFiles) {
    throw new Error(`Evidence source changedFiles exceeds maxChangedFiles: count=${changedFiles.length} max=${maxChangedFiles}`);
  }
  return deepFreeze({
    repository,
    baseSha: source.baseSha.toLowerCase(),
    headSha: source.headSha.toLowerCase(),
    changedFiles,
    diffSha256: source.diffSha256.toUpperCase(),
    diffBytes: source.diffBytes,
    reference: source.reference ? safeReference(source.reference, "Evidence source reference") : undefined,
  });
}

function prepareCi(records: readonly CiEvidence[], maxCiRecords: number, source?: SourceDiffEvidence): readonly CiEvidence[] {
  if (records.length > maxCiRecords) {
    throw new Error(`Evidence CI records exceed maxCiRecords: count=${records.length} max=${maxCiRecords}`);
  }
  const seen = new Set<string>();
  const result = records.map((record, index) => {
    if (record.provider !== "github") throw new Error(`Evidence CI[${index}].provider must be github`);
    assertGitSha(record.commitSha, `Evidence CI[${index}].commitSha`);
    if (!["success", "failure", "cancelled", "skipped"].includes(record.conclusion)) {
      throw new Error(`Evidence CI[${index}].conclusion is invalid`);
    }
    if (source && record.commitSha.toLowerCase() !== source.headSha.toLowerCase()) {
      throw new Error(`Evidence CI[${index}] commitSha does not match source headSha`);
    }
    const prepared: CiEvidence = {
      provider: "github",
      workflow: sanitizePublishText(record.workflow),
      runId: safeReference(record.runId, `Evidence CI[${index}].runId`),
      commitSha: record.commitSha.toLowerCase(),
      conclusion: record.conclusion,
      reference: safeReference(record.reference, `Evidence CI[${index}].reference`),
    };
    const key = `${prepared.provider}:${prepared.runId}`;
    if (seen.has(key)) throw new Error(`Evidence CI contains duplicate run identity: ${key}`);
    seen.add(key);
    return deepFreeze(prepared);
  });
  result.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  return Object.freeze(result);
}

function prepareArtifacts(artifacts: readonly EvidenceArtifactDigest[], max: number): readonly EvidenceArtifactDigest[] {
  if (artifacts.length > max) throw new Error(`Evidence artifact digests exceed maxArtifactDigests: ${artifacts.length} > ${max}`);
  const seen = new Set<string>();
  const result = artifacts.map((artifact, index) => {
    const name = sanitizePublishText(artifact.name).trim();
    assertNonEmptyString(name, `Evidence artifact[${index}].name`);
    assertSha256(artifact.sha256, `Evidence artifact[${index}].sha256`);
    assertNonNegativeInteger(artifact.bytes, `Evidence artifact[${index}].bytes`);
    if (seen.has(name)) throw new Error(`Evidence artifact names must be unique: ${name}`);
    seen.add(name);
    return deepFreeze({
      name,
      sha256: artifact.sha256.toUpperCase(),
      bytes: artifact.bytes,
      reference: artifact.reference ? safeReference(artifact.reference, `Evidence artifact[${index}].reference`) : undefined,
    });
  });
  result.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  return Object.freeze(result);
}

function mergeCi(left: readonly CiEvidence[], right: readonly CiEvidence[], max: number): readonly CiEvidence[] {
  const byId = new Map<string, CiEvidence>();
  for (const item of [...left, ...right]) byId.set(`${item.provider}:${item.runId}`, item);
  if (byId.size > max) throw new Error(`Merged CI evidence exceeds maxCiRecords: ${byId.size} > ${max}`);
  return Object.freeze([...byId.values()].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))));
}

function mergeArtifacts(left: readonly EvidenceArtifactDigest[], right: readonly EvidenceArtifactDigest[], max: number): readonly EvidenceArtifactDigest[] {
  const byName = new Map<string, EvidenceArtifactDigest>();
  for (const item of [...left, ...right]) byName.set(item.name, item);
  if (byName.size > max) throw new Error(`Merged artifact evidence exceeds maxArtifactDigests: ${byName.size} > ${max}`);
  return Object.freeze([...byName.values()].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))));
}

function prepareEvidence(records: readonly EvidenceRecord[]): readonly EvidenceRecord[] {
  const result = records.map((record, index) => {
    if (!Number.isFinite(Date.parse(record.collectedAt))) throw new Error(`Evidence[${index}].collectedAt must be valid`);
    return deepFreeze({
      kind: record.kind,
      status: record.status,
      reference: safeReference(record.reference, `Evidence[${index}].reference`),
      producer: safeReference(record.producer, `Evidence[${index}].producer`),
      collectedAt: record.collectedAt,
      metadata: record.metadata ? sanitizeMetadata(record.metadata) : undefined,
    });
  });
  result.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  return Object.freeze(result);
}

function sanitizeMetadata(metadata: Readonly<Record<string, string | number | boolean | null>>): Readonly<Record<string, string | number | boolean | null>> {
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Evidence metadata ${key} must be finite`);
    output[key] = isSensitiveKey(key) ? "[redacted]" : typeof value === "string" ? sanitizePublishText(value) : value;
  }
  return deepFreeze(output);
}

function prepareMetrics(metrics: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const output: Record<string, number> = {};
  for (const key of Object.keys(metrics).sort()) {
    const value = metrics[key];
    if (!Number.isFinite(value)) throw new Error(`Evidence metric ${key} must be finite`);
    output[key] = value;
  }
  return deepFreeze(output);
}

function normalizePublishText(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => sanitizePublishText(value).trim()))].filter(Boolean).sort());
}

function normalizeReferences(values: readonly string[], label: string): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => safeReference(value, label)))].sort());
}

function safeReference(value: string, label: string): string {
  assertNonEmptyString(value, label);
  const trimmed = value.trim();
  if (sanitizePublishText(trimmed) !== trimmed) {
    throw new Error(`${label} contains secret-like material and cannot be published as an identity reference`);
  }
  return trimmed;
}

function sanitizePublishText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

function isSensitiveKey(key: string): boolean {
  return /authorization|api[_-]?key|access[_-]?token|password|secret|credential/i.test(key);
}

function normalizeGitPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  assertNonEmptyString(normalized, "Evidence source changed file");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Evidence source changed file must be repository-relative: ${value}`);
  }
  return safeReference(normalized, "Evidence source changed file");
}

async function bundleIdentity(runId: string, projectId: string, traceId: string): Promise<string> {
  const digest = await sha256Canonical({ projectId, runId, traceId });
  return `9router-evidence:${runId}:${digest.slice(0, 16).toLowerCase()}`;
}

async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Text(stableStringify(value));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
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

function clonePayload(payload: EvidenceBundlePayload): EvidenceBundlePayload {
  return {
    ...payload,
    modelRoute: [...payload.modelRoute],
    skills: [...payload.skills],
    toolsets: [...payload.toolsets],
    policyDecisions: [...payload.policyDecisions],
    approvalIds: [...payload.approvalIds],
    changeReferences: [...payload.changeReferences],
    evidence: payload.evidence.map((item) => ({ ...item, metadata: item.metadata ? { ...item.metadata } : undefined })),
    resourceMetrics: { ...payload.resourceMetrics },
    source: payload.source ? { ...payload.source, changedFiles: [...payload.source.changedFiles] } : undefined,
    ci: payload.ci.map((item) => ({ ...item })),
    artifacts: payload.artifacts.map((item) => ({ ...item })),
  };
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
}

function assertGitSha(value: string, label: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) throw new Error(`${label} must be a hexadecimal Git object id`);
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} must be a 64-character SHA-256 digest`);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
