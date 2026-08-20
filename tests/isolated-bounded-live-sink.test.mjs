import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("isolated sink did not become healthy before timeout");
}

async function postJson(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`isolated sink request failed: ${JSON.stringify(payload)}`);
  return payload;
}

test("isolated bounded-live sink exposes only loopback output and persists hashes/reference facts, never raw output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "9router-isolated-live-sink-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "sink-state.json");
  const port = await freePort();
  const referenceSubjectId = "opencode:9router/hemat";
  const candidateSubjectId = "opencode:9router/smart";
  const child = spawn(process.execPath, [resolve("scripts/isolated-bounded-live-sink.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROUTER_BOUNDED_LIVE_ISOLATED_SINK_ONLY: "ISOLATED_LOOPBACK_ONLY",
      ROUTER_BOUNDED_LIVE_SINK_HOST: "127.0.0.1",
      ROUTER_BOUNDED_LIVE_SINK_PORT: String(port),
      ROUTER_BOUNDED_LIVE_SINK_STATE_PATH: statePath,
      ROUTER_BOUNDED_LIVE_REFERENCE_SUBJECT_ID: referenceSubjectId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))]);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl);
  assert.equal(health.isolated, true);
  assert.equal(health.host, "127.0.0.1");

  const rawOutput = "candidate-isolated-proof-output-never-persist-this-verbatim";
  const outputSha256 = createHash("sha256").update(rawOutput).digest("hex").toUpperCase();
  const publication = await postJson(baseUrl, "/publish", {
    idempotencyKey: "idem:isolated-candidate-1",
    sampleAuthorizationId: "m5liveauth:isolated-candidate-1",
    sampleId: "isolated-candidate-1",
    selectedSubjectId: candidateSubjectId,
    selectedRole: "candidate",
    output: rawOutput,
    outputSha256,
  });
  assert.equal(publication.selectedRole, "candidate");
  assert.equal(publication.outputSha256, outputSha256);
  assert.equal(publication.externallyVisible, true);

  const stateAfterPublish = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(stateAfterPublish.activeSubjectId, candidateSubjectId);
  assert.equal(stateAfterPublish.rawOutputPersisted, false);
  assert.equal(stateAfterPublish.publications.length, 1);
  assert.equal(stateAfterPublish.publications[0].outputSha256, outputSha256);
  assert.equal(JSON.stringify(stateAfterPublish).includes(rawOutput), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stateAfterPublish.publications[0], "output"), false);

  const restore = await postJson(baseUrl, "/restore", {
    idempotencyKey: "idem:restore-reference-1",
    experimentId: "m5experiment:isolated-live-test",
    targetSubjectId: referenceSubjectId,
  });
  assert.equal(restore.activeSubjectId, referenceSubjectId);

  const stateAfterRestore = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(stateAfterRestore.activeSubjectId, referenceSubjectId);
  assert.equal(stateAfterRestore.restores.length, 1);
  assert.equal(JSON.stringify(stateAfterRestore).includes(rawOutput), false);
});

test("isolated bounded-live sink refuses non-loopback binding before serving requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "9router-isolated-live-sink-host-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [resolve("scripts/isolated-bounded-live-sink.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROUTER_BOUNDED_LIVE_ISOLATED_SINK_ONLY: "ISOLATED_LOOPBACK_ONLY",
      ROUTER_BOUNDED_LIVE_SINK_HOST: "0.0.0.0",
      ROUTER_BOUNDED_LIVE_SINK_PORT: "4097",
      ROUTER_BOUNDED_LIVE_SINK_STATE_PATH: join(root, "state.json"),
      ROUTER_BOUNDED_LIVE_REFERENCE_SUBJECT_ID: "opencode:9router/hemat",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
});
