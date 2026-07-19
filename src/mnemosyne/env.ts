const LEGACY_BLOCKED_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "CLAUDECODE"]);

const OPERATIONAL_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
]);

export const CAPTURED_SESSION_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "NODE_EXTRA_CA_CERTS",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
] as const;

export type CapturedSessionEnv = Partial<
  Record<(typeof CAPTURED_SESSION_ENV_KEYS)[number], string>
>;

export function captureSessionEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): CapturedSessionEnv {
  const captured: CapturedSessionEnv = {};

  for (const key of CAPTURED_SESSION_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) {
      captured[key] = value;
    }
  }

  return captured;
}

function copyOperationalEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const operationalEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (OPERATIONAL_ENV_KEYS.has(key) || key.startsWith("LC_")) {
      operationalEnv[key] = value;
    }
  }

  return operationalEnv;
}

export function buildIsolatedEnv(
  workerEnv?: NodeJS.ProcessEnv,
  capturedSessionEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // Undefined preserves the legacy behavior for callers that have not opted
  // into per-session isolation. The dream path now always supplies either its
  // triggering session snapshot or an empty snapshot for the safe baseline.
  if (capturedSessionEnv === undefined) {
    const sourceEnv = workerEnv ?? process.env;
    const legacyEnv: NodeJS.ProcessEnv = {};

    for (const [key, value] of Object.entries(sourceEnv)) {
      if (!LEGACY_BLOCKED_ENV_KEYS.has(key)) {
        legacyEnv[key] = value;
      }
    }

    legacyEnv.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
    return legacyEnv;
  }

  const sourceEnv = workerEnv ?? process.env;
  const isolatedEnv: NodeJS.ProcessEnv = {};

  Object.assign(isolatedEnv, copyOperationalEnv(sourceEnv));
  Object.assign(isolatedEnv, captureSessionEnv(capturedSessionEnv));

  isolatedEnv.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";

  return isolatedEnv;
}
