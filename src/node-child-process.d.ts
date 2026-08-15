declare module "node:child_process" {
  interface ReadableByteStream {
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
  }

  interface SpawnedProcess {
    readonly stdout: ReadableByteStream;
    readonly stderr: ReadableByteStream;
    once(event: "error", listener: (error: Error) => void): void;
    once(event: "close", listener: (code: number | null) => void): void;
  }

  interface SpawnOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly shell?: boolean;
    readonly windowsHide?: boolean;
    readonly stdio?: readonly ["ignore", "pipe", "pipe"];
  }

  export function spawn(command: string, args: readonly string[], options?: SpawnOptions): SpawnedProcess;
}
