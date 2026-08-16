import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeRuntimeAdapter } from "../dist/index.js";

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
  return {
    url: new URL(String(url)),
    method: init.method ?? "GET",
  };
}

const terminalMessages = [
  { info: { id: "msg_user_1", role: "user", time: { created: 1_000 } }, parts: [] },
  {
    info: {
      id: "msg_assistant_1",
      role: "assistant",
      finish: "stop",
      time: { created: 2_000, completed: 3_000 },
    },
    parts: [],
  },
];

test("stale busy status yields to current terminal assistant evidence after one busy poll", async () => {
  const adapter = new OpenCodeRuntimeAdapter({
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      if (call.method === "POST" && call.url.pathname === "/session") {
        return jsonResponse({ id: "ses_stale_busy", version: "1.18.18" });
      }
      if (call.method === "PATCH" && call.url.pathname === "/session/ses_stale_busy") {
        return jsonResponse({ id: "ses_stale_busy" });
      }
      if (call.method === "POST" && call.url.pathname.endsWith("/prompt_async")) return noContent();
      if (call.method === "GET" && call.url.pathname === "/session/status") {
        return jsonResponse({ ses_stale_busy: { type: "busy" } });
      }
      if (call.method === "GET" && call.url.pathname === "/session/ses_stale_busy/message") {
        return jsonResponse(terminalMessages);
      }
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });

  const session = await adapter.createSession({ projectId: "p", workspace: "C:\\p", riskClass: "R2" });
  await adapter.sendTask(session.id, { taskId: "task-1", prompt: "write doc", context: [], toolIds: ["read", "edit"] });

  assert.equal(await adapter.getStatus(session.id), "running");
  assert.equal(await adapter.getStatus(session.id), "completed");
});

test("tool-calls and unknown finishes remain non-terminal even when message time.completed exists", async () => {
  for (const finish of ["tool-calls", "unknown"]) {
    const sessionId = `ses_${finish.replace(/[^a-z]/g, "_")}`;
    const adapter = new OpenCodeRuntimeAdapter({
      fetchImpl: async (url, init) => {
        const call = requestView(url, init);
        if (call.method === "POST" && call.url.pathname === "/session") {
          return jsonResponse({ id: sessionId, version: "1.18.18" });
        }
        if (call.method === "PATCH" && call.url.pathname === `/session/${sessionId}`) {
          return jsonResponse({ id: sessionId });
        }
        if (call.method === "POST" && call.url.pathname.endsWith("/prompt_async")) return noContent();
        if (call.method === "GET" && call.url.pathname === "/session/status") {
          return jsonResponse({ [sessionId]: { type: "busy" } });
        }
        if (call.method === "GET" && call.url.pathname === `/session/${sessionId}/message`) {
          return jsonResponse([
            { info: { id: "msg_user", role: "user", time: { created: 1_000 } }, parts: [] },
            {
              info: {
                id: `msg_assistant_${finish}`,
                role: "assistant",
                finish,
                time: { created: 2_000, completed: 3_000 },
              },
              parts: [],
            },
          ]);
        }
        if (call.method === "GET" && call.url.pathname === "/permission") return jsonResponse([]);
        throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
      },
    });

    const session = await adapter.createSession({ projectId: "p", workspace: "C:\\p", riskClass: "R2" });
    await adapter.sendTask(session.id, { taskId: "task-1", prompt: "work", context: [], toolIds: ["edit"] });

    assert.equal(await adapter.getStatus(session.id), "running");
    assert.equal(await adapter.getStatus(session.id), "running");
    const events = await adapter.getEvents(session.id);
    assert.equal(events.some((event) => event.type === "task_completed"), false);
  }
});

test("terminal evidence from a previous task cannot complete a reused session task", async () => {
  let phase = 1;
  let promptCount = 0;
  const firstMessages = terminalMessages;
  const secondMessages = [
    ...firstMessages,
    { info: { id: "msg_user_2", role: "user", time: { created: 4_000 } }, parts: [] },
    {
      info: {
        id: "msg_assistant_2",
        role: "assistant",
        finish: "stop",
        time: { created: 5_000, completed: 6_000 },
      },
      parts: [],
    },
  ];

  const adapter = new OpenCodeRuntimeAdapter({
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      if (call.method === "POST" && call.url.pathname === "/session") {
        return jsonResponse({ id: "ses_reuse", version: "1.18.18" });
      }
      if (call.method === "PATCH" && call.url.pathname === "/session/ses_reuse") {
        return jsonResponse({ id: "ses_reuse" });
      }
      if (call.method === "POST" && call.url.pathname.endsWith("/prompt_async")) {
        promptCount += 1;
        if (promptCount === 2) phase = 2;
        return noContent();
      }
      if (call.method === "GET" && call.url.pathname === "/session/status") {
        return jsonResponse(phase === 1 ? {} : { ses_reuse: { type: "busy" } });
      }
      if (call.method === "GET" && call.url.pathname === "/session/ses_reuse/message") {
        return jsonResponse(phase === 3 ? secondMessages : firstMessages);
      }
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });

  const session = await adapter.createSession({ projectId: "p", workspace: "C:\\p", riskClass: "R2" });
  await adapter.sendTask(session.id, { taskId: "task-1", prompt: "first", context: [], toolIds: [] });
  assert.equal(await adapter.getStatus(session.id), "completed");

  await adapter.sendTask(session.id, { taskId: "task-2", prompt: "second", context: [], toolIds: [] });
  assert.equal(await adapter.getStatus(session.id), "running");

  phase = 3;
  assert.equal(await adapter.getStatus(session.id), "completed");
});
