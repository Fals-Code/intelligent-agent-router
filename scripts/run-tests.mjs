import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function collectTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTests(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(full);
    }
  }
  return files;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const tests = (await collectTests(join(root, "tests"))).sort();
const child = spawn(process.execPath, ["--test", ...tests], { stdio: "inherit" });
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
