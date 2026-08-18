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
import {
  RoutingEvalPlane,
  prepareEvalBaseline,
  verifyRoutingEvalReport,
  type EvalBaselineComparison,
  type EvalBaselineDefinition,
  type RoutingEvalReport,
} from "./eval-plane.js";

export const EVAL_HISTORY_SCHEMA_VERSION = 1 as const;

export interface EvalMeasurementSample {
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly sourceReferences: readonly string[];
}

export interface EvalHistoryObservationPayload {
  readonly observedAt: string;
  readonly report: RoutingEvalReport;
  readonly baseline: EvalBaselineDefinition;
  readonly comparison: EvalBaselineComparison;
  readonly measurement?: EvalMeasurementSample;
}

export interface EvalHistoryObservation {
  readonly algorithm: "sha256";
  readonly observationId: string;
  readonly observationSha256: string;
  readonly payload: EvalHistoryObservationPayload;
}

export interface AppendEvalHistoryObservationInput {
  readonly observedAt: string;
  readonly report: RoutingEvalReport;
  readonly baseline: EvalBaselineDefinition;
  readonly measurement?: EvalMeasurementSample;
}

export interface JsonlEvalHistoryOptions {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxObservationBytes: number;
  readonly maxReportBytes: number;
  readonly maxStringBytes: number;
  readonly maxSourceReferences: number;
}

interface PersistedEvalHistoryEntry {
  readonly schemaVersion: typeof EVAL_HISTORY_SCHEMA_VERSION;
  readonly sequence: number;
  readonly observation: EvalHistoryObservation;
}

/**
 * Local, single-writer, append-only evaluation history.
 *
 * The store persists verified eval reports plus the exact baseline snapshot used
 * to classify that observation. Optional latency/cost samples require explicit
 * source references. Startup replay is fail-closed for malformed/truncated data,
 * sequence gaps, unsupported schemas, digest mismatch, duplicate observation IDs,
 * or eval/baseline incompatibility. Every append is fsync'd before memory admission.
 */
export class JsonlEvalHistory {
  readonly filePath: string;
  private readonly observations = new Map<string, EvalHistoryObservation>();
  private readonly maxFileBytes: number;
  private readonly maxObservationBytes: number;
  private readonly maxReportBytes: number;
  private readonly maxStringBytes: number;
  private readonly maxSourceReferences: number;
  private expectedFileSize = 0;

  private constructor(options: JsonlEvalHistoryOptions) {
    if (!options.filePath.trim()) throw new Error("Eval history filePath must not be empty");
    assertPositiveInteger(options.maxFileBytes, "Eval history maxFileBytes");
    assertPositiveInteger(options.maxObservationBytes, "Eval history maxObservationBytes");
    assertPositiveInteger(options.maxReportBytes, "Eval history maxReportBytes");
    assertPositiveInteger(options.maxStringBytes, "Eval history maxStringBytes");
    assertPositiveInteger(options.maxSourceReferences, "Eval history maxSourceReferences");
    if (options.maxObservationBytes > options.maxFileBytes) throw new Error("Eval history maxObservationBytes must not exceed maxFileBytes");

    this.filePath = resolve(options.filePath);
    this.maxFileBytes = options.maxFileBytes;
    this.maxObservationBytes = options.maxObservationBytes;
    this.maxReportBytes = options.maxReportBytes;
    this.maxStringBytes = options.maxStringBytes;
    this.maxSourceReferences = options.maxSourceReferences;
    mkdirSync(resolve(this.filePath, ".."), { recursive: true });
  }

  static async open(options: JsonlEvalHistoryOptions): Promise<JsonlEvalHistory> {
    const history = new JsonlEvalHistory(options);
    await history.load();
    return history;
  }

