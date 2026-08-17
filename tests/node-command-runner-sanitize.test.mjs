import test from "node:test";
import assert from "node:assert/strict";
import { NodeCommandRunner } from "../dist/index.js";

test("NodeCommandRunner output sanitizer redacts Authorization Bearer tokens and sensitive key-value patterns", async () => {
  const runner = new NodeCommandRunner();

  // Process that outputs sensitive strings to stdout and stderr
  const script = `
    console.log("Authorization: Bearer secret-token-12345");
    console.log("api_key=my-super-secret-key");
    console.error("Authorization: Bearer stderr-secret-67890");
    console.error("password: mypassword123");
  `;

  const result = await runner.run(process.execPath, ["-e", script]);

  assert.equal(result.exitCode, 0);

  // Ensure raw secrets are absent
  assert.ok(!result.stdout.includes("secret-token-12345"), "stdout contains raw bearer token");
  assert.ok(!result.stdout.includes("my-super-secret-key"), "stdout contains raw api key");
  assert.ok(!result.stderr.includes("stderr-secret-67890"), "stderr contains raw bearer token");
  assert.ok(!result.stderr.includes("mypassword123"), "stderr contains raw password");

  // Ensure redaction markers are present
  assert.ok(result.stdout.includes("Authorization=[redacted]"), "stdout missing Authorization=[redacted]");
  assert.ok(result.stdout.includes("api_key=[redacted]"), "stdout missing api_key=[redacted]");
  assert.ok(result.stderr.includes("Authorization=[redacted]"), "stderr missing Authorization=[redacted]");
  assert.ok(result.stderr.includes("password=[redacted]"), "stderr missing password=[redacted]");
});
