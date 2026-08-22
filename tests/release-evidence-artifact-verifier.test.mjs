import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stringifyReleaseEvidenceVerificationResult,
  verifyReleaseEvidenceArtifacts,
} from "../dist/publication/release-evidence-verifier.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(repoRoot, "scripts", "verify-release-evidence-artifacts.mjs");
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
    assert.equal(first.release.tag.status, "DECLARED_NOT_VERIFIED");
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

test("Windows-invalid characters and reserved device basenames are rejected case-insensitively", async () => {
  await withTempRoot(async (root) => {
    const invalidPaths = [
      "bad<name.json",
      "bad>name.json",
      "bad\"name.json",
      "bad|name.json",
      "bad?name.json",
      "bad*name.json",
      "CON",
      "CON.json",
      "prn.txt",
      "AUX.txt",
      "nul.bin",
      "Com1.log",
      "COM9.proof",
      "lpt1.txt",
      "nested/LPT9.proof",
    ];

    for (const [index, path] of invalidPaths.entries()) {
      const result = await verifyReleaseEvidenceArtifacts({
        verificationRoot: root,
        manifest: manifestFor([
          { name: `invalid-${index}`, path, sha256: "A".repeat(64), bytes: 1 },
        ]),
      });
      assert.equal(result.overall, "FAIL", path);
      assert.deepEqual(result.manifest.reasons, ["INVALID_ARTIFACT_PATH"], path);
      assert.deepEqual(result.artifacts, [], path);
    }
  });
});

test("ordinary names containing reserved-name substrings and nested regular paths remain portable", async () => {
  await withTempRoot(async (root) => {
    const paths = ["console.json", "auxiliary.txt", "company1.log", "nested/lpt10.proof"];
    await mkdir(join(root, "nested"), { recursive: true });
    const artifacts = [];
    for (const [index, path] of paths.entries()) {
      const bytes = new TextEncoder().encode(`portable-${index}\n`);
      await writeFile(join(root, ...path.split("/")), bytes);
      artifacts.push({
        name: `portable-${index}`,
        path,
        sha256: await sha256(bytes),
        bytes: bytes.byteLength,
      });
    }

    const result = await verifyReleaseEvidenceArtifacts({ verificationRoot: root, manifest: manifestFor(artifacts) });
    assert.equal(result.overall, "PASS");
    assert.ok(result.artifacts.every((artifact) => artifact.status === "PASS"));
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

test("direct artifact symlink fails with ARTIFACT_SYMLINK_FORBIDDEN", async () => {
  await withTempRoot(async (root) => {
    const bytes = new TextEncoder().encode("exact symlink target\n");
    const target = join(root, "target.bin");
    const link = join(root, "proof.bin");
    await writeFile(target, bytes);
    await createRequiredSymlink(target, link, "file");

    const result = await verifyReleaseEvidenceArtifacts({
      verificationRoot: root,
      manifest: manifestFor([
        { name: "direct-link", path: "proof.bin", sha256: await sha256(bytes), bytes: bytes.byteLength },
      ]),
    });

    assert.equal(result.overall, "FAIL");
    assert.deepEqual(result.artifacts[0].reasons, ["ARTIFACT_SYMLINK_FORBIDDEN"]);
  });
});

test("parent symlink or junction cannot expose byte-identical artifact outside verification root", async () => {
  await withTempRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "9router-release-evidence-outside-"));
    try {
      const bytes = new TextEncoder().encode("byte-identical outside artifact\n");
      await writeFile(join(outside, "proof.bin"), bytes);
      await createRequiredSymlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

      const result = await verifyReleaseEvidenceArtifacts({
        verificationRoot: root,
        manifest: manifestFor([
          { name: "outside", path: "escape/proof.bin", sha256: await sha256(bytes), bytes: bytes.byteLength },
        ]),
      });

      assert.equal(result.overall, "FAIL");
      assert.deepEqual(result.artifacts[0].reasons, ["ARTIFACT_PATH_ESCAPES_ROOT"]);
      assert.notEqual(result.artifacts[0].status, "PASS");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("ordinary nested regular file inside verification root PASSes", async () => {
  await withTempRoot(async (root) => {
    const bytes = new TextEncoder().encode("nested regular artifact\n");
    await mkdir(join(root, "nested", "ci"), { recursive: true });
    await writeFile(join(root, "nested", "ci", "proof.bin"), bytes);

    const result = await verifyReleaseEvidenceArtifacts({
      verificationRoot: root,
      manifest: manifestFor([
        { name: "nested-proof", path: "nested/ci/proof.bin", sha256: await sha256(bytes), bytes: bytes.byteLength },
      ]),
    });

    assert.equal(result.overall, "PASS");
    assert.deepEqual(result.artifacts[0].reasons, []);
  });
});

test("CLI valid fixture exits 0, emits exactly one deterministic JSON result, and leaks no raw artifact content", async () => {
  await withTempRoot(async (root) => {
    const sentinel = "RAW_ARTIFACT_SENTINEL_DO_NOT_LEAK_51";
    const bytes = new TextEncoder().encode(`${sentinel}\n`);
    await writeFile(join(root, "proof.bin"), bytes);
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifestFor([
      { name: "cli-proof", path: "proof.bin", sha256: await sha256(bytes), bytes: bytes.byteLength },
    ])));

    const first = runCli([root, manifestPath]);
    const second = runCli([root, manifestPath]);
    const parsed = parseExactlyOneJsonResult(first.stdout);

    assert.equal(first.status, 0);
    assert.equal(first.signal, null);
    assert.equal(first.stderr, "");
    assert.equal(parsed.overall, "PASS");
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stderr, second.stderr);
    assert.ok(!first.stdout.includes(sentinel));
    assert.ok(!first.stderr.includes(sentinel));
  });
});

test("CLI tampered fixture exits 1 with one JSON failure and leaks no raw artifact content", async () => {
  await withTempRoot(async (root) => {
    const original = new TextEncoder().encode("expected bytes\n");
    const sentinel = "RAW_TAMPERED_SENTINEL_DO_NOT_LEAK_51";
    const tampered = new TextEncoder().encode(`${sentinel}\n`);
    await writeFile(join(root, "proof.bin"), tampered);
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifestFor([
      { name: "cli-proof", path: "proof.bin", sha256: await sha256(original), bytes: original.byteLength },
    ])));

    const run = runCli([root, manifestPath]);
    const parsed = parseExactlyOneJsonResult(run.stdout);
    assert.equal(run.status, 1);
    assert.equal(parsed.overall, "FAIL");
    assert.ok(parsed.artifacts[0].reasons.includes("ARTIFACT_SHA256_MISMATCH"));
    assert.ok(!run.stdout.includes(sentinel));
    assert.ok(!run.stderr.includes(sentinel));
  });
});

