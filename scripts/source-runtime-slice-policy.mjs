export const SOURCE_RUNTIME_ALLOWED_FILES = Object.freeze([
  "src/workspace/node-command-runner.ts",
  "tests/node-command-runner-sanitize.test.mjs",
]);

export const SOURCE_RUNTIME_COMMAND_IDS = Object.freeze([
  "typescript-build",
  "focused-regression",
  "independent-verifier",
]);

export function validateSourceRuntimeScope({ runtimeFiles, gitFiles }) {
  const allowed = [...SOURCE_RUNTIME_ALLOWED_FILES].map(normalizeGitPath).sort();
  const normalizedRuntime = uniqueNormalized(runtimeFiles);
  const normalizedGit = uniqueNormalized(gitFiles);

  const runtimeUnexpected = normalizedRuntime.filter((file) => !allowed.includes(file));
  if (runtimeUnexpected.length > 0) {
    throw new Error(`OpenCode diff reports out-of-scope source/runtime files: ${runtimeUnexpected.join(", ")}`);
  }

  if (!sameList(normalizedGit, allowed)) {
    throw new Error(
      `Git source/runtime scope must equal ${allowed.join(",")}; observed=${normalizedGit.join(",") || "none"}`,
    );
  }

  return Object.freeze({
    runtimeFiles: Object.freeze(normalizedRuntime),
    gitFiles: Object.freeze(normalizedGit),
    runtimeDiffObservation: normalizedRuntime.length > 0 ? "REPORTED_IN_SCOPE" : "EMPTY_ADVISORY",
    canonicalMutationEvidence: "git-worktree",
  });
}

export function validateSourceRuntimeCommandEvidence(evidence) {
  const rows = Array.isArray(evidence) ? evidence : [];
  if (rows.length !== SOURCE_RUNTIME_COMMAND_IDS.length) {
    throw new Error(
      `Source/runtime command evidence must contain exactly ${SOURCE_RUNTIME_COMMAND_IDS.length} allowlisted commands; observed=${rows.length}`,
    );
  }

  for (const id of SOURCE_RUNTIME_COMMAND_IDS) {
    const matching = rows.filter((row) => row?.id === id);
    if (matching.length !== 1) {
      throw new Error(`Source/runtime command evidence must contain exactly one ${id} result; observed=${matching.length}`);
    }
    const row = matching[0];
    if (row.timedOut === true || row.exitCode !== 0) {
      throw new Error(`Allowlisted source/runtime command failed: ${id}; exit=${row.exitCode}; timedOut=${row.timedOut === true}`);
    }
  }

  return Object.freeze({
    commandCount: SOURCE_RUNTIME_COMMAND_IDS.length,
    commandIds: Object.freeze([...SOURCE_RUNTIME_COMMAND_IDS]),
  });
}

export function sanitizeCommandOutput(value, maxLength = 4_000) {
  const input = String(value ?? "");
  return input
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, "authorization=[redacted]")
    .replace(/\bbearer\s+[^\s,;]+/gi, "bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .trim()
    .slice(0, maxLength);
}

function uniqueNormalized(values) {
  return [...new Set((values ?? []).map(normalizeGitPath).filter(Boolean))].sort();
}

function normalizeGitPath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
