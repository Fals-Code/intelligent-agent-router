import type { EvidenceRecord, RiskClass, RunLedgerRecord } from "../control-plane/contracts.js";
import { InMemoryRunLedger } from "../control-plane/run-ledger.js";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1 as const;

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

export interface EvidenceBundle {
  readonly schemaVersion: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION;
  readonly bundleId: string;
  readonly bundleSha256: string;
  readonly sealedAt: string;
  readonly runId: string;
  readonly projectId: string;
  readonly riskClass: RiskClass;
  readonly outcome: RunLedgerRecord["outcome"];
  readonly traceId: string;
  readonly runLedgerSha256: string;
  readonly runLedger: RunLedgerRecord;
  readonly verificationEvidence: readonly EvidenceRecord[];
  readonly approvalIds: readonly string[];
  readonly approvalEvidence: readonly EvidenceRecord[];
  readonly source?: SourceDiffEvidence;
  readonly ci: readonly CiEvidence[];
  readonly artifacts: readonly EvidenceArtifactDigest[];
}

export interface EvidenceBundleBuilderOptions {
  readonly maxBundleBytes: number;
  readonly maxCiRecords: number;
  readonly maxArtifactDigests: number;
  readonly maxChangedFiles: number;
  readonly now?: () => string;
}

export interface BuildEvidenceBundleInput {
  readonly runLedger: RunLedgerRecord;
  readonly source?: SourceDiffEvidence;
  readonly ci?: readonly CiEvidence[];
  readonly artifacts?: readonly EvidenceArtifactDigest[];
}

/**
 * Builds a bounded, sanitized, immutable publication snapshot from an existing
 * terminal Run Ledger record. Raw source patches are intentionally not part of
 * this contract; source changes are represented by identity, file scope and a
 * SHA-256 digest.
 */
export class EvidenceBundleBuilder {
  private readonly now: () => string;

