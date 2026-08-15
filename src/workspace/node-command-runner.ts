import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "./contracts.js";

export interface NodeCommandRunnerOptions {
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export class NodeCommandRunner implements CommandRunner {
  private readonly maxOutputBytes: number;

  constructor(private readonly options: NodeCommandRunnerOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("maxOutputBytes must be a positive integer");
    }
  }

  async run(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        env: this.options.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= this.maxOutputBytes) stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= this.maxOutputBytes) stderr.push(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: sanitize(Buffer.concat(stdout).toString("utf8"), stdoutBytes > this.maxOutputBytes),
          stderr: sanitize(Buffer.concat(stderr).toString("utf8"), stderrBytes > this.maxOutputBytes),
        });
      });
    });
  }
}

function sanitize(value: string, truncated: boolean): string {
  const safe = value
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .trim();
  return truncated ? `${safe}\n[output truncated]` : safe;
}
