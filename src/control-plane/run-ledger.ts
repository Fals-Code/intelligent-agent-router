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
import type {
  EvidenceKind,
  EvidenceRecord,
  RiskClass,
  RunLedgerRecord,
} from "./contracts.js";

export type EvidenceRequirements = Readonly<Record<RiskClass, readonly EvidenceKind[]>>;

export const DEFAULT_EVIDENCE_REQUIREMENTS: EvidenceRequirements = {
  R0: ["policy"],
  R1: ["policy", "isolation", "deterministic_check"],
  R2: ["policy", "test", "review"],
  R3: ["policy", "isolation", "test", "independent_review", "approval"],
  R4: ["policy", "isolation", "approval", "backup", "rollback"],
};

export const RUN_LEDGER_SCHEMA_VERSION = 1 as const;

export interface EvidenceGateResult {
  readonly passed: boolean;
  readonly required: readonly EvidenceKind[];
  readonly missing: readonly EvidenceKind[];
  readonly failed: readonly EvidenceKind[];
}

export class EvidenceGate {
  constructor(private readonly requirements: EvidenceRequirements = DEFAULT_EVIDENCE_REQUIREMENTS) {}

  evaluate(riskClass: RiskClass, evidence: readonly EvidenceRecord[]): EvidenceGateResult {
    const required = this.requirements[riskClass];
    const missing: EvidenceKind[] = [];
    const failed: EvidenceKind[] = [];

    for (const kind of required) {
      const records = evidence.filter((item) => item.kind === kind);
      if (records.length === 0) {
        missing.push(kind);
        continue;
      }
      if (!records.some((item) => item.status === "passed")) failed.push(kind);
    }

    return {
      passed: missing.length === 0 && failed.length === 0,
      required: [...required],
      missing,
      failed,
    };
  }
}

export interface RunLedger {
  append(record: RunLedgerRecord): void;
  get(runId: string): RunLedgerRecord | undefined;
  list(): readonly RunLedgerRecord[];
}

export class InMemoryRunLedger implements RunLedger {
  private readonly records = new Map<string, RunLedgerRecord>();

  constructor(private readonly evidenceGate = new EvidenceGate()) {}

  append(record: RunLedgerRecord): void {
    const prepared = prepareRecord(record, this.records, this.evidenceGate);
    this.records.set(prepared.runId, prepared);
  }

  get(runId: string): RunLedgerRecord | undefined {
    return this.records.get(runId);
  }

  list(): readonly RunLedgerRecord[] {
    return [...this.records.values()];
  }
}

export interface JsonlRunLedgerOptions {
  readonly filePath: string;
  readonly evidenceGate?: EvidenceGate;
}

/**
 * Local, single-writer durable Run Ledger.
 *
 * Records are stored as versioned JSON Lines. Each successful append is fsync'd
 * before it becomes visible through this instance. Startup reload is fail-closed:
 * malformed JSON, unsupported schema versions, truncated final writes, duplicate
 * run IDs, or evidence-invalid successful runs reject the ledger instead of being
 * silently skipped.
 *
 * This class deliberately does not coordinate multiple concurrent processes.
 * It detects file-size drift observed before an append and requires the caller to
 * reopen the ledger. Shared/multi-process persistence remains a separate backend.
 */
export class JsonlRunLedger implements RunLedger {
  readonly filePath: string;
  private readonly records = new Map<string, RunLedgerRecord>();
  private readonly evidenceGate: EvidenceGate;
  private expectedFileSize = 0;

  constructor(options: JsonlRunLedgerOptions) {
    if (!options.filePath.trim()) throw new Error("Run ledger filePath must not be empty");
    this.filePath = resolve(options.filePath);
    this.evidenceGate = options.evidenceGate ?? new EvidenceGate();
    mkdirSync(resolve(this.filePath, ".."), { recursive: true });
    this.load();
  }

