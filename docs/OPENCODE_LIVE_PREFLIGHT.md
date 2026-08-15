# OpenCode Live Adapter Preflight

This preflight validates the 9Router OpenCode adapter against a real OpenCode HTTP server without treating mock tests as production evidence.

## Safety defaults

- Loopback OpenCode servers are allowed by default.
- Non-loopback servers are refused unless `OPENCODE_ALLOW_REMOTE=true` is explicitly set.
- The default preflight is read-only: health/version, scoped session-status read, and scoped path read.
- No prompt is sent and no source-code mutation is requested.
- Temporary session creation/deletion is opt-in through `OPENCODE_LIVE_SESSION_SMOKE=true`.
- Credentials are read from environment variables and are never printed by the preflight output.

## 1. Start a stable OpenCode server

OpenCode's current server command defaults to `127.0.0.1:4096`. A fixed port is preferable for repeatable adapter validation.

```powershell
opencode serve --hostname 127.0.0.1 --port 4096
```

If Basic Auth is enabled on the server, configure `OPENCODE_SERVER_PASSWORD` before starting it. The default username is `opencode` unless overridden by `OPENCODE_SERVER_USERNAME`.

## 2. Run the read-only preflight

From the `intelligent-agent-router` repository, set the target project explicitly and run:

```powershell
$env:OPENCODE_BASE_URL = "http://127.0.0.1:4096"
$env:OPENCODE_PROJECT_DIR = "D:\proyek\sistem_rekonsiliasi_stok"
$env:OPENCODE_SERVER_USERNAME = "opencode"
# Only set the next variable when the server actually requires Basic Auth.
# $env:OPENCODE_SERVER_PASSWORD = "<your-local-password>"
$env:OPENCODE_LIVE_SESSION_SMOKE = "false"
npm run validate:opencode-live
```

Expected successful output contains:

```text
"overall": "PASS"
"health": "healthy"
"compatible": true
"scopedStatusReadable": true
```

`pathInfo` should resolve to the target project/worktree context exposed by the connected OpenCode server.

## 3. Optional reversible session smoke

After the read-only preflight passes, a temporary R0 session can be created and deleted to verify the session lifecycle adapter:

```powershell
$env:OPENCODE_LIVE_SESSION_SMOKE = "true"
npm run validate:opencode-live
```

A passing smoke run requires:

```text
"created": true
"destroyed": true
```

This smoke still does not send a coding prompt. The first prompt-based vertical-slice run remains gated on isolated worktree policy, Tool Broker grants, workflow/evidence state, and explicit risk policy.

## Failure handling

Do not bypass a failed compatibility or health result. Fix the adapter/server mismatch or quarantine the provider route. A successful unit test is not a substitute for a successful live preflight.
