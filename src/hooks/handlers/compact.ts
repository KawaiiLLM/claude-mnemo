import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { getPendingTurns, getTurnsForSession } from "../../db/turns";
import { forkMnemosyne } from "../../mnemosyne/fork";
import {
  buildExtractionStatusSummary,
  buildMnemosynePrompt,
} from "../../mnemosyne/prompt";
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
    buildExtractionStatusSummary(
      getTurnsForSession(db, sessionDbId).map((turn) => ({
        promptNumber: turn.promptNumber,
        status: turn.status as
          | "pending"
          | "stale"
          | "extracted"
          | "skipped"
          | "undone",
        promptPreview: turn.userPrompt ?? "",
      })),
    ),
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
        sessionId: input.sessionId,
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
