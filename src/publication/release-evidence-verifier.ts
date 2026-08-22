import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const RELEASE_EVIDENCE_VERIFICATION_SCHEMA_VERSION = 1 as const;

export type ReleaseEvidenceVerificationOutcome = "PASS" | "FAIL";
export type ReleaseEvidenceIdentityStatus = "DECLARED_NOT_VERIFIED";
export type ReleaseEvidenceArtifactStatus = "PASS" | "FAIL";

export type ReleaseEvidenceReasonCode =
  | "CLI_ARGUMENTS_INVALID"
  | "MANIFEST_INPUT_UNREADABLE"
  | "MANIFEST_JSON_INVALID"
  | "INVALID_MANIFEST"
  | "DUPLICATE_ARTIFACT_NAME"
  | "DUPLICATE_ARTIFACT_PATH"
  | "INVALID_ARTIFACT_PATH"
  | "VERIFICATION_ROOT_UNAVAILABLE"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_NOT_REGULAR_FILE"
  | "ARTIFACT_SYMLINK_FORBIDDEN"
  | "ARTIFACT_PATH_ESCAPES_ROOT"
  | "ARTIFACT_READ_FAILED"
  | "ARTIFACT_BYTES_MISMATCH"
  | "ARTIFACT_SHA256_MISMATCH"
  | "SHA256_UNAVAILABLE";

export interface ReleaseEvidenceArtifactExpectation {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ReleaseEvidenceVerificationManifest {
  readonly schemaVersion: typeof RELEASE_EVIDENCE_VERIFICATION_SCHEMA_VERSION;
  readonly release: {
    readonly tag: string;
    readonly commitSha: string;
    readonly treeSha: string;
  };
  readonly artifacts: readonly ReleaseEvidenceArtifactExpectation[];
}

export interface ReleaseEvidenceDeclaredIdentity {
  readonly kind: "git_tag" | "git_commit" | "git_tree";
  readonly value: string;
  readonly status: ReleaseEvidenceIdentityStatus;
}

export interface ReleaseEvidenceSubjectIdentity {
  readonly tag: ReleaseEvidenceDeclaredIdentity;
  readonly commit: ReleaseEvidenceDeclaredIdentity;
  readonly tree: ReleaseEvidenceDeclaredIdentity;
}

export interface ReleaseEvidenceArtifactVerification {
  readonly name: string;
  readonly path: string;
  readonly status: ReleaseEvidenceArtifactStatus;
  readonly identity: {
    readonly kind: "artifact_bytes";
    readonly algorithm: "sha256";
    readonly expectedSha256: string;
    readonly actualSha256: string | null;
    readonly expectedBytes: number;
    readonly actualBytes: number | null;
  };
  readonly reasons: readonly ReleaseEvidenceReasonCode[];
}

export interface ReleaseEvidenceVerificationResult {
  readonly schemaVersion: typeof RELEASE_EVIDENCE_VERIFICATION_SCHEMA_VERSION;
  readonly scope: "ARTIFACT_IDENTITY_ONLY";
  readonly mode: "OFFLINE_READ_ONLY";
  readonly overall: ReleaseEvidenceVerificationOutcome;
  readonly release: ReleaseEvidenceSubjectIdentity | null;
  readonly manifest: {
    readonly status: "VALID" | "INVALID";
    readonly reasons: readonly ReleaseEvidenceReasonCode[];
  };
  readonly artifacts: readonly ReleaseEvidenceArtifactVerification[];
}

export interface VerifyReleaseEvidenceArtifactsInput {
  readonly verificationRoot: string;
  readonly manifest: unknown;
}

const MAX_ARTIFACTS = 256;
const MAX_IDENTITY_TEXT = 256;

/**
 * Verifies supplied artifact bytes against an explicitly supplied manifest.
 *
 * This function is intentionally offline and read-only. A PASS proves only
 * artifact byte identity against the supplied contract. The release tag,
 * commit SHA and tree SHA remain declared subject identifiers and are never
 * promoted to independently verified Git identity by this verifier.
 */
export async function verifyReleaseEvidenceArtifacts(
  input: VerifyReleaseEvidenceArtifactsInput,
): Promise<ReleaseEvidenceVerificationResult> {
  let manifest: ReleaseEvidenceVerificationManifest;
  try {
    manifest = parseManifest(input.manifest);
  } catch (error) {
    return createReleaseEvidenceVerificationFailure(reasonFromManifestError(error));
  }

  const release = declaredReleaseIdentity(manifest);
  let root: string;
  try {
    root = realpathSync(resolve(assertVerificationRoot(input.verificationRoot)));
    if (!lstatSync(root).isDirectory()) {
      return createReleaseEvidenceVerificationFailure("VERIFICATION_ROOT_UNAVAILABLE", release, true);
    }
  } catch {
    return createReleaseEvidenceVerificationFailure("VERIFICATION_ROOT_UNAVAILABLE", release, true);
  }

  const artifacts: ReleaseEvidenceArtifactVerification[] = [];
  for (const artifact of manifest.artifacts) {
    artifacts.push(await verifyArtifact(root, artifact));
  }

  const overall: ReleaseEvidenceVerificationOutcome = artifacts.every((artifact) => artifact.status === "PASS")
    ? "PASS"
    : "FAIL";

  return freezeResult({
    schemaVersion: RELEASE_EVIDENCE_VERIFICATION_SCHEMA_VERSION,
    scope: "ARTIFACT_IDENTITY_ONLY",
    mode: "OFFLINE_READ_ONLY",
    overall,
    release,
    manifest: Object.freeze({ status: "VALID", reasons: Object.freeze([]) }),
    artifacts: Object.freeze(artifacts),
  });
}

export function createReleaseEvidenceVerificationFailure(
  reason: ReleaseEvidenceReasonCode,
  release: ReleaseEvidenceSubjectIdentity | null = null,
  manifestValid = false,
): ReleaseEvidenceVerificationResult {
  return freezeResult({
    schemaVersion: RELEASE_EVIDENCE_VERIFICATION_SCHEMA_VERSION,
    scope: "ARTIFACT_IDENTITY_ONLY",
    mode: "OFFLINE_READ_ONLY",
    overall: "FAIL",
    release,
    manifest: Object.freeze({
      status: manifestValid ? "VALID" : "INVALID",
      reasons: Object.freeze([reason]),
    }),
    artifacts: Object.freeze([]),
  });
}

export function stringifyReleaseEvidenceVerificationResult(
  result: ReleaseEvidenceVerificationResult,
): string {
  return JSON.stringify(sortJson(result));
}

async function verifyArtifact(
  root: string,
  artifact: ReleaseEvidenceArtifactExpectation,
): Promise<ReleaseEvidenceArtifactVerification> {
  const base = artifactResultBase(artifact);
  const candidate = resolve(root, artifact.path);
  if (escapesRoot(root, candidate)) {
    return failedArtifact(base, "ARTIFACT_PATH_ESCAPES_ROOT");
  }

  let realCandidate: string;
  try {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) return failedArtifact(base, "ARTIFACT_SYMLINK_FORBIDDEN");
    if (!stats.isFile()) return failedArtifact(base, "ARTIFACT_NOT_REGULAR_FILE");
    realCandidate = realpathSync(candidate);
  } catch (error) {
    return failedArtifact(base, errorCode(error) === "ENOENT" ? "ARTIFACT_MISSING" : "ARTIFACT_READ_FAILED");
  }

