import type { Database } from "bun:sqlite";

import { getSessionByContentId, upsertSession } from "../../db/sessions";
import { getTurn, getTurnsForSession } from "../../db/turns";
import { extractAssistantResponse } from "../../shared/transcript-parser";
import { forkMnemosyne } from "../../mnemosyne/fork";
import {
  buildExtractionStatusSummary,
  buildMnemosynePrompt,
} from "../../mnemosyne/prompt";
import type { HookResult, NormalizedHookInput } from "../types";

export interface SessionInitDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
  extractAssistantResponse: typeof extractAssistantResponse;
  now?: () => number;
}

function createPendingTurn(
  db: Database,
  sessionId: number,
  promptNumber: number,
  prompt: string,
  createdAtEpoch: number,
): void {
  db.query(
    `INSERT INTO turns (
      session_id,
      prompt_number,
      status,
      user_prompt,
      created_at_epoch
    ) VALUES (?, ?, 'pending', ?, ?)`,
  ).run(sessionId, promptNumber, prompt, createdAtEpoch);
}

function buildSessionStatusPrompt(db: Database, sessionId: number): string {
  const statusSummary = buildExtractionStatusSummary(
    getTurnsForSession(db, sessionId).map((turn) => ({
      promptNumber: turn.promptNumber,
      status: turn.status as "pending" | "stale" | "extracted" | "skipped",
      promptPreview: turn.userPrompt ?? "",
    })),
  );

  return buildMnemosynePrompt(statusSummary);
}

export function createSessionInitHandler(
  dependencies: SessionInitDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  return async function handleSessionInitHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId || !input.cwd || !input.prompt) {
      return {
        continue: true,
        suppressOutput: true,
      };
    }

    const existingSession = getSessionByContentId(dependencies.db, input.sessionId);
    const session = upsertSession(dependencies.db, {
      contentSessionId: input.sessionId,
      project: input.cwd,
      title: existingSession?.title ?? null,
      description: existingSession?.description ?? null,
      insight: existingSession?.insight ?? null,
      startedAtEpoch: existingSession?.startedAtEpoch ?? now(),
      updatedAtEpoch: now(),
      completedAtEpoch: existingSession?.completedAtEpoch ?? null,
    });

    const promptNumber = getTurnsForSession(dependencies.db, session.id).length + 1;

    createPendingTurn(
      dependencies.db,
      session.id,
      promptNumber,
      input.prompt,
      now(),
    );

    if (promptNumber > 1) {
      const previousTurn = getTurn(dependencies.db, session.id, promptNumber - 1);

      if (previousTurn?.status === "pending") {
        const assistantResponse =
          input.transcriptPath && previousTurn.userPrompt
            ? dependencies.extractAssistantResponse(
                input.transcriptPath,
                previousTurn.userPrompt,
                previousTurn.promptNumber,
              )
            : "";

        dependencies.db
          .query(
            "UPDATE turns SET assistant_response = ? WHERE id = ?",
          )
          .run(assistantResponse, previousTurn.id);

        void dependencies.forkMnemosyne({
          sessionId: input.sessionId,
          cwd: input.cwd,
          prompt: buildSessionStatusPrompt(dependencies.db, session.id),
        });
      }
    }

    return {
      continue: true,
      suppressOutput: true,
    };
  };
}

export function handleSessionInitHook(_input: NormalizedHookInput): HookResult {
  return {
    continue: true,
    suppressOutput: true,
  };
}
