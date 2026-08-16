import test from "node:test";
import assert from "node:assert/strict";
import { validateReferenceEvidenceScope } from "../scripts/reference-evidence-scope.mjs";

const allowedFile = "docs/19-release-evidence-template.md";

test("empty OpenCode diff is advisory when canonical Git scope proves the exact required file", () => {
  const evidence = validateReferenceEvidenceScope({
    runtimeFiles: [],
    gitFiles: [allowedFile],
    allowedFile,
  });

  assert.deepEqual(evidence.runtimeFiles, []);
  assert.deepEqual(evidence.gitFiles, [allowedFile]);
  assert.equal(evidence.runtimeDiffObservation, "EMPTY_ADVISORY");
  assert.equal(evidence.canonicalMutationEvidence, "git-worktree");
});

test("OpenCode diff still fails closed when it reports any out-of-scope file", () => {
  assert.throws(
    () =>
      validateReferenceEvidenceScope({
        runtimeFiles: [allowedFile, "src/app/page.tsx"],
        gitFiles: [allowedFile],
        allowedFile,
      }),
    /OpenCode diff reports out-of-scope files/,
  );
});

test("canonical Git scope rejects missing or additional filesystem mutations even when runtime diff is empty", () => {
  assert.throws(
    () => validateReferenceEvidenceScope({ runtimeFiles: [], gitFiles: [], allowedFile }),
    /Git scope gate requires exactly/,
  );
  assert.throws(
    () =>
      validateReferenceEvidenceScope({
        runtimeFiles: [],
        gitFiles: [allowedFile, "README.md"],
        allowedFile,
      }),
    /Git scope gate requires exactly/,
  );
});
