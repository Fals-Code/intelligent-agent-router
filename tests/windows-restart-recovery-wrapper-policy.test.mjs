import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const wrapperUrl = new URL("../scripts/windows-reference-restart-recovery-slice.ps1", import.meta.url);

test("Windows restart/recovery wrapper stays ASCII-safe for Windows PowerShell 5.1", async () => {
  const source = await readFile(wrapperUrl, "utf8");
  const nonAscii = [...source].filter((character) => character.codePointAt(0) > 0x7f);
  assert.deepEqual(nonAscii, []);
  assert.match(source, /CONTROL-PLANE PROCESS A - PREPARE/);
  assert.match(source, /CONTROL-PLANE PROCESS B - RECOVER/);
});

test("Windows restart/recovery wrapper propagates failure through process exit status", async () => {
  const source = await readFile(wrapperUrl, "utf8");
  assert.doesNotMatch(source, /\[Environment\]::ExitCode/);
  assert.match(source, /if \(\$RunFailed\) \{ exit 1 \}\s+exit 0\s*$/);
});
