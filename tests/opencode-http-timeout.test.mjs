import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeHttpClient, OpenCodeHttpError } from "../dist/index.js";

test("OpenCode HTTP client aborts a hung request at the configured boundary", async () => {
  const client = new OpenCodeHttpClient({
    requestTimeoutMs: 25,
    fetchImpl: async (_url, init = {}) => {
      return await new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) {
          reject(new Error("expected AbortSignal"));
          return;
        }
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });

  const startedAt = Date.now();
  await assert.rejects(
    client.request({ method: "POST", path: "/session/test/prompt_async", body: {} }),
    (error) => {
      assert.ok(error instanceof OpenCodeHttpError);
      assert.match(error.message, /timed out after 25ms/i);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 1_000, "hung request must fail within a bounded interval");
});

test("OpenCode HTTP client rejects invalid timeout configuration", () => {
  assert.throws(
    () => new OpenCodeHttpClient({ requestTimeoutMs: 0 }),
    /requestTimeoutMs must be a positive finite number/i,
  );
});