test("CLI invalid args, malformed JSON, and unreadable manifest fail with stable reason codes", async () => {
  await withTempRoot(async (root) => {
    const invalidArgs = runCli([]);
    assert.equal(invalidArgs.status, 1);
    assert.deepEqual(parseExactlyOneJsonResult(invalidArgs.stdout).manifest.reasons, ["CLI_ARGUMENTS_INVALID"]);
    assert.equal(invalidArgs.stderr, "");

    const malformedPath = join(root, "malformed.json");
    await writeFile(malformedPath, '{"schemaVersion":');
    const malformed = runCli([root, malformedPath]);
    assert.equal(malformed.status, 1);
    assert.deepEqual(parseExactlyOneJsonResult(malformed.stdout).manifest.reasons, ["MANIFEST_JSON_INVALID"]);
    assert.equal(malformed.stderr, "");

    const missing = runCli([root, join(root, "missing-manifest.json")]);
    assert.equal(missing.status, 1);
    assert.deepEqual(parseExactlyOneJsonResult(missing.stdout).manifest.reasons, ["MANIFEST_INPUT_UNREADABLE"]);
    assert.equal(missing.stderr, "");
  });
});

test("CLI valid verification stays offline under fetch/http/https/net/tls network tripwires", async () => {
  await withTempRoot(async (root) => {
    const bytes = new TextEncoder().encode("offline proof\n");
    await writeFile(join(root, "proof.bin"), bytes);
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifestFor([
      { name: "offline-proof", path: "proof.bin", sha256: await sha256(bytes), bytes: bytes.byteLength },
    ])));

    const tripwireSource = String.raw`
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
let hits = 0;
const blocked = (name) => (...args) => {
  void args;
  hits += 1;
  throw new Error("NETWORK_TRIPWIRE_HIT:" + name);
};
globalThis.fetch = blocked("fetch");
http.request = blocked("http.request");
http.get = blocked("http.get");
https.request = blocked("https.request");
https.get = blocked("https.get");
net.connect = blocked("net.connect");
net.createConnection = blocked("net.createConnection");
tls.connect = blocked("tls.connect");
syncBuiltinESMExports();
process.on("exit", () => process.stderr.write("NETWORK_TRIPWIRE_HITS=" + hits + "\n"));
`;
    const preload = `data:text/javascript,${encodeURIComponent(tripwireSource)}`;
    const run = runCli([root, manifestPath], ["--import", preload]);
    const parsed = parseExactlyOneJsonResult(run.stdout);

    assert.equal(run.status, 0);
    assert.equal(parsed.overall, "PASS");
    assert.equal(run.stderr, "NETWORK_TRIPWIRE_HITS=0\n");
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

function runCli(args, nodeArgs = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return result;
}

function parseExactlyOneJsonResult(stdout) {
  assert.ok(stdout.endsWith("\n"), "CLI stdout must end with exactly one JSON line terminator");
  const normalized = stdout.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  assert.equal(lines.at(-1), "");
  const nonEmpty = lines.filter((line) => line.length > 0);
  assert.equal(nonEmpty.length, 1, `expected exactly one JSON stdout line, got ${nonEmpty.length}`);
  return JSON.parse(nonEmpty[0]);
}

async function createRequiredSymlink(target, path, type) {
  try {
    await symlink(target, path, type);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN";
    assert.fail(`SYMLINK_TEST_ENVIRONMENT_LIMITATION:${code}`);
  }
}

async function withTempRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), "9router-release-evidence-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
