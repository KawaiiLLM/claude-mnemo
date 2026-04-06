const BLOCKED_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "CLAUDECODE"]);

export function buildIsolatedEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const isolatedEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (BLOCKED_ENV_KEYS.has(key)) {
      continue;
    }

    isolatedEnv[key] = value;
  }

  isolatedEnv.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";

  return isolatedEnv;
}