  if (escapesRoot(root, realCandidate)) {
    return failedArtifact(base, "ARTIFACT_PATH_ESCAPES_ROOT");
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(realCandidate);
  } catch {
    return failedArtifact(base, "ARTIFACT_READ_FAILED");
  }

  let actualSha256: string;
  try {
    actualSha256 = await sha256Bytes(bytes);
  } catch {
    return failedArtifact(
      {
        ...base,
        identity: {
          ...base.identity,
          actualBytes: bytes.byteLength,
        },
      },
      "SHA256_UNAVAILABLE",
    );
  }

  const reasons: ReleaseEvidenceReasonCode[] = [];
  if (bytes.byteLength !== artifact.bytes) reasons.push("ARTIFACT_BYTES_MISMATCH");
  if (actualSha256 !== artifact.sha256) reasons.push("ARTIFACT_SHA256_MISMATCH");

  return Object.freeze({
    ...base,
    status: reasons.length === 0 ? "PASS" : "FAIL",
    identity: Object.freeze({
      ...base.identity,
      actualSha256,
      actualBytes: bytes.byteLength,
    }),
    reasons: Object.freeze(reasons),
  });
}

function parseManifest(value: unknown): ReleaseEvidenceVerificationManifest {
  if (!isRecord(value)) throw new ManifestValidationError("INVALID_MANIFEST");
  assertExactKeys(value, ["schemaVersion", "release", "artifacts"]);
  if (value.schemaVersion !== RELEASE_EVIDENCE_VERIFICATION_SCHEMA_VERSION) {
    throw new ManifestValidationError("INVALID_MANIFEST");
  }
  if (!isRecord(value.release)) throw new ManifestValidationError("INVALID_MANIFEST");
  assertExactKeys(value.release, ["tag", "commitSha", "treeSha"]);

  const tag = strictIdentityText(value.release.tag);
  const commitSha = strictGitSha(value.release.commitSha);
  const treeSha = strictGitSha(value.release.treeSha);
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > MAX_ARTIFACTS) {
    throw new ManifestValidationError("INVALID_MANIFEST");
  }

  const names = new Set<string>();
  const paths = new Set<string>();
  const artifacts = value.artifacts.map((item) => {
    if (!isRecord(item)) throw new ManifestValidationError("INVALID_MANIFEST");
    assertExactKeys(item, ["name", "path", "sha256", "bytes"]);
    const name = strictIdentityText(item.name);
    const path = strictArtifactPath(item.path);
    const sha256 = strictSha256(item.sha256);
    const bytes = strictByteCount(item.bytes);

    const nameKey = name.toLowerCase();
    const pathKey = path.toLowerCase();
    if (names.has(nameKey)) throw new ManifestValidationError("DUPLICATE_ARTIFACT_NAME");
    if (paths.has(pathKey)) throw new ManifestValidationError("DUPLICATE_ARTIFACT_PATH");
    names.add(nameKey);
    paths.add(pathKey);
    return Object.freeze({ name, path, sha256, bytes });
  });

  artifacts.sort((left, right) => compareText(left.name, right.name) || compareText(left.path, right.path));
  return Object.freeze({
    schemaVersion: RELEASE_EVIDENCE_VERIFICATION_SCHEMA_VERSION,
    release: Object.freeze({ tag, commitSha, treeSha }),
    artifacts: Object.freeze(artifacts),
  });
}

