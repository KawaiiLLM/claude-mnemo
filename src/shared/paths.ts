import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DB_PATH = join(homedir(), ".claude-mnemo", "claude-mnemo.db");

export function resolveDatabasePath(explicitPath?: string): string {
  if (explicitPath) {
    return explicitPath;
  }

  return process.env.CLAUDE_MNEMO_DB_PATH ?? DEFAULT_DB_PATH;
}

export function encodeProjectPath(projectPath: string): string {
  return encodeURIComponent(projectPath);
}

export function resolveTranscriptPath(
  projectPath: string,
  sessionId: string,
): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectPath(projectPath),
    `${sessionId}.jsonl`,
  );
}
