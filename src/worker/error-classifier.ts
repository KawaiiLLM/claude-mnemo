export type WorkerErrorClassification =
  | "connection"
  | "deterministic"
  | "blocked";

export type WorkerAbortReason = "stall-watchdog" | "shutdown";

export const MAX_WORKER_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;

const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

const CONNECTION_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);

const DETERMINISTIC_STATUSES = new Set([400, 401, 403, 404, 413]);
const TRANSIENT_STATUSES = new Set([408, 409, 429, 529]);
const TRANSIENT_TYPES = new Set([
  "rate_limit",
  "rate_limit_error",
  "server_error",
  "overloaded_error",
  "api_error",
]);
const BLOCKED_TYPES = new Set([
  "billing_error",
  "credit_exhausted",
  "credit_exhausted_error",
  "insufficient_credits",
  "insufficient_credit",
]);
const DETERMINISTIC_TYPES = new Set([
  "authentication_failed",
  "authentication_error",
  "permission_error",
  "invalid_request",
  "invalid_request_error",
  "invalid_model",
  "model_not_found",
  "not_found_error",
  "request_too_large",
  "conflict_error",
  "business_conflict",
  "resource_conflict",
]);

const BLOCKED_TEXT =
  /\b(?:billing[_ -]?error|credit(?:s)?[_ -]?exhausted|insufficient[_ -]?credits?)\b/i;

export interface WorkerErrorDetails {
  classification: WorkerErrorClassification;
  status: number | null;
  type: string | null;
  requestId: string | null;
  retryInMs: number | null;
  retryAfter: string | null;
}

interface CollectedSignals {
  objects: Record<PropertyKey, unknown>[];
  statuses: number[];
  types: string[];
  texts: string[];
  retryInMs: number[];
  retryAfter: string[];
  requestIds: string[];
  hasConnectionSignal: boolean;
}

export class WorkerAbortError extends Error {
  readonly workerAbortReason: WorkerAbortReason;

  constructor(reason: WorkerAbortReason, message?: string) {
    super(message ?? `Worker request aborted: ${reason}`);
    this.name = "WorkerAbortError";
    this.workerAbortReason = reason;
  }
}

export function createWorkerAbortError(
  reason: WorkerAbortReason,
  message?: string,
): WorkerAbortError {
  return new WorkerAbortError(reason, message);
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizedType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  return normalized === "" ? null : normalized;
}

function numericStatus(value: unknown): number | null {
  const status =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

function clampedRetryMs(value: unknown): number | null {
  const retryMs =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(retryMs) || retryMs < 0) {
    return null;
  }
  return Math.min(Math.round(retryMs), MAX_WORKER_RETRY_DELAY_MS);
}

function headerValue(headers: unknown, name: string): string | null {
  if (!isObject(headers)) {
    return null;
  }

  const getter = headers.get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : null;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    if (Array.isArray(value)) {
      return value.length > 0 ? String(value[0]) : null;
    }
    return value === null || value === undefined ? null : String(value);
  }
  return null;
}

function headerEntries(headers: unknown): Array<[string, string]> {
  if (!isObject(headers)) {
    return [];
  }
  const entries: Array<[string, string]> = [];
  const forEach = headers.forEach;
  if (typeof forEach === "function") {
    forEach.call(headers, (value: unknown, key: unknown) => {
      entries.push([String(key), String(value)]);
    });
    return entries;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        entries.push([key, String(item)]);
      }
    } else if (value !== null && value !== undefined) {
      entries.push([key, String(value)]);
    }
  }
  return entries;
}

