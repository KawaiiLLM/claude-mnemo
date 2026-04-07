import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { getPendingTurns } from "../../db/turns";
import { forkMnemosyne } from "../../mnemosyne/fork";
import { buildMnemosynePrompt } from "../../mnemosyne/prompt";
import { recallMemory } from "../../mcp/recall";
import { backfillFromTranscript } from "../backfill";
import { createLogger } from "../../shared/logger";
import { resolveTranscriptPath } from "../../shared/paths";
import type { HookResult, NormalizedHookInput } from "../types";

const log = createLogger("MNEMOSYNE");

export interface CompactHandlerDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
}

function buildPrompt(db: Database, sessionDbId: number): string {
  return buildMnemosynePrompt(
    recallMemory(db, {
      scope: "turns",
      session: sessionDbId,
      depth: "expanded",
    }),
  );
}

export function createCompactHandler(dependencies: CompactHandlerDependencies) {
  return async function handleCompactHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId) {
      return { continue: true };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);

    if (!session) {
      return { continue: true };
    }

    const transcriptPath =
      input.transcriptPath ||
      (input.cwd ? resolveTranscriptPath(input.cwd, input.sessionId) : undefined);
    const pendingTurns = getPendingTurns(dependencies.db, session.id);
    backfillFromTranscript(dependencies.db, pendingTurns, transcriptPath);

    if (pendingTurns.length > 0) {
      const result = await dependencies.forkMnemosyne({
        cwd: input.cwd,
        prompt: buildPrompt(dependencies.db, session.id),
        database: dependencies.db,
      });

      if (result) {
        const cacheHitPct =
          result.inputTokens > 0
            ? Math.round(
                (result.cacheReadInputTokens / result.inputTokens) * 100,
              )
            : 0;
        log.info("extraction complete", {
          hook: "compact",
          turns: result.numTurns,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadInputTokens,
          cacheCreationTokens: result.cacheCreationInputTokens,
          cacheHitPct,
          durationMs: result.durationMs,
        });
      }
    }

    return {
      continue: true,
    };
  };
}
