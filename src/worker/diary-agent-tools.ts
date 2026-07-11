import type { Database } from "bun:sqlite";

import type { DiaryStateStore } from "../db/diary-state";
import { getTurn } from "../db/turns";
import { stripDiaryPrivateContent } from "../diary/domain";
import type { DiaryFileStore } from "../diary/file-store";
import { validateAndMarkStale } from "../diary/validate-and-mark-stale";

export interface CreateDiaryAgentToolHandlersOptions {
  db: Database;
  stateStore: Pick<
    DiaryStateStore,
    "getDayState" | "markDayStaleAndEnqueue"
  >;
  allowedTurnRefs: ReadonlySet<string>;
  fileStore: DiaryFileStore;
  allowedDiaryDates: ReadonlySet<string>;
}

export interface DiaryAgentTurn {
  sessionId: number;
  promptNumber: number;
  userPrompt: string | null;
  assistantResponse: string | null;
}

export interface DiaryAgentToolHandlers {
  readTurn(sessionId: number, promptNumber: number): DiaryAgentTurn;
  readDiary(date: string): Promise<Uint8Array>;
}

function turnRef(sessionId: number, promptNumber: number): string {
  return `S${sessionId}/T${promptNumber}`;
}

export function createDiaryAgentToolHandlers(
  options: CreateDiaryAgentToolHandlersOptions,
): DiaryAgentToolHandlers {
  const allowedTurnRefs = new Set(options.allowedTurnRefs);
  const allowedDiaryDates = new Set(options.allowedDiaryDates);

  return {
    readTurn(sessionId, promptNumber) {
      const ref = turnRef(sessionId, promptNumber);

      if (!allowedTurnRefs.has(ref)) {
        throw new Error(`Turn ${ref} is not allowed for this request.`);
      }

      const turn = getTurn(options.db, sessionId, promptNumber);

      if (!turn) {
        throw new Error(`Turn ${ref} was not found.`);
      }

      return {
        sessionId: turn.sessionId,
        promptNumber: turn.promptNumber,
        userPrompt:
          turn.userPrompt === null
            ? null
            : stripDiaryPrivateContent(turn.userPrompt),
        assistantResponse:
          turn.assistantResponse === null
            ? null
            : stripDiaryPrivateContent(turn.assistantResponse),
      };
    },
    async readDiary(date) {
      if (!allowedDiaryDates.has(date)) {
        throw new Error(`Diary ${date} is not allowed for this request.`);
      }

      const state = options.stateStore.getDayState(date);
      if (
        state === null ||
        state.settledAtEpoch === null ||
        state.watermark === null ||
        state.watermark === "empty" ||
        state.fileSha256 === null ||
        state.indexHook === null ||
        state.needsRegen
      ) {
        options.stateStore.markDayStaleAndEnqueue({
          date,
          enqueuedAtEpoch: Math.floor(Date.now() / 1_000),
        });
        throw new Error(`Diary ${date} has no valid settled day state.`);
      }

      return validateAndMarkStale(options, {
        date: state.date,
        watermark: state.watermark,
        fileSha256: state.fileSha256,
        indexHook: state.indexHook,
      });
    },
  };
}
