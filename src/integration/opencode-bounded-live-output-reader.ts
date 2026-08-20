import type { BoundedLiveOutputReader } from "./bounded-live-publication.js";
import { OpenCodeHttpClient, type OpenCodeHttpClientOptions } from "../runtime/opencode-http-client.js";

interface OpenCodeMessagePart {
  readonly type?: unknown;
  readonly text?: unknown;
}

interface OpenCodeMessage {
  readonly info?: {
    readonly id?: unknown;
    readonly role?: unknown;
    readonly finish?: unknown;
    readonly time?: { readonly completed?: unknown };
  };
  readonly parts?: readonly OpenCodeMessagePart[];
}

export interface OpenCodeBoundedLiveOutputReaderOptions extends OpenCodeHttpClientOptions {
  readonly workspace: string;
  readonly maxOutputBytes: number;
}

/**
 * GET-only, ephemeral provider-output reader for a verified OpenCode session.
 *
 * The caller is responsible for separately proving the RuntimeBinding and
 * canonical Run Ledger identity. This reader never writes provider output to
 * disk, never logs it, and never mutates the provider session.
 */
export class OpenCodeBoundedLiveOutputReader implements BoundedLiveOutputReader {
  private readonly client: OpenCodeHttpClient;
  private readonly workspace: string;
  private readonly maxOutputBytes: number;

  constructor(options: OpenCodeBoundedLiveOutputReaderOptions) {
    if (!options.workspace.trim()) throw new Error("OpenCode bounded-live output reader workspace must not be empty");
    if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) throw new Error("OpenCode bounded-live output reader maxOutputBytes must be a positive integer");
    this.workspace = options.workspace;
    this.maxOutputBytes = options.maxOutputBytes;
    this.client = new OpenCodeHttpClient(options);
  }

  async read(input: { readonly runtimeId: string; readonly sessionId: string; readonly runId: string }): Promise<string> {
    if (input.runtimeId !== "opencode") throw new Error(`OpenCode bounded-live output reader cannot read runtimeId=${input.runtimeId}`);
    prepareIdentity(input.sessionId, "OpenCode bounded-live sessionId");
    prepareIdentity(input.runId, "OpenCode bounded-live runId");

    const raw = await this.client.request<readonly OpenCodeMessage[]>({
      method: "GET",
      path: `/session/${encodeURIComponent(input.sessionId)}/message`,
      directory: this.workspace,
    });
    const messages: readonly OpenCodeMessage[] = Array.isArray(raw) ? raw : [];
    const assistants = messages.filter((message: OpenCodeMessage) => stringValue(message.info?.role) === "assistant");
    if (assistants.length === 0) throw new Error("OpenCode bounded-live output reader found no assistant message");

    const completed = assistants.filter((message: OpenCodeMessage) => timestamp(message.info?.time?.completed) !== undefined || terminalFinish(message.info?.finish));
    const selected = (completed.length > 0 ? completed : assistants).at(-1);
    if (!selected) throw new Error("OpenCode bounded-live output reader could not select assistant output");
    const parts: readonly OpenCodeMessagePart[] = Array.isArray(selected.parts) ? selected.parts : [];
    const text = parts
      .filter((part: OpenCodeMessagePart) => stringValue(part.type) === "text")
      .map((part: OpenCodeMessagePart) => stringValue(part.text))
      .filter((value: string | undefined): value is string => Boolean(value))
      .join("\n")
      .trim();
    if (!text) throw new Error("OpenCode bounded-live output reader selected assistant message has no text output");
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > this.maxOutputBytes) throw new Error(`OpenCode bounded-live output exceeds maxOutputBytes: bytes=${bytes} max=${this.maxOutputBytes}`);
    return text;
  }
}

function terminalFinish(value: unknown): boolean {
  const finish = stringValue(value);
  return finish !== undefined && finish.length > 0 && finish !== "unknown";
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  return value.trim();
}
