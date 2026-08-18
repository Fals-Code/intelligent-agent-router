import type { RoutingDecision } from "../domain/types.js";
import type {
  GoldenAssertionKind,
  GoldenTaskAssertionDefinition,
  GoldenTaskSuite,
} from "./golden-task.js";

export const ROUTING_EVAL_REPORT_SCHEMA_VERSION = 1 as const;
export const EVAL_BASELINE_SCHEMA_VERSION = 1 as const;

export interface RoutingEvalSubject {
  readonly id: string;
  route(prompt: string): Promise<RoutingDecision>;
}

export interface RoutingEvalActual {
  readonly primaryModel: string;
  readonly selectedSkills: readonly string[];
  readonly requiresVerification: boolean;
}

export interface RoutingEvalAssertionResult {
  readonly id: string;
  readonly kind: GoldenAssertionKind;
  readonly weight: number;
  readonly passed: boolean;
  readonly expected: string | readonly string[] | boolean;
  readonly actual: string | readonly string[] | boolean;
}

export interface RoutingEvalTaskResult {
  readonly taskId: string;
  readonly critical: boolean;
  readonly score: number;
  readonly passed: boolean;
  readonly actual: RoutingEvalActual;
  readonly assertions: readonly RoutingEvalAssertionResult[];
}

export interface RoutingEvalMetrics {
  readonly weightedScore: number;
  readonly taskPassRate: number;
  readonly criticalPassRate: number;
  readonly passedTasks: number;
  readonly failedTasks: number;
  readonly totalTasks: number;
}

export interface RoutingEvalReportPayload {
  readonly suiteId: string;
  readonly suiteSha256: string;
  readonly subjectId: string;
  readonly tasks: readonly RoutingEvalTaskResult[];
  readonly metrics: RoutingEvalMetrics;
}

export interface RoutingEvalReport {
  readonly schemaVersion: typeof ROUTING_EVAL_REPORT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly reportId: string;
  readonly reportSha256: string;
  readonly payload: RoutingEvalReportPayload;
}

export interface RoutingEvalPlaneOptions {
  readonly maxReportBytes: number;
  readonly maxSubjectIdBytes: number;
}

export interface EvalBaselineDefinition {
  readonly schemaVersion: typeof EVAL_BASELINE_SCHEMA_VERSION;
  readonly baselineId: string;
  readonly suiteId: string;
  readonly suiteSha256: string;
  readonly subjectId: string;
  readonly minimumWeightedScore: number;
  readonly minimumTaskPassRate: number;
  readonly minimumCriticalPassRate: number;
  readonly maximumFailedTasks: number;
}

export interface EvalBaselineComparison {
  readonly baselineId: string;
  readonly reportId: string;
  readonly passed: boolean;
  readonly regressions: readonly string[];
}

const BASELINE_FIELDS = new Set([
  "schemaVersion",
  "baselineId",
  "suiteId",
  "suiteSha256",
  "subjectId",
  "minimumWeightedScore",
  "minimumTaskPassRate",
  "minimumCriticalPassRate",
  "maximumFailedTasks",
]);

export class RoutingEvalPlane {
  constructor(private readonly options: RoutingEvalPlaneOptions) {
    assertPositiveInteger(options.maxReportBytes, "Eval maxReportBytes");
    assertPositiveInteger(options.maxSubjectIdBytes, "Eval maxSubjectIdBytes");
  }

  async evaluate(suite: GoldenTaskSuite, subject: RoutingEvalSubject): Promise<RoutingEvalReport> {
    const subjectId = prepareIdentity(subject.id, "Eval subjectId", this.options.maxSubjectIdBytes);
    const taskResults: RoutingEvalTaskResult[] = [];
    let earnedWeight = 0;
    let totalWeight = 0;

    for (const task of suite.tasks) {
      const decision = await subject.route(task.prompt);
      const actual = normalizeActual(decision);
      const assertions = task.assertions.map((assertion) => evaluateAssertion(assertion, actual));
      const taskTotalWeight = assertions.reduce((sum, item) => sum + item.weight, 0);
      const taskEarnedWeight = assertions.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0);
      const score = taskTotalWeight === 0 ? 0 : taskEarnedWeight / taskTotalWeight;
      earnedWeight += taskEarnedWeight;
      totalWeight += taskTotalWeight;
      taskResults.push(deepFreeze({
        taskId: task.id,
        critical: task.critical,
        score,
        passed: score >= task.minimumScore,
        actual,
        assertions,
      }));
    }

