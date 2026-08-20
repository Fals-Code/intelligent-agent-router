import { createHash } from "node:crypto";
import { execFile as execFileCallback, fork } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  BoundedLiveSideEffectRecoveryCoordinator,
  IsolatedLoopbackBoundedLiveSinkClient,
  JsonlBoundedLiveSideEffectJournal,
  verifyBoundedLiveSideEffectRecoveryReport,
} from "../dist/index.js";

const execFile = promisify(execFileCallback);

const projectDir = resolve(
  process.env.ROUTER_BOUNDED_LIVE_PROJECT_DIR?.trim() || process.cwd()
);

const stateRootInput =
  process.env.ROUTER_BOUNDED_LIVE_STATE_ROOT?.trim();

const sinkHost = "127.0.0.1";
const sinkPort = parsePort(
  process.env.ROUTER_BOUNDED_LIVE_SINK_PORT || "4097"
);

const sinkBaseUrl = `http://${sinkHost}:${sinkPort}`;

const referenceSubjectId = "opencode:9router/hemat";
const candidateSubjectId = "opencode:9router/smart";

const PUBLICATION_OPERATION_ID = "op:pub-recovery-1";
const PUBLICATION_IDEMPOTENCY_KEY = "idem:pub-recovery-1";
const PUBLICATION_AUTHORITY_ID = "auth:pub-recovery-1";
const PUBLICATION_SAMPLE_ID = "sample-pub-recovery-1";
const PUBLICATION_OUTPUT = "mock-candidate-output";
const PUBLICATION_OUTPUT_SHA256 = sha256Text(PUBLICATION_OUTPUT);

const RESTORE_OPERATION_ID = "op:res-recovery-1";
const RESTORE_IDEMPOTENCY_KEY = "idem:res-recovery-1";
const RESTORE_AUTHORITY_ID = "auth:restore-recovery-1";

const RESERVED_OPERATION_ID = "op:reserved-only-1";
const RESERVED_IDEMPOTENCY_KEY = "idem:reserved-only-1";

const UNKNOWN_OPERATION_ID = "op:error-unknown-1";
const UNKNOWN_IDEMPOTENCY_KEY = "idem:error-unknown-1";

const COMMITTED_OPERATION_ID = "op:committed-control-1";
const COMMITTED_IDEMPOTENCY_KEY = "idem:committed-control-1";

if (!stateRootInput) {
  throw new Error("ROUTER_BOUNDED_LIVE_STATE_ROOT is required");
}

const stateRoot = resolve(stateRootInput);

assertTempOnly(stateRoot);

