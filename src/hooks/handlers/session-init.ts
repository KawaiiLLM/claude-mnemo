import type { Database } from "bun:sqlite";

import { runHookWriteTransaction } from "../../db/database";
import { getSessionByContentId, upsertSession } from "../../db/sessions";
import { getMaxPromptNumber } from "../../db/turns";
import {
  countUserPromptsInEntries,
  parseReplayTranscript,
  readAllTranscriptEntries,
} from "../../shared/transcript-parser";
import {
  applyInvalidationSets,
  computeInvalidationSets,
} from "../../worker/invalidation";
import { detectAndCleanSubagentTurnsFromParsed } from "../../worker/subagent-filter";
import type { HookResult, NormalizedHookInput } from "../types";

export interface SessionInitDependencies {
  db: Database;
  now?: () => number;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
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
    ) VALUES (?, ?, 'active', ?, ?)`,
  ).run(sessionId, promptNumber, prompt, createdAtEpoch);
}

export function createSessionInitHandler(
  dependencies: SessionInitDependencies,
) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const writeTransaction = dependencies.runHookWriteTransaction ?? runHookWriteTransaction;

  return async function handleSessionInitHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (!input.sessionId || !input.cwd || !input.prompt) {
      return {
        continue: true,
        suppressOutput: true,
      };
    }

    const epoch = now();
    const contentSessionId = input.sessionId;
    const project = input.cwd;
    const prompt = input.prompt;
    const existingSession = getSessionByContentId(dependencies.db, contentSessionId);
    const transcriptEntries = input.transcriptPath
      ? readAllTranscriptEntries(input.transcriptPath)
      : null;
    const invalidationSets = transcriptEntries
      ? computeInvalidationSets(transcriptEntries)
      : null;
    const parsedTurns = transcriptEntries
      ? parseReplayTranscript(input.transcriptPath ?? "", transcriptEntries)
      : null;
    const transcriptPromptCount = transcriptEntries
      ? countUserPromptsInEntries(transcriptEntries)
      : null;

    writeTransaction(dependencies.db, () => {
      const session = upsertSession(dependencies.db, {
        contentSessionId,
        project,
        title: existingSession?.title ?? null,
        content: existingSession?.content ?? null,
        insight: existingSession?.insight ?? null,
        createdAtEpoch: existingSession?.createdAtEpoch ?? epoch,
        updatedAtEpoch: epoch,
        completedAtEpoch: existingSession?.completedAtEpoch ?? null,
      });

      if (transcriptEntries && invalidationSets && parsedTurns) {
        applyInvalidationSets(
          dependencies.db,
          session.id,
          invalidationSets,
          epoch,
        );
        detectAndCleanSubagentTurnsFromParsed(
          dependencies.db,
          session.id,
          parsedTurns,
          epoch,
        );
      }

      const dbMaxPromptNumber = getMaxPromptNumber(dependencies.db, session.id);
      const promptNumber = dbMaxPromptNumber !== null
        ? dbMaxPromptNumber + 1
        : transcriptPromptCount !== null
          ? transcriptPromptCount + 1
          : 1;

      createPendingTurn(
        dependencies.db,
        session.id,
        promptNumber,
        prompt,
        epoch,
      );
    });

    return {
      continue: true,
      suppressOutput: true,
    };
  };
}