    const passedTasks = taskResults.filter((task) => task.passed).length;
    const criticalTasks = taskResults.filter((task) => task.critical);
    const passedCriticalTasks = criticalTasks.filter((task) => task.passed).length;
    const metrics: RoutingEvalMetrics = deepFreeze({
      weightedScore: totalWeight === 0 ? 0 : earnedWeight / totalWeight,
      taskPassRate: taskResults.length === 0 ? 0 : passedTasks / taskResults.length,
      criticalPassRate: criticalTasks.length === 0 ? 1 : passedCriticalTasks / criticalTasks.length,
      passedTasks,
      failedTasks: taskResults.length - passedTasks,
      totalTasks: taskResults.length,
    });

    const payload: RoutingEvalReportPayload = deepFreeze({
      suiteId: suite.suiteId,
      suiteSha256: suite.suiteSha256,
      subjectId,
      tasks: taskResults,
      metrics,
    });
    const reportSha256 = await sha256Canonical(payload);
    const report: RoutingEvalReport = deepFreeze({
      schemaVersion: ROUTING_EVAL_REPORT_SCHEMA_VERSION,
      algorithm: "sha256" as const,
      reportId: `eval:${reportSha256.slice(0, 32).toLowerCase()}`,
      reportSha256,
      payload,
    });
    assertReportBytes(report, this.options.maxReportBytes);
    return report;
  }

  async compare(report: RoutingEvalReport, baseline: EvalBaselineDefinition): Promise<EvalBaselineComparison> {
    await verifyRoutingEvalReport(report, this.options.maxReportBytes, this.options.maxSubjectIdBytes);
    const preparedBaseline = prepareEvalBaseline(baseline, this.options.maxSubjectIdBytes);
    if (preparedBaseline.suiteId !== report.payload.suiteId) {
      throw new Error(`Eval baseline suiteId mismatch: baseline=${preparedBaseline.suiteId} report=${report.payload.suiteId}`);
    }
    if (preparedBaseline.suiteSha256 !== report.payload.suiteSha256) {
      throw new Error("Eval baseline suiteSha256 does not match evaluated golden suite");
    }
    if (preparedBaseline.subjectId !== report.payload.subjectId) {
      throw new Error(`Eval baseline subjectId mismatch: baseline=${preparedBaseline.subjectId} report=${report.payload.subjectId}`);
    }

    const regressions: string[] = [];
    const metrics = report.payload.metrics;
    if (metrics.weightedScore < preparedBaseline.minimumWeightedScore) {
      regressions.push(`weightedScore ${formatScore(metrics.weightedScore)} < ${formatScore(preparedBaseline.minimumWeightedScore)}`);
    }
    if (metrics.taskPassRate < preparedBaseline.minimumTaskPassRate) {
      regressions.push(`taskPassRate ${formatScore(metrics.taskPassRate)} < ${formatScore(preparedBaseline.minimumTaskPassRate)}`);
    }
    if (metrics.criticalPassRate < preparedBaseline.minimumCriticalPassRate) {
      regressions.push(`criticalPassRate ${formatScore(metrics.criticalPassRate)} < ${formatScore(preparedBaseline.minimumCriticalPassRate)}`);
    }
    if (metrics.failedTasks > preparedBaseline.maximumFailedTasks) {
      regressions.push(`failedTasks ${metrics.failedTasks} > ${preparedBaseline.maximumFailedTasks}`);
    }
    return deepFreeze({
      baselineId: preparedBaseline.baselineId,
      reportId: report.reportId,
      passed: regressions.length === 0,
      regressions,
    });
  }
}

