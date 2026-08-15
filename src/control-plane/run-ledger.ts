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
    if (!record.runId.trim()) throw new Error("runId must not be empty");
    if (this.records.has(record.runId)) {
      throw new Error(`Run ledger record already exists: ${record.runId}`);
    }
    if (record.outcome === "succeeded") {
      const gate = this.evidenceGate.evaluate(record.riskClass, record.evidence);
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

    this.records.set(record.runId, deepFreeze(cloneRecord(record)));
  }

  get(runId: string): RunLedgerRecord | undefined {
    return this.records.get(runId);
  }

  list(): readonly RunLedgerRecord[] {
    return [...this.records.values()];
  }
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
