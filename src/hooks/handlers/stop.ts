import type { Database } from "bun:sqlite";

import { getSessionByContentId, upsertSession } from "../../db/sessions";
import {
  getPendingTurns,
  getTurn,
  getTurnsForSession,
  markTurnsStale,
} from "../../db/turns";
import { forkMnemosyne } from "../../mnemosyne/fork";
import {
  buildExtractionStatusSummary,
  buildMnemosynePrompt,
} from "../../mnemosyne/prompt";
import { extractAssistantResponse } from "../../shared/transcript-parser";
import { HOOK_SUCCESS_EXIT_CODE } from "../../shared/hook-constants";
import type { HookResult, NormalizedHookInput } from "../types";

export interface StopHandlerDependencies {
  db: Database;
  forkMnemosyne: typeof forkMnemosyne;
  extractAssistantResponse: typeof extractAssistantResponse;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  now?: () => number;
}

function buildStopPrompt(db: Database, sessionDbId: number): string {
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

function backfillLastPendingTurn(
  db: Database,
  input: NormalizedHookInput,
  transcriptReader: typeof extractAssistantResponse,
  sessionDbId: number,
): void {
  const turns = getTurnsForSession(db, sessionDbId);
  const lastPendingTurn = [...turns]
    .reverse()
    .find((turn) => turn.status === "pending");

  if (!lastPendingTurn) {
    return;
  }

  const assistantResponse =
    input.lastAssistantMessage ??
    (input.transcriptPath && lastPendingTurn.userPrompt
      ? transcriptReader(
          input.transcriptPath,
          lastPendingTurn.userPrompt,
          lastPendingTurn.promptNumber,
        )
      : "");

  db.query("UPDATE turns SET assistant_response = ? WHERE id = ?").run(
    assistantResponse,
    lastPendingTurn.id,
  );
}

function detectUndoPromptNumbers(
  db: Database,
  transcriptReader: typeof extractAssistantResponse,
  sessionDbId: number,
  transcriptPath?: string,
): number[] {
  if (!transcriptPath) {
    return [];
  }

  return getTurnsForSession(db, sessionDbId)
    .filter((turn) => turn.status === "extracted" && turn.userPrompt)
    .filter((turn) => {
      const currentResponse = transcriptReader(
        transcriptPath,
        turn.userPrompt ?? "",
        turn.promptNumber,
      );
      return currentResponse !== "" && currentResponse !== (turn.assistantResponse ?? "");
    })
    .map((turn) => turn.promptNumber);
}

export function createStopHandler(dependencies: StopHandlerDependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const stderr = dependencies.stderr ?? process.stderr;

  return async function handleStopHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (input.stopHookActive) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE,
      };
    }

    if (!input.sessionId) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE,
      };
    }

    const session = getSessionByContentId(dependencies.db, input.sessionId);

    if (!session) {
      return {
        continue: true,
        exitCode: HOOK_SUCCESS_EXIT_CODE,
      };
    }

    backfillLastPendingTurn(
      dependencies.db,
      input,
      dependencies.extractAssistantResponse,
      session.id,
    );

    const stalePromptNumbers = detectUndoPromptNumbers(
      dependencies.db,
      dependencies.extractAssistantResponse,
      session.id,
      input.transcriptPath,
    );

    markTurnsStale(dependencies.db, session.id, stalePromptNumbers);

    const pendingTurns = getPendingTurns(dependencies.db, session.id);

    if (pendingTurns.length > 0) {
      await dependencies.forkMnemosyne({
        sessionId: input.sessionId,
        cwd: input.cwd,
        prompt: buildStopPrompt(dependencies.db, session.id),
      });
    }

    upsertSession(dependencies.db, {
      contentSessionId: session.contentSessionId,
      project: session.project,
      title: session.title,
      description: session.description,
      insight: session.insight,
      startedAtEpoch: session.startedAtEpoch,
      updatedAtEpoch: now(),
      completedAtEpoch: now(),
    });

    stderr.write(
      `Mnemosyne: ${pendingTurns.length} turns queued for extraction\n`,
    );

    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
    };
  };
}

export function handleStopHook(input: NormalizedHookInput): HookResult {
  if (input.stopHookActive) {
    return {
      continue: true,
      exitCode: HOOK_SUCCESS_EXIT_CODE,
    };
  }

  return {
    continue: true,
    exitCode: HOOK_SUCCESS_EXIT_CODE,
  };
}
