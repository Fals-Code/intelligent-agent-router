import type { EvidenceBundle } from "./evidence-bundle.js";
import { verifyEvidenceBundle } from "./evidence-bundle.js";

export interface PublicationAuthorization {
  readonly runId: string;
  readonly bundleSha256: string;
  readonly decision: "allow" | "deny";
  readonly actor: string;
  readonly decidedAt: string;
  readonly policyReferences: readonly string[];
  readonly approvalIds: readonly string[];
}

export interface GitHubPullRequestPublicationTarget {
  readonly repository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
  readonly draft?: boolean;
}

export interface GitHubPullRequestReference {
  readonly repository: string;
  readonly pullRequestNumber: number;
}

export interface CreateOrUpdateGitHubPullRequestInput {
  readonly repository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly idempotencyKey: string;
}

export interface CreateGitHubPullRequestCommentInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface GitHubPullRequestResult {
  readonly pullRequestNumber: number;
  readonly reference: string;
}

export interface GitHubPullRequestCommentResult {
  readonly id: string;
  readonly reference: string;
}

export interface GitHubPublishClient {
  createOrUpdatePullRequest(input: CreateOrUpdateGitHubPullRequestInput): Promise<GitHubPullRequestResult>;
  createPullRequestComment(input: CreateGitHubPullRequestCommentInput): Promise<GitHubPullRequestCommentResult>;
}

export interface GitHubPublishAdapterOptions {
  readonly maxMarkdownBytes: number;
  readonly now?: () => string;
}

export interface GitHubPublicationReceipt {
  readonly adapter: "github";
  readonly operation: "candidate_pr" | "terminal_seal";
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly reference: string;
  readonly externalId?: string;
  readonly bundleId: string;
  readonly bundleSha256: string;
  readonly publishedAt: string;
}

/**
 * GitHub remains an output adapter. Candidate publication and terminal evidence
 * sealing are separate external side effects. Neither operation can mutate
 * workflow state, Run Ledger state, runtime state, or approvals.
 */
export class GitHubPublishAdapter {
  private readonly now: () => string;

