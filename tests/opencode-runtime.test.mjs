import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenCodeCapabilityProvider,
  OpenCodeHttpClient,
  OpenCodeRuntimeAdapter,
} from "../dist/index.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noContent() {
  return new Response(null, { status: 204 });
}

function requestView(url, init = {}) {
  const headers = new Headers(init.headers);
  return {
    url: new URL(String(url)),
    method: init.method ?? "GET",
    headers,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
}

test("OpenCode HTTP client mirrors upstream directory routing and Basic Auth behavior", async () => {
  const calls = [];
  const workspace = "D:\\proyek\\stok rekonsiliasi";
  const client = new OpenCodeHttpClient({
    baseUrl: "http://127.0.0.1:20128",
    username: "opencode",
    password: "secret",
    fetchImpl: async (url, init) => {
      calls.push(requestView(url, init));
      return jsonResponse({ ok: true });
    },
  });

  await client.request({ method: "POST", path: "/session", directory: workspace, body: {} });
  await client.request({ method: "GET", path: "/session/status", directory: workspace });

  assert.equal(calls[0].url.pathname, "/session");
  assert.equal(calls[0].url.searchParams.has("directory"), false);
  assert.equal(calls[0].headers.get("x-opencode-directory"), encodeURIComponent(workspace));
  assert.equal(calls[0].headers.get("authorization"), `Basic ${btoa("opencode:secret")}`);

  assert.equal(calls[1].url.pathname, "/session/status");
  assert.equal(calls[1].url.searchParams.get("directory"), workspace);
  assert.equal(calls[1].headers.has("x-opencode-directory"), false);
});

test("OpenCode adapter creates scoped sessions and applies deny-by-default tool policy before async prompts", async () => {
  const calls = [];
  const adapter = new OpenCodeRuntimeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    now: () => "2026-08-16T00:00:00.000Z",
    createEventId: (() => {
      let value = 0;
      return () => `event-${++value}`;
    })(),
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      calls.push(call);
      if (call.method === "POST" && call.url.pathname === "/session") {
        return jsonResponse({
          id: "ses_1",
          directory: "D:\\proyek\\stok",
          version: "1.15.0",
          time: { created: 1_787_000_000_000 },
        });
      }
      if (call.method === "PATCH" && call.url.pathname === "/session/ses_1") {
        return jsonResponse({ id: "ses_1" });
      }
      if (call.method === "POST" && call.url.pathname === "/session/ses_1/prompt_async") return noContent();
      throw new Error(`unexpected request ${call.method} ${call.url.pathname}`);
    },
  });

  const session = await adapter.createSession({
    projectId: "stok-reconciliation",
    workspace: "D:\\proyek\\stok",
    riskClass: "R2",
    metadata: { runId: "run-1" },
  });
  assert.equal(session.id, "ses_1");
  assert.equal(session.runtimeId, "opencode");

  await adapter.sendTask(session.id, {
    taskId: "task-1",
    prompt: "Fix the reconciliation bug",
    context: ["Follow AGENTS.md", "Only edit relevant files"],
    toolIds: ["read", "edit", "read"],
  });

  const create = calls[0];
  assert.equal(create.body.metadata["9router.projectId"], "stok-reconciliation");
  assert.equal(create.body.metadata["9router.riskClass"], "R2");

  const permissionPatch = calls[1];
  assert.deepEqual(permissionPatch.body.permission, [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
  ]);

  const prompt = calls[2];
  assert.equal(prompt.body.noReply, false);
  assert.equal(prompt.body.system, "Follow AGENTS.md\n\nOnly edit relevant files");
  assert.deepEqual(prompt.body.parts, [{ type: "text", text: "Fix the reconciliation bug" }]);
  assert.equal(await adapter.getStatus(session.id).catch(() => "network-not-mocked"), "network-not-mocked");
});

test("OpenCode adapter normalizes busy then completed status using status plus completed message evidence", async () => {
  let statusReads = 0;
  const adapter = new OpenCodeRuntimeAdapter({
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      if (call.method === "POST" && call.url.pathname === "/session") {
        return jsonResponse({ id: "ses_status", version: "1.15.0", time: { created: 1_000 } });
      }
      if (call.method === "PATCH") return jsonResponse({ id: "ses_status" });
      if (call.method === "POST" && call.url.pathname.endsWith("/prompt_async")) return noContent();
      if (call.method === "GET" && call.url.pathname === "/session/status") {
        statusReads += 1;
        return jsonResponse(statusReads === 1 ? { ses_status: { type: "busy" } } : {});
      }
      if (call.method === "GET" && call.url.pathname === "/session/ses_status/message") {
        return jsonResponse([
          { info: { id: "msg_user", role: "user", time: { created: 2_000 } }, parts: [] },
          {
            info: {
              id: "msg_assistant",
              role: "assistant",
              finish: "stop",
              time: { created: 3_000, completed: 4_000 },
            },
            parts: [],
          },
        ]);
      }
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });
  const session = await adapter.createSession({ projectId: "p", workspace: "C:\\p", riskClass: "R2" });
  await adapter.sendTask(session.id, { taskId: "t", prompt: "work", context: [], toolIds: [] });
  assert.equal(await adapter.getStatus(session.id), "running");
  assert.equal(await adapter.getStatus(session.id), "completed");
});

