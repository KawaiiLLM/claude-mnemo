import { existsSync, readFileSync } from "node:fs";

import { resolveTranscriptPath } from "../shared/paths";

const DEFAULT_TAIL_LINES = 30;

interface DetectCacheTtlDeps {
  existsSyncImpl?: typeof existsSync;
  readFileSyncImpl?: typeof readFileSync;
  resolveTranscriptPathImpl?: typeof resolveTranscriptPath;
}

export function detectCacheTtlFromLines(lines: string[]): number | null {
  for (const line of [...lines].reverse()) {
    try {
      const entry = JSON.parse(line) as {
        message?: {
          usage?: {
            cache_creation?: {
              ephemeral_1h_input_tokens?: number;
              ephemeral_5m_input_tokens?: number;
            };
          };
        };
      };
      const cacheCreation = entry.message?.usage?.cache_creation;
      if (!cacheCreation) {
        continue;
      }
      if ((cacheCreation.ephemeral_1h_input_tokens ?? 0) > 0) {
        return 3_600_000;
      }
      if ((cacheCreation.ephemeral_5m_input_tokens ?? 0) > 0) {
        return 300_000;
      }
    } catch {
      // Skip malformed JSONL lines.
    }
  }

  return null;
}

export async function detectCacheTtl(
  agentSessionId: string,
  projectPath: string,
  tailLines = DEFAULT_TAIL_LINES,
  deps: DetectCacheTtlDeps = {},
): Promise<number | null> {
  const existsSyncImpl = deps.existsSyncImpl ?? existsSync;
  const readFileSyncImpl = deps.readFileSyncImpl ?? readFileSync;
  const resolveTranscriptPathImpl =
    deps.resolveTranscriptPathImpl ?? resolveTranscriptPath;

  const transcriptPath = resolveTranscriptPathImpl(projectPath, agentSessionId);
  if (!existsSyncImpl(transcriptPath)) {
    return null;
  }

  try {
    const lines = readFileSyncImpl(transcriptPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-tailLines);

    return detectCacheTtlFromLines(lines);
  } catch {
    return null;
  }
}
