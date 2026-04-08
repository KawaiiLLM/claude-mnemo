import type { Database } from "bun:sqlite";

import { getSessionByContentId, upsertSession } from "../../db/sessions";
import { getTurnsForSession } from "../../db/turns";
import { countUserPromptsInTranscript } from "../../shared/transcript-parser";
import type { HookResult, NormalizedHookInput } from "../types";

export interface SessionInitDependencies {
  db: Database;
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
      content: existingSession?.content ?? null,
      insight: existingSession?.insight ?? null,
      createdAtEpoch: existingSession?.createdAtEpoch ?? now(),
      updatedAtEpoch: now(),
      completedAtEpoch: existingSession?.completedAtEpoch ?? null,
    });

    const promptNumber = input.transcriptPath
      ? countUserPromptsInTranscript(input.transcriptPath) + 1
      : getTurnsForSession(dependencies.db, session.id).length + 1;

    createPendingTurn(
      dependencies.db,
      session.id,
      promptNumber,
      input.prompt,
      now(),
    );

    return {
      continue: true,
      suppressOutput: true,
    };
  };
}
