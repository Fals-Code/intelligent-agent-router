import { runOpenCodeLivePreflight } from "../dist/runtime/opencode-live-preflight.js";

const projectDir = process.env.OPENCODE_PROJECT_DIR?.trim();
if (!projectDir) {
  console.error("OPENCODE_PROJECT_DIR is required. Point it at the project/worktree you want 9Router to validate.");
  process.exit(2);
}

const sessionSmoke = truthy(process.env.OPENCODE_LIVE_SESSION_SMOKE);
const allowRemote = truthy(process.env.OPENCODE_ALLOW_REMOTE);

try {
  const result = await runOpenCodeLivePreflight({
    baseUrl: process.env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096",
    projectDir,
    username: process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode",
    password: process.env.OPENCODE_SERVER_PASSWORD,
    allowRemote,
    sessionSmoke,
  });

  console.log(
    JSON.stringify(
      {
        overall: result.ready ? "PASS" : "FAIL",
        baseUrl: result.baseUrl,
        projectDir: result.projectDir,
        health: result.health.status,
        version: result.version.version,
        compatible: result.version.compatible,
        scopedStatusReadable: result.scopedStatusReadable,
        pathInfo: result.pathInfo ?? null,
        sessionSmoke: result.sessionSmoke,
        basicAuthConfigured: Boolean(process.env.OPENCODE_SERVER_PASSWORD),
      },
      null,
      2,
    ),
  );

  if (!result.ready) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        overall: "FAIL",
        error: sanitize(error instanceof Error ? error.message : String(error)),
        sessionSmokeRequested: sessionSmoke,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function sanitize(value) {
  return value
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2000);
}