export function prepareEvalBaseline(input: unknown, maxStringBytes = 2048): EvalBaselineDefinition {
  assertPositiveInteger(maxStringBytes, "Eval baseline maxStringBytes");
  if (!isRecord(input)) throw new Error("Eval baseline must be an object");
  assertExactFields(input, BASELINE_FIELDS, "Eval baseline");
  if (input.schemaVersion !== EVAL_BASELINE_SCHEMA_VERSION) {
    throw new Error(`Unsupported eval baseline schema version: ${String(input.schemaVersion)}`);
  }
  const suiteSha256 = prepareIdentity(input.suiteSha256, "Eval baseline suiteSha256", maxStringBytes).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(suiteSha256)) throw new Error("Eval baseline suiteSha256 must be a SHA-256 digest");
  const maximumFailedTasks = Number(input.maximumFailedTasks);
  if (!Number.isInteger(maximumFailedTasks) || maximumFailedTasks < 0) {
    throw new Error("Eval baseline maximumFailedTasks must be a non-negative integer");
  }
  return deepFreeze({
    schemaVersion: EVAL_BASELINE_SCHEMA_VERSION,
    baselineId: prepareIdentity(input.baselineId, "Eval baselineId", maxStringBytes),
    suiteId: prepareIdentity(input.suiteId, "Eval baseline suiteId", maxStringBytes),
    suiteSha256,
    subjectId: prepareIdentity(input.subjectId, "Eval baseline subjectId", maxStringBytes),
    minimumWeightedScore: prepareScore(input.minimumWeightedScore, "Eval baseline minimumWeightedScore"),
    minimumTaskPassRate: prepareScore(input.minimumTaskPassRate, "Eval baseline minimumTaskPassRate"),
    minimumCriticalPassRate: prepareScore(input.minimumCriticalPassRate, "Eval baseline minimumCriticalPassRate"),
    maximumFailedTasks,
  });
}

export async function verifyRoutingEvalReport(
  report: RoutingEvalReport,
  maxReportBytes = Number.MAX_SAFE_INTEGER,
  maxSubjectIdBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  if (!isRecord(report)) throw new Error("Routing eval report must be an object");
  if (report.schemaVersion !== ROUTING_EVAL_REPORT_SCHEMA_VERSION) throw new Error("Unsupported routing eval report schema version");
  if (report.algorithm !== "sha256") throw new Error("Routing eval report algorithm must be sha256");
  prepareIdentity(report.payload.subjectId, "Eval report subjectId", maxSubjectIdBytes);
  if (!/^[0-9A-F]{64}$/.test(report.payload.suiteSha256)) throw new Error("Eval report suiteSha256 must be a SHA-256 digest");
  const expectedSha = await sha256Canonical(report.payload);
  if (report.reportSha256 !== expectedSha) throw new Error("Routing eval report digest does not match canonical payload");
  const expectedId = `eval:${expectedSha.slice(0, 32).toLowerCase()}`;
  if (report.reportId !== expectedId) throw new Error("Routing eval reportId does not match canonical payload");
  assertReportBytes(report, maxReportBytes);
}

function normalizeActual(decision: RoutingDecision): RoutingEvalActual {
  const selectedSkills = [...new Set(decision.selectedSkills.map((item) => item.candidate.id))].sort();
  return deepFreeze({
    primaryModel: decision.primaryModel.candidate.id,
    selectedSkills,
    requiresVerification: decision.analysis.requiresVerification,
  });
}

function evaluateAssertion(
  assertion: GoldenTaskAssertionDefinition,
  actual: RoutingEvalActual,
): RoutingEvalAssertionResult {
  if (assertion.kind === "primary_model_equals") {
    const expected = assertion.expected as string;
    return deepFreeze({ ...assertion, passed: actual.primaryModel === expected, actual: actual.primaryModel });
  }
  if (assertion.kind === "requires_verification_equals") {
    const expected = assertion.expected as boolean;
    return deepFreeze({ ...assertion, passed: actual.requiresVerification === expected, actual: actual.requiresVerification });
  }
  const expected = assertion.expected as readonly string[];
  const passed = expected.every((skill) => actual.selectedSkills.includes(skill));
  return deepFreeze({ ...assertion, passed, actual: actual.selectedSkills });
}

function prepareScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
  return value;
}

function prepareIdentity(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/[\r\n]/.test(prepared)) throw new Error(`${label} must be single-line`);
  if (utf8ByteLength(prepared) > maxBytes) throw new Error(`${label} exceeds configured byte bound`);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
}

function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value)
    || /\bghp_[A-Za-z0-9]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
}

function assertReportBytes(report: RoutingEvalReport, maxBytes: number): void {
  assertPositiveInteger(maxBytes, "Eval maxReportBytes");
  const bytes = utf8ByteLength(stableStringify(report));
  if (bytes > maxBytes) throw new Error(`Routing eval report exceeds maxReportBytes: bytes=${bytes} max=${maxBytes}`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new Error(`${label} contains unknown field: ${field}`);
  for (const field of allowed) if (!(field in value)) throw new Error(`${label} is missing field: ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatScore(value: number): string {
  return value.toFixed(4);
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
