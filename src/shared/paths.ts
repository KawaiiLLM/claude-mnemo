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

/**
 * The single declared root of Claude Code's per-project transcript directories.
 * Both the derivation below and the one-time transcript-path repair scan read
 * it from here so they can never disagree about where transcripts live.
 */
export function transcriptRootPath(): string {
  return join(homedir(), ".claude", "projects");
}

export function resolveTranscriptPath(
  projectPath: string,
  sessionId: string,
): string {
  return join(
    transcriptRootPath(),
    encodeProjectPath(projectPath),
    `${sessionId}.jsonl`,
  );
}

/**
 * Every reader that needs a session's transcript file goes through here.
 *
 * `sessions.project` means "the latest cwd this session was seen in", but Claude
 * Code fixes the transcript directory at the STARTING cwd — so a session that
 * `cd`ed mid-flight derives a path that does not exist. `transcript_path` is the
 * authoritative value captured from the hook input at registration; the
 * derivation stays as the fallback for rows that predate the column (or whose
 * one-time repair found no file), which keeps legacy behavior byte-identical.
 */
export function resolveSessionTranscriptPath(session: {
  transcriptPath: string | null;
  project: string;
  contentSessionId: string;
}): string {
  return (
    session.transcriptPath ??
    resolveTranscriptPath(session.project, session.contentSessionId)
  );
}
