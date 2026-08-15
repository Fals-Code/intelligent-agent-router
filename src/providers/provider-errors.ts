export type ProviderErrorCategory =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "timeout"
  | "network"
  | "invalid_request"
  | "model_unavailable"
  | "content_policy"
  | "provider_error"
  | "aborted"
  | "unknown";

export interface ProviderError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly category: ProviderErrorCategory;
  readonly providerId: string;
  readonly internalModelId: string;
  readonly providerModelId: string;
  readonly requestId?: string;
  readonly cause?: unknown;
}

export function normalizeProviderError(input: {
  readonly error: unknown;
  readonly providerId: string;
  readonly internalModelId: string;
  readonly providerModelId: string;
  readonly requestId?: string;
  readonly retryTimeouts?: boolean;
}): ProviderError {
  const { error, providerId, internalModelId, providerModelId, requestId, retryTimeouts = true } = input;
  if (isProviderError(error)) {
    return { ...error, retryable: error.retryable && (error.category !== "timeout" || retryTimeouts) };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      name: "AbortError",
      message: "The request was aborted",
      retryable: false,
      category: "aborted",
      providerId,
      internalModelId,
      providerModelId,
      requestId,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeMessage(error.message),
      retryable: false,
      category: "unknown",
      providerId,
      internalModelId,
      providerModelId,
      requestId,
      cause: undefined,
    };
  }
  return {
    name: "Error",
    message: sanitizeMessage(String(error)),
    retryable: false,
    category: "unknown",
    providerId,
    internalModelId,
    providerModelId,
    requestId,
  };
}

export function isProviderError(value: unknown): value is ProviderError {
  return Boolean(value && typeof value === "object" && "providerId" in value && "category" in value && "retryable" in value);
}

export function sanitizeMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key\s*[:=]\s*[A-Za-z0-9._-]+/gi, "apiKey=[redacted]")
    .replace(/authorization\s*[:=]\s*[A-Za-z0-9._-]+/gi, "authorization=[redacted]");
}
