export type WorkerErrorClassification = "connection" | "deterministic";

export type WorkerAbortReason = "stall-watchdog" | "shutdown";

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

export class WorkerAbortError extends Error {
  readonly workerAbortReason: WorkerAbortReason;

  constructor(reason: WorkerAbortReason) {
    super(`Worker request aborted: ${reason}`);
    this.name = "WorkerAbortError";
    this.workerAbortReason = reason;
  }
}

export function createWorkerAbortError(
  reason: WorkerAbortReason,
): WorkerAbortError {
  return new WorkerAbortError(reason);
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function classifyOne(
  error: Record<PropertyKey, unknown>,
): WorkerErrorClassification | null {
  // A concrete HTTP status means the API was reached and answered. Even when
  // the SDK attaches a lower-level cause, the status failure is deterministic
  // for the worker retry budget.
  if (typeof error.status === "number") {
    return "deterministic";
  }

  if (
    error.workerAbortReason === "stall-watchdog" ||
    error.workerAbortReason === "shutdown"
  ) {
    return "connection";
  }

  if (typeof error.code === "string" && CONNECTION_ERROR_CODES.has(error.code)) {
    return "connection";
  }

  const errorName = typeof error.name === "string" ? error.name : null;
  const constructorName =
    typeof error.constructor === "function" ? error.constructor.name : null;
  if (
    (errorName !== null && CONNECTION_ERROR_NAMES.has(errorName)) ||
    (constructorName !== null && CONNECTION_ERROR_NAMES.has(constructorName))
  ) {
    return "connection";
  }

  if (
    typeof error.message === "string" &&
    /\bfetch failed\b/i.test(error.message)
  ) {
    return "connection";
  }

  return null;
}

/**
 * Classify worker delivery errors without probing the network.
 *
 * Unknown failures are deterministic by design: only positively identified
 * connection failures may bypass the bounded retry/drop budget.
 */
export function classifyWorkerError(error: unknown): WorkerErrorClassification {
  const seen = new Set<object>();
  let current: unknown = error;

  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    const classification = classifyOne(current);
    if (classification !== null) {
      return classification;
    }
    current = current.cause;
  }

  return "deterministic";
}