function declaredReleaseIdentity(manifest: ReleaseEvidenceVerificationManifest): ReleaseEvidenceSubjectIdentity {
  return Object.freeze({
    tag: Object.freeze({ kind: "git_tag", value: manifest.release.tag, status: "DECLARED_NOT_VERIFIED" }),
    commit: Object.freeze({ kind: "git_commit", value: manifest.release.commitSha, status: "DECLARED_NOT_VERIFIED" }),
    tree: Object.freeze({ kind: "git_tree", value: manifest.release.treeSha, status: "DECLARED_NOT_VERIFIED" }),
  });
}

function strictIdentityText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_IDENTITY_TEXT) {
    throw new ManifestValidationError("INVALID_MANIFEST");
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ManifestValidationError("INVALID_MANIFEST");
  }
  return value;
}

function strictGitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{40}$/.test(value)) {
    throw new ManifestValidationError("INVALID_MANIFEST");
  }
  return value.toLowerCase();
}

function strictSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new ManifestValidationError("INVALID_MANIFEST");
  }
  return value.toUpperCase();
}

function strictByteCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ManifestValidationError("INVALID_MANIFEST");
  }
  return value;
}

function strictArtifactPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new ManifestValidationError("INVALID_ARTIFACT_PATH");
  }
  if (
    value.trim() !== value
    || value.includes("\\")
    || value.includes(":")
    || value.includes("\0")
    || value.startsWith("/")
    || isAbsolute(value)
  ) {
    throw new ManifestValidationError("INVALID_ARTIFACT_PATH");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.endsWith(" ")
      || segment.endsWith(".")
      || /[\u0000-\u001f\u007f]/.test(segment)
    )
  ) {
    throw new ManifestValidationError("INVALID_ARTIFACT_PATH");
  }
  return value;
}

function assertVerificationRoot(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error("invalid verification root");
  }
  return value;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort(compareText);
  const canonicalExpected = [...expected].sort(compareText);
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new ManifestValidationError("INVALID_MANIFEST");
  }
}

function artifactResultBase(artifact: ReleaseEvidenceArtifactExpectation): ReleaseEvidenceArtifactVerification {
  return {
    name: artifact.name,
    path: artifact.path,
    status: "FAIL",
    identity: {
      kind: "artifact_bytes",
      algorithm: "sha256",
      expectedSha256: artifact.sha256,
      actualSha256: null,
      expectedBytes: artifact.bytes,
      actualBytes: null,
    },
    reasons: Object.freeze([]),
  };
}

function failedArtifact(
  base: ReleaseEvidenceArtifactVerification,
  reason: ReleaseEvidenceReasonCode,
): ReleaseEvidenceArtifactVerification {
  return Object.freeze({
    ...base,
    status: "FAIL",
    identity: Object.freeze({ ...base.identity }),
    reasons: Object.freeze([reason]),
  });
}

function escapesRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA256_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function reasonFromManifestError(error: unknown): ReleaseEvidenceReasonCode {
  return error instanceof ManifestValidationError ? error.reason : "INVALID_MANIFEST";
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function freezeResult(result: ReleaseEvidenceVerificationResult): ReleaseEvidenceVerificationResult {
  return Object.freeze(result);
}

class ManifestValidationError extends Error {
  constructor(readonly reason: ReleaseEvidenceReasonCode) {
    super(reason);
  }
}
