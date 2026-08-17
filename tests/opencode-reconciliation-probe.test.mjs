import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeRuntimeReconciliationProbe } from "../dist/index.js";

function binding() {
  return {
    workflowRunId: "run-1",
    projectId: "project-1",
    workflowAttempt: 1,
    runtimeId: "opencode",
    sessionId: "ses-1",
    workspace: "C:/workspace/project-1",
    boundAt: "2026-08-18T01:00:00.000Z",
  };
}

function fakeFetch(routes, calls) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? "GET", pathname: url.pathname, directory: url.searchParams.get("directory") });
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const value = routes[key];
    if (value === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("OpenCodeRuntimeReconciliationProbe observes an existing completed session without exposing patch content", async () => {
  const calls = [];
  const routes = {
    "GET /session/ses-1": { id: "ses-1", directory: "C:/workspace/project-1" },
    "GET /session/status": { "ses-1": { type: "idle" } },
    "GET /session/ses-1/message": [
      { info: { id: "m1", role: "user", time: { created: "2026-08-18T01:00:01.000Z" } } },
      { info: { id: "m2", role: "assistant", finish: "stop", time: { created: "2026-08-18T01:00:02.000Z", completed: "2026-08-18T01:00:03.000Z" } } },
    ],
    "GET /permission": [],
    "GET /session/ses-1/diff": [{ file: "src/example.ts", patch: "Authorization: Bearer raw-secret-must-not-surface" }],
  };
  const probe = new OpenCodeRuntimeReconciliationProbe({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: fakeFetch(routes, calls),
    now: () => "2026-08-18T01:00:10.000Z",
  });

  const result = await probe.inspect(binding());
  assert.equal(result.status, "completed");
  assert.deepEqual(result.diff.filesChanged, ["src/example.ts"]);
  assert.equal(result.diff.patchObserved, true);
  assert.equal("patch" in result.diff, false);
  assert.deepEqual(result.events.types, ["task_completed", "task_started"]);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(calls.length, 5);
});

test("OpenCodeRuntimeReconciliationProbe gives pending approval precedence over provider busy status", async () => {
  const calls = [];
  const routes = {
    "GET /session/ses-1": { id: "ses-1", directory: "C:/workspace/project-1" },
    "GET /session/status": { "ses-1": { type: "busy" } },
    "GET /session/ses-1/message": [],
    "GET /permission": [{ id: "perm-1", sessionID: "ses-1" }],
    "GET /session/ses-1/diff": [],
  };
  const probe = new OpenCodeRuntimeReconciliationProbe({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: fakeFetch(routes, calls),
    now: () => "2026-08-18T01:00:10.000Z",
  });

  const result = await probe.inspect(binding());
  assert.equal(result.status, "waiting_approval");
  assert.deepEqual(result.events.types, ["approval_requested"]);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("OpenCodeRuntimeReconciliationProbe rejects provider identity or workspace drift", async () => {
  for (const sessionResponse of [
    { id: "different-session", directory: "C:/workspace/project-1" },
    { id: "ses-1", directory: "C:/workspace/other" },
  ]) {
    const calls = [];
    const probe = new OpenCodeRuntimeReconciliationProbe({
      baseUrl: "http://127.0.0.1:4096",
      fetchImpl: fakeFetch({ "GET /session/ses-1": sessionResponse }, calls),
    });
    await assert.rejects(probe.inspect(binding()), /identity mismatch|workspace does not match/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  }
});