  async append(input: AppendEvalHistoryObservationInput): Promise<EvalHistoryObservation> {
    this.assertStorageUnchanged();
    const observation = await prepareEvalHistoryObservation(input, {
      maxObservationBytes: this.maxObservationBytes,
      maxReportBytes: this.maxReportBytes,
      maxStringBytes: this.maxStringBytes,
      maxSourceReferences: this.maxSourceReferences,
    });
    if (this.observations.has(observation.observationId)) throw new Error(`Eval history observation already exists: ${observation.observationId}`);

    const sequence = this.observations.size + 1;
    const line = `${JSON.stringify({ schemaVersion: EVAL_HISTORY_SCHEMA_VERSION, sequence, observation })}\n`;
    const lineBytes = utf8ByteLength(line);
    if (lineBytes > this.maxObservationBytes) {
      throw new Error(`Eval history observation exceeds maxObservationBytes: bytes=${lineBytes} max=${this.maxObservationBytes}`);
    }
    if (this.expectedFileSize + lineBytes > this.maxFileBytes) {
      throw new Error(`Eval history append would exceed maxFileBytes: current=${this.expectedFileSize} append=${lineBytes} max=${this.maxFileBytes}`);
    }

    const handle = openSync(this.filePath, "a", 0o600);
    try {
      writeFileSync(handle, line, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    this.expectedFileSize += lineBytes;
    this.observations.set(observation.observationId, observation);
    return observation;
  }

  get(observationId: string): EvalHistoryObservation | undefined {
    return this.observations.get(observationId);
  }

  list(): readonly EvalHistoryObservation[] {
    return [...this.observations.values()];
  }

  private async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const size = statSync(this.filePath).size;
    if (size > this.maxFileBytes) throw new Error(`Eval history exceeds maxFileBytes: bytes=${size} max=${this.maxFileBytes}`);

    const raw = readFileSync(this.filePath, "utf8");
    this.expectedFileSize = utf8ByteLength(raw);
    if (raw.length === 0) return;
    if (!raw.endsWith("\n")) throw new Error(`Eval history is not newline-terminated; possible partial write: ${this.filePath}`);

    const lines = raw.slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      if (!line.trim()) throw new Error(`Eval history contains an empty record at line ${lineNumber}`);
      const lineBytes = utf8ByteLength(`${line}\n`);
      if (lineBytes > this.maxObservationBytes) throw new Error(`Eval history record at line ${lineNumber} exceeds maxObservationBytes`);
      const persisted = parsePersistedEntry(line, lineNumber);
      if (persisted.sequence !== lineNumber) throw new Error(`Eval history sequence mismatch at line ${lineNumber}: sequence=${persisted.sequence}`);

      const prepared = await prepareEvalHistoryObservation({
        observedAt: persisted.observation.payload.observedAt,
        report: persisted.observation.payload.report,
        baseline: persisted.observation.payload.baseline,
        measurement: persisted.observation.payload.measurement,
      }, {
        maxObservationBytes: this.maxObservationBytes,
        maxReportBytes: this.maxReportBytes,
        maxStringBytes: this.maxStringBytes,
        maxSourceReferences: this.maxSourceReferences,
      });
      if (prepared.observationId !== persisted.observation.observationId || prepared.observationSha256 !== persisted.observation.observationSha256) {
        throw new Error(`Eval history observation digest mismatch at line ${lineNumber}`);
      }
      if (stableStringify(prepared.payload.comparison) !== stableStringify(persisted.observation.payload.comparison)) {
        throw new Error(`Eval history baseline comparison mismatch at line ${lineNumber}`);
      }
      if (this.observations.has(prepared.observationId)) throw new Error(`Eval history duplicate observation at line ${lineNumber}: ${prepared.observationId}`);
      this.observations.set(prepared.observationId, prepared);
    }
  }

  private assertStorageUnchanged(): void {
    const currentSize = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (currentSize !== this.expectedFileSize) {
      throw new Error(`Eval history changed outside this writer; reopen before appending: expectedBytes=${this.expectedFileSize} actualBytes=${currentSize}`);
    }
  }
}

export async function verifyEvalHistoryObservation(
  observation: EvalHistoryObservation,
  options: Pick<JsonlEvalHistoryOptions, "maxObservationBytes" | "maxReportBytes" | "maxStringBytes" | "maxSourceReferences"> = {
    maxObservationBytes: Number.MAX_SAFE_INTEGER,
    maxReportBytes: Number.MAX_SAFE_INTEGER,
    maxStringBytes: Number.MAX_SAFE_INTEGER,
    maxSourceReferences: Number.MAX_SAFE_INTEGER,
  },
): Promise<void> {
  const prepared = await prepareEvalHistoryObservation({
    observedAt: observation.payload.observedAt,
    report: observation.payload.report,
    baseline: observation.payload.baseline,
    measurement: observation.payload.measurement,
  }, options);
  if (prepared.observationId !== observation.observationId || prepared.observationSha256 !== observation.observationSha256) throw new Error("Eval history observation digest does not match canonical payload");
  if (stableStringify(prepared.payload.comparison) !== stableStringify(observation.payload.comparison)) throw new Error("Eval history observation comparison does not match canonical baseline comparison");
}