  constructor(
    private readonly client: GitHubPublishClient,
    private readonly options: GitHubPublishAdapterOptions,
  ) {
    assertPositiveInteger(options.maxMarkdownBytes, "GitHub publish maxMarkdownBytes");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async publishCandidate(
    bundle: EvidenceBundle,
    target: GitHubPullRequestPublicationTarget,
    authorization: PublicationAuthorization,
  ): Promise<GitHubPublicationReceipt> {
    await verifyEvidenceBundle(bundle);
    if (bundle.payload.stage !== "candidate") {
      throw new Error("GitHub PR publication requires an evidence bundle candidate");
    }
    assertAuthorization(bundle, authorization);
    assertPullRequestTarget(target);
    const body = renderCandidateMarkdown(bundle, authorization);
    this.assertMarkdownBound(body);

    const result = await this.client.createOrUpdatePullRequest({
      repository: target.repository,
      baseBranch: target.baseBranch,
      headBranch: target.headBranch,
      title: target.title,
      body,
      draft: target.draft ?? false,
      idempotencyKey: `${bundle.bundleId}:candidate:${bundle.bundleSha256}`,
    });
    assertPositiveInteger(result.pullRequestNumber, "GitHub publication pullRequestNumber");
    assertSafeExternalReference(result.reference, "GitHub publication reference");
    return this.receipt(
      "candidate_pr",
      target.repository,
      result.pullRequestNumber,
      result.reference,
      bundle,
    );
  }

  async publishTerminalSeal(
    bundle: EvidenceBundle,
    target: GitHubPullRequestReference,
    authorization: PublicationAuthorization,
  ): Promise<GitHubPublicationReceipt> {
    await verifyEvidenceBundle(bundle);
    if (bundle.payload.stage !== "sealed_terminal") {
      throw new Error("GitHub terminal evidence publication requires a sealed terminal bundle");
    }
    assertAuthorization(bundle, authorization);
    assertPullRequestReference(target);
    const body = renderTerminalSealMarkdown(bundle, authorization);
    this.assertMarkdownBound(body);

    const result = await this.client.createPullRequestComment({
      repository: target.repository,
      pullRequestNumber: target.pullRequestNumber,
      body,
      idempotencyKey: `${bundle.bundleId}:terminal:${bundle.bundleSha256}`,
    });
    assertSafeExternalReference(result.id, "GitHub publication comment id");
    assertSafeExternalReference(result.reference, "GitHub publication reference");
    return this.receipt(
      "terminal_seal",
      target.repository,
      target.pullRequestNumber,
      result.reference,
      bundle,
      result.id,
    );
  }

  private assertMarkdownBound(body: string): void {
    const bytes = utf8ByteLength(body);
    if (bytes > this.options.maxMarkdownBytes) {
      throw new Error(`GitHub evidence Markdown exceeds maxMarkdownBytes: bytes=${bytes} max=${this.options.maxMarkdownBytes}`);
    }
  }

  private receipt(
    operation: GitHubPublicationReceipt["operation"],
    repository: string,
    pullRequestNumber: number,
    reference: string,
    bundle: EvidenceBundle,
    externalId?: string,
  ): GitHubPublicationReceipt {
    const publishedAt = this.now();
    assertTimestamp(publishedAt, "GitHub publication publishedAt");
    return Object.freeze({
      adapter: "github" as const,
      operation,
      repository,
      pullRequestNumber,
      reference,
      externalId,
      bundleId: bundle.bundleId,
      bundleSha256: bundle.bundleSha256,
      publishedAt,
    });
  }
}

export function renderCandidateMarkdown(bundle: EvidenceBundle, authorization: PublicationAuthorization): string {
  if (bundle.payload.stage !== "candidate") throw new Error("Candidate Markdown requires candidate bundle");
  const p = bundle.payload;
  const lines = [
    "<!-- 9router-evidence-candidate -->",
    "## 9Router Publication Evidence",
    "",
    `- Bundle: \`${inline(bundle.bundleId)}\``,
    `- Candidate SHA-256: \`${bundle.bundleSha256}\``,
    `- Run: \`${inline(p.runId)}\``,
    `- Risk: \`${inline(p.riskClass)}\``,
    `- Runtime: \`${inline(p.runtimeId)}\``,
    `- Trace: \`${inline(p.traceId)}\``,
    `- Task SHA-256: \`${p.taskSha256}\``,
    `- Workspace SHA-256: \`${p.workspaceSha256}\``,
    `- Publication policy: **${authorization.decision}** by \`${inline(authorization.actor)}\``,
    "",
  ];
  appendSource(lines, bundle);
  appendVerification(lines, bundle);
  appendApprovals(lines, bundle);
  lines.push(
    "### Terminal seal",
    "",
    "- Pending. Final Run Ledger and post-publication CI evidence are attached only after terminal finalization.",
    "",
    "GitHub publication is an external side effect. It does not mark the 9Router workflow successful.",
  );
  return lines.join("\n");
}

export function renderTerminalSealMarkdown(bundle: EvidenceBundle, authorization: PublicationAuthorization): string {
  if (bundle.payload.stage !== "sealed_terminal") throw new Error("Terminal Markdown requires sealed bundle");
  const p = bundle.payload;
  const lines = [
    "<!-- 9router-evidence-terminal-seal -->",
    "## 9Router Terminal Evidence Seal",
    "",
    `- Bundle: \`${inline(bundle.bundleId)}\``,
    `- Terminal SHA-256: \`${bundle.bundleSha256}\``,
    `- Candidate SHA-256: \`${p.candidateDigest}\``,
    `- Run Ledger SHA-256: \`${p.runLedgerSha256}\``,
    `- Run: \`${inline(p.runId)}\``,
    `- Outcome: **${inline(p.outcome ?? "unknown")}**`,
    `- Trace: \`${inline(p.traceId)}\``,
    `- Publication policy: **${authorization.decision}** by \`${inline(authorization.actor)}\``,
    "",
  ];
  appendSource(lines, bundle);
  appendVerification(lines, bundle);
  appendCi(lines, bundle);
  appendApprovals(lines, bundle);
  appendArtifacts(lines, bundle);
  lines.push(
    "",
    "Run Ledger remains canonical for terminal control-plane outcome. This GitHub record is a publication receipt only.",
  );
  return lines.join("\n");
}

function appendSource(lines: string[], bundle: EvidenceBundle): void {
  const source = bundle.payload.source;
  if (!source) return;
  lines.push(
    "### Source",
    "",
    `- Repository: \`${inline(source.repository)}\``,
    `- Base: \`${source.baseSha}\``,
    `- Head: \`${source.headSha}\``,
    `- Diff SHA-256: \`${source.diffSha256}\` (${source.diffBytes} bytes)`,
    `- Changed files (${source.changedFiles.length}): ${source.changedFiles.map((file) => `\`${inline(file)}\``).join(", ")}`,
    "",
  );
}

function appendVerification(lines: string[], bundle: EvidenceBundle): void {
  lines.push("### Verification", "");
  const evidence = bundle.payload.evidence.filter(
    (item) => item.kind === "deterministic_check" || item.kind === "test" || item.kind === "review" || item.kind === "independent_review" || (item.kind === "other" && item.producer.startsWith("runtime-reconciliation:")),
  );
  if (evidence.length === 0) lines.push("- No dedicated verification references attached.");
  else for (const item of evidence) {
    lines.push(`- ${inline(item.kind)} / **${inline(item.status)}** / \`${inline(item.producer)}\` / \`${inline(item.reference)}\``);
  }
  lines.push("");
}

