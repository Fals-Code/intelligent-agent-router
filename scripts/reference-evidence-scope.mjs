export function validateReferenceEvidenceScope({ runtimeFiles, gitFiles, allowedFile }) {
  const normalizedAllowed = normalizeGitPath(allowedFile);
  const normalizedRuntime = uniqueNormalized(runtimeFiles);
  const normalizedGit = uniqueNormalized(gitFiles);

  const runtimeUnexpected = normalizedRuntime.filter((file) => file !== normalizedAllowed);
  if (runtimeUnexpected.length > 0) {
    throw new Error(`OpenCode diff reports out-of-scope files: ${runtimeUnexpected.join(", ")}`);
  }

  if (normalizedGit.length !== 1 || normalizedGit[0] !== normalizedAllowed) {
    throw new Error(
      `Git scope gate requires exactly ${normalizedAllowed}; observed=${normalizedGit.join(",") || "none"}`,
    );
  }

  return Object.freeze({
    runtimeFiles: Object.freeze(normalizedRuntime),
    gitFiles: Object.freeze(normalizedGit),
    runtimeDiffObservation: normalizedRuntime.length > 0 ? "REPORTED_IN_SCOPE" : "EMPTY_ADVISORY",
    canonicalMutationEvidence: "git-worktree",
  });
}

function uniqueNormalized(values) {
  return [...new Set((values ?? []).map(normalizeGitPath).filter(Boolean))].sort();
}

function normalizeGitPath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}
