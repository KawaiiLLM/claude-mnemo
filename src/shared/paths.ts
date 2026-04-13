import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = join(homedir(), ".claude-mnemo");
const DEFAULT_DB_PATH = join(DATA_DIR, "claude-mnemo.db");
export const WORKER_PID_PATH = join(DATA_DIR, "worker.pid");
export const WORKER_STARTING_PATH = join(DATA_DIR, "worker.starting");

export function resolveDatabasePath(explicitPath?: string): string {
  const candidatePath = explicitPath || process.env.CLAUDE_MNEMO_DB_PATH || DEFAULT_DB_PATH;

  if (candidatePath.startsWith("~/")) {
    return join(homedir(), candidatePath.slice(2));
  }

  return candidatePath;
}

export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[/:\\.]/g, "-");
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
