import type { Database } from "bun:sqlite";

import { getSessionByContentId } from "../../db/sessions";
import { getPendingTurns, getTurnsForSession } from "../../db/turns";
import { forkMnemosyne } from "../../mnemosyne/fork";
import {
  buildExtractionStatusSummary,
  buildMnemosynePrompt,
} from "../../mnemosyne/prompt";
import { resolveTranscriptPath } from "../../shared/paths";
import { extractAssistantResponse } from "../../shared/transcript-parser";
import type { HookResult, NormalizedHookInput } from "../types";

export interface CompactHandlerDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
  extractAssistantResponse: typeof extractAssistantResponse;
}

function buildPrompt(db: Database, sessionDbId: number): string {
  return buildMnemosynePrompt(
    buildExtractionStatusSummary(
      getTurnsForSession(db, sessionDbId).map((turn) => ({
        promptNumber: turn.promptNumber,
        status: turn.status as "pending" | "stale" | "extracted" | "skipped",
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

    for (const turn of pendingTurns) {
      if (turn.assistantResponse || !turn.userPrompt) {
        continue;
      }

      const assistantResponse = transcriptPath
        ? dependencies.extractAssistantResponse(transcriptPath, turn.userPrompt, turn.promptNumber)
        : "";

      dependencies.db
        .query("UPDATE turns SET assistant_response = ? WHERE id = ?")
        .run(assistantResponse, turn.id);
    }

    if (pendingTurns.length > 0) {
      void dependencies.forkMnemosyne({
        sessionId: input.sessionId,
        cwd: input.cwd,
        prompt: buildPrompt(dependencies.db, session.id),
      });
    }

    return {
      continue: true,
    };
  };
}