async function prepareEvalHistoryObservation(
  input: AppendEvalHistoryObservationInput,
  options: Pick<JsonlEvalHistoryOptions, "maxObservationBytes" | "maxReportBytes" | "maxStringBytes" | "maxSourceReferences">,
): Promise<EvalHistoryObservation> {
  assertTimestamp(input.observedAt, "Eval history observedAt");
  await verifyRoutingEvalReport(input.report, options.maxReportBytes, options.maxStringBytes);
  const baseline = prepareEvalBaseline(input.baseline, options.maxStringBytes);
  const plane = new RoutingEvalPlane({ maxReportBytes: options.maxReportBytes, maxSubjectIdBytes: options.maxStringBytes });
  const comparison = await plane.compare(input.report, baseline);
  const measurement = input.measurement === undefined ? undefined : prepareMeasurement(input.measurement, options.maxStringBytes, options.maxSourceReferences);

  const payload: EvalHistoryObservationPayload = deepFreeze({
    observedAt: new Date(input.observedAt).toISOString(),
    report: deepClone(input.report),
    baseline,
    comparison,
    measurement,
  });
  const observationSha256 = await sha256Canonical(payload);
  const observation: EvalHistoryObservation = deepFreeze({
    algorithm: "sha256" as const,
    observationId: `evalobs:${observationSha256.slice(0, 32).toLowerCase()}`,
    observationSha256,
    payload,
  });
  const bytes = utf8ByteLength(stableStringify(observation));
  if (bytes > options.maxObservationBytes) throw new Error(`Eval history observation exceeds maxObservationBytes: bytes=${bytes} max=${options.maxObservationBytes}`);
  return observation;
}

function prepareMeasurement(input: EvalMeasurementSample, maxStringBytes: number, maxSourceReferences: number): EvalMeasurementSample {
  if (!isRecord(input)) throw new Error("Eval measurement must be an object");
  const allowed = new Set(["latencyMs", "costUsd", "sourceReferences"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Eval measurement contains unknown field: ${key}`);
  const latencyMs = input.latencyMs === undefined ? undefined : prepareNonNegativeNumber(input.latencyMs, "Eval measurement latencyMs");
  const costUsd = input.costUsd === undefined ? undefined : prepareNonNegativeNumber(input.costUsd, "Eval measurement costUsd");
  if (latencyMs === undefined && costUsd === undefined) throw new Error("Eval measurement requires latencyMs and/or costUsd");
  if (!Array.isArray(input.sourceReferences) || input.sourceReferences.length === 0) throw new Error("Eval measurement requires at least one source reference");
  if (input.sourceReferences.length > maxSourceReferences) throw new Error(`Eval measurement exceeds maxSourceReferences: count=${input.sourceReferences.length} max=${maxSourceReferences}`);
  const refs = input.sourceReferences.map((value, index) => prepareIdentity(value, `Eval measurement sourceReferences[${index}]`, maxStringBytes));
  const unique = [...new Set(refs)].sort();
  if (unique.length !== refs.length) throw new Error("Eval measurement sourceReferences contain duplicates");
  return deepFreeze({ latencyMs, costUsd, sourceReferences: unique });
}

function parsePersistedEntry(line: string, lineNumber: number): PersistedEvalHistoryEntry {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Eval history contains invalid JSON at line ${lineNumber}: ${safeErrorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Eval history entry at line ${lineNumber} must be an object`);
  const allowed = new Set(["schemaVersion", "sequence", "observation"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Eval history entry at line ${lineNumber} contains unknown field: ${key}`);
  if (value.schemaVersion !== EVAL_HISTORY_SCHEMA_VERSION) throw new Error(`Unsupported eval history schema version at line ${lineNumber}: ${String(value.schemaVersion)}`);
  if (!Number.isInteger(value.sequence) || Number(value.sequence) <= 0) throw new Error(`Eval history sequence at line ${lineNumber} is invalid`);
  if (!isRecord(value.observation) || !isRecord(value.observation.payload)) throw new Error(`Eval history observation at line ${lineNumber} is invalid`);
  return value as unknown as PersistedEvalHistoryEntry;
}

function prepareNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  return value;
}

function prepareIdentity(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`);
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

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
