import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stringifyReleaseEvidenceVerificationResult,
  verifyReleaseEvidenceArtifacts,
} from "../dist/publication/release-evidence-verifier.js";

const release = Object.freeze({
  tag: "v0.1.0",
  commitSha: "4d39c48d7be25db08e2e5cfff1309b6825f4cbcd",
  treeSha: "9b66ef26152ec0e0789077fda0deb417beea8441",
});

test("exact supplied artifact bytes PASS deterministically without promoting Git identities", async () => {
  await withTempRoot(async (root) => {
    const bytes = new TextEncoder().encode("release evidence\n");
    await writeFile(join(root, "ubuntu.json"), bytes);
    const manifest = manifestFor([
      {
        name: "ubuntu-check",
        path: "ubuntu.json",
        sha256: await sha256(bytes),
        bytes: bytes.byteLength,
      },
    ]);

    const first = await verifyReleaseEvidenceArtifacts({ verificationRoot: root, manifest });
    const second = await verifyReleaseEvidenceArtifacts({ verificationRoot: root, manifest });

    assert.equal(first.overall, "PASS");
    assert.equal(first.scope, "ARTIFACT_IDENTITY_ONLY");
    assert.equal(first.mode, "OFFLINE_READ_ONLY");
    assert.equal(first.release.commit.status, "DECLARED_NOT_VERIFIED");
    assert.equal(first.release.tree.status, "DECLARED_NOT_VERIFIED");
    assert.equal(first.artifacts[0].identity.kind, "artifact_bytes");
    assert.deepEqual(first, second);
    assert.equal(stringifyReleaseEvidenceVerificationResult(first), stringifyReleaseEvidenceVerificationResult(second));
  });
});

test("same-length byte tampering FAILS byte-exact SHA-256 identity", async () => {
  await withTempRoot(async (root) => {
    const original = new TextEncoder().encode("PASS\n");
    const tampered = new TextEncoder().encode("FAIL\n");
    await writeFile(join(root, "check.txt"), tampered);
    const result = await verifyReleaseEvidenceArtifacts({
      verificationRoot: root,
      manifest: manifestFor([
        {
          name: "check",
          path: "check.txt",
          sha256: await sha256(original),
          bytes: original.byteLength,
        },
      ]),
    });

    assert.equal(result.overall, "FAIL");
    assert.equal(result.artifacts[0].identity.actualBytes, original.byteLength);
    assert.deepEqual(result.artifacts[0].reasons, ["ARTIFACT_SHA256_MISMATCH"]);
  });
});

test("missing required artifact FAILS closed", async () => {
  await withTempRoot(async (root) => {
    const result = await verifyReleaseEvidenceArtifacts({
      verificationRoot: root,
      manifest: manifestFor([
        {
          name: "windows-check",
          path: "windows.json",
          sha256: "A".repeat(64),
          bytes: 10,
        },
      ]),
    });

    assert.equal(result.overall, "FAIL");
    assert.deepEqual(result.artifacts[0].reasons, ["ARTIFACT_MISSING"]);
    assert.equal(result.artifacts[0].identity.actualSha256, null);
  });
});

test("ambiguous duplicate artifact paths FAIL manifest validation", async () => {
  await withTempRoot(async (root) => {
    const result = await verifyReleaseEvidenceArtifacts({
      verificationRoot: root,
      manifest: manifestFor([
        { name: "a", path: "proof.json", sha256: "A".repeat(64), bytes: 1 },
        { name: "b", path: "PROOF.json", sha256: "B".repeat(64), bytes: 1 },
      ]),
    });

    assert.equal(result.overall, "FAIL");
    assert.equal(result.manifest.status, "INVALID");
    assert.deepEqual(result.manifest.reasons, ["DUPLICATE_ARTIFACT_PATH"]);
    assert.deepEqual(result.artifacts, []);
  });
});

test("path traversal and non-portable path forms FAIL before artifact access", async () => {
  await withTempRoot(async (root) => {
    for (const path of ["../outside.json", "C:/outside.json", "nested\\proof.json", "./proof.json"]) {
      const result = await verifyReleaseEvidenceArtifacts({
        verificationRoot: root,
        manifest: manifestFor([
          { name: `bad-${path}`, path, sha256: "A".repeat(64), bytes: 1 },
        ]),
      });
      assert.equal(result.overall, "FAIL");
      assert.deepEqual(result.manifest.reasons, ["INVALID_ARTIFACT_PATH"]);
    }
  });
});

test("malformed release or digest identity never becomes PASS", async () => {
  await withTempRoot(async (root) => {
    const malformedCommit = {
      ...manifestFor([{ name: "proof", path: "proof.json", sha256: "A".repeat(64), bytes: 1 }]),
      release: { ...release, commitSha: "not-a-commit" },
    };
    const malformedDigest = manifestFor([
      { name: "proof", path: "proof.json", sha256: "not-a-digest", bytes: 1 },
    ]);

    const commitResult = await verifyReleaseEvidenceArtifacts({ verificationRoot: root, manifest: malformedCommit });
    const digestResult = await verifyReleaseEvidenceArtifacts({ verificationRoot: root, manifest: malformedDigest });
    assert.equal(commitResult.overall, "FAIL");
    assert.equal(digestResult.overall, "FAIL");
    assert.deepEqual(commitResult.manifest.reasons, ["INVALID_MANIFEST"]);
    assert.deepEqual(digestResult.manifest.reasons, ["INVALID_MANIFEST"]);
  });
});

function manifestFor(artifacts) {
  return {
    schemaVersion: 1,
    release,
    artifacts,
  };
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function withTempRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), "9router-release-evidence-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
