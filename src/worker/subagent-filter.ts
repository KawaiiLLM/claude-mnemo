import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { updateTurnById, getTurnsForSession, type TurnRecord } from "../db/turns";
import {
  parseReplayTranscript,
  readAllTranscriptEntries,
  type ParsedReplayTurn,
} from "../shared/transcript-parser";

const SUBAGENT_PENDING_TAG = "subagent:pending";
const SUBAGENT_NOTIFIED_TAG = "subagent:notified";

interface DetectAndCleanSubagentTurnsOptions {
  runWriteTransaction?: typeof runWriteTransaction;
}

function addSubagentPendingTag(tags: string[]): string[] {
  if (tags.includes(SUBAGENT_PENDING_TAG) || tags.includes(SUBAGENT_NOTIFIED_TAG)) {
    return tags;
  }

  return [...tags, SUBAGENT_PENDING_TAG];
}

function markSubagentNotifiedTags(tags: string[]): string[] {
  const withoutPending = tags.filter((tag) => tag !== SUBAGENT_PENDING_TAG);
  if (withoutPending.includes(SUBAGENT_NOTIFIED_TAG)) {
    return withoutPending;
  }

  return [...withoutPending, SUBAGENT_NOTIFIED_TAG];
}

function deleteObservationFtsRows(db: Database, observationIds: number[]): void {
  if (observationIds.length === 0) {
    return;
  }

  const deleteStatement = db.query<unknown, [number]>(
    "DELETE FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
  );

  for (const observationId of observationIds) {
    deleteStatement.run(observationId);
  }
}

function selectObservationIdsForTurns(db: Database, turnIds: number[]): number[] {
  if (turnIds.length === 0) {
    return [];
  }

  return db
    .query<{ id: number }, number[]>(
      `
        SELECT id
        FROM observations
        WHERE turn_id IN (${turnIds.map(() => "?").join(", ")})
        ORDER BY id ASC
      `,
    )
    .all(...turnIds)
    .map((row) => row.id);
}

function deleteTurnStopQueueItems(
  db: Database,
  sessionDbId: number,
  turnIds: number[],
): void {
  if (turnIds.length === 0) {
    return;
  }

  db.query<unknown, [number, ...number[]]>(
    `
      DELETE FROM pending_queue
      WHERE session_db_id = ?
        AND kind = 'turn-stop'
        AND target_id IN (${turnIds.map(() => "?").join(", ")})
    `,
  ).run(sessionDbId, ...turnIds);
}

function deleteObservationQueueItems(
  db: Database,
  sessionDbId: number,
  observationIds: number[],
): void {
  if (observationIds.length === 0) {
    return;
  }

  db.query<unknown, [number, ...number[]]>(
    `
      DELETE FROM pending_queue
      WHERE session_db_id = ?
        AND kind = 'obs'
        AND target_id IN (${observationIds.map(() => "?").join(", ")})
    `,
  ).run(sessionDbId, ...observationIds);
}

function deleteObservationsForTurns(db: Database, turnIds: number[]): void {
  if (turnIds.length === 0) {
    return;
  }

  db.query<unknown, number[]>(
    `
      DELETE FROM observations
      WHERE turn_id IN (${turnIds.map(() => "?").join(", ")})
    `,
  ).run(...turnIds);
}

function resolveSubagentTurnsFromParsedTurns(
  db: Database,
  sessionDbId: number,
  parsedTurns: ParsedReplayTurn[],
): TurnRecord[] {
  const newestSubagentChain: typeof parsedTurns = [];

  for (let index = parsedTurns.length - 1; index >= 0; index -= 1) {
    const parsedTurn = parsedTurns[index]!;
    if (!parsedTurn.isSidechain) {
      break;
    }
    newestSubagentChain.unshift(parsedTurn);
  }

  if (newestSubagentChain.length === 0) {
    return [];
  }

  const liveTurns = getTurnsForSession(db, sessionDbId).filter(
    (turn) => turn.status !== "undone",
  );
  const byPromptId = new Map(
    liveTurns
      .filter((turn) => turn.contentPromptId)
      .map((turn) => [turn.contentPromptId!, turn] as const),
  );
  const byPromptNumber = new Map(liveTurns.map((turn) => [turn.promptNumber, turn] as const));
  const matched = new Map<number, TurnRecord>();

  for (const parsedTurn of newestSubagentChain) {
    const turn =
      (parsedTurn.promptId ? byPromptId.get(parsedTurn.promptId) : undefined) ??
      byPromptNumber.get(parsedTurn.promptNumber);

    if (turn) {
      matched.set(turn.id, turn);
    }
  }

  return [...matched.values()].sort((left, right) => left.promptNumber - right.promptNumber);
}

function cleanSubagentTurns(
  db: Database,
  sessionDbId: number,
  matchedTurns: TurnRecord[],
  updatedAtEpoch: number,
): number[] {
  if (matchedTurns.length === 0) {
    return [];
  }

  const turnIds = matchedTurns.map((turn) => turn.id);
  const observationIds = selectObservationIdsForTurns(db, turnIds);

  deleteTurnStopQueueItems(db, sessionDbId, turnIds);
  deleteObservationQueueItems(db, sessionDbId, observationIds);
  deleteObservationFtsRows(db, observationIds);
  deleteObservationsForTurns(db, turnIds);

  for (const turn of matchedTurns) {
    updateTurnById(db, turn.id, {
      status: "undone",
      tags: addSubagentPendingTag(turn.tags),
      updatedAtEpoch,
    });
  }

  return matchedTurns.map((turn) => turn.promptNumber);
}

export function detectAndCleanSubagentTurnsFromParsed(
  db: Database,
  sessionDbId: number,
  parsedTurns: ParsedReplayTurn[],
  updatedAtEpoch: number,
): number[] {
  return cleanSubagentTurns(
    db,
    sessionDbId,
    resolveSubagentTurnsFromParsedTurns(
      db,
      sessionDbId,
      parsedTurns,
    ),
    updatedAtEpoch,
  );
}

export function detectAndCleanSubagentTurns(
  db: Database,
  sessionDbId: number,
  transcriptPath: string,
  updatedAtEpoch: number,
  options: DetectAndCleanSubagentTurnsOptions = {},
): number[] {
  const entries = readAllTranscriptEntries(transcriptPath);
  const parsedTurns = parseReplayTranscript(transcriptPath, entries);
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  return writeTransaction(db, () =>
    detectAndCleanSubagentTurnsFromParsed(
      db,
      sessionDbId,
      parsedTurns,
      updatedAtEpoch,
    ),
  );
}
