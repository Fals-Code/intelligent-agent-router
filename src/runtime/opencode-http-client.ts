export interface OpenCodeHttpClientOptions {
  readonly baseUrl?: string;
  readonly username?: string;
  readonly password?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface OpenCodeRequestOptions {
  readonly method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly directory?: string;
  readonly body?: unknown;
}

export class OpenCodeHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

export class OpenCodeHttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenCodeHttpClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:4096");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T = unknown>(options: OpenCodeRequestOptions): Promise<T> {
    const url = new URL(options.path.replace(/^\//, ""), this.baseUrl);
    const headers = new Headers({ Accept: "application/json" });
    const auth = this.authorizationHeader();
    if (auth) headers.set("Authorization", auth);

    if (options.directory) {
      if (options.method === "GET" || options.method === "HEAD") {
        url.searchParams.set("directory", options.directory);
      } else {
        headers.set("x-opencode-directory", encodeURIComponent(options.directory));
      }
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: options.method,
        headers,
        body,
      });
    } catch (error) {
      throw new OpenCodeHttpError(`OpenCode request failed: ${safeMessage(error)}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const raw = response.status === 204 ? "" : await response.text();
    if (!response.ok) {
      const safeBody = sanitize(raw);
      throw new OpenCodeHttpError(
        `OpenCode request failed with HTTP ${response.status}${safeBody ? `: ${safeBody}` : ""}`,
        response.status,
        safeBody,
      );
    }
    if (contentType.toLowerCase().includes("text/html")) {
      throw new OpenCodeHttpError(
        "OpenCode server returned text/html; this endpoint is not compatible with the connected server version",
        response.status,
      );
    }
    if (!raw.trim()) return undefined as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new OpenCodeHttpError("OpenCode server returned malformed JSON", response.status, sanitize(raw));
    }
  }

  private authorizationHeader(): string | undefined {
    const password = this.options.password;
    if (!password) return undefined;
    const username = this.options.username ?? "opencode";
    const raw = `${username}:${password}`;
    if (/[^\x00-\xFF]/.test(raw)) {
      throw new OpenCodeHttpError("OpenCode Basic Auth credentials must be Latin-1 compatible");
    }
    return `Basic ${globalThis.btoa(raw)}`;
  }
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return parsed.toString();
}

function safeMessage(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}

function sanitize(value: string): string {
  return value
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2_000);
}
