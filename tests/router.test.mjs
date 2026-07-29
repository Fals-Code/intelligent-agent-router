import test from "node:test";
import assert from "node:assert/strict";
import { IntelligentAgentRouter } from "../dist/orchestrator/agent-router.js";

const router = new IntelligentAgentRouter();

test("routes fresh GitHub coding work to GitHub and a tool-capable model", async () => {
  const result = await router.route(
    "Gunakan GitHub untuk memeriksa bug terbaru pada repository, perbaiki kodenya, jalankan test, lalu buat pull request.",
  );

  assert.equal(result.analysis.domain, "software");
  assert.equal(result.analysis.requiresFreshData, true);
  assert.ok(result.selectedSkills.map((item) => item.candidate.id).includes("github"));
  assert.equal(result.primaryModel.candidate.toolUse, true);
  assert.ok(result.plan.some((step) => step.purpose === "verify"));
});

test("keeps a simple summary on the cheapest capable model", async () => {
  const result = await router.route("Ringkas paragraf ini menjadi tiga kalimat.");
  assert.equal(result.analysis.complexity, "simple");
  assert.equal(result.primaryModel.candidate.id, "openai-fast");
});

test("escalates security analysis", async () => {
  const result = await router.route(
    "Audit repository untuk kerentanan SQL injection, auth bypass, dan kebocoran secret. Buat remediation plan.",
  );

  assert.equal(result.analysis.domain, "security");
  assert.equal(result.analysis.complexity, "expert");
  assert.equal(result.primaryModel.candidate.id, "openai-frontier");
  assert.equal(result.analysis.requiresVerification, true);
});

test("adds image generation skill for visual tasks", async () => {
  const result = await router.route("Buat poster promosi dari foto produk ini.");
  assert.ok(result.selectedSkills.map((item) => item.candidate.id).includes("image-generation"));
});
