export const METRIC_TAXONOMY_SCHEMA_VERSION = 1 as const;

export type CanonicalMetricId =
  | "eval.weighted_score"
  | "eval.task_pass_rate"
  | "eval.critical_pass_rate"
  | "eval.baseline_pass_rate"
  | "execution.success_rate_excluding_cancelled"
  | "execution.cancellation_rate"
  | "execution.latency_ms"
  | "execution.cost_usd";

export type MetricDomain = "quality" | "reliability" | "efficiency";
export type MetricUnit = "ratio" | "milliseconds" | "usd";
export type MetricOptimizationDirection = "higher_is_better" | "lower_is_better";
export type MetricSourceOwner = "eval_report" | "eval_history" | "run_ledger_projection";

export interface MetricTaxonomyDefinition {
  readonly id: CanonicalMetricId;
  readonly domain: MetricDomain;
  readonly unit: MetricUnit;
  readonly direction: MetricOptimizationDirection;
  readonly sourceOwner: MetricSourceOwner;
  readonly availability: "required" | "optional";
}

export interface MetricTaxonomyPayload {
  readonly name: "9router-m4-canonical-metrics";
  readonly definitions: readonly MetricTaxonomyDefinition[];
}

export interface MetricTaxonomy {
  readonly schemaVersion: typeof METRIC_TAXONOMY_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly taxonomyId: string;
  readonly taxonomySha256: string;
  readonly payload: MetricTaxonomyPayload;
}

const CANONICAL_DEFINITIONS: readonly MetricTaxonomyDefinition[] = Object.freeze([
  Object.freeze({ id: "eval.weighted_score", domain: "quality", unit: "ratio", direction: "higher_is_better", sourceOwner: "eval_report", availability: "required" }),
  Object.freeze({ id: "eval.task_pass_rate", domain: "quality", unit: "ratio", direction: "higher_is_better", sourceOwner: "eval_report", availability: "required" }),
  Object.freeze({ id: "eval.critical_pass_rate", domain: "quality", unit: "ratio", direction: "higher_is_better", sourceOwner: "eval_report", availability: "required" }),
  Object.freeze({ id: "eval.baseline_pass_rate", domain: "reliability", unit: "ratio", direction: "higher_is_better", sourceOwner: "eval_history", availability: "required" }),
  Object.freeze({ id: "execution.success_rate_excluding_cancelled", domain: "reliability", unit: "ratio", direction: "higher_is_better", sourceOwner: "run_ledger_projection", availability: "optional" }),
  Object.freeze({ id: "execution.cancellation_rate", domain: "reliability", unit: "ratio", direction: "lower_is_better", sourceOwner: "run_ledger_projection", availability: "optional" }),
  Object.freeze({ id: "execution.latency_ms", domain: "efficiency", unit: "milliseconds", direction: "lower_is_better", sourceOwner: "run_ledger_projection", availability: "optional" }),
  Object.freeze({ id: "execution.cost_usd", domain: "efficiency", unit: "usd", direction: "lower_is_better", sourceOwner: "run_ledger_projection", availability: "optional" }),
]);

export async function buildCanonicalMetricTaxonomy(): Promise<MetricTaxonomy> {
  const payload: MetricTaxonomyPayload = deepFreeze({
    name: "9router-m4-canonical-metrics" as const,
    definitions: CANONICAL_DEFINITIONS.map((item) => Object.freeze({ ...item })),
  });
  const taxonomySha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: METRIC_TAXONOMY_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    taxonomyId: `metrictax:${taxonomySha256.slice(0, 32).toLowerCase()}`,
    taxonomySha256,
    payload,
  });
}

export async function verifyMetricTaxonomy(taxonomy: MetricTaxonomy): Promise<void> {
  if (!isRecord(taxonomy)) throw new Error("Metric taxonomy must be an object");
  if (taxonomy.schemaVersion !== METRIC_TAXONOMY_SCHEMA_VERSION || taxonomy.algorithm !== "sha256") throw new Error("Metric taxonomy envelope is invalid");
  if (!isRecord(taxonomy.payload) || taxonomy.payload.name !== "9router-m4-canonical-metrics") throw new Error("Metric taxonomy payload is invalid");
  if (!Array.isArray(taxonomy.payload.definitions)) throw new Error("Metric taxonomy definitions must be an array");
  validateDefinitions(taxonomy.payload.definitions);
  const expectedCanonical = await buildCanonicalMetricTaxonomy();
  if (stableStringify(taxonomy.payload) !== stableStringify(expectedCanonical.payload)) throw new Error("Metric taxonomy differs from canonical M4 taxonomy");
  const expected = await sha256Canonical(taxonomy.payload);
  if (taxonomy.taxonomySha256 !== expected) throw new Error("Metric taxonomy digest does not match canonical payload");
  if (taxonomy.taxonomyId !== `metrictax:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Metric taxonomyId does not match canonical payload");
}

export function getMetricDefinition(taxonomy: MetricTaxonomy, metricId: CanonicalMetricId): MetricTaxonomyDefinition {
  const definition = taxonomy.payload.definitions.find((item) => item.id === metricId);
  if (!definition) throw new Error(`Metric taxonomy does not contain ${metricId}`);
  return definition;
}

function validateDefinitions(definitions: readonly MetricTaxonomyDefinition[]): void {
  if (definitions.length !== CANONICAL_DEFINITIONS.length) throw new Error("Metric taxonomy definition count is invalid");
  const ids = definitions.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("Metric taxonomy contains duplicate metric IDs");
  const ordered = [...definitions].sort((left, right) => left.id.localeCompare(right.id));
  const receivedOrder = definitions.map((item) => item.id);
  const canonicalOrder = [...CANONICAL_DEFINITIONS].map((item) => item.id);
  if (stableStringify(receivedOrder) !== stableStringify(canonicalOrder)) throw new Error("Metric taxonomy definition order is not canonical");
  for (const definition of ordered) {
    if (!isRecord(definition)) throw new Error("Metric taxonomy definition must be an object");
    const keys = Object.keys(definition).sort();
    if (stableStringify(keys) !== stableStringify(["availability", "direction", "domain", "id", "sourceOwner", "unit"])) throw new Error(`Metric taxonomy ${definition.id} contains unknown or missing fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
