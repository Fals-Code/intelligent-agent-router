export const GOLDEN_TASK_SUITE_SCHEMA_VERSION = 1 as const;

export type GoldenTaskKind = "routing";
export type GoldenAssertionKind =
  | "primary_model_equals"
  | "selected_skills_include"
  | "requires_verification_equals";

export interface GoldenTaskAssertionDefinition {
  readonly id: string;
  readonly kind: GoldenAssertionKind;
  readonly weight: number;
  readonly expected: string | readonly string[] | boolean;
}

export interface GoldenTaskDefinition {
  readonly id: string;
  readonly kind: GoldenTaskKind;
  readonly prompt: string;
  readonly critical: boolean;
  readonly minimumScore: number;
  readonly assertions: readonly GoldenTaskAssertionDefinition[];
}

export interface GoldenTaskSuiteDefinition {
  readonly schemaVersion: typeof GOLDEN_TASK_SUITE_SCHEMA_VERSION;
  readonly suiteId: string;
  readonly description: string;
  readonly tasks: readonly GoldenTaskDefinition[];
}

export interface GoldenTaskSuite extends GoldenTaskSuiteDefinition {
  readonly algorithm: "sha256";
  readonly suiteSha256: string;
}

export interface GoldenTaskSuiteLimits {
  readonly maxTasks: number;
  readonly maxAssertionsPerTask: number;
  readonly maxPromptBytes: number;
  readonly maxStringBytes: number;
  readonly maxSuiteBytes: number;
}

const SUITE_FIELDS = new Set(["schemaVersion", "suiteId", "description", "tasks"]);
const TASK_FIELDS = new Set(["id", "kind", "prompt", "critical", "minimumScore", "assertions"]);
const ASSERTION_FIELDS = new Set(["id", "kind", "weight", "expected"]);
const ASSERTION_KINDS = new Set<GoldenAssertionKind>([
  "primary_model_equals",
  "selected_skills_include",
  "requires_verification_equals",
]);

export async function prepareGoldenTaskSuite(
  input: unknown,
  limits: GoldenTaskSuiteLimits,
): Promise<GoldenTaskSuite> {
  assertLimits(limits);
  if (!isRecord(input)) throw new Error("Golden task suite must be an object");
  assertExactFields(input, SUITE_FIELDS, "Golden task suite");
  if (input.schemaVersion !== GOLDEN_TASK_SUITE_SCHEMA_VERSION) {
    throw new Error(`Unsupported golden task suite schema version: ${String(input.schemaVersion)}`);
  }

  const suiteId = prepareIdentity(input.suiteId, "Golden task suiteId", limits.maxStringBytes);
  const description = preparePublicText(input.description, "Golden task description", limits.maxStringBytes);
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error("Golden task suite requires at least one task");
  }
  if (input.tasks.length > limits.maxTasks) {
    throw new Error(`Golden task suite exceeds maxTasks: count=${input.tasks.length} max=${limits.maxTasks}`);
  }

  const taskIds = new Set<string>();
  const tasks = input.tasks.map((task, index) => {
    const prepared = prepareTask(task, index, limits);
    if (taskIds.has(prepared.id)) throw new Error(`Golden task id is duplicated: ${prepared.id}`);
    taskIds.add(prepared.id);
    return prepared;
  });

  const definition: GoldenTaskSuiteDefinition = deepFreeze({
    schemaVersion: GOLDEN_TASK_SUITE_SCHEMA_VERSION,
    suiteId,
    description,
    tasks,
  });
  const suiteSha256 = await sha256Canonical(definition);
  const suite: GoldenTaskSuite = deepFreeze({
    ...definition,
    algorithm: "sha256" as const,
    suiteSha256,
  });
  const bytes = utf8ByteLength(stableStringify(suite));
  if (bytes > limits.maxSuiteBytes) {
    throw new Error(`Golden task suite exceeds maxSuiteBytes: bytes=${bytes} max=${limits.maxSuiteBytes}`);
  }
  return suite;
}