function appendCi(lines: string[], bundle: EvidenceBundle): void {
  lines.push("### CI", "");
  if (bundle.payload.ci.length === 0) lines.push("- No CI records attached.");
  else for (const ci of bundle.payload.ci) {
    lines.push(`- GitHub \`${inline(ci.workflow)}\` run \`${inline(ci.runId)}\`: **${ci.conclusion}** at \`${ci.commitSha}\``);
  }
  lines.push("");
}

function appendApprovals(lines: string[], bundle: EvidenceBundle): void {
  lines.push("### Durable approvals", "");
  if (bundle.payload.approvalIds.length === 0) lines.push("- No workflow approval IDs recorded.");
  else for (const approvalId of bundle.payload.approvalIds) lines.push(`- \`${inline(approvalId)}\``);
  lines.push("");
}

function appendArtifacts(lines: string[], bundle: EvidenceBundle): void {
  lines.push("### Artifact digests", "");
  if (bundle.payload.artifacts.length === 0) lines.push("- No artifact digests attached.");
  else for (const artifact of bundle.payload.artifacts) {
    lines.push(`- \`${inline(artifact.name)}\`: \`${artifact.sha256}\` (${artifact.bytes} bytes)`);
  }
}

function assertAuthorization(bundle: EvidenceBundle, authorization: PublicationAuthorization): void {
  if (authorization.runId !== bundle.payload.runId) {
    throw new Error(`GitHub publication authorization runId mismatch for ${bundle.payload.runId}`);
  }
  if (authorization.bundleSha256.toUpperCase() !== bundle.bundleSha256.toUpperCase()) {
    throw new Error("GitHub publication authorization does not match exact evidence bundle SHA-256");
  }
  if (authorization.decision !== "allow") {
    throw new Error(`GitHub publication denied by policy for run ${bundle.payload.runId}`);
  }
  assertSafeExternalReference(authorization.actor, "GitHub authorization actor");
  assertTimestamp(authorization.decidedAt, "GitHub authorization decidedAt");
  if (authorization.policyReferences.length === 0) throw new Error("GitHub publication requires a policy reference");
  authorization.policyReferences.forEach((item) => assertSafeExternalReference(item, "GitHub authorization policy reference"));
  const expected = normalizeSet(bundle.payload.approvalIds);
  const actual = normalizeSet(authorization.approvalIds);
  if (!sameArray(expected, actual)) throw new Error("GitHub publication authorization approvalIds do not match durable bundle approvals");
  if ((bundle.payload.riskClass === "R3" || bundle.payload.riskClass === "R4") && expected.length === 0) {
    throw new Error(`GitHub publication for ${bundle.payload.riskClass} requires durable approval IDs`);
  }
}

function assertPullRequestTarget(target: GitHubPullRequestPublicationTarget): void {
  assertRepository(target.repository);
  assertBranch(target.baseBranch, "GitHub baseBranch");
  assertBranch(target.headBranch, "GitHub headBranch");
  assertNonEmptyString(target.title, "GitHub pull request title");
  if (utf8ByteLength(target.title) > 256) throw new Error("GitHub pull request title exceeds 256 bytes");
}

function assertPullRequestReference(target: GitHubPullRequestReference): void {
  assertRepository(target.repository);
  assertPositiveInteger(target.pullRequestNumber, "GitHub pullRequestNumber");
}

function assertRepository(value: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error("GitHub repository must use owner/name form");
  assertSafeExternalReference(value, "GitHub repository");
}

function assertBranch(value: string, label: string): void {
  assertNonEmptyString(value, label);
  if (/\s|\.\.|~|\^|:|\?|\*|\[|\\/.test(value) || value.startsWith("-") || value.endsWith("/") || value.includes("//")) {
    throw new Error(`${label} is not a safe Git ref name`);
  }
  assertSafeExternalReference(value, label);
}

function assertSafeExternalReference(value: string, label: string): void {
  assertNonEmptyString(value, label);
  if (sanitizeText(value) !== value) throw new Error(`${label} contains secret-like material`);
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

function inline(value: string): string {
  return sanitizeText(value).replace(/[\r\n]+/g, " ").replace(/`/g, "'");
}

function normalizeSet(values: readonly string[]): string[] {
  return [...new Set(values.map((item) => item.trim()))].sort();
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