  append(record: RunLedgerRecord): void {
    this.assertStorageUnchanged();
    const prepared = prepareRecord(record, this.records, this.evidenceGate);
    const line = `${JSON.stringify({ schemaVersion: RUN_LEDGER_SCHEMA_VERSION, record: prepared })}\n`;
    const handle = openSync(this.filePath, "a", 0o600);

    try {
      writeFileSync(handle, line, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    this.expectedFileSize += utf8ByteLength(line);
    this.records.set(prepared.runId, prepared);
  }

  get(runId: string): RunLedgerRecord | undefined {
    return this.records.get(runId);
  }

  list(): readonly RunLedgerRecord[] {
    return [...this.records.values()];
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf8");
    this.expectedFileSize = utf8ByteLength(raw);
    if (raw.length === 0) return;
    if (!raw.endsWith("\n")) {
      throw new Error(`Run ledger is not newline-terminated; possible partial write: ${this.filePath}`);
    }

    const lines = raw.slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      if (!line.trim()) throw new Error(`Run ledger contains an empty record at line ${lineNumber}`);
      const record = parsePersistedEntry(line, lineNumber);
      const prepared = prepareRecord(record, this.records, this.evidenceGate);
      this.records.set(prepared.runId, prepared);
    }
  }

  private assertStorageUnchanged(): void {
    const currentSize = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (currentSize !== this.expectedFileSize) {
      throw new Error(
        `Run ledger changed outside this writer; reopen before appending: expectedBytes=${this.expectedFileSize} actualBytes=${currentSize}`,
      );
    }
  }
}

function prepareRecord(
  record: RunLedgerRecord,
  records: ReadonlyMap<string, RunLedgerRecord>,
  evidenceGate: EvidenceGate,
): RunLedgerRecord {
  assertRunLedgerRecord(record, "Run ledger record");
  if (records.has(record.runId)) {
    throw new Error(`Run ledger record already exists: ${record.runId}`);
  }
  if (record.outcome === "succeeded") {
    const gate = evidenceGate.evaluate(record.riskClass, record.evidence);
    if (!gate.passed) {
      const details = [
        gate.missing.length > 0 ? `missing=${gate.missing.join(",")}` : "",
        gate.failed.length > 0 ? `failed=${gate.failed.join(",")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      throw new Error(`Evidence gate rejected successful run ${record.runId}: ${details}`);
    }
  }

  return deepFreeze(cloneRecord(record));
}

function parsePersistedEntry(line: string, lineNumber: number): RunLedgerRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Run ledger contains invalid JSON at line ${lineNumber}: ${safeErrorMessage(error)}`);
  }

  if (!isRecord(value)) throw new Error(`Run ledger entry at line ${lineNumber} must be an object`);
  if (value.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported run ledger schema version at line ${lineNumber}: ${String(value.schemaVersion)}`,
    );
  }
  assertRunLedgerRecord(value.record, `Run ledger entry at line ${lineNumber}`);
  return value.record;
}

function assertRunLedgerRecord(value: unknown, label: string): asserts value is RunLedgerRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);

  for (const field of ["runId", "projectId", "task", "runtimeId", "contextCompilerVersion", "workspace", "traceId", "createdAt"] as const) {
    assertNonEmptyString(value[field], `${label}.${field}`);
  }

  if (!["R0", "R1", "R2", "R3", "R4"].includes(String(value.riskClass))) {
    throw new Error(`${label}.riskClass is invalid`);
  }
  if (!["failed", "cancelled", "succeeded"].includes(String(value.outcome))) {
    throw new Error(`${label}.outcome is invalid`);
  }
  if (value.failureReason !== undefined && typeof value.failureReason !== "string") {
    throw new Error(`${label}.failureReason must be a string when present`);
  }

  for (const field of ["modelRoute", "skills", "toolsets", "policyDecisions", "approvalIds", "changeReferences"] as const) {
    assertStringArray(value[field], `${label}.${field}`);
  }

  if (!Array.isArray(value.evidence)) throw new Error(`${label}.evidence must be an array`);
  value.evidence.forEach((item, index) => assertEvidenceRecord(item, `${label}.evidence[${index}]`));

  if (!isRecord(value.resourceMetrics)) throw new Error(`${label}.resourceMetrics must be an object`);
  for (const [key, metric] of Object.entries(value.resourceMetrics)) {
    if (typeof metric !== "number" || !Number.isFinite(metric)) {
      throw new Error(`${label}.resourceMetrics.${key} must be a finite number`);
    }
  }
}

function assertEvidenceRecord(value: unknown, label: string): asserts value is EvidenceRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (![
    "policy",
    "isolation",
    "deterministic_check",
    "test",
    "browser",
    "review",
    "independent_review",
    "approval",
    "backup",
    "rollback",
    "other",
  ].includes(String(value.kind))) {
    throw new Error(`${label}.kind is invalid`);
  }
  if (!["passed", "failed", "not_applicable"].includes(String(value.status))) {
    throw new Error(`${label}.status is invalid`);
  }
  for (const field of ["reference", "producer", "collectedAt"] as const) {
    assertNonEmptyString(value[field], `${label}.${field}`);
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) throw new Error(`${label}.metadata must be an object when present`);
    for (const [key, metadataValue] of Object.entries(value.metadata)) {
      if (
        metadataValue !== null &&
        typeof metadataValue !== "string" &&
        typeof metadataValue !== "number" &&
        typeof metadataValue !== "boolean"
      ) {
        throw new Error(`${label}.metadata.${key} must be a scalar value`);
      }
    }
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneRecord(record: RunLedgerRecord): RunLedgerRecord {
  return {
    ...record,
    modelRoute: [...record.modelRoute],
    skills: [...record.skills],
    toolsets: [...record.toolsets],
    policyDecisions: [...record.policyDecisions],
    approvalIds: [...record.approvalIds],
    changeReferences: [...record.changeReferences],
    evidence: record.evidence.map((item) => ({
      ...item,
      metadata: item.metadata ? { ...item.metadata } : undefined,
    })),
    resourceMetrics: { ...record.resourceMetrics },
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
