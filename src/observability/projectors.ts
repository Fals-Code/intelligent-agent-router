import type { RunLedgerRecord } from "../control-plane/contracts.js";
import { InMemoryRunLedger } from "../control-plane/run-ledger.js";
import type { RuntimeVerificationOutcome } from "../integration/runtime-run-integration.js";
import type { EvidenceBundle } from "../publication/evidence-bundle.js";
import { verifyEvidenceBundle } from "../publication/evidence-bundle.js";
import type { GitHubPublicationReceipt } from "../publication/github-publish-adapter.js";
import type { RuntimeReconciliationReport } from "../reconciliation/runtime-reconciliation.js";
import { InternalObservabilityEventBuilder, type InternalObservabilityEvent, type ObservabilityLink } from "./internal-event.js";

export class ObservabilityProjector {
  constructor(private readonly builder: InternalObservabilityEventBuilder) {}

  async runtimeReconciliation(input: { readonly report: RuntimeReconciliationReport; readonly traceId: string; readonly projectId?: string; readonly occurredAt?: string }): Promise<InternalObservabilityEvent> {
    const { report } = input;
    const occurredAt = report.observation?.observedAt ?? input.occurredAt;
    if (!occurredAt) throw new Error("Runtime reconciliation observability requires occurredAt when no runtime observation exists");
    const attributes: Record<string, string | number | boolean | null> = {
      "router.runtime.disposition": report.disposition,
      "router.runtime.verification_required": report.verificationRequired,
      "router.runtime.automatic_redispatch_allowed": report.automaticRedispatchAllowed,
      "router.workflow.phase": report.recovery.phase,
      "router.workflow.status": report.recovery.status,
    };
    const links: ObservabilityLink[] = [];
    if (report.binding) {
      attributes["router.runtime.id"] = report.binding.runtimeId;
      attributes["router.workflow.attempt"] = report.binding.workflowAttempt;
      links.push({ type: "runtime_session", reference: `runtime:${report.binding.runtimeId}:${report.binding.sessionId}` });
    }
    if (report.observation) {
      attributes["router.runtime.status"] = report.observation.status;
      attributes["router.runtime.event_count"] = report.observation.events.count;
      attributes["router.runtime.files_changed_count"] = report.observation.diff.filesChanged.length;
      attributes["router.runtime.diff_observed"] = report.observation.diff.patchObserved;
    }
    return this.builder.create({
      name: "9router.runtime.reconciled",
      occurredAt,
      severity: report.disposition === "observation_failed" ? "error" : report.disposition === "manual_intervention" ? "warn" : "info",
      traceId: input.traceId,
      runId: report.workflowRunId,
      projectId: report.binding?.projectId ?? input.projectId,
      attributes,
      links,
    });
  }

  async runtimeVerification(input: { readonly verification: RuntimeVerificationOutcome; readonly traceId: string; readonly projectId?: string }): Promise<InternalObservabilityEvent> {
    const deterministic = input.verification.evidence.find((item) => item.kind === "deterministic_check");
    const occurredAt = deterministic?.collectedAt ?? input.verification.evidence.at(-1)?.collectedAt;
    if (!occurredAt) throw new Error("Runtime verification observability requires evidence timestamp");
    return this.builder.create({
      name: "9router.verification.completed",
      occurredAt,
      severity: input.verification.passed ? "info" : "error",
      traceId: input.traceId,
      runId: input.verification.workflowRunId,
      projectId: input.projectId,
      attributes: {
        "router.verification.passed": input.verification.passed,
        "router.verifier.id": input.verification.verifierId,
        "router.runtime.id": input.verification.runtimeId,
        "router.verification.evidence_count": input.verification.evidence.length,
      },
      links: [{ type: "runtime_session", reference: `runtime:${input.verification.runtimeId}:${input.verification.sessionId}` }],
    });
  }

  async githubPublication(input: { readonly receipt: GitHubPublicationReceipt; readonly traceId: string; readonly runId: string; readonly projectId?: string }): Promise<InternalObservabilityEvent> {
    return this.builder.create({
      name: "9router.publication.completed",
      occurredAt: input.receipt.publishedAt,
      severity: "info",
      traceId: input.traceId,
      runId: input.runId,
      projectId: input.projectId,
      attributes: {
        "router.publication.adapter": input.receipt.adapter,
        "router.publication.operation": input.receipt.operation,
        "router.publication.pull_request_number": input.receipt.pullRequestNumber,
      },
      links: [
        { type: "evidence_bundle", reference: input.receipt.bundleId },
        { type: "publication", reference: input.receipt.reference },
      ],
    });
  }

  async runTerminal(input: { readonly record: RunLedgerRecord; readonly terminalAt: string; readonly bundle?: EvidenceBundle }): Promise<InternalObservabilityEvent> {
    const record = validateCanonicalRunLedger(input.record);
    const links: ObservabilityLink[] = [];
    if (input.bundle) {
      await verifyEvidenceBundle(input.bundle);
      if (input.bundle.payload.stage !== "sealed_terminal") throw new Error("Terminal run observability requires a sealed terminal evidence bundle");
      if (input.bundle.payload.runId !== record.runId || input.bundle.payload.projectId !== record.projectId || input.bundle.payload.traceId !== record.traceId || input.bundle.payload.outcome !== record.outcome) throw new Error("Terminal run observability bundle identity/outcome does not match canonical Run Ledger");
      links.push({ type: "evidence_bundle", reference: input.bundle.bundleId });
      if (input.bundle.payload.runLedgerSha256) links.push({ type: "run_ledger", reference: `sha256:${input.bundle.payload.runLedgerSha256}` });
    }
    return this.builder.create({
      name: "9router.run.terminal",
      occurredAt: input.terminalAt,
      severity: record.outcome === "failed" ? "error" : record.outcome === "cancelled" ? "warn" : "info",
      traceId: record.traceId,
      runId: record.runId,
      projectId: record.projectId,
      attributes: {
        "router.run.outcome": record.outcome,
        "router.risk.class": record.riskClass,
        "router.runtime.id": record.runtimeId,
        "router.run.evidence_count": record.evidence.length,
        "router.run.approval_count": record.approvalIds.length,
        "router.run.change_reference_count": record.changeReferences.length,
      },
      links,
    });
  }
}

function validateCanonicalRunLedger(record: RunLedgerRecord): RunLedgerRecord {
  const ledger = new InMemoryRunLedger();
  ledger.append(record);
  const canonical = ledger.get(record.runId);
  if (!canonical) throw new Error(`Observability could not validate Run Ledger record ${record.runId}`);
  return canonical;
}
