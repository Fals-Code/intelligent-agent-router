export const AUTHORITATIVE_SCHEDULER_JOBS = Object.freeze([
  Object.freeze({ code: "NOTIFICATION_OUTBOX", cronName: "phase2-notification-outbox" }),
  Object.freeze({ code: "CLAIM_DEADLINE", cronName: "phase2-claim-deadline" }),
  Object.freeze({ code: "EXPIRY_DAILY", cronName: "phase2-expiry-daily" }),
  Object.freeze({ code: "RECONCILIATION_DAILY", cronName: "phase2-reconciliation-daily" }),
]);

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

export function validateReferenceSchedulerContract(document) {
  const section = extractSection(
    String(document),
    "## Scheduler / Job Health",
    "## Backup / PITR",
  );
  const tableRows = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));

  if (tableRows.length < 2) {
    throw new Error("Scheduler evidence section must contain one Markdown table");
  }

  const nonSeparatorRows = tableRows.filter((row) => !isMarkdownSeparatorRow(row));
  if (nonSeparatorRows.length < 1) {
    throw new Error("Scheduler evidence table is missing its header row");
  }

  const dataRows = nonSeparatorRows.slice(1);
  if (dataRows.length !== AUTHORITATIVE_SCHEDULER_JOBS.length) {
    throw new Error(
      `Scheduler evidence must contain exactly ${AUTHORITATIVE_SCHEDULER_JOBS.length} authoritative job rows; observed=${dataRows.length}`,
    );
  }

  for (const job of AUTHORITATIVE_SCHEDULER_JOBS) {
    const matching = dataRows.filter((row) => row.includes(job.code) && row.includes(job.cronName));
    if (matching.length !== 1) {
      throw new Error(
        `Scheduler evidence must contain exactly one row for ${job.code} / ${job.cronName}; observed=${matching.length}`,
      );
    }
  }

  return Object.freeze({
    jobCount: AUTHORITATIVE_SCHEDULER_JOBS.length,
    jobs: Object.freeze(AUTHORITATIVE_SCHEDULER_JOBS.map((job) => Object.freeze({ ...job }))),
  });
}

function extractSection(document, startHeading, endHeading) {
  const start = document.indexOf(startHeading);
  const end = document.indexOf(endHeading);
  if (start < 0 || end <= start) {
    throw new Error(`Required section boundary missing: ${startHeading} -> ${endHeading}`);
  }
  return document.slice(start + startHeading.length, end);
}

function isMarkdownSeparatorRow(row) {
  const cells = row
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function uniqueNormalized(values) {
  return [...new Set((values ?? []).map(normalizeGitPath).filter(Boolean))].sort();
}

function normalizeGitPath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}
