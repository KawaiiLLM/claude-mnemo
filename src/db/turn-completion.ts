import type { Database } from "bun:sqlite";

import { getExtractableObservationsForTurn } from "./observations";
import { getTurnById, updateTurnById, type TurnRecord } from "./turns";
import { isSegmentEra } from "../segment-era";

/**
 * What a finished turn's record is, mechanically.
 *
 * There is no extraction subagent any more (ticket 15): nothing arrives after
 * the turn ends to write a record it does not already carry, so the completion
 * event itself is the settlement. Everything in this module is arithmetic over
 * rows the capture path already wrote — no model, no queue, no retry.
 */

/**
 * What a turn nobody will write any more should be left as.
 *
 * A record on the row wins outright — the main agent's own note, or a partial
 * extraction left behind by the retired pipeline, is the record. Without one the
 * answer depends on whether anybody was ever going to write it: pre-era the
 * extraction really did lose the only summary that turn would have had, which is
 * a failure; in the new era a turn its own agent chose not to note is a hole,
 * and `skipped` is what a hole has always been called.
 *
 * ONE definition, three callers: the completion settlement below, the stranded
 * repair's floor (worker/turn-liveness.ts), and nothing else. They must not
 * disagree about what an un-noted turn looks like.
 */
export function completionFloorStatus(
  turn: Pick<TurnRecord, "title" | "content" | "createdAtEpoch">,
  eraCutoffEpoch: number | null = null,
): "extracted" | "skipped" | "failed" {
  if (turn.title !== null || turn.content !== null) {
    return "extracted";
  }
  return isSegmentEra(turn.createdAtEpoch, eraCutoffEpoch) ? "skipped" : "failed";
}

function safeJsonParse(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collectPathValues(
  input: Record<string, unknown>,
  key: string,
): string[] {
  const value = input[key];
  if (typeof value === "string" && value.trim() !== "") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
  }
  return [];
}

export interface TurnFileAggregate {
  filesRead: string[];
  filesModified: string[];
  toolCallCount: number;
}

/**
 * The turn's mechanical file sets and tool-call count, derived from its captured
 * observations. Extractable rows only: a `note` call is bookkeeping ABOUT a
 * turn, so counting it would let note-taking inflate the very count the segment
 * ranking and the settlement priors read as evidence of work.
 *
 * This used to be a side effect of building the extraction agent's mini-turn
 * payload, which is why it had to move: `turns.files_read` / `files_modified` /
 * `tool_call_count` are read by recall, search, `db/segment-rank.ts` and the
 * settlement prompt, and nothing else writes them.
 */
export function aggregateTurnFiles(
  db: Database,
  turnId: number,
): TurnFileAggregate {
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const observations = getExtractableObservationsForTurn(db, turnId);

  for (const observation of observations) {
    const input = safeJsonParse(observation.toolInput);
    if (!input) {
      continue;
    }

    switch (observation.toolName) {
      case "Read":
      case "Grep":
      case "Glob":
        for (const path of [
          ...collectPathValues(input, "file_path"),
          ...collectPathValues(input, "path"),
        ]) {
          filesRead.add(path);
        }
        break;
      case "Write":
      case "Edit":
      case "MultiEdit":
        for (const path of collectPathValues(input, "file_path")) {
          filesModified.add(path);
        }
        break;
      default:
        break;
    }
  }

  return {
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    toolCallCount: observations.length,
  };
}

/**
 * Settle one turn that has just been observed to be over.
 *
 * Three mechanical writes, and no judgement anywhere:
 *
 *  - the file/tool aggregation above, which the retired pipeline used to
 *    persist while rendering its prompt;
 *  - the terminal status, from `completionFloorStatus`;
 *  - its still-`pending` observations retired to `skipped`, so nothing that
 *    scans for pending work keeps finding a turn that is over.
 *
 * Idempotent by the status guard: only `active`/`provisional` rows are settled,
 * so re-running it changes nothing, and a LATE note (the backlog relief answers
 * a turn settled as `skipped` turns ago) still promotes the row — that path is
 * `promoteTurnFromNote`, whose finished-turn branch writes `extracted`, and it
 * is deliberately not gated by anything here.
 *
 * `undone` is left alone: a sidechain row is not part of this session's arc.
 */
export function settleCompletedTurn(
  db: Database,
  turnId: number,
  eraCutoffEpoch: number | null,
  nowEpoch: number,
): boolean {
  const turn = getTurnById(db, turnId);
  if (
    !turn ||
    (turn.status !== "active" && turn.status !== "provisional")
  ) {
    return false;
  }

  const aggregate = aggregateTurnFiles(db, turnId);
  updateTurnById(db, turnId, {
    status: completionFloorStatus(turn, eraCutoffEpoch),
    filesRead: aggregate.filesRead,
    filesModified: aggregate.filesModified,
    toolCallCount: aggregate.toolCallCount,
    updatedAtEpoch: nowEpoch,
  });

  db.query<unknown, [number]>(
    `UPDATE observations SET status = 'skipped'
     WHERE turn_id = ? AND status = 'pending'`,
  ).run(turnId);

  return true;
}
