import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Where the Claude Code executable lives, for the two subprocesses the worker
 * still starts: the nightly dream agent and the note-settlement payload.
 *
 * This is all that survives of the resident extraction agent's session module
 * (ticket 15) — the SDK MCP server it exposed to that agent went with it.
 */
interface ClaudeExecutableResolverDeps {
  existsSync: (path: string) => boolean;
  findOnPath: () => string | null;
}

function findClaudeOnPath(): string | null {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, ["claude"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return null;
  }

  const candidate = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return candidate || null;
}

export function resolveClaudeCodeExecutablePath(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: ClaudeExecutableResolverDeps = {
    existsSync,
    findOnPath: findClaudeOnPath,
  },
): string | undefined {
  const explicitPath =
    sourceEnv.CLAUDE_CODE_PATH || sourceEnv.CLAUDE_CODE_EXECUTABLE;

  if (explicitPath && deps.existsSync(explicitPath)) {
    return explicitPath;
  }

  return deps.findOnPath() ?? undefined;
}
