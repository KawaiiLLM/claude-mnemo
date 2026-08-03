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
import {
  applyCaptureRepair,
  type CaptureRepairLog,
} from "../capture-repair";
import {
  scanTranscriptIncrementally,
  DEFAULT_SCAN_MAX_LINES,
} from "../transcript-scan";
import type { HookResult, NormalizedHookInput } from "../types";

export interface SessionInitDependencies {
  db: Database;
  now?: () => number;
  runHookWriteTransaction?: typeof runHookWriteTransaction;
  captureRepairLog?: CaptureRepairLog;
  captureRepairMaxLines?: number;
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

    // Capture repair (spec §F) — the file read happens OUTSIDE the write
    // transaction; only the claims/links/cursor commit inside it. The scan
    // resumes from the session's persisted byte cursor, so its cost tracks new
    // bytes rather than transcript size.
    const repairCursor = {
      byteOffset: existingSession?.scanCursorByteOffset ?? 0,
      lineNumber: existingSession?.scanCursorLine ?? 0,
    };
    const repairScan = input.transcriptPath
      ? scanTranscriptIncrementally(input.transcriptPath, repairCursor, {
          maxLines: dependencies.captureRepairMaxLines ?? DEFAULT_SCAN_MAX_LINES,
          log: dependencies.captureRepairLog,
        })
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

      // Runs BEFORE the new pending turn exists: a marker minted here takes a
      // prompt number lower than this prompt's, which is the true order (the
      // compact happened before the user typed).
      if (
        repairScan &&
        (repairScan.entries.length > 0 ||
          repairScan.restarted ||
          repairScan.nextCursor.byteOffset !== repairCursor.byteOffset)
      ) {
        applyCaptureRepair(dependencies.db, session.id, repairScan, repairCursor, {
          nowEpoch: epoch,
          log: dependencies.captureRepairLog,
        });
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