function collectSignals(error: unknown): CollectedSignals {
  const signals: CollectedSignals = {
    objects: [],
    statuses: [],
    types: [],
    texts: [],
    retryInMs: [],
    retryAfter: [],
    requestIds: [],
    hasConnectionSignal: false,
  };
  const seen = new Set<object>();
  const queue: unknown[] = [error];

  while (queue.length > 0 && signals.objects.length < 100) {
    const current = queue.shift();
    if (typeof current === "string") {
      signals.texts.push(current);
      const trimmed = current.trim();
      if (
        (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
        trimmed.length <= 1_000_000
      ) {
        try {
          queue.push(JSON.parse(trimmed));
        } catch {}
      }
      continue;
    }
    if (!isObject(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    signals.objects.push(current);

    const status =
      numericStatus(current.status) ?? numericStatus(current.statusCode);
    if (status !== null) {
      signals.statuses.push(status);
    }

    const type = normalizedType(current.type);
    if (type !== null) {
      signals.types.push(type);
    }
    const errorType = normalizedType(current.error);
    if (errorType !== null) {
      signals.types.push(errorType);
    }

    const directRetry = clampedRetryMs(
      current.retryInMs ?? current.retry_in_ms,
    );
    if (directRetry !== null) {
      signals.retryInMs.push(directRetry);
    }

    const retryAfter =
      headerValue(current.headers, "retry-after") ??
      (typeof current.retryAfter === "string"
        ? current.retryAfter
        : typeof current.retry_after === "string"
          ? current.retry_after
          : null);
    if (retryAfter !== null) {
      signals.retryAfter.push(retryAfter);
    }

    for (const key of ["requestId", "request_id", "request-id"] as const) {
      const value = current[key];
      if (typeof value === "string" && value.trim() !== "") {
        signals.requestIds.push(value.trim());
        break;
      }
    }
    const headerRequestId =
      headerValue(current.headers, "request-id") ??
      headerValue(current.headers, "x-request-id");
    if (headerRequestId !== null) {
      signals.requestIds.push(headerRequestId);
    }
    for (const [headerName, headerContent] of headerEntries(current.headers)) {
      const normalizedHeaderName = headerName.toLowerCase();
      if (
        normalizedHeaderName === "status" ||
        normalizedHeaderName === "x-status" ||
        normalizedHeaderName === "x-status-code"
      ) {
        const headerStatus = numericStatus(headerContent);
        if (headerStatus !== null) {
          signals.statuses.push(headerStatus);
        }
      }
      if (
        normalizedHeaderName === "error-type" ||
        normalizedHeaderName === "x-error-type" ||
        normalizedHeaderName === "anthropic-error-type"
      ) {
        const headerType = normalizedType(headerContent);
        if (headerType !== null) {
          signals.types.push(headerType);
        }
      }
      if (
        normalizedHeaderName === "error-message" ||
        normalizedHeaderName === "x-error-message"
      ) {
        signals.texts.push(headerContent);
      }
    }

    if (
      (current.type === "system" && current.subtype === "api_error") ||
      (current.type === "assistant" &&
        (current.error === "rate_limit" || current.error === "server_error"))
    ) {
      signals.hasConnectionSignal = true;
    }
    if (
      current.workerAbortReason === "stall-watchdog" ||
      current.workerAbortReason === "shutdown"
    ) {
      signals.hasConnectionSignal = true;
    }
    if (
      typeof current.code === "string" &&
      CONNECTION_ERROR_CODES.has(current.code)
    ) {
      signals.hasConnectionSignal = true;
    }
    const errorName =
      typeof current.name === "string" ? current.name : null;
    const constructorName =
      typeof current.constructor === "function"
        ? current.constructor.name
        : null;
    if (
      (errorName !== null && CONNECTION_ERROR_NAMES.has(errorName)) ||
      (constructorName !== null &&
        CONNECTION_ERROR_NAMES.has(constructorName))
    ) {
      signals.hasConnectionSignal = true;
    }

    if (typeof current.message === "string") {
      signals.texts.push(current.message);
    }
    for (const key of [
      "cause",
      "error",
      "body",
      "response",
      "data",
      "event",
      "headers",
      "message",
    ] as const) {
      queue.push(current[key]);
    }

    for (const [key, value] of Object.entries(current)) {
      if (
        typeof value === "string" &&
        (key === "message" || key === "body" || key === "detail")
      ) {
        signals.texts.push(value);
      }
    }
  }

  if (signals.texts.some((text) => /\bfetch failed\b/i.test(text))) {
    signals.hasConnectionSignal = true;
  }

  return signals;
}

function classifySignals(signals: CollectedSignals): WorkerErrorClassification {
  const hasType = (types: Set<string>) =>
    signals.types.some((type) => types.has(type));

  // These statuses must win even when the SDK attaches a lower-level network
  // cause. In particular, bad credentials must never enter a permanent retry
  // loop.
  if (signals.statuses.some((status) => DETERMINISTIC_STATUSES.has(status))) {
    return "deterministic";
  }

  if (
    hasType(BLOCKED_TYPES) ||
    signals.statuses.includes(402) ||
    signals.texts.some((text) => BLOCKED_TEXT.test(text))
  ) {
    return "blocked";
  }

  if (hasType(DETERMINISTIC_TYPES)) {
    return "deterministic";
  }

  if (
    hasType(TRANSIENT_TYPES) ||
    signals.statuses.some(
      (status) =>
        TRANSIENT_STATUSES.has(status) || (status >= 500 && status <= 599),
    ) ||
    signals.hasConnectionSignal
  ) {
    return "connection";
  }

  // A concrete, otherwise-unrecognised HTTP response stays deterministic.
  if (signals.statuses.length > 0) {
    return "deterministic";
  }

  return "deterministic";
}

export function inspectWorkerError(error: unknown): WorkerErrorDetails {
  const signals = collectSignals(error);
  const meaningfulTypes = signals.types.filter(
    (type) =>
      type !== "assistant" &&
      type !== "system" &&
      type !== "stream_event" &&
      type !== "error",
  );
  return {
    classification: classifySignals(signals),
    status: signals.statuses[0] ?? null,
    type: meaningfulTypes[0] ?? null,
    requestId: signals.requestIds[0] ?? null,
    retryInMs: signals.retryInMs[0] ?? null,
    retryAfter: signals.retryAfter[0] ?? null,
  };
}

/**
 * Parse Retry-After as either integer seconds or an HTTP-date. Negative and
 * excessively large values are clamped to the worker's in-memory retry bound.
 */
export function parseRetryAfterMs(
  value: string,
  nowMs = Date.now(),
): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1_000, MAX_WORKER_RETRY_DELAY_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) {
    return null;
  }
  return Math.min(
    Math.max(0, dateMs - nowMs),
    MAX_WORKER_RETRY_DELAY_MS,
  );
}

export function resolveWorkerRetryDelayMs(
  error: unknown,
  defaultDelayMs: number,
  nowMs = Date.now(),
): number {
  const details = inspectWorkerError(error);
  if (details.retryInMs !== null) {
    return details.retryInMs;
  }
  if (details.retryAfter !== null) {
    const parsed = parseRetryAfterMs(details.retryAfter, nowMs);
    if (parsed !== null) {
      return parsed;
    }
  }
  return Math.min(
    Math.max(0, Math.round(defaultDelayMs)),
    MAX_WORKER_RETRY_DELAY_MS,
  );
}

/**
 * Unknown failures are deterministic by design: only positively identified
 * transport, quota, server, or blocked-account evidence bypasses the bounded
 * retry/drop budget.
 */
export function classifyWorkerError(error: unknown): WorkerErrorClassification {
  return inspectWorkerError(error).classification;
}
