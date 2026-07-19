const REDACTED = "[REDACTED]";

const SENSITIVE_ENV_KEY =
  /(?:API[_-]?KEY|AUTH|TOKEN|SECRET|PASSWORD|COOKIE|CUSTOM[_-]?HEADERS|(?:^|_)PROXY$)/i;
const BUILTIN_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
];

export type SensitiveEnv = Record<string, string | undefined>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectSensitiveValues(env: SensitiveEnv): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || !SENSITIVE_ENV_KEY.test(key)) {
      continue;
    }
    if (value.length >= 4) {
      values.add(value);
    }
    try {
      const url = new URL(value);
      if (url.username.length >= 1) {
        values.add(decodeURIComponent(url.username));
      }
      if (url.password.length >= 1) {
        values.add(decodeURIComponent(url.password));
      }
    } catch {}
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function collectCustomHeaderNames(env: SensitiveEnv): string[] {
  const names = new Set(BUILTIN_HEADER_NAMES);
  for (const [key, value] of Object.entries(env)) {
    if (!value || !/CUSTOM[_-]?HEADERS/i.test(key)) {
      continue;
    }
    for (const line of value.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator > 0) {
        names.add(line.slice(0, separator).trim().toLowerCase());
      }
    }
  }
  return [...names].filter((name) => name !== "");
}

/**
 * Redact both known snapshot values and secret-bearing string structures.
 * Value replacement runs first so a gateway echo is cleaned even when it has
 * lost the original field name.
 */
export function sanitizeSecretString(
  input: string,
  sensitiveEnv: SensitiveEnv = process.env,
): string {
  let sanitized = input;
  for (const value of collectSensitiveValues(sensitiveEnv)) {
    sanitized = sanitized.replaceAll(value, REDACTED);
  }

  // URLs can appear inside a larger remote body. Strip userinfo without
  // needing the URL itself to be present in the env snapshot.
  sanitized = sanitized.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(?::([^/\s@]*))?@/gi,
    `$1${REDACTED}@`,
  );

  for (const headerName of collectCustomHeaderNames(sensitiveEnv)) {
    const escaped = escapeRegExp(headerName);
    sanitized = sanitized.replace(
      new RegExp(`("${escaped}"\\s*:\\s*")[^"]*(")`, "gi"),
      `$1${REDACTED}$2`,
    );
    sanitized = sanitized.replace(
      new RegExp(`(^|[\\r\\n,;{]\\s*)(${escaped}\\s*[:=]\\s*)[^\\r\\n,;}]+`, "gi"),
      `$1$2${REDACTED}`,
    );
  }

  return sanitized;
}

function sensitiveObjectKey(key: string, customHeaders: Set<string>): boolean {
  return SENSITIVE_ENV_KEY.test(key) || customHeaders.has(key.toLowerCase());
}

export function sanitizeLogValue(
  value: unknown,
  sensitiveEnv: SensitiveEnv = process.env,
): unknown {
  const seen = new WeakSet<object>();
  const customHeaders = new Set(collectCustomHeaderNames(sensitiveEnv));

  const visit = (current: unknown): unknown => {
    if (typeof current === "string") {
      return sanitizeSecretString(current, sensitiveEnv);
    }
    if (
      current === null ||
      current === undefined ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (typeof current !== "object") {
      return String(current);
    }
    if (seen.has(current)) {
      return "[Circular]";
    }
    seen.add(current);

    if (current instanceof Error) {
      const error = current as Error & Record<string, unknown>;
      const summary: Record<string, unknown> = {
        name: error.name,
        message: sanitizeSecretString(error.message, sensitiveEnv),
      };
      for (const key of [
        "type",
        "status",
        "requestId",
        "request_id",
        "code",
        "retryInMs",
        "retryAfter",
      ]) {
        const field = error[key];
        if (field !== undefined && field !== null) {
          summary[key] = visit(field);
        }
      }
      return summary;
    }

    if (Array.isArray(current)) {
      return current.map(visit);
    }

    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(current)) {
      result[key] = sensitiveObjectKey(key, customHeaders)
        ? REDACTED
        : visit(field);
    }
    return result;
  };

  return visit(value);
}

function directMetadata(
  error: unknown,
): { type: string | null; status: number | null; requestId: string | null } {
  const seen = new Set<object>();
  let current: unknown = error;
  let type: string | null = null;
  let status: number | null = null;
  let requestId: string | null = null;

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (type === null && typeof record.type === "string") {
      type = record.type;
    }
    if (status === null && typeof record.status === "number") {
      status = record.status;
    }
    const candidateRequestId = record.requestId ?? record.request_id;
    if (requestId === null && typeof candidateRequestId === "string") {
      requestId = candidateRequestId;
    }
    current = record.cause;
  }

  return { type, status, requestId };
}

/**
 * Persist a bounded, stable identity for the failure. Remote bodies and stacks
 * are deliberately omitted; local errors retain only a sanitized short message.
 */
export function formatErrorForPersistence(
  error: unknown,
  sensitiveEnv: SensitiveEnv = process.env,
): string {
  const metadata = directMetadata(error);
  const fields = [
    metadata.type ? `type=${sanitizeSecretString(metadata.type, sensitiveEnv)}` : null,
    metadata.status !== null ? `status=${metadata.status}` : null,
    metadata.requestId
      ? `request-id=${sanitizeSecretString(metadata.requestId, sensitiveEnv)}`
      : null,
  ].filter((field): field is string => field !== null);
  if (fields.length > 0) {
    return fields.join(" ");
  }

  const name = error instanceof Error ? error.name : "Error";
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const sanitizedMessage = sanitizeSecretString(message, sensitiveEnv)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return sanitizedMessage === ""
    ? `type=${name}`
    : `type=${name} message=${sanitizedMessage}`;
}
