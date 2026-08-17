import { NodeCommandRunner } from "../dist/workspace/node-command-runner.js";

const bearerSecret = "VERIFIER_BEARER_SECRET_7d3f1c2a9b";
const passwordSecret = "VERIFIER_PASSWORD_SECRET_91ab72c4";
const accessTokenSecret = "VERIFIER_ACCESS_TOKEN_6e34f1a2";

const childScript = [
  `process.stdout.write(${JSON.stringify(`Authorization: Bearer ${bearerSecret}\n`)})`,
  `process.stdout.write(${JSON.stringify(`access_token=${accessTokenSecret}\n`)})`,
  `process.stderr.write(${JSON.stringify(`password=${passwordSecret}\n`)})`,
].join(";");

const runner = new NodeCommandRunner({ maxOutputBytes: 20_000 });
const result = await runner.run(process.execPath, ["-e", childScript]);

if (result.exitCode !== 0) {
  throw new Error("Independent verifier child command failed");
}

const combined = `${result.stdout}\n${result.stderr}`;
for (const secret of [bearerSecret, passwordSecret, accessTokenSecret]) {
  if (combined.includes(secret)) {
    throw new Error("Independent verifier detected an unredacted sensitive value");
  }
}

if (!/authorization=\[redacted\]/i.test(result.stdout)) {
  throw new Error("Independent verifier did not observe Authorization redaction");
}
if (!/access[_-]?token=\[redacted\]/i.test(result.stdout)) {
  throw new Error("Independent verifier did not observe access-token redaction");
}
if (!/password=\[redacted\]/i.test(result.stderr)) {
  throw new Error("Independent verifier did not observe password redaction");
}

console.log(JSON.stringify({
  overall: "PASS",
  verifier: "deterministic-node",
  checks: [
    "authorization-bearer-secret-redacted",
    "access-token-redacted",
    "password-redacted",
  ],
}));
