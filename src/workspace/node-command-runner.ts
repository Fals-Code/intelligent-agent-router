import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "./contracts.js";

export interface NodeCommandRunnerOptions {
  readonly maxOutputBytes?: number;
  readonly env?: Record<string, string | undefined>;
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
      const decoder = new TextDecoder();
      const stdout: string[] = [];
      const stderr: string[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= this.maxOutputBytes) stdout.push(decoder.decode(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= this.maxOutputBytes) stderr.push(decoder.decode(chunk));
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: sanitize(stdout.join(""), stdoutBytes > this.maxOutputBytes),
          stderr: sanitize(stderr.join(""), stderrBytes > this.maxOutputBytes),
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
