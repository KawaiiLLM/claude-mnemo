import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import {
  listSettlementCandidateTurnIds,
  settleOutstandingTurns,
} from "../../src/db/turn-settlement";

/**
 * Ticket 02 (spec D10): `settleCompletedTurn` now has exactly one caller, and
 * this is its candidate predicate — self-identifying, no cursor. These tests
 * cover the predicate itself and the write it drives; the three call sites
 * that reach it (Stop, PostToolUse, the worker's turn-stop queue drain) are
 * covered where they already live: tests/hooks/stop.test.ts (turn.status
 * becomes terminal on its own Stop), tests/hooks/post-tool-use.test.ts, and
 * tests/worker/pending-queue.test.ts ("drains a legacy obs row and still
 * settles a valid turn-stop in the same pass").
 */

const CUTOFF = 2_000;

describe("turn settlement channel", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "settlement-session",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => db.close());

  function seedTurn(
    promptNumber: number,
    status: string = "active",
    createdAtEpoch = 3_000,
  ): number {
    return db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, ?, ?, 'prompt', ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, status, createdAtEpoch)!.id;
  }

  function queueTurnStop(turnId: number): void {
    db.query<unknown, [number, number]>(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('turn-stop', ?, ?, 10)`,
    ).run(turnId, sessionId);
  }

  test("a turn with no later prompt and no queued turn-stop is not a candidate", () => {
    // The only way a turn can lack BOTH evidence sources: it is the session's
    // newest turn (nothing has a greater prompt_number) and its own Stop has
    // not been captured yet. That is either an ordinary still-open turn or a
    // genuinely stranded one — either way, not this channel's business.
    const onlyTurn = seedTurn(1);

    expect(listSettlementCandidateTurnIds(db, sessionId)).toEqual([]);
    expect(settleOutstandingTurns(db, sessionId, CUTOFF, 4_000)).toEqual([]);
    expect(getTurnById(db, onlyTurn)?.status).toBe("active");
  });

  test("a strictly greater prompt_number is completion evidence on its own — the prompt clock", () => {
    const earlier = seedTurn(1);
    const current = seedTurn(2); // no turn-stop queued for either

    expect(listSettlementCandidateTurnIds(db, sessionId)).toEqual([earlier]);
    expect(settleOutstandingTurns(db, sessionId, CUTOFF, 4_000)).toEqual([
      earlier,
    ]);
    expect(getTurnById(db, earlier)?.status).toBe("skipped");
    // The session's own newest turn still has neither evidence source.
    expect(getTurnById(db, current)?.status).toBe("active");
  });

  test("a queued turn-stop is completion evidence on its own — a turn's own Stop, before any later prompt exists", () => {
    const onlyTurn = seedTurn(1);
    queueTurnStop(onlyTurn);

    expect(listSettlementCandidateTurnIds(db, sessionId)).toEqual([onlyTurn]);
    expect(settleOutstandingTurns(db, sessionId, CUTOFF, 4_000)).toEqual([
      onlyTurn,
    ]);
    expect(getTurnById(db, onlyTurn)?.status).toBe("skipped");
  });

  test("settles every determinable turn in one pass — no cursor, no blocking on an unrelated gap", () => {
    // The old classification walk stopped at the first turn lacking evidence
    // (a contiguous-prefix watermark). This channel has no watermark: each
    // turn is judged on its own evidence, so two turns behind the newest one
    // both settle in the same call, in prompt order.
    const first = seedTurn(1);
    const second = seedTurn(2, "provisional");
    const newest = seedTurn(3); // no turn-stop queued — stays a live candidate-less turn

    const settled = settleOutstandingTurns(db, sessionId, CUTOFF, 4_000);

    expect(settled).toEqual([first, second]);
    expect(getTurnById(db, first)?.status).not.toBe("active");
    expect(getTurnById(db, second)?.status).not.toBe("provisional");
    expect(getTurnById(db, newest)?.status).toBe("active");
  });

  test("an already-terminal turn is never a candidate", () => {
    const extracted = seedTurn(1, "extracted");
    seedTurn(2);

    expect(listSettlementCandidateTurnIds(db, sessionId)).toEqual([]);
    expect(getTurnById(db, extracted)?.status).toBe("extracted");
  });

  test("an undone sidechain row is never a candidate, later prompt or not", () => {
    const undone = seedTurn(1, "undone");
    seedTurn(2);

    expect(listSettlementCandidateTurnIds(db, sessionId)).toEqual([]);
    expect(settleOutstandingTurns(db, sessionId, CUTOFF, 4_000)).toEqual([]);
    expect(getTurnById(db, undone)?.status).toBe("undone");
  });

  test("a later undone sidechain row is not evidence that the still-running root turn ended (P1-1)", () => {
    // The root turn is still active — its own tool batch dispatched a
    // subagent, and session-init.ts's createPendingTurn (裁決 25) born the
    // sidechain's row already `undone` at a HIGHER prompt_number than the
    // root's, before the root turn's Stop has ever fired.
    const root = seedTurn(1); // active — the root's own turn
    seedTurn(2, "undone"); // the sidechain's pending row, born ahead of it

    expect(listSettlementCandidateTurnIds(db, sessionId)).toEqual([]);
    expect(settleOutstandingTurns(db, sessionId, CUTOFF, 4_000)).toEqual([]);
    expect(getTurnById(db, root)?.status).toBe("active");
  });

  test("carries the mechanical writes through: file aggregate, tool count, observation retirement", () => {
    const earlier = seedTurn(1);
    const observationId = createObservation(db, {
      turnId: earlier,
      toolName: "Edit",
      toolInput: JSON.stringify({ file_path: "/a.ts" }),
      status: "pending",
      excludedFromExtraction: false,
      createdAtEpoch: 10,
    }).id;
    seedTurn(2);

    settleOutstandingTurns(db, sessionId, CUTOFF, 4_000);

    const turn = getTurnById(db, earlier)!;
    expect(turn.filesModified).toEqual(["/a.ts"]);
    expect(turn.toolCallCount).toBe(1);
    expect(
      db
        .query<{ status: string }, [number]>(
          "SELECT status FROM observations WHERE id = ?",
        )
        .get(observationId)?.status,
    ).toBe("skipped");
  });

  test("is idempotent — a second pass over the same session settles nothing new", () => {
    const earlier = seedTurn(1);
    seedTurn(2);

    expect(settleOutstandingTurns(db, sessionId, CUTOFF, 4_000)).toEqual([
      earlier,
    ]);
    expect(settleOutstandingTurns(db, sessionId, CUTOFF, 5_000)).toEqual([]);
    expect(getTurnById(db, earlier)?.updatedAtEpoch).toBe(4_000);
  });

  test("never crosses sessions", () => {
    const otherSessionId = upsertSession(db, {
      contentSessionId: "other-settlement-session",
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    const foreignEarlier = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, 1, 'active', 'prompt', ?) RETURNING id`,
      )
      .get(otherSessionId, 3_000)!.id;
    db.query<unknown, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, 2, 'active', 'prompt', ?)`,
    ).run(otherSessionId, 3_000);
    seedTurn(1); // this session's own only turn — no evidence at all

    expect(settleOutstandingTurns(db, sessionId, CUTOFF, 4_000)).toEqual([]);
    // The foreign session's own settleable turn is untouched by a call scoped
    // to a different session — settlement never reaches across sessionId.
    expect(getTurnById(db, foreignEarlier)?.status).toBe("active");
  });
});
