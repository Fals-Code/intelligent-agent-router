import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeOpenCodeBaseUrl, runOpenCodeLivePreflight } from "../dist/index.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestView(url, init = {}) {
  return {
    url: new URL(String(url)),
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
}

test("OpenCode live preflight is loopback-only unless remote access is explicitly allowed", () => {
  assert.equal(assertSafeOpenCodeBaseUrl("http://127.0.0.1:4096"), "http://127.0.0.1:4096");
  assert.equal(assertSafeOpenCodeBaseUrl("http://localhost:4096/"), "http://localhost:4096");
  assert.throws(() => assertSafeOpenCodeBaseUrl("https://opencode.example.com"), /Refusing non-loopback OpenCode server/);
  assert.equal(
    assertSafeOpenCodeBaseUrl("https://opencode.example.com", true),
    "https://opencode.example.com",
  );
});

test("read-only OpenCode live preflight checks health, compatibility, scoped status and path without creating sessions", async () => {
  const calls = [];
  const projectDir = "D:\\proyek\\stok-reconciliation-system";
  const result = await runOpenCodeLivePreflight({
    baseUrl: "http://127.0.0.1:4096",
    projectDir,
    username: "opencode",
    password: "secret",
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      calls.push(call);
      if (call.method === "GET" && call.url.pathname === "/global/health") {
        return jsonResponse({ healthy: true, version: "1.15.0" });
      }
      if (call.method === "GET" && call.url.pathname === "/session/status") return jsonResponse({});
      if (call.method === "GET" && call.url.pathname === "/path") {
        return jsonResponse({ directory: projectDir, worktree: projectDir });
      }
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.health.status, "healthy");
  assert.equal(result.version.compatible, true);
  assert.equal(result.scopedStatusReadable, true);
  assert.equal(result.pathInfo.directory, projectDir);
  assert.deepEqual(result.sessionSmoke, {
    requested: false,
    created: false,
    destroyed: false,
    initialStatus: undefined,
  });
  assert.equal(calls.some((call) => call.method === "POST" || call.method === "DELETE"), false);
  const scopedCalls = calls.filter((call) => ["/session/status", "/path"].includes(call.url.pathname));
  assert.ok(scopedCalls.every((call) => call.url.searchParams.get("directory") === projectDir));
  assert.ok(calls.every((call) => call.headers.get("authorization") === `Basic ${btoa("opencode:secret")}`));
});

test("explicit OpenCode session smoke creates and destroys only a temporary R0 session", async () => {
  const calls = [];
  const projectDir = "C:\\project";
  const result = await runOpenCodeLivePreflight({
    projectDir,
    sessionSmoke: true,
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      calls.push(call);
      if (call.method === "GET" && call.url.pathname === "/global/health") {
        return jsonResponse({ healthy: true, version: "1.15.0" });
      }
      if (call.method === "GET" && call.url.pathname === "/session/status") return jsonResponse({});
      if (call.method === "GET" && call.url.pathname === "/path") return jsonResponse({ directory: projectDir });
      if (call.method === "POST" && call.url.pathname === "/session") {
        return jsonResponse({ id: "ses_preflight", version: "1.15.0", time: { created: 1_000 } });
      }
      if (call.method === "DELETE" && call.url.pathname === "/session/ses_preflight") return jsonResponse(true);
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.sessionSmoke, {
    requested: true,
    created: true,
    destroyed: true,
    initialStatus: "created",
  });
  const create = calls.find((call) => call.method === "POST" && call.url.pathname === "/session");
  assert.equal(create.body.metadata["9router.riskClass"], "R0");
  assert.equal(create.body.metadata.purpose, "adapter-live-preflight");
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.pathname === "/session/ses_preflight"));
});

test("preflight reports not-ready when health is degraded by missing version and does not attempt scoped reads", async () => {
  const calls = [];
  const result = await runOpenCodeLivePreflight({
    projectDir: "C:\\project",
    fetchImpl: async (url, init) => {
      const call = requestView(url, init);
      calls.push(call);
      if (call.url.pathname === "/global/health") return jsonResponse({ healthy: true });
      throw new Error(`unexpected ${call.method} ${call.url.pathname}`);
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.health.status, "degraded");
  assert.equal(result.version.compatible, false);
  assert.equal(result.scopedStatusReadable, false);
  assert.equal(calls.every((call) => call.url.pathname === "/global/health"), true);
});