if (process.env.RECOVERY_PROOF_PROCESS_ROLE) {
  const role = process.env.RECOVERY_PROOF_PROCESS_ROLE;
  const scenarioRoot = resolve(
    requiredEnv("RECOVERY_PROOF_SCENARIO_ROOT")
  );

  assertWithinStateRoot(scenarioRoot);

  runProcessRole(role, scenarioRoot)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(`${safeError(error)}\n`);
      process.exit(1);
    });
} else {
  runMainOrchestrator().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        overall: "FAIL",
        error: safeError(error),
      })}\n`
    );
    process.exitCode = 1;
  });
}

async function runMainOrchestrator() {
  /*
   * State is explicitly TEMP-only. The wrapper gives each proof run
   * its own unique root, so removing it here cannot touch repository
   * or production state.
   */
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });

  const originalHead = await gitOutput(["rev-parse", "HEAD"]);
  const originalSnapshot = await workingTreeSnapshot();

  const roots = {
    reserved: join(stateRoot, "scenario-reserved"),
    publication: join(stateRoot, "scenario-publication"),
    restore: join(stateRoot, "scenario-restore"),
    unknown: join(stateRoot, "scenario-unknown"),
    committed: join(stateRoot, "scenario-committed"),
  };

  for (const root of Object.values(roots)) {
    await mkdir(root, { recursive: true });
  }

  // ==========================================================
  // SCENARIO 1 — RESERVATION EXISTS, SINK AUTHORITATIVELY ABSENT
  // ==========================================================

  let reservedSink;

  try {
    reservedSink = await startSinkServer(roots.reserved);

    const s1A = await runInSubprocess(
      "SCENARIO_RESERVED_A",
      roots.reserved
    );

    const s1B = await runInSubprocess(
      "SCENARIO_RESERVED_B",
      roots.reserved
    );

    var reservedPair = { a: s1A, b: s1B };
  } finally {
    await stopSinkServer(reservedSink);
  }

  // ==========================================================
  // SCENARIO 2 — PUBLICATION APPLIED, PROCESS DIES BEFORE COMMIT
  // ==========================================================

  let publicationSinkA;
  let publicationSinkB;

  try {
    publicationSinkA = await startSinkServer(roots.publication);
    const publicationSinkAPid = publicationSinkA.pid;

    const s2A = await runInSubprocess(
      "SCENARIO_PUBLICATION_A",
      roots.publication
    );

    await stopSinkServer(publicationSinkA);
    publicationSinkA = undefined;

    publicationSinkB = await startSinkServer(roots.publication);
    const publicationSinkBPid = publicationSinkB.pid;

    const s2B = await runInSubprocess(
      "SCENARIO_PUBLICATION_B",
      roots.publication
    );

    var publicationPair = {
      a: s2A,
      b: s2B,
      sinkAPid: publicationSinkAPid,
      sinkBPid: publicationSinkBPid,
    };
  } finally {
    await stopSinkServer(publicationSinkA);
    await stopSinkServer(publicationSinkB);
  }

  // ==========================================================
  // SCENARIO 3 — RESTORE APPLIED, PROCESS DIES BEFORE COMMIT
  // ==========================================================

  let restoreSinkA;
  let restoreSinkB;

  try {
    restoreSinkA = await startSinkServer(roots.restore);
    const restoreSinkAPid = restoreSinkA.pid;

    const s3A = await runInSubprocess(
      "SCENARIO_RESTORE_A",
      roots.restore
    );

    await stopSinkServer(restoreSinkA);
    restoreSinkA = undefined;

    restoreSinkB = await startSinkServer(roots.restore);
    const restoreSinkBPid = restoreSinkB.pid;

    const s3B = await runInSubprocess(
      "SCENARIO_RESTORE_B",
      roots.restore
    );

    var restorePair = {
      a: s3A,
      b: s3B,
      sinkAPid: restoreSinkAPid,
      sinkBPid: restoreSinkBPid,
    };
  } finally {
    await stopSinkServer(restoreSinkA);
    await stopSinkServer(restoreSinkB);
  }

  // ==========================================================
  // SCENARIO 4 — OPERATION_ERROR + LATER ABSENCE
  // ==========================================================

  let unknownSink;

  try {
    unknownSink = await startSinkServer(roots.unknown);

    const s4A = await runInSubprocess(
      "SCENARIO_UNKNOWN_A",
      roots.unknown
    );

    const s4B = await runInSubprocess(
      "SCENARIO_UNKNOWN_B",
      roots.unknown
    );

    var unknownPair = { a: s4A, b: s4B };
  } finally {
    await stopSinkServer(unknownSink);
  }

  // ==========================================================
  // CONTROL — DURABLE COMMIT. PROCESS B MUST NOT PROBE.
  // No sink server is intentionally running here. If the committed
  // fast path probes, the proof will fail classification/probe count.
  // ==========================================================

  const sControlA = await runInSubprocess(
    "SCENARIO_COMMITTED_A",
    roots.committed
  );

  const sControlB = await runInSubprocess(
    "SCENARIO_COMMITTED_B",
    roots.committed
  );

  const committedPair = {
    a: sControlA,
    b: sControlB,
  };

  // ==========================================================
  // DURABLE STATE INSPECTION
  // ==========================================================

  const publicationStatePath =
    join(roots.publication, "sink-state.json");

  const restoreStatePath =
    join(roots.restore, "sink-state.json");

  const publicationJournalPath =
    join(roots.publication, "side-effects.jsonl");

  const restoreJournalPath =
    join(roots.restore, "side-effects.jsonl");

  const publicationStateRaw =
    await readFile(publicationStatePath, "utf8");

  const restoreStateRaw =
    await readFile(restoreStatePath, "utf8");

  const publicationState = JSON.parse(publicationStateRaw);
  const restoreState = JSON.parse(restoreStateRaw);

  const publicationCount =
    publicationState.publications.filter(
      (entry) =>
        entry.idempotencyKey === PUBLICATION_IDEMPOTENCY_KEY
    ).length;

  const restoreCount =
    restoreState.restores.filter(
      (entry) =>
        entry.idempotencyKey === RESTORE_IDEMPOTENCY_KEY
    ).length;

  const publicationDuplicateCount =
    Math.max(0, publicationCount - 1);

  const restoreDuplicateCount =
    Math.max(0, restoreCount - 1);

  const reports = [
    reservedPair.b.report,
    publicationPair.b.report,
    restorePair.b.report,
    unknownPair.b.report,
    committedPair.b.report,
  ];

  const automaticRetryAllowed =
    !reports.every(
      (report) =>
        report.payload.automaticRetryAllowed === false
    );

  const automaticMutationAllowed =
    !reports.every(
      (report) =>
        report.payload.automaticMutationAllowed === false
    );

  const recoveryPostSideEffectCalls =
    reservedPair.b.sideEffectCalls +
    publicationPair.b.sideEffectCalls +
    restorePair.b.sideEffectCalls +
    unknownPair.b.sideEffectCalls +
    committedPair.b.sideEffectCalls;

  const committedPathProbes =
    committedPair.b.probeCalls;

  const processRestartProven =
    reservedPair.a.pid !== reservedPair.b.pid &&
    publicationPair.a.pid !== publicationPair.b.pid &&
    restorePair.a.pid !== restorePair.b.pid &&
    unknownPair.a.pid !== unknownPair.b.pid &&
    committedPair.a.pid !== committedPair.b.pid &&
    publicationPair.sinkAPid !== publicationPair.sinkBPid &&
    restorePair.sinkAPid !== restorePair.sinkBPid;

  const journalReopened =
    reservedPair.b.journalReopened === true &&
    publicationPair.b.journalReopened === true &&
    restorePair.b.journalReopened === true &&
    unknownPair.b.journalReopened === true &&
    committedPair.b.journalReopened === true;

  const rawProviderOutputPersisted =
    publicationState.rawOutputPersisted !== false ||
    restoreState.rawOutputPersisted !== false ||
    /"output"\s*:/.test(publicationStateRaw) ||
    /"output"\s*:/.test(restoreStateRaw);

  const finalHead =
    await gitOutput(["rev-parse", "HEAD"]);

  const finalSnapshot =
    await workingTreeSnapshot();

  const gitHeadUnchanged =
    finalHead === originalHead;

  const workingTreeUnchanged =
    sameArray(finalSnapshot, originalSnapshot);

  const durableHashes = {
    publicationJournalSha256:
      await sha256File(publicationJournalPath),
    publicationSinkStateSha256:
      await sha256File(publicationStatePath),
    restoreJournalSha256:
      await sha256File(restoreJournalPath),
    restoreSinkStateSha256:
      await sha256File(restoreStatePath),
  };

  const result = {
    processAPid: publicationPair.a.pid,
    processBPid: publicationPair.b.pid,
    processRestartProven,
    journalReopened,
    publicationDuplicateCount,
    restoreDuplicateCount,
    reservedOnlyClassification:
      reservedPair.b.report.payload.classification,
    publicationRecoveryClassification:
      publicationPair.b.report.payload.classification,
    restoreRecoveryClassification:
      restorePair.b.report.payload.classification,
    unknownRecoveryClassification:
      unknownPair.b.report.payload.classification,
    committedRecoveryClassification:
      committedPair.b.report.payload.classification,
    automaticRetryAllowed,
    automaticMutationAllowed,
    recoveryPostSideEffectCalls,
    committedPathProbes,
    rawProviderOutputPersisted,
    productionRoutingMutationAllowed: false,
    automaticRedispatchAllowed: false,
    isolatedSinkLoopbackOnly: true,
    gitHeadUnchanged,
    workingTreeUnchanged,
    durableHashes,
  };

  // ==========================================================
  // FAIL-CLOSED ASSERTIONS — NOTHING MAY PRINT PASS BEFORE THESE
  // ==========================================================

  assertInvariant(
    Number.isInteger(result.processAPid) &&
      result.processAPid > 0,
    "Process A PID evidence is invalid"
  );

  assertInvariant(
    Number.isInteger(result.processBPid) &&
      result.processBPid > 0,
    "Process B PID evidence is invalid"
  );

  assertInvariant(
    result.processAPid !== result.processBPid,
    "Process A and Process B are not distinct"
  );

  assertInvariant(
    result.processRestartProven === true,
    "Required process/sink restart topology was not proven"
  );

  assertInvariant(
    result.journalReopened === true,
    "Process B did not reopen durable journals"
  );

  assertInvariant(
    publicationCount === 1,
    `Expected exactly one publication, observed ${publicationCount}`
  );

  assertInvariant(
    restoreCount === 1,
    `Expected exactly one restore, observed ${restoreCount}`
  );

  assertInvariant(
    result.publicationDuplicateCount === 0,
    "Duplicate publication detected"
  );

  assertInvariant(
    result.restoreDuplicateCount === 0,
    "Duplicate restore detected"
  );

  assertInvariant(
    result.reservedOnlyClassification ===
      "explicit_retry_eligible",
    `Reserved-only classification drifted: ${result.reservedOnlyClassification}`
  );

  assertInvariant(
    result.publicationRecoveryClassification ===
      "external_commit_observed",
    `Publication recovery classification drifted: ${result.publicationRecoveryClassification}`
  );

  assertInvariant(
    result.restoreRecoveryClassification ===
      "external_commit_observed",
    `Restore recovery classification drifted: ${result.restoreRecoveryClassification}`
  );

  assertInvariant(
    result.unknownRecoveryClassification ===
      "manual_reconciliation_required",
    `Unknown recovery classification drifted: ${result.unknownRecoveryClassification}`
  );

  assertInvariant(
    result.committedRecoveryClassification ===
      "consistent_committed",
    `Committed classification drifted: ${result.committedRecoveryClassification}`
  );

  assertInvariant(
    result.automaticRetryAllowed === false,
    "Automatic retry became allowed"
  );

  assertInvariant(
    result.automaticMutationAllowed === false,
    "Automatic mutation became allowed"
  );

  assertInvariant(
    result.recoveryPostSideEffectCalls === 0,
    `Recovery performed side-effect calls: ${result.recoveryPostSideEffectCalls}`
  );

  assertInvariant(
    result.committedPathProbes === 0,
    `Committed fast path performed ${result.committedPathProbes} probe call(s)`
  );

  assertInvariant(
    result.rawProviderOutputPersisted === false,
    "Raw provider output appears persisted"
  );

  assertInvariant(
    result.productionRoutingMutationAllowed === false,
    "Production routing mutation became allowed"
  );

  assertInvariant(
    result.automaticRedispatchAllowed === false,
    "Automatic redispatch became allowed"
  );

  assertInvariant(
    result.isolatedSinkLoopbackOnly === true,
    "Sink isolation is not loopback-only"
  );

  assertInvariant(
    result.gitHeadUnchanged === true,
    "Proof mutated Git HEAD"
  );

  assertInvariant(
    result.workingTreeUnchanged === true,
    "Proof mutated repository source state"
  );

  for (
    const [name, value] of
      Object.entries(result.durableHashes)
  ) {
    assertInvariant(
      /^[0-9A-F]{64}$/.test(value),
      `${name} is not real SHA-256 evidence`
    );
  }

  // ==========================================================
  // EXACT MACHINE-READABLE SUCCESS EVIDENCE
  // ==========================================================

  console.log(`processAPid=${result.processAPid}`);
  console.log(`processBPid=${result.processBPid}`);
  console.log(
    `processRestartProven=${result.processRestartProven}`
  );
  console.log(`journalReopened=${result.journalReopened}`);
  console.log(
    `publicationDuplicateCount=${result.publicationDuplicateCount}`
  );
  console.log(
    `restoreDuplicateCount=${result.restoreDuplicateCount}`
  );
  console.log(
    `reservedOnlyClassification=${result.reservedOnlyClassification}`
  );
  console.log(
    `publicationRecoveryClassification=${result.publicationRecoveryClassification}`
  );
  console.log(
    `restoreRecoveryClassification=${result.restoreRecoveryClassification}`
  );
  console.log(
    `unknownRecoveryClassification=${result.unknownRecoveryClassification}`
  );
  console.log(
    `committedRecoveryClassification=${result.committedRecoveryClassification}`
  );
  console.log(
    `automaticRetryAllowed=${result.automaticRetryAllowed}`
  );
  console.log(
    `automaticMutationAllowed=${result.automaticMutationAllowed}`
  );
  console.log(
    `recoveryPostSideEffectCalls=${result.recoveryPostSideEffectCalls}`
  );
  console.log(
    `committedPathProbes=${result.committedPathProbes}`
  );
  console.log(
    `rawProviderOutputPersisted=${result.rawProviderOutputPersisted}`
  );
  console.log(
    `productionRoutingMutationAllowed=${result.productionRoutingMutationAllowed}`
  );
  console.log(
    `automaticRedispatchAllowed=${result.automaticRedispatchAllowed}`
  );
  console.log(
    `isolatedSinkLoopbackOnly=${result.isolatedSinkLoopbackOnly}`
  );
  console.log(
    `gitHeadUnchanged=${result.gitHeadUnchanged}`
  );
  console.log(
    `workingTreeUnchanged=${result.workingTreeUnchanged}`
  );

  console.log(
    `publicationJournalSha256=${result.durableHashes.publicationJournalSha256}`
  );
  console.log(
    `publicationSinkStateSha256=${result.durableHashes.publicationSinkStateSha256}`
  );
  console.log(
    `restoreJournalSha256=${result.durableHashes.restoreJournalSha256}`
  );
  console.log(
    `restoreSinkStateSha256=${result.durableHashes.restoreSinkStateSha256}`
  );

  console.log(
    "9ROUTER ISOLATED BOUNDED-LIVE SIDE-EFFECT RECOVERY : PASS"
  );
  console.log("RESULT=PASS");
}

async function runProcessRole(role, scenarioRoot) {
  const journalPath =
    join(scenarioRoot, "side-effects.jsonl");

  const journal =
    await JsonlBoundedLiveSideEffectJournal.open({
      filePath: journalPath,
      maxFileBytes: 4 * 1024 * 1024,
      maxEventBytes: 64 * 1024,
      maxStringBytes: 2048,
    });

  const sinkClient =
    new IsolatedLoopbackBoundedLiveSinkClient({
      baseUrl: sinkBaseUrl,
      timeoutMs: 10_000,
    });

  let sideEffectCalls = 0;
  let probeCalls = 0;

  const trackingProbe = {
    id: sinkClient.id,

    async publish(input) {
      sideEffectCalls += 1;
      return sinkClient.publish(input);
    },

    async restore(input) {
      sideEffectCalls += 1;
      return sinkClient.restore(input);
    },

    async inspect(request) {
      probeCalls += 1;
      return sinkClient.inspect(request);
    },
  };

  const coordinator =
    new BoundedLiveSideEffectRecoveryCoordinator();

  const pid = process.pid;

  // ----------------------------------------------------------
  // RESERVED ONLY
  // ----------------------------------------------------------

  if (role === "SCENARIO_RESERVED_A") {
    await journal.reserve({
      kind: "publication",
      operationId: RESERVED_OPERATION_ID,
      idempotencyKey: RESERVED_IDEMPOTENCY_KEY,
      sinkId: sinkClient.id,
      authorityId: "auth:reserved-only-1",
      subjectId: candidateSubjectId,
      sampleId: "sample-reserved-only-1",
      outputSha256: sha256Text("reserved-output"),
      reservedAt: new Date().toISOString(),
    });

    return {
      pid,
      status: "reserved_only_persisted",
    };
  }

  if (role === "SCENARIO_RESERVED_B") {
    const journalReopened =
      Boolean(journal.latest(RESERVED_OPERATION_ID));

    const report = await coordinator.reconcile({
      journal,
      operationId: RESERVED_OPERATION_ID,
      probe: trackingProbe,
    });

    await verifyBoundedLiveSideEffectRecoveryReport(report);

    return {
      pid,
      journalReopened,
      report,
      sideEffectCalls,
      probeCalls,
    };
  }

  // ----------------------------------------------------------
  // PUBLICATION — DIRECT SINK CALL, NO JOURNAL COMMIT
  // ----------------------------------------------------------

  if (role === "SCENARIO_PUBLICATION_A") {
    const reservedAt =
      new Date().toISOString();

    await journal.reserve({
      kind: "publication",
      operationId: PUBLICATION_OPERATION_ID,
      idempotencyKey: PUBLICATION_IDEMPOTENCY_KEY,
      sinkId: sinkClient.id,
      authorityId: PUBLICATION_AUTHORITY_ID,
      subjectId: candidateSubjectId,
      sampleId: PUBLICATION_SAMPLE_ID,
      outputSha256: PUBLICATION_OUTPUT_SHA256,
      reservedAt,
    });

    const receipt =
      await sinkClient.publish({
        idempotencyKey: PUBLICATION_IDEMPOTENCY_KEY,
        sampleAuthorizationId: PUBLICATION_AUTHORITY_ID,
        sampleId: PUBLICATION_SAMPLE_ID,
        selectedSubjectId: candidateSubjectId,
        selectedRole: "candidate",
        output: PUBLICATION_OUTPUT,
        outputSha256: PUBLICATION_OUTPUT_SHA256,
      });

    /*
     * Deliberately return/exit WITHOUT recordCommit().
     * Durable journal remains operation_reserved while sink state
     * already contains the externally applied publication.
     */
    return {
      pid,
      status: "publication_applied_commit_missing",
      publicationReference: receipt.publicationReference,
    };
  }

  if (role === "SCENARIO_PUBLICATION_B") {
    const journalReopened =
      Boolean(journal.latest(PUBLICATION_OPERATION_ID));

    const report = await coordinator.reconcile({
      journal,
      operationId: PUBLICATION_OPERATION_ID,
      probe: trackingProbe,
    });

    await verifyBoundedLiveSideEffectRecoveryReport(report);

    return {
      pid,
      journalReopened,
      report,
      sideEffectCalls,
      probeCalls,
    };
  }

  // ----------------------------------------------------------
  // RESTORE — DIRECT SINK CALL, NO JOURNAL COMMIT
  // ----------------------------------------------------------

  if (role === "SCENARIO_RESTORE_A") {
    await journal.reserve({
      kind: "reference_restore",
      operationId: RESTORE_OPERATION_ID,
      idempotencyKey: RESTORE_IDEMPOTENCY_KEY,
      sinkId: sinkClient.id,
      authorityId: RESTORE_AUTHORITY_ID,
      subjectId: referenceSubjectId,
      reservedAt: new Date().toISOString(),
    });

    const receipt =
      await sinkClient.restore({
        idempotencyKey: RESTORE_IDEMPOTENCY_KEY,
        experimentId: "exp:recovery-proof",
        targetSubjectId: referenceSubjectId,
      });

    /*
     * Deliberately exit without journal.recordCommit().
     */
    return {
      pid,
      status: "restore_applied_commit_missing",
      restoreReference: receipt.restoreReference,
    };
  }

  if (role === "SCENARIO_RESTORE_B") {
    const journalReopened =
      Boolean(journal.latest(RESTORE_OPERATION_ID));

    const report = await coordinator.reconcile({
      journal,
      operationId: RESTORE_OPERATION_ID,
      probe: trackingProbe,
    });

    await verifyBoundedLiveSideEffectRecoveryReport(report);

    return {
      pid,
      journalReopened,
      report,
      sideEffectCalls,
      probeCalls,
    };
  }

  // ----------------------------------------------------------
  // UNKNOWN / OPERATION ERROR
  // ----------------------------------------------------------

  if (role === "SCENARIO_UNKNOWN_A") {
    const reservedAt =
      new Date().toISOString();

    await journal.reserve({
      kind: "publication",
      operationId: UNKNOWN_OPERATION_ID,
      idempotencyKey: UNKNOWN_IDEMPOTENCY_KEY,
      sinkId: sinkClient.id,
      authorityId: "auth:error-unknown-1",
      subjectId: candidateSubjectId,
      sampleId: "sample-error-unknown-1",
      outputSha256: sha256Text("unknown-output"),
      reservedAt,
    });

    await journal.recordError({
      operationId: UNKNOWN_OPERATION_ID,
      observedAt: new Date().toISOString(),
      error: "simulated network uncertainty after side-effect attempt",
    });

    return {
      pid,
      status: "operation_error_persisted",
    };
  }

  if (role === "SCENARIO_UNKNOWN_B") {
    const journalReopened =
      Boolean(journal.latest(UNKNOWN_OPERATION_ID));

    const report = await coordinator.reconcile({
      journal,
      operationId: UNKNOWN_OPERATION_ID,
      probe: trackingProbe,
    });

    await verifyBoundedLiveSideEffectRecoveryReport(report);

    return {
      pid,
      journalReopened,
      report,
      sideEffectCalls,
      probeCalls,
    };
  }

  // ----------------------------------------------------------
  // COMMITTED CONTROL
  // ----------------------------------------------------------

  if (role === "SCENARIO_COMMITTED_A") {
    const reservedAt =
      new Date().toISOString();

    await journal.reserve({
      kind: "publication",
      operationId: COMMITTED_OPERATION_ID,
      idempotencyKey: COMMITTED_IDEMPOTENCY_KEY,
      sinkId: sinkClient.id,
      authorityId: "auth:committed-control-1",
      subjectId: candidateSubjectId,
      sampleId: "sample-committed-control-1",
      outputSha256: sha256Text("committed-output"),
      reservedAt,
    });

    await journal.recordCommit({
      operationId: COMMITTED_OPERATION_ID,
      externalReference:
        "isolated-publication:committed-control-1",
      committedAt: new Date().toISOString(),
    });

    return {
      pid,
      status: "committed_control_persisted",
    };
  }

  if (role === "SCENARIO_COMMITTED_B") {
    const journalReopened =
      Boolean(journal.latest(COMMITTED_OPERATION_ID));

    const report = await coordinator.reconcile({
      journal,
      operationId: COMMITTED_OPERATION_ID,
      probe: trackingProbe,
    });

    await verifyBoundedLiveSideEffectRecoveryReport(report);

    return {
      pid,
      journalReopened,
      report,
      sideEffectCalls,
      probeCalls,
    };
  }

  throw new Error(
    `Unknown recovery proof process role: ${role}`
  );
}

function runInSubprocess(role, scenarioRoot) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = fork(
      resolve(
        "scripts/run-isolated-bounded-live-side-effect-recovery-proof.mjs"
      ),
      [],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          ROUTER_BOUNDED_LIVE_PROJECT_DIR: projectDir,
          ROUTER_BOUNDED_LIVE_STATE_ROOT: stateRoot,
          ROUTER_BOUNDED_LIVE_SINK_PORT: String(sinkPort),
          RECOVERY_PROOF_PROCESS_ROLE: role,
          RECOVERY_PROOF_SCENARIO_ROOT: scenarioRoot,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", rejectPromise);

    child.on("exit", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `Subprocess role ${role} exited code ${code}: ${
              stderr || stdout
            }`
          )
        );
        return;
      }

      try {
        const parsed =
          JSON.parse(stdout.trim());

        resolvePromise(parsed);
      } catch {
        rejectPromise(
          new Error(
            `Subprocess role ${role} returned invalid JSON: ${stdout}`
          )
        );
      }
    });
  });
}

async function startSinkServer(scenarioRoot) {
  const statePath =
    join(scenarioRoot, "sink-state.json");

  const child = fork(
    resolve("scripts/isolated-bounded-live-sink.mjs"),
    [],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        ROUTER_BOUNDED_LIVE_ISOLATED_SINK_ONLY:
          "ISOLATED_LOOPBACK_ONLY",
        ROUTER_BOUNDED_LIVE_SINK_HOST: sinkHost,
        ROUTER_BOUNDED_LIVE_SINK_PORT:
          String(sinkPort),
        ROUTER_BOUNDED_LIVE_SINK_STATE_PATH:
          statePath,
        ROUTER_BOUNDED_LIVE_REFERENCE_SUBJECT_ID:
          referenceSubjectId,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }
  );

  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const deadline =
    Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Isolated sink exited before health readiness: ${
          stderr || `exit=${child.exitCode}`
        }`
      );
    }

    try {
      const response = await fetch(
        `${sinkBaseUrl}/health`,
        {
          method: "GET",
          cache: "no-store",
          signal: AbortSignal.timeout(750),
        }
      );

      if (response.ok) {
        const value = await response.json();

        if (
          value.overall === "PASS" &&
          value.isolated === true
        ) {
          return child;
        }
      }
    } catch {
      // bounded poll until deadline
    }

    await delay(100);
  }

  await stopSinkServer(child);

  throw new Error(
    `Isolated sink did not become healthy within timeout: ${stderr}`
  );
}

