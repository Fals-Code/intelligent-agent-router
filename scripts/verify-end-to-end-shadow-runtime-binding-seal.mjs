import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  prepareShadowProvenanceRuntimeBindingSeal,
  verifyShadowProvenanceRuntimeBindingSeal,
} from "../dist/index.js";

const stateRootInput = process.env.ROUTER_SHADOW_E2E_STATE_ROOT?.trim() || process.argv[2]?.trim();
if (!stateRootInput) {
  console.error("ROUTER_SHADOW_E2E_STATE_ROOT or argv[2] is required");
  process.exit(2);
}
const stateRoot = resolve(stateRootInput);

try {
  const provenance = JSON.parse(await readFile(join(stateRoot, "provenance.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(stateRoot, "manifest.json"), "utf8"));
  const bindingRaw = await readFile(join(stateRoot, "binding.jsonl"), "utf8");
  const bindings = parseBindings(bindingRaw);
  const referenceBinding = latestBinding(bindings, provenance.payload.referenceRunId, "reference");
  const candidateBinding = latestBinding(bindings, provenance.payload.candidateRunId, "candidate");

  if (manifest.referenceRunId !== referenceBinding.workflowRunId || manifest.candidateRunId !== candidateBinding.workflowRunId) {
    throw new Error("Manifest run IDs do not match durable RuntimeBindings");
  }
  if (manifest.referenceSessionId !== referenceBinding.sessionId || manifest.candidateSessionId !== candidateBinding.sessionId) {
    throw new Error("Manifest session IDs do not match durable RuntimeBindings");
  }
  if (manifest.referenceExecutionReference !== provenance.payload.referenceExecutionReference
    || manifest.candidateExecutionReference !== provenance.payload.candidateExecutionReference) {
    throw new Error("Manifest execution references do not match sealed sample provenance");
  }

  const sources = { provenance, referenceBinding, candidateBinding };
  const seal = await prepareShadowProvenanceRuntimeBindingSeal(sources);
  await verifyShadowProvenanceRuntimeBindingSeal(seal, sources);
  const sealPath = join(stateRoot, "binding-seal.json");
  await writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`, "utf8");
  const durableSeal = JSON.parse(await readFile(sealPath, "utf8"));
  await verifyShadowProvenanceRuntimeBindingSeal(durableSeal, sources);
  const fileSha256 = createHash("sha256").update(await readFile(sealPath)).digest("hex").toUpperCase();

  console.log(JSON.stringify({
    overall: "PASS",
    referenceSlice: "9router-shadow-provenance-runtime-binding-seal",
    stateRoot,
    provenanceId: provenance.provenanceId,
    bindingSealId: durableSeal.sealId,
    bindingSealSha256: durableSeal.sealSha256,
    bindingSealFileSha256: fileSha256,
    referenceRunId: referenceBinding.workflowRunId,
    candidateRunId: candidateBinding.workflowRunId,
    referenceWorkflowAttempt: referenceBinding.workflowAttempt,
    candidateWorkflowAttempt: candidateBinding.workflowAttempt,
    referenceSessionId: referenceBinding.sessionId,
    candidateSessionId: candidateBinding.sessionId,
    exactReferenceExecutionReferenceBound: true,
    exactCandidateExecutionReferenceBound: true,
    candidateOutputExternallyVisible: false,
    automaticRedispatchAllowed: false,
    productionRoutingMutationAllowed: false,
    nextGate: "INDEPENDENT_END_TO_END_SHADOW_PROVENANCE_REVIEW",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ overall: "FAIL", stateRoot, error: safeError(error) }, null, 2));
  process.exitCode = 1;
}

function parseBindings(raw) {
  if (!raw.endsWith("\n")) throw new Error("Runtime binding journal is not newline-terminated");
  return raw.slice(0, -1).split("\n").filter(Boolean).map((line, index) => {
    const entry = JSON.parse(line);
    if (!entry || entry.schemaVersion !== 1 || entry.sequence !== index + 1 || !entry.binding) {
      throw new Error(`Runtime binding journal entry ${index + 1} is invalid`);
    }
    return entry.binding;
  });
}

function latestBinding(bindings, workflowRunId, role) {
  const matches = bindings.filter((binding) => binding.workflowRunId === workflowRunId);
  if (matches.length === 0) throw new Error(`No durable ${role} RuntimeBinding found for ${workflowRunId}`);
  return matches.at(-1);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]");
}
