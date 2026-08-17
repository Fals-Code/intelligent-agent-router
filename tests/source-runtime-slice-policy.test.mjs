import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_RUNTIME_ALLOWED_FILES,
  SOURCE_RUNTIME_COMMAND_IDS,
  sanitizeCommandOutput,
  validateSourceRuntimeCommandEvidence,
  validateSourceRuntimeScope,
} from "../scripts/source-runtime-slice-policy.mjs";

test("source/runtime scope accepts exact Git files while empty runtime diff stays advisory", () => {
  const evidence = validateSourceRuntimeScope({
    runtimeFiles: [],
    gitFiles: [...SOURCE_RUNTIME_ALLOWED_FILES].reverse(),
  });
  assert.deepEqual(evidence.gitFiles, [...SOURCE_RUNTIME_ALLOWED_FILES].sort());
  assert.deepEqual(evidence.runtimeFiles, []);
  assert.equal(evidence.runtimeDiffObservation, "EMPTY_ADVISORY");
  assert.equal(evidence.canonicalMutationEvidence, "git-worktree");
});

test("source/runtime scope rejects missing, extra, or runtime-reported out-of-scope files", () => {
  assert.throws(
    () => validateSourceRuntimeScope({ runtimeFiles: [], gitFiles: [SOURCE_RUNTIME_ALLOWED_FILES[0]] }),
    /Git source\/runtime scope must equal/,
  );
  assert.throws(
    () => validateSourceRuntimeScope({
      runtimeFiles: [],
      gitFiles: [...SOURCE_RUNTIME_ALLOWED_FILES, "README.md"],
    }),
    /Git source\/runtime scope must equal/,
  );
  assert.throws(
    () => validateSourceRuntimeScope({
      runtimeFiles: ["README.md"],
      gitFiles: SOURCE_RUNTIME_ALLOWED_FILES,
    }),
    /OpenCode diff reports out-of-scope source\/runtime files/,
  );
});

test("source/runtime command evidence requires exactly the fixed allowlisted PASS set", () => {
  const rows = SOURCE_RUNTIME_COMMAND_IDS.map((id) => ({ id, exitCode: 0, timedOut: false }));
  const result = validateSourceRuntimeCommandEvidence(rows);
  assert.equal(result.commandCount, SOURCE_RUNTIME_COMMAND_IDS.length);
  assert.deepEqual(result.commandIds, SOURCE_RUNTIME_COMMAND_IDS);

  assert.throws(
    () => validateSourceRuntimeCommandEvidence(rows.slice(1)),
    /must contain exactly/,
  );
  assert.throws(
    () => validateSourceRuntimeCommandEvidence(rows.map((row) => row.id === "focused-regression" ? { ...row, exitCode: 1 } : row)),
    /Allowlisted source\/runtime command failed/,
  );
});

test("harness command-output sanitizer removes the complete Bearer credential and keyed secrets", () => {
  const bearer = "BEARER_SECRET_SHOULD_NOT_SURVIVE_123";
  const password = "PASSWORD_SHOULD_NOT_SURVIVE_456";
  const access = "ACCESS_SHOULD_NOT_SURVIVE_789";
  const sanitized = sanitizeCommandOutput(
    `Authorization: Bearer ${bearer}\npassword=${password}\naccess_token=${access}`,
  );
  assert.equal(sanitized.includes(bearer), false);
  assert.equal(sanitized.includes(password), false);
  assert.equal(sanitized.includes(access), false);
  assert.match(sanitized, /authorization=\[redacted\]/i);
  assert.match(sanitized, /password=\[redacted\]/i);
  assert.match(sanitized, /access[_-]?token=\[redacted\]/i);
});
