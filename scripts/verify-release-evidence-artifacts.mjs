import { readFileSync } from "node:fs";
import {
  createReleaseEvidenceVerificationFailure,
  stringifyReleaseEvidenceVerificationResult,
  verifyReleaseEvidenceArtifacts,
} from "../dist/publication/release-evidence-verifier.js";

const [verificationRoot, manifestPath, ...extra] = process.argv.slice(2);

let result;
if (!verificationRoot || !manifestPath || extra.length > 0) {
  result = createReleaseEvidenceVerificationFailure("CLI_ARGUMENTS_INVALID");
} else {
  let rawManifest;
  try {
    rawManifest = readFileSync(manifestPath, "utf8");
  } catch {
    result = createReleaseEvidenceVerificationFailure("MANIFEST_INPUT_UNREADABLE");
  }

  if (!result) {
    let manifest;
    try {
      manifest = JSON.parse(rawManifest);
    } catch {
      result = createReleaseEvidenceVerificationFailure("MANIFEST_JSON_INVALID");
    }

    if (!result) {
      result = await verifyReleaseEvidenceArtifacts({ verificationRoot, manifest });
    }
  }
}

process.stdout.write(`${stringifyReleaseEvidenceVerificationResult(result)}\n`);
process.exitCode = result.overall === "PASS" ? 0 : 1;
