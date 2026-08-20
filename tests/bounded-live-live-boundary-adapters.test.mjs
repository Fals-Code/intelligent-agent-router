import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  IsolatedLoopbackBoundedLiveSinkClient,
  OpenCodeBoundedLiveOutputReader,
} from "../dist/index.js";

async function withServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return `http://127.0.0.1:${address.port}`;
}

function json(response, status, body) {
  const raw = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  response.end(raw);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("OpenCode bounded-live output reader reads only completed assistant text ephemerally", async (t) => {
  let messageGets = 0;
  const baseUrl = await withServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.includes("/session/ses_live/message")) {
      messageGets += 1;
      return json(response, 200, [
        { info: { id: "msg_user", role: "user", time: { completed: 1787120000000 } }, parts: [{ type: "text", text: "prompt" }] },
        { info: { id: "msg_assistant", role: "assistant", finish: "stop", time: { completed: 1787120001000 } }, parts: [{ type: "text", text: "verified live output" }] },
      ]);
    }
    return json(response, 404, { error: "not_found" });
  });
  const reader = new OpenCodeBoundedLiveOutputReader({ baseUrl, workspace: "C:/isolated/live", maxOutputBytes: 1024 });
  assert.equal(await reader.read({ runtimeId: "opencode", sessionId: "ses_live", runId: "run_live" }), "verified live output");
  assert.equal(messageGets, 1);
  await assert.rejects(() => reader.read({ runtimeId: "other", sessionId: "ses_live", runId: "run_live" }), /cannot read runtimeId/);
});

test("isolated loopback bounded-live sink client enforces loopback and exact receipts", async (t) => {
  const baseUrl = await withServer(t, async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { overall: "PASS", isolated: true });
    if (request.method === "POST" && request.url === "/publish") {
      const body = await readJson(request);
      return json(response, 200, {
        sinkId: "isolated-loopback-bounded-live-sink",
        idempotencyKey: body.idempotencyKey,
        publicationReference: "isolated-publication:test",
        publishedAt: "2026-08-20T00:00:01.000Z",
        selectedRole: body.selectedRole,
        outputSha256: body.outputSha256,
        externallyVisible: true,
      });
    }
    if (request.method === "POST" && request.url === "/restore") {
      const body = await readJson(request);
      return json(response, 200, {
        sinkId: "isolated-loopback-bounded-live-sink",
        idempotencyKey: body.idempotencyKey,
        restoreReference: "isolated-restore:test",
        restoredAt: "2026-08-20T00:00:02.000Z",
        activeSubjectId: body.targetSubjectId,
      });
    }
    return json(response, 404, { error: "not_found" });
  });
  assert.throws(() => new IsolatedLoopbackBoundedLiveSinkClient({ baseUrl: "http://localhost:4097" }), /requires http:\/\/127\.0\.0\.1/);
  const client = new IsolatedLoopbackBoundedLiveSinkClient({ baseUrl, timeoutMs: 2_000 });
  assert.deepEqual(await client.health(), { overall: "PASS", isolated: true });
  const outputSha256 = "A".repeat(64);
  const publication = await client.publish({ idempotencyKey: "idem:publish", sampleAuthorizationId: "auth:1", sampleId: "sample:1", selectedSubjectId: "opencode:9router/smart", selectedRole: "candidate", output: "verified", outputSha256 });
  assert.equal(publication.externallyVisible, true);
  assert.equal(publication.selectedRole, "candidate");
  assert.equal(publication.outputSha256, outputSha256);
  const restore = await client.restore({ idempotencyKey: "idem:restore", experimentId: "experiment:1", targetSubjectId: "opencode:9router/hemat" });
  assert.equal(restore.activeSubjectId, "opencode:9router/hemat");
});
