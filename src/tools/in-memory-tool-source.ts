import type { ProviderHealth, ProviderVersion, TransportId } from "../control-plane/contracts.js";
import type {
  ToolDescriptor,
  ToolSourceAdapter,
  ToolSourceExecutionRequest,
  ToolSourceExecutionResult,
} from "./contracts.js";

export type InMemoryToolHandler = (
  request: ToolSourceExecutionRequest,
) => ToolSourceExecutionResult | Promise<ToolSourceExecutionResult>;

export interface InMemoryToolSourceOptions {
  readonly sourceId: string;
  readonly transport?: TransportId;
  readonly tools: readonly ToolDescriptor[];
  readonly handlers?: Readonly<Record<string, InMemoryToolHandler>>;
  readonly health?: ProviderHealth | (() => ProviderHealth | Promise<ProviderHealth>);
  readonly version?: ProviderVersion | (() => ProviderVersion | Promise<ProviderVersion>);
}

export class InMemoryToolSource implements ToolSourceAdapter {
  readonly sourceId: string;
  readonly transport: TransportId;
  private readonly tools: readonly ToolDescriptor[];
  private readonly handlers: Readonly<Record<string, InMemoryToolHandler>>;

  constructor(private readonly options: InMemoryToolSourceOptions) {
    this.sourceId = options.sourceId;
    this.transport = options.transport ?? "native-api";
    this.tools = Object.freeze(options.tools.map((tool) => Object.freeze({ ...tool })));
    this.handlers = options.handlers ?? {};
  }

  async health(): Promise<ProviderHealth> {
    const value = this.options.health;
    if (typeof value === "function") return value();
    return (
      value ?? {
        status: "healthy",
        checkedAt: "1970-01-01T00:00:00.000Z",
        quotaState: "available",
      }
    );
  }

  async version(): Promise<ProviderVersion> {
    const value = this.options.version;
    if (typeof value === "function") return value();
    return value ?? { version: "test", protocolVersion: this.transport, compatible: true };
  }

  async discover(): Promise<readonly ToolDescriptor[]> {
    return this.tools;
  }

  async execute(request: ToolSourceExecutionRequest): Promise<ToolSourceExecutionResult> {
    if (request.tool.sourceId !== this.sourceId) {
      return {
        error: {
          name: "ToolSourceMismatch",
          message: `Tool ${request.tool.id} does not belong to source ${this.sourceId}`,
          category: "invalid_request",
          retryable: false,
        },
      };
    }
    const handler = this.handlers[request.tool.id];
    if (!handler) {
      return {
        error: {
          name: "ToolHandlerNotFound",
          message: `No in-memory handler registered for ${request.tool.id}`,
          category: "not_found",
          retryable: false,
        },
      };
    }
    return handler(request);
  }
}
