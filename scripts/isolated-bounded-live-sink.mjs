import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const APPROVAL = "ISOLATED_LOOPBACK_ONLY";
const host = process.env.ROUTER_BOUNDED_LIVE_SINK_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.ROUTER_BOUNDED_LIVE_SINK_PORT || "4097");
const statePathInput = process.env.ROUTER_BOUNDED_LIVE_SINK_STATE_PATH?.trim();
const referenceSubjectId = requiredEnv("ROUTER_BOUNDED_LIVE_REFERENCE_SUBJECT_ID");
const approval = process.env.ROUTER_BOUNDED_LIVE_ISOLATED_SINK_ONLY?.trim();
const maxBodyBytes = 256 * 1024;

if (approval !== APPROVAL) fail("Isolated bounded-live sink requires explicit ROUTER_BOUNDED_LIVE_ISOLATED_SINK_ONLY=ISOLATED_LOOPBACK_ONLY");
if (host !== "127.0.0.1") fail("Isolated bounded-live sink must bind exactly to 127.0.0.1");
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("Isolated bounded-live sink port is invalid");
if (!statePathInput) fail("ROUTER_BOUNDED_LIVE_SINK_STATE_PATH is required");

const statePath = resolve(statePathInput);
await mkdir(dirname(statePath), { recursive: true });
let state = await loadState();

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { overall: "PASS", isolated: true, host, port });
    if (request.method === "GET" && request.url === "/state") return json(response, 200, state);
    if (request.method === "POST" && request.url === "/publish") return publish(request, response);
    if (request.method === "POST" && request.url === "/restore") return restoreReference(request, response);
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    return json(response, 400, { error: safeError(error) });
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ overall: "PASS", service: "isolated-bounded-live-sink", host, port, statePath, rawOutputPersistenceAllowed: false }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => { process.exitCode = 0; }));
}

async function publish(request, response) {
  const body = await readJson(request);
  assertExactFields(body, new Set(["idempotencyKey", "sampleAuthorizationId", "sampleId", "selectedSubjectId", "selectedRole", "output", "outputSha256"]), "publication request");
  const idempotencyKey = identity(body.idempotencyKey, "idempotencyKey");
  const sampleAuthorizationId = identity(body.sampleAuthorizationId, "sampleAuthorizationId");
  const sampleId = identity(body.sampleId, "sampleId");
  const selectedSubjectId = identity(body.selectedSubjectId, "selectedSubjectId");
  const selectedRole = body.selectedRole;
  if (selectedRole !== "reference" && selectedRole !== "candidate") throw new Error("selectedRole must be reference or candidate");
  if (typeof body.output !== "string" || body.output.length === 0) throw new Error("output must be non-empty string");
  const outputBytes = Buffer.byteLength(body.output, "utf8");
  if (outputBytes > 64 * 1024) throw new Error("output exceeds isolated proof byte bound");
  const outputSha256 = sha256(body.output);
  if (normalizeSha(body.outputSha256) !== outputSha256) throw new Error("output hash mismatch");

  const existing = state.publications.find((entry) => entry.idempotencyKey === idempotencyKey);
  if (existing) {
    if (existing.sampleAuthorizationId !== sampleAuthorizationId || existing.sampleId !== sampleId || existing.selectedSubjectId !== selectedSubjectId || existing.selectedRole !== selectedRole || existing.outputSha256 !== outputSha256) throw new Error("idempotency key reused with different publication facts");
    return json(response, 200, publicationResponse(existing));
  }

  const publishedAt = new Date().toISOString();
  const publicationReference = `isolated-publication:${randomUUID()}`;
  const entry = Object.freeze({ idempotencyKey, sampleAuthorizationId, sampleId, selectedSubjectId, selectedRole, outputSha256, outputBytes, publicationReference, publishedAt, externallyVisible: true });
  state = Object.freeze({ ...state, activeSubjectId: selectedSubjectId, publications: Object.freeze([...state.publications, entry]) });
  await persistState();
  return json(response, 200, publicationResponse(entry));
}

async function restoreReference(request, response) {
  const body = await readJson(request);
  assertExactFields(body, new Set(["idempotencyKey", "experimentId", "targetSubjectId"]), "restore request");
  const idempotencyKey = identity(body.idempotencyKey, "idempotencyKey");
  const experimentId = identity(body.experimentId, "experimentId");
  const targetSubjectId = identity(body.targetSubjectId, "targetSubjectId");
  if (targetSubjectId !== referenceSubjectId) throw new Error("isolated restore target must equal configured canonical reference subject");

  const existing = state.restores.find((entry) => entry.idempotencyKey === idempotencyKey);
  if (existing) {
    if (existing.experimentId !== experimentId || existing.targetSubjectId !== targetSubjectId) throw new Error("idempotency key reused with different restore facts");
    return json(response, 200, restoreResponse(existing));
  }

  const restoredAt = new Date().toISOString();
  const restoreReference = `isolated-restore:${randomUUID()}`;
  const entry = Object.freeze({ idempotencyKey, experimentId, targetSubjectId, restoreReference, restoredAt, activeSubjectId: targetSubjectId });
  state = Object.freeze({ ...state, activeSubjectId: targetSubjectId, restores: Object.freeze([...state.restores, entry]) });
  await persistState();
  return json(response, 200, restoreResponse(entry));
}

function publicationResponse(entry) {
  return {
    sinkId: "isolated-loopback-bounded-live-sink",
    idempotencyKey: entry.idempotencyKey,
    publicationReference: entry.publicationReference,
    publishedAt: entry.publishedAt,
    selectedRole: entry.selectedRole,
    outputSha256: entry.outputSha256,
    externallyVisible: true,
  };
}

function restoreResponse(entry) {
  return {
    sinkId: "isolated-loopback-bounded-live-sink",
    idempotencyKey: entry.idempotencyKey,
    restoreReference: entry.restoreReference,
    restoredAt: entry.restoredAt,
    activeSubjectId: entry.activeSubjectId,
  };
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (!parsed || parsed.schemaVersion !== 1 || parsed.rawOutputPersisted !== false || !Array.isArray(parsed.publications) || !Array.isArray(parsed.restores)) throw new Error("existing isolated sink state is invalid");
    if (JSON.stringify(parsed).includes('"output"')) throw new Error("existing isolated sink state appears to contain raw output field");
    return Object.freeze(parsed);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return Object.freeze({ schemaVersion: 1, activeSubjectId: referenceSubjectId, publications: Object.freeze([]), restores: Object.freeze([]), rawOutputPersisted: false });
  }
}

async function persistState() {
  if (JSON.stringify(state).includes('"output"')) throw new Error("isolated sink refused raw output persistence");
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new Error("request body exceeds isolated sink bound");
    chunks.push(chunk);
  }
  if (bytes === 0) throw new Error("request body is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value);
  for (const key of keys) if (!fields.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const key of fields) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label}.${key} is required`);
}

function identity(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  return value.trim();
}

function normalizeSha(value) {
  if (typeof value !== "string" || !/^[0-9A-Fa-f]{64}$/.test(value)) throw new Error("SHA-256 is invalid");
  return value.toUpperCase();
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").toUpperCase();
}

function json(response, status, value) {
  const payload = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  response.end(payload);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function fail(message) {
  console.error(message);
  process.exitCode = 2;
  throw new Error(message);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]");
}