function prepareTask(input: unknown, index: number, limits: GoldenTaskSuiteLimits): GoldenTaskDefinition {
  if (!isRecord(input)) throw new Error(`Golden task[${index}] must be an object`);
  assertExactFields(input, TASK_FIELDS, `Golden task[${index}]`);
  const id = prepareIdentity(input.id, `Golden task[${index}] id`, limits.maxStringBytes);
  if (input.kind !== "routing") throw new Error(`Golden task ${id} kind is unsupported: ${String(input.kind)}`);
  const prompt = preparePrompt(input.prompt, `Golden task ${id} prompt`, limits.maxPromptBytes);
  if (typeof input.critical !== "boolean") throw new Error(`Golden task ${id} critical must be boolean`);
  const minimumScore = prepareScore(input.minimumScore, `Golden task ${id} minimumScore`);
  if (!Array.isArray(input.assertions) || input.assertions.length === 0) {
    throw new Error(`Golden task ${id} requires at least one assertion`);
  }
  if (input.assertions.length > limits.maxAssertionsPerTask) {
    throw new Error(`Golden task ${id} exceeds maxAssertionsPerTask: count=${input.assertions.length} max=${limits.maxAssertionsPerTask}`);
  }
  const assertionIds = new Set<string>();
  const assertions = input.assertions.map((assertion, assertionIndex) => {
    const prepared = prepareAssertion(assertion, id, assertionIndex, limits.maxStringBytes);
    if (assertionIds.has(prepared.id)) throw new Error(`Golden task ${id} assertion id is duplicated: ${prepared.id}`);
    assertionIds.add(prepared.id);
    return prepared;
  });
  return deepFreeze({ id, kind: "routing" as const, prompt, critical: input.critical, minimumScore, assertions });
}

function prepareAssertion(
  input: unknown,
  taskId: string,
  index: number,
  maxStringBytes: number,
): GoldenTaskAssertionDefinition {
  if (!isRecord(input)) throw new Error(`Golden task ${taskId} assertion[${index}] must be an object`);
  assertExactFields(input, ASSERTION_FIELDS, `Golden task ${taskId} assertion[${index}]`);
  const id = prepareIdentity(input.id, `Golden task ${taskId} assertion[${index}] id`, maxStringBytes);
  if (!ASSERTION_KINDS.has(input.kind as GoldenAssertionKind)) {
    throw new Error(`Golden task ${taskId} assertion ${id} kind is unsupported: ${String(input.kind)}`);
  }
  const weight = Number(input.weight);
  if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Golden task ${taskId} assertion ${id} weight must be positive and finite`);
  const kind = input.kind as GoldenAssertionKind;
  const expected = prepareExpected(kind, input.expected, taskId, id, maxStringBytes);
  return deepFreeze({ id, kind, weight, expected });
}

function prepareExpected(
  kind: GoldenAssertionKind,
  value: unknown,
  taskId: string,
  assertionId: string,
  maxStringBytes: number,
): string | readonly string[] | boolean {
  if (kind === "requires_verification_equals") {
    if (typeof value !== "boolean") throw new Error(`Golden task ${taskId} assertion ${assertionId} expected must be boolean`);
    return value;
  }
  if (kind === "primary_model_equals") {
    return prepareIdentity(value, `Golden task ${taskId} assertion ${assertionId} expected model`, maxStringBytes);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Golden task ${taskId} assertion ${assertionId} expected skills must be a non-empty array`);
  }
  const prepared = value.map((item, index) => prepareIdentity(item, `Golden task ${taskId} assertion ${assertionId} expected skill[${index}]`, maxStringBytes));
  const unique = [...new Set(prepared)].sort();
  if (unique.length !== prepared.length) throw new Error(`Golden task ${taskId} assertion ${assertionId} expected skills contain duplicates`);
  return deepFreeze(unique);
}

function preparePrompt(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prompt = value.trim();
  if (utf8ByteLength(prompt) > maxBytes) throw new Error(`${label} exceeds maxPromptBytes`);
  if (containsSecretLikeMaterial(prompt)) throw new Error(`${label} contains secret-like material`);
  return prompt;
}

function prepareIdentity(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/[\r\n]/.test(prepared)) throw new Error(`${label} must be single-line`);
  if (utf8ByteLength(prepared) > maxBytes) throw new Error(`${label} exceeds maxStringBytes`);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
}

function preparePublicText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (utf8ByteLength(prepared) > maxBytes) throw new Error(`${label} exceeds maxStringBytes`);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
}

function prepareScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
  return value;
}

function assertLimits(limits: GoldenTaskSuiteLimits): void {
  assertPositiveInteger(limits.maxTasks, "Golden task maxTasks");
  assertPositiveInteger(limits.maxAssertionsPerTask, "Golden task maxAssertionsPerTask");
  assertPositiveInteger(limits.maxPromptBytes, "Golden task maxPromptBytes");
  assertPositiveInteger(limits.maxStringBytes, "Golden task maxStringBytes");
  assertPositiveInteger(limits.maxSuiteBytes, "Golden task maxSuiteBytes");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new Error(`${label} contains unknown field: ${field}`);
  for (const field of allowed) if (!(field in value)) throw new Error(`${label} is missing field: ${field}`);
}

function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value)
    || /\bghp_[A-Za-z0-9]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
