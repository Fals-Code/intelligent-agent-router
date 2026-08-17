import type { EvidenceBundle } from "./evidence-bundle.js";

export interface GitHubPullRequestTarget {
  readonly repository: string;
  readonly pullRequestNumber: number;
}

export interface PublicationAuthorization {
  readonly runId: string;
  readonly bundleSha256: string;
  readonly decision: "allow" | "deny";
  readonly actor: string;
  readonly decidedAt: string;
  readonly policyReferences: readonly string[];
  readonly approvalIds: readonly string[];
}

export interface CreateGitHubPullRequestCommentInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface GitHubPullRequestCommentResult {
  readonly id: string;
  readonly reference: string;
}

export interface GitHubPublishClient {
  createPullRequestComment(
    input: CreateGitHubPullRequestCommentInput,
  ): Promise<GitHubPullRequestCommentResult>;
}

export interface GitHubPublishAdapterOptions {
  readonly maxMarkdownBytes: number;
  readonly now?: () => string;
}

export interface GitHubPublicationReceipt {
  readonly adapter: "github";
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly commentId: string;
  readonly reference: string;
  readonly bundleSha256: string;
  readonly publishedAt: string;
}

/**
 * GitHub is a publication adapter only. It receives a sealed evidence bundle and
 * an explicit policy decision, renders a bounded summary, and performs exactly
 * one client call. It has no workflow, Run Ledger, approval-store, or runtime
 * mutation capability and does not retry failed publication automatically.
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

  async publishPullRequestComment(
    bundle: EvidenceBundle,
    target: GitHubPullRequestTarget,
    authorization: PublicationAuthorization,
  ): Promise<GitHubPublicationReceipt> {
    assertTarget(target);
    assertAuthorization(bundle, authorization);
    const body = renderEvidenceBundleMarkdown(bundle, authorization);
    const bodyBytes = utf8ByteLength(body);
    if (bodyBytes > this.options.maxMarkdownBytes) {
      throw new Error(
        `GitHub evidence comment exceeds maxMarkdownBytes: bytes=${bodyBytes} max=${this.options.maxMarkdownBytes}`,
      );
    }

    const result = await this.client.createPullRequestComment({
      repository: target.repository,
      pullRequestNumber: target.pullRequestNumber,
      body,
      idempotencyKey: `9router-evidence:${bundle.runId}:${bundle.bundleSha256}`,
    });
    assertNonEmptyString(result.id, "GitHub publication comment id");
    assertNonEmptyString(result.reference, "GitHub publication reference");

    const publishedAt = this.now();
    assertTimestamp(publishedAt, "GitHub publication publishedAt");
    return Object.freeze({
      adapter: "github" as const,
      repository: target.repository,
      pullRequestNumber: target.pullRequestNumber,
      commentId: sanitizeText(result.id),
      reference: sanitizeText(result.reference),
      bundleSha256: bundle.bundleSha256,
      publishedAt,
    });
  }
}

export function renderEvidenceBundleMarkdown(
  bundle: EvidenceBundle,
  authorization: PublicationAuthorization,
): string {
  const lines: string[] = [
    "<!-- 9router-evidence-bundle -->",
    "## 9Router Evidence Bundle",
    "",
    `- Bundle: \`${inline(bundle.bundleId)}\``,
    `- Bundle SHA-256: \`${bundle.bundleSha256}\``,
    `- Run: \`${inline(bundle.runId)}\``,
    `- Outcome: **${inline(bundle.outcome)}**`,
    `- Risk: \`${inline(bundle.riskClass)}\``,
    `- Runtime: \`${inline(bundle.runLedger.runtimeId)}\``,
    `- Trace: \`${inline(bundle.traceId)}\``,
    `- Run Ledger SHA-256: \`${bundle.runLedgerSha256}\``,
    `- Publication policy: **${inline(authorization.decision)}** by \`${inline(authorization.actor)}\``,
    "",
  ];

  if (bundle.source) {
    lines.push(
      "### Source",
      "",
      `- Repository: \`${inline(bundle.source.repository)}\``,
      `- Base: \`${bundle.source.baseSha}\``,
      `- Head: \`${bundle.source.headSha}\``,
      `- Diff SHA-256: \`${bundle.source.diffSha256}\` (${bundle.source.diffBytes} bytes)`,
      `- Changed files (${bundle.source.changedFiles.length}): ${bundle.source.changedFiles.length > 0 ? bundle.source.changedFiles.map((file) => `\`${inline(file)}\``).join(", ") : "none"}`,
      "",
    );
  }

  lines.push("### Verification", "");
  if (bundle.verificationEvidence.length === 0) {
    lines.push("- No dedicated runtime verification evidence in this Run Ledger.");
  } else {
    for (const evidence of bundle.verificationEvidence) {
      lines.push(
        `- ${inline(evidence.kind)} / **${inline(evidence.status)}** / \`${inline(evidence.producer)}\` / \`${inline(evidence.reference)}\``,
      );
    }
  }
  lines.push("");

  lines.push("### CI", "");
  if (bundle.ci.length === 0) {
    lines.push("- No CI records attached.");
  } else {
    for (const ci of bundle.ci) {
      lines.push(
        `- GitHub \`${inline(ci.workflow)}\` run \`${inline(ci.runId)}\`: **${inline(ci.conclusion)}** at \`${ci.commitSha}\``,
      );
    }
  }
  lines.push("");

  lines.push("### Approvals", "");
  if (bundle.approvalIds.length === 0) lines.push("- No workflow approval IDs recorded.");
  else for (const approvalId of bundle.approvalIds) lines.push(`- \`${inline(approvalId)}\``);
  lines.push("");

  lines.push("### Artifact digests", "");
  if (bundle.artifacts.length === 0) {
    lines.push("- No artifact digests attached.");
  } else {
    for (const artifact of bundle.artifacts) {
      lines.push(`- \`${inline(artifact.name)}\`: \`${artifact.sha256}\` (${artifact.bytes} bytes)`);
    }
  }

  lines.push(
    "",
    "Provider state is evidence only. Publication does not mutate canonical 9Router workflow or Run Ledger state.",
  );
  return lines.join("\n");
}

function assertAuthorization(bundle: EvidenceBundle, authorization: PublicationAuthorization): void {
  if (authorization.runId !== bundle.runId) {
    throw new Error(`GitHub publication authorization runId mismatch: expected=${bundle.runId} actual=${authorization.runId}`);
  }
  if (authorization.bundleSha256.toUpperCase() !== bundle.bundleSha256) {
    throw new Error("GitHub publication authorization does not match sealed bundle SHA-256");
  }
  if (authorization.decision !== "allow") {
    throw new Error(`GitHub publication denied by policy for run ${bundle.runId}`);
  }
  assertNonEmptyString(authorization.actor, "GitHub publication authorization actor");
  assertTimestamp(authorization.decidedAt, "GitHub publication authorization decidedAt");
  if (
    !Array.isArray(authorization.policyReferences) ||
    authorization.policyReferences.length === 0 ||
    authorization.policyReferences.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error("GitHub publication authorization requires at least one policy reference");
  }
  if (
    !Array.isArray(authorization.approvalIds) ||
    authorization.approvalIds.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error("GitHub publication authorization approvalIds must contain non-empty strings");
  }

  const expectedApprovals = normalizeSet(bundle.approvalIds);
  const authorizedApprovals = normalizeSet(authorization.approvalIds);
  if (!sameArray(expectedApprovals, authorizedApprovals)) {
    throw new Error(
      `GitHub publication authorization approvalIds do not match Run Ledger approvals for ${bundle.runId}`,
    );
  }
  if ((bundle.riskClass === "R3" || bundle.riskClass === "R4") && expectedApprovals.length === 0) {
    throw new Error(`GitHub publication for ${bundle.riskClass} run ${bundle.runId} requires durable approval IDs`);
  }
}

function assertTarget(target: GitHubPullRequestTarget): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(target.repository)) {
    throw new Error("GitHub publication repository must use owner/name form");
  }
  assertPositiveInteger(target.pullRequestNumber, "GitHub publication pullRequestNumber");
}

function normalizeSet(values: readonly string[]): string[] {
  return [...new Set(values.map((item) => item.trim()))].sort();
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function inline(value: string): string {
  return sanitizeText(value).replace(/[\r\n]+/g, " ").replace(/`/g, "'");
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]",
    );
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