  constructor(private readonly options: EvidenceBundleBuilderOptions) {
    assertPositiveInteger(options.maxBundleBytes, "Evidence bundle maxBundleBytes");
    assertPositiveInteger(options.maxCiRecords, "Evidence bundle maxCiRecords");
    assertPositiveInteger(options.maxArtifactDigests, "Evidence bundle maxArtifactDigests");
    assertPositiveInteger(options.maxChangedFiles, "Evidence bundle maxChangedFiles");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async build(input: BuildEvidenceBundleInput): Promise<EvidenceBundle> {
    const canonicalLedger = validateCanonicalLedger(input.runLedger);
    const sealedAt = this.now();
    assertTimestamp(sealedAt, "Evidence bundle sealedAt");

    const source = input.source ? prepareSource(input.source, this.options.maxChangedFiles) : undefined;
    const ci = prepareCi(input.ci ?? [], this.options.maxCiRecords, source);
    const artifacts = prepareArtifacts(input.artifacts ?? [], this.options.maxArtifactDigests);
    const sanitizedLedger = sanitizeRunLedger(canonicalLedger);
    const runLedgerSha256 = await sha256Canonical(canonicalLedger);

    const verificationEvidence = sanitizedLedger.evidence.filter(
      (item) =>
        item.kind === "deterministic_check" ||
        (item.kind === "other" && item.producer.startsWith("runtime-reconciliation:")),
    );
    const approvalEvidence = sanitizedLedger.evidence.filter((item) => item.kind === "approval");

    const unsigned = {
      schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
      sealedAt,
      runId: sanitizedLedger.runId,
      projectId: sanitizedLedger.projectId,
      riskClass: sanitizedLedger.riskClass,
      outcome: sanitizedLedger.outcome,
      traceId: sanitizedLedger.traceId,
      runLedgerSha256,
      runLedger: sanitizedLedger,
      verificationEvidence,
      approvalIds: [...sanitizedLedger.approvalIds],
      approvalEvidence,
      source,
      ci,
      artifacts,
    } as const;

    const bundleSha256 = await sha256Canonical(unsigned);
    const bundle: EvidenceBundle = deepFreeze({
      ...unsigned,
      bundleId: `9router-evidence:${sanitizedLedger.runId}:${bundleSha256.slice(0, 16).toLowerCase()}`,
      bundleSha256,
    });

    const bundleBytes = utf8ByteLength(stableStringify(bundle));
    if (bundleBytes > this.options.maxBundleBytes) {
      throw new Error(
        `Evidence bundle exceeds maxBundleBytes: runId=${bundle.runId} bytes=${bundleBytes} max=${this.options.maxBundleBytes}`,
      );
    }
    return bundle;
  }
}

function validateCanonicalLedger(record: RunLedgerRecord): RunLedgerRecord {
  const ledger = new InMemoryRunLedger();
  ledger.append(record);
  const prepared = ledger.get(record.runId);
  if (!prepared) throw new Error(`Evidence bundle could not validate Run Ledger record ${record.runId}`);
  return prepared;
}

function prepareSource(source: SourceDiffEvidence, maxChangedFiles: number): SourceDiffEvidence {
  assertNonEmptyString(source.repository, "Evidence source repository");
  assertGitSha(source.baseSha, "Evidence source baseSha");
  assertGitSha(source.headSha, "Evidence source headSha");
  if (source.baseSha.toLowerCase() === source.headSha.toLowerCase()) {
    throw new Error("Evidence source baseSha and headSha must differ");
  }
  assertSha256(source.diffSha256, "Evidence source diffSha256");
  assertNonNegativeInteger(source.diffBytes, "Evidence source diffBytes");
  if (!Array.isArray(source.changedFiles) || source.changedFiles.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Evidence source changedFiles must contain non-empty strings");
  }
  const changedFiles = [...new Set(source.changedFiles.map((item) => sanitizeText(item.trim())))].sort();
  if (changedFiles.length > maxChangedFiles) {
    throw new Error(`Evidence source changedFiles exceeds maxChangedFiles: count=${changedFiles.length} max=${maxChangedFiles}`);
  }
  if (source.reference !== undefined) assertNonEmptyString(source.reference, "Evidence source reference");
  return deepFreeze({
    repository: sanitizeText(source.repository.trim()),
    baseSha: source.baseSha.toLowerCase(),
    headSha: source.headSha.toLowerCase(),
    changedFiles,
    diffSha256: source.diffSha256.toUpperCase(),
    diffBytes: source.diffBytes,
    reference: source.reference ? sanitizeText(source.reference) : undefined,
  });
}

function prepareCi(
  records: readonly CiEvidence[],
  maxCiRecords: number,
  source: SourceDiffEvidence | undefined,
): readonly CiEvidence[] {
  if (records.length > maxCiRecords) {
    throw new Error(`Evidence CI records exceed maxCiRecords: count=${records.length} max=${maxCiRecords}`);
  }
  const seen = new Set<string>();
  return deepFreeze(records.map((record, index) => {
    if (record.provider !== "github") throw new Error(`Evidence CI[${index}].provider must be github`);
    assertNonEmptyString(record.workflow, `Evidence CI[${index}].workflow`);
    assertNonEmptyString(record.runId, `Evidence CI[${index}].runId`);
    assertGitSha(record.commitSha, `Evidence CI[${index}].commitSha`);
    if (!["success", "failure", "cancelled", "skipped"].includes(record.conclusion)) {
      throw new Error(`Evidence CI[${index}].conclusion is invalid`);
    }
    assertNonEmptyString(record.reference, `Evidence CI[${index}].reference`);
    if (source && record.commitSha.toLowerCase() !== source.headSha.toLowerCase()) {
      throw new Error(
        `Evidence CI[${index}] commitSha does not match source headSha: ci=${record.commitSha} source=${source.headSha}`,
      );
    }
    const key = `${record.provider}:${record.runId}`;
    if (seen.has(key)) throw new Error(`Evidence CI contains duplicate run identity: ${key}`);
    seen.add(key);
    return {
      provider: "github" as const,
      workflow: sanitizeText(record.workflow),
      runId: sanitizeText(record.runId),
      commitSha: record.commitSha.toLowerCase(),
      conclusion: record.conclusion,
      reference: sanitizeText(record.reference),
    };
  }));
}

function prepareArtifacts(
  artifacts: readonly EvidenceArtifactDigest[],
  maxArtifactDigests: number,
): readonly EvidenceArtifactDigest[] {
  if (artifacts.length > maxArtifactDigests) {
    throw new Error(
      `Evidence artifact digests exceed maxArtifactDigests: count=${artifacts.length} max=${maxArtifactDigests}`,
    );
  }
  const seen = new Set<string>();
  return deepFreeze(artifacts.map((artifact, index) => {
    assertNonEmptyString(artifact.name, `Evidence artifact[${index}].name`);
    assertSha256(artifact.sha256, `Evidence artifact[${index}].sha256`);
    assertNonNegativeInteger(artifact.bytes, `Evidence artifact[${index}].bytes`);
    if (artifact.reference !== undefined) assertNonEmptyString(artifact.reference, `Evidence artifact[${index}].reference`);
    const name = sanitizeText(artifact.name.trim());
    if (seen.has(name)) throw new Error(`Evidence artifact names must be unique: ${name}`);
    seen.add(name);
    return {
      name,
      sha256: artifact.sha256.toUpperCase(),
      bytes: artifact.bytes,
      reference: artifact.reference ? sanitizeText(artifact.reference) : undefined,
    };
  }));
}

function sanitizeRunLedger(record: RunLedgerRecord): RunLedgerRecord {
  return deepFreeze({
    ...record,
    runId: sanitizeText(record.runId),
    projectId: sanitizeText(record.projectId),
    task: sanitizeText(record.task),
    runtimeId: sanitizeText(record.runtimeId),
    modelRoute: record.modelRoute.map(sanitizeText),
    contextCompilerVersion: sanitizeText(record.contextCompilerVersion),
    skills: record.skills.map(sanitizeText),
    toolsets: record.toolsets.map(sanitizeText),
    workspace: sanitizeText(record.workspace),
    policyDecisions: record.policyDecisions.map(sanitizeText),
    approvalIds: record.approvalIds.map(sanitizeText),
    changeReferences: record.changeReferences.map(sanitizeText),
    evidence: record.evidence.map((item) => sanitizeEvidence(item)),
    resourceMetrics: { ...record.resourceMetrics },
    traceId: sanitizeText(record.traceId),
    failureReason: record.failureReason ? sanitizeText(record.failureReason) : undefined,
    createdAt: record.createdAt,
  });
}

function sanitizeEvidence(record: EvidenceRecord): EvidenceRecord {
  return deepFreeze({
    ...record,
    reference: sanitizeText(record.reference),
    producer: sanitizeText(record.producer),
    metadata: record.metadata
      ? Object.fromEntries(
          Object.entries(record.metadata).map(([key, value]) => [
            sanitizeText(key),
            typeof value === "string" ? sanitizeText(value) : value,
          ]),
        )
      : undefined,
  });
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]",
    );
}

async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
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

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
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