test("OpenCode adapter surfaces provider messages and pending permissions as normalized runtime events", async () => {
  let permissionPending = true;
  const adapter = new OpenCodeRuntimeAdapter({
    now: () => "2026-08-16T00:00:10.000Z",
    createEventId: (() => {
      let value = 0;
      return () => `local-${++value}`;
    })(),
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      if (call.method === "POST" && call.url.pathname === "/session") return jsonResponse({ id: "ses_events", version: "1.15.0" });
      if (call.method === "GET" && call.url.pathname === "/session/ses_events/message") {
        return jsonResponse([
          { info: { id: "msg_1", role: "user", time: { created: 1_000 } }, parts: [] },
          { info: { id: "msg_2", role: "assistant", finish: "stop", time: { created: 2_000, completed: 3_000 } }, parts: [] },
        ]);
      }
      if (call.method === "GET" && call.url.pathname === "/permission") {
        return jsonResponse(permissionPending ? [{ id: "per_1", sessionID: "ses_events", permission: "edit", patterns: ["*"] }] : []);
      }
      if (call.method === "POST" && call.url.pathname === "/permission/per_1/reply") {
        permissionPending = false;
        return jsonResponse(true);
      }
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });
  const session = await adapter.createSession({ projectId: "p", workspace: "C:\\p", riskClass: "R3" });
  const events = await adapter.getEvents(session.id);
  assert.ok(events.some((event) => event.id === "opencode:message:msg_1:user" && event.type === "task_started"));
  assert.ok(events.some((event) => event.id === "opencode:message:msg_2:assistant" && event.type === "task_completed"));
  assert.ok(events.some((event) => event.id === "opencode:permission:per_1" && event.type === "approval_requested"));
  assert.equal(await adapter.getStatus(session.id), "waiting_approval");

  await adapter.respondToApproval(session.id, { approvalId: "per_1", decision: "approved", actor: "human:test" });
  const refreshed = await adapter.getEvents(session.id);
  assert.ok(refreshed.some((event) => event.type === "approval_responded"));
  assert.ok(!refreshed.some((event) => event.id === "opencode:permission:per_1"));
});

test("OpenCode adapter falls back to legacy session permission response endpoint when current endpoint is unavailable", async () => {
  const calls = [];
  const adapter = new OpenCodeRuntimeAdapter({
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      calls.push(call);
      if (call.method === "POST" && call.url.pathname === "/session") return jsonResponse({ id: "ses_perm" });
      if (call.method === "POST" && call.url.pathname === "/permission/per_old/reply") return jsonResponse({ error: "not found" }, 404);
      if (call.method === "POST" && call.url.pathname === "/session/ses_perm/permissions/per_old") return jsonResponse(true);
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });
  const session = await adapter.createSession({ projectId: "p", workspace: "C:\\p", riskClass: "R3" });
  await adapter.respondToApproval(session.id, { approvalId: "per_old", decision: "denied", actor: "human" });
  assert.equal(calls.at(-1).body.response, "reject");
  assert.equal(await adapter.getStatus(session.id), "aborted");
});

test("OpenCode adapter normalizes structured file diffs", async () => {
  const adapter = new OpenCodeRuntimeAdapter({
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      if (call.method === "POST" && call.url.pathname === "/session") return jsonResponse({ id: "ses_diff" });
      if (call.method === "GET" && call.url.pathname === "/session/ses_diff/diff") {
        return jsonResponse([
          { file: "src/a.ts", patch: "@@ a", additions: 2, deletions: 1, status: "modified" },
          { file: "src/b.ts", patch: "@@ b", additions: 1, deletions: 0, status: "added" },
        ]);
      }
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });
  const session = await adapter.createSession({ projectId: "p", workspace: "C:\\p", riskClass: "R2" });
  const diff = await adapter.getDiff(session.id);
  assert.deepEqual(diff.filesChanged, ["src/a.ts", "src/b.ts"]);
  assert.equal(diff.patch, "@@ a\n@@ b");
});

test("OpenCode interrupt maps to abort while resume verifies the reusable session instead of pretending to resume generation", async () => {
  const calls = [];
  const adapter = new OpenCodeRuntimeAdapter({
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      calls.push(call);
      if (call.method === "POST" && call.url.pathname === "/session") return jsonResponse({ id: "ses_resume" });
      if (call.method === "PATCH") return jsonResponse({ id: "ses_resume" });
      if (call.method === "POST" && call.url.pathname.endsWith("/prompt_async")) return noContent();
      if (call.method === "POST" && call.url.pathname.endsWith("/abort")) return jsonResponse(true);
      if (call.method === "GET" && call.url.pathname === "/session/ses_resume") return jsonResponse({ id: "ses_resume" });
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });
  const session = await adapter.createSession({ projectId: "p", workspace: "C:\\p", riskClass: "R2" });
  await adapter.sendTask(session.id, { taskId: "t", prompt: "work", context: [], toolIds: [] });
  await adapter.interrupt(session.id);
  assert.equal(await adapter.getStatus(session.id), "interrupted");
  await adapter.resume(session.id);
  assert.ok(calls.some((call) => call.method === "GET" && call.url.pathname === "/session/ses_resume"));
});

test("OpenCode capability provider reports health/version without claiming compatibility when version is missing", async () => {
  let includeVersion = true;
  const provider = new OpenCodeCapabilityProvider({
    checkedAt: () => "2026-08-16T00:00:00.000Z",
    fetchImpl: async () => jsonResponse(includeVersion ? { healthy: true, version: "1.15.0" } : { healthy: true }),
  });

  const healthy = await provider.health();
  assert.equal(healthy.status, "healthy");
  const version = await provider.version();
  assert.deepEqual(version, { version: "1.15.0", protocolVersion: "opencode-http", compatible: true });

  includeVersion = false;
  assert.equal((await provider.health()).status, "degraded");
  assert.equal((await provider.version()).compatible, false);
});
