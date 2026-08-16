import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORITATIVE_SCHEDULER_JOBS,
  validateReferenceEvidenceScope,
  validateReferenceSchedulerContract,
} from "../scripts/reference-evidence-scope.mjs";

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

test("scheduler evidence accepts exactly the four authoritative production jobs", () => {
  const evidence = validateReferenceSchedulerContract(`
# Template Bukti Rilis Produksi
## Scheduler / Job Health
| Job code | Cron name | Result | Evidence |
|---|---|---|---|
| NOTIFICATION_OUTBOX | phase2-notification-outbox | NOT_RUN | <ref> |
| CLAIM_DEADLINE | phase2-claim-deadline | NOT_RUN | <ref> |
| EXPIRY_DAILY | phase2-expiry-daily | NOT_RUN | <ref> |
| RECONCILIATION_DAILY | phase2-reconciliation-daily | NOT_RUN | <ref> |
## Backup / PITR
`);

  assert.equal(evidence.jobCount, 4);
  assert.deepEqual(evidence.jobs, AUTHORITATIVE_SCHEDULER_JOBS);
});

test("scheduler evidence rejects speculative or extra job rows", () => {
  assert.throws(
    () =>
      validateReferenceSchedulerContract(`
## Scheduler / Job Health
| Job code | Cron name | Result |
|---|---|---|
| NOTIFICATION_OUTBOX | phase2-notification-outbox | NOT_RUN |
| CLAIM_DEADLINE | phase2-claim-deadline | NOT_RUN |
| EXPIRY_DAILY | phase2-expiry-daily | NOT_RUN |
| RECONCILIATION_DAILY | phase2-reconciliation-daily | NOT_RUN |
| STOCKTAKE_REMINDER | phase2-stocktake | NOT_RUN |
## Backup / PITR
`),
    /exactly 4 authoritative job rows/,
  );
});

test("scheduler evidence rejects a missing or mismatched authoritative job", () => {
  assert.throws(
    () =>
      validateReferenceSchedulerContract(`
## Scheduler / Job Health
| Job code | Cron name | Result |
|---|---|---|
| NOTIFICATION_OUTBOX | phase2-notification-outbox | NOT_RUN |
| CLAIM_DEADLINE | phase2-claim-deadline | NOT_RUN |
| EXPIRY_DAILY | phase2-expiry-daily | NOT_RUN |
| RECONCILIATION_DAILY | phase2-wrong-name | NOT_RUN |
## Backup / PITR
`),
    /RECONCILIATION_DAILY \/ phase2-reconciliation-daily/,
  );
});