async function stopSinkServer(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  if (await waitForExit(child, 5_000)) {
    return;
  }

  child.kill("SIGKILL");

  if (!(await waitForExit(child, 5_000))) {
    throw new Error(
      `Isolated sink PID ${child.pid} did not exit`
    );
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise(true);
      return;
    }

    let settled = false;

    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(true);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);

    child.once("exit", onExit);
  });
}

async function gitOutput(args) {
  const { stdout } =
    await execFile("git", args, {
      cwd: projectDir,
      windowsHide: true,
    });

  return stdout.trim();
}

async function workingTreeSnapshot() {
  const raw = await gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  return raw
    ? raw.split(/\r?\n/).filter(Boolean)
    : [];
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
    .toUpperCase();
}

function sha256Text(value) {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .toUpperCase();
}

function sameArray(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value === right[index]
    )
  );
}

function parsePort(value) {
  const port = Number(value);

  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  ) {
    throw new Error(
      "ROUTER_BOUNDED_LIVE_SINK_PORT is invalid"
    );
  }

  return port;
}

function assertTempOnly(path) {
  const tempRoot =
    resolve(tmpdir());

  const expectedPrefix =
    `${tempRoot}${sep}`.toLowerCase();

  if (
    !path.toLowerCase().startsWith(expectedPrefix)
  ) {
    throw new Error(
      `Recovery proof state must be below TEMP: ${path}`
    );
  }
}

function assertWithinStateRoot(path) {
  const expectedPrefix =
    `${stateRoot}${sep}`.toLowerCase();

  if (
    !path.toLowerCase().startsWith(expectedPrefix)
  ) {
    throw new Error(
      `Scenario state escaped proof root: ${path}`
    );
  }
}

function requiredEnv(name) {
  const value =
    process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is required`
    );
  }

  return value;
}

function assertInvariant(condition, message) {
  if (!condition) {
    throw new Error(
      `Recovery proof invariant failed: ${message}`
    );
  }
}

function delay(ms) {
  return new Promise(
    (resolvePromise) =>
      setTimeout(resolvePromise, ms)
  );
}

function safeError(error) {
  return (
    error instanceof Error
      ? error.message
      : String(error)
  )
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
      "Bearer [redacted]"
    )
    .replace(
      /(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]"
    );
}
