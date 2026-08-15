import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { recordNoteIdExposure } from "../../src/db/note-debt";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import { isNoteSuccess, noteTool } from "../../src/mcp/note";
import {
  applyNoteSettlementWriteBack,
  parseAddressToken,
} from "../../src/worker/note-settlement-writeback";
import type { NoteSettlementResponse } from "../../src/worker/note-settlement-response";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 02 (spec D7/D8) — the mechanical backfill's write path. It must draft
 * a reconstructed note's turn exactly as `note.ts`'s agent-written path does:
 * same title, same derivation, same columns. This does not re-cover the rest
 * of `applyNoteSettlementWriteBack` (segments, edges, the gap-coverage guard —
 * untested elsewhere and out of this ticket's scope); it isolates the one
 * behaviour this ticket adds.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-writeback-session",
    project: "/tmp/project-settlement-writeback",
    title: "settlement writeback fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedHoleTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

/**
 * Every turn these fixtures seeded, standing in for "what this prompt showed".
 * A real context builds this from the window plus the rendered lookback; the
 * fixtures seed only turns that are in the window, so the two coincide — except
 * where a test deliberately seeds a turn OUTSIDE the prompt to exercise the
 * gate, which passes its own narrower set.
 */
function allSeededTurnIds(): Set<number> {
  return new Set(
    db.query<{ id: number }, []>("SELECT id FROM turns").all().map((row) => row.id),
  );
}

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

function emptyResponse(
  reconstructedNotes: NoteSettlementResponse["reconstructedNotes"],
  turnReview: NoteSettlementResponse["turnReview"] = [],
): NoteSettlementResponse {
  return {
    segments: [],
    edges: [],
    reconstructedNotes,
    turnReview,
    sessionSummary: null,
  };
}

/**
 * Ticket 01, the half its acceptance criterion left ambiguous. "The address
 * token must match whole" can mean one whole legal citation — which would
 * admit the annotated form — or the four forms this function's own doc comment
 * names. It means the four.
 *
 * An annotation exists so a human reading PROSE can see why a turn is cited.
 * An address field has no prose and no reader: `members` and the `citing`/
 * `cited` keys carry one address and nothing else, so words there are a model
 * that misread the schema, and reading past them would silently accept the
 * misreading. Rejecting costs one dropped reference and a log line, because
 * these fields drop bad tokens rather than failing the batch.
 */
describe("parseAddressToken", () => {
  test("accepts exactly the four documented forms, bracketed or bare", () => {
    for (const token of ["S12/T30", "[S12/T30]", "E47", "[E47]"]) {
      expect(parseAddressToken(token)).not.toBeNull();
    }
  });

  test("tolerates surrounding and interior whitespace — a wrapped field is a typography accident", () => {
    expect(parseAddressToken("  [S15069/T332]  ")).not.toBeNull();
    expect(parseAddressToken("[ S15069 / T332 ]")).not.toBeNull();
  });

  test("rejects an annotation: an address field has no reader to annotate for", () => {
    expect(parseAddressToken("S1/T2 annotation")).toBeNull();
    expect(parseAddressToken("[S1/T2 the retry arc]")).toBeNull();
    expect(parseAddressToken("[E47 approval]")).toBeNull();
  });

  test("rejects a token that merely contains an address", () => {
    expect(parseAddressToken("[S1/T2] junk")).toBeNull();
    expect(parseAddressToken("see [S1/T2]")).toBeNull();
    expect(parseAddressToken("[[S1/T2]]")).toBeNull();
    expect(parseAddressToken("[S1/T2] [S1/T3]")).toBeNull();
  });
});

test("a mechanical reconstruction drafts its turn's type and tag exactly as an agent-written note does", () => {
  const sessionDbId = seedSession();
  const turnId = seedHoleTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);

  const result = applyNoteSettlementWriteBack(db, {
    job,
    response: emptyResponse([
      {
        turn: `S${sessionDbId}/T1`,
        title: "implement+shadow-store: reconstructed from raw material",
        content: "Backfilled by settlement, not by the agent.",
        insight: null,
      },
    ]),
    nowEpoch: NOW,
    reconstructableTurnIds: new Set([turnId]),
    reviewableTurnIds: allSeededTurnIds(),
    contextBuiltAtEpoch: NOW,
    exposedSegmentIds: new Set(),
    rideTurnId: turnId,
  });

  expect(result.committed).toBe(true);
  expect(result.notesReconstructed).toBe(1);

  const turn = getTurnById(db, turnId)!;
  expect(turn.type).toBe("implement");
  expect(turn.tags).toContain("topic:shadow-store");
  expect(getShadowNote(db, turnId)?.writerOrigin).toBe("settlement");
});

test("an unrecognised activity word leaves the reconstruction's type empty, same as the agent path", () => {
  const sessionDbId = seedSession();
  const turnId = seedHoleTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);

  applyNoteSettlementWriteBack(db, {
    job,
    response: emptyResponse([
      {
        turn: `S${sessionDbId}/T1`,
        title: "addendum+the-plan: appended a clause",
        content: "The activity word has no alias.",
        insight: null,
      },
    ]),
    nowEpoch: NOW,
    reconstructableTurnIds: new Set([turnId]),
    reviewableTurnIds: allSeededTurnIds(),
    contextBuiltAtEpoch: NOW,
    exposedSegmentIds: new Set(),
    rideTurnId: turnId,
  });

  const turn = getTurnById(db, turnId)!;
  expect(turn.type).toBeNull();
  expect(turn.tags).toContain("topic:the-plan");
});

test("a malformed reconstruction title drafts neither, and the reconstruction still commits", () => {
  const sessionDbId = seedSession();
  const turnId = seedHoleTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);

  const result = applyNoteSettlementWriteBack(db, {
    job,
    response: emptyResponse([
      {
        turn: `S${sessionDbId}/T1`,
        title: "a plain title with no delimiters",
        content: "No shape to parse.",
        insight: null,
      },
    ]),
    nowEpoch: NOW,
    reconstructableTurnIds: new Set([turnId]),
    reviewableTurnIds: allSeededTurnIds(),
    contextBuiltAtEpoch: NOW,
    exposedSegmentIds: new Set(),
    rideTurnId: turnId,
  });

  expect(result.committed).toBe(true);
  expect(result.notesReconstructed).toBe(1);
  const turn = getTurnById(db, turnId)!;
  expect(turn.type).toBeNull();
  expect(turn.tags).toEqual([]);
});

/** `turn_review` addresses are gated by the writer's exposure ledger — the
 * same gate `members`/`edges` already go through — so a direct writeback test
 * (bypassing `buildNoteSettlementContext`, which records exposure itself)
 * must seed it, or every address in these tests would read as "not shown". */
function expose(sessionDbId: number, rideTurnId: number, turnIds: number[]): void {
  recordNoteIdExposure(db, {
    sessionId: sessionDbId,
    rideTurnId,
    exposedTurnIds: turnIds,
    source: "injection",
    nowEpoch: NOW,
  });
}

/**
 * Run `fire` the instant after the next read of a turns row, then get out of
 * the way. Ticket 05's own race: the main agent notes its own turn WHILE the
 * turn is still running, so a note transaction can commit between the
 * write-back's read of a row and its write. This reproduces that interleave
 * deterministically, on the same connection, via a nested savepoint —
 * verified (see the ticket's own investigation notes) to compose correctly
 * with bun:sqlite's `.immediate()` transactions rather than throwing.
 *
 * Copied from `tests/mcp/era-cutover.test.ts`'s helper of the same name
 * (that file's own doc comment explains the mechanism); duplicated rather
 * than imported because each settlement/era fixture file owns its local
 * seeding helpers already, and a shared import here would be a new seam for
 * one seven-line function.
 */
function fireAfterNextTurnRead(fire: () => void): void {
  const originalQuery = db.query.bind(db);
  let armed = true;
  (db as unknown as { query: (sql: string) => unknown }).query = (
    sql: string,
  ) => {
    const statement = originalQuery(sql) as unknown as {
      get: (...args: unknown[]) => unknown;
    };
    if (!armed || !/^\s*SELECT/i.test(sql) || !/FROM turns/i.test(sql)) {
      return statement;
    }
    const originalGet = statement.get.bind(statement);
    statement.get = (...args: unknown[]) => {
      const row = originalGet(...args);
      if (armed) {
        armed = false;
        statement.get = originalGet;
        (db as unknown as { query: unknown }).query = originalQuery;
        fire();
      }
      return row;
    };
    return statement;
  };
}

describe("turn review: grade, type, tag (ticket 05)", () => {
  test("lands on every directed turn, including one that already has a note, with a per-grade histogram", () => {
    const sessionDbId = seedSession();
    const t1 = seedHoleTurn(sessionDbId, 1);
    const t2 = seedHoleTurn(sessionDbId, 2);
    db.query<unknown, [number, string, string, number, number]>(
      `INSERT INTO shadow_notes (turn_id, title, content, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(t1, "agent's own title", "agent's own content", NOW - 10, NOW - 10);
    const job = claimWindow(sessionDbId, 1, 2);
    expose(sessionDbId, t2, [t1, t2]);

    const result = applyNoteSettlementWriteBack(db, {
      job,
      response: emptyResponse([], [
        { turn: `S${sessionDbId}/T1`, grade: 2, type: "design", tag: "widgets" },
        { turn: `S${sessionDbId}/T2`, grade: 0, type: null, tag: null },
      ]),
      nowEpoch: NOW,
      reconstructableTurnIds: new Set(),
      reviewableTurnIds: allSeededTurnIds(),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t2,
    });

    expect(result.committed).toBe(true);
    expect(result.turnsReviewed).toBe(2);
    expect(result.gradeHistogram).toEqual([1, 0, 1, 0, 0]);

    const turn1 = getTurnById(db, t1)!;
    expect(turn1.significanceGrade).toBe(2);
    expect(turn1.type).toBe("design");
    expect(turn1.tags).toContain("topic:widgets");
    // Review never touches the note itself — only turns columns.
    expect(getShadowNote(db, t1)?.title).toBe("agent's own title");

    const turn2 = getTurnById(db, t2)!;
    expect(turn2.significanceGrade).toBe(0);
    expect(turn2.type).toBeNull();
    expect(turn2.tags).toEqual([]);
  });

  test("preserves a non-topic tag while replacing the topic slice", () => {
    const sessionDbId = seedSession();
    const t1 = seedHoleTurn(sessionDbId, 1);
    db.query<unknown, [number]>(
      `UPDATE turns SET tags = '["deferred","topic:stale"]' WHERE id = ?`,
    ).run(t1);
    const job = claimWindow(sessionDbId, 1, 1);
    expose(sessionDbId, t1, [t1]);

    applyNoteSettlementWriteBack(db, {
      job,
      response: emptyResponse([], [
        { turn: `S${sessionDbId}/T1`, grade: 1, type: null, tag: "fresh-topic" },
      ]),
      nowEpoch: NOW,
      reconstructableTurnIds: new Set(),
      reviewableTurnIds: allSeededTurnIds(),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t1,
    });

    const turn = getTurnById(db, t1)!;
    expect(turn.tags).toContain("deferred");
    expect(turn.tags).toContain("topic:fresh-topic");
    expect(turn.tags).not.toContain("topic:stale");
  });

  test("an unexposed or nonexistent turn address fails the whole window, committing nothing", () => {
    const sessionDbId = seedSession();
    const t1 = seedHoleTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    expose(sessionDbId, t1, [t1]);

    const result = applyNoteSettlementWriteBack(db, {
      job,
      response: emptyResponse([], [
        { turn: `S${sessionDbId}/T1`, grade: 3, type: "fix", tag: "widgets" },
        // Never shown to this writer — no address at prompt_number 999.
        { turn: `S${sessionDbId}/T999`, grade: 1, type: null, tag: null },
      ]),
      nowEpoch: NOW,
      reconstructableTurnIds: new Set(),
      reviewableTurnIds: allSeededTurnIds(),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t1,
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toContain("turn_review");
    // All-or-nothing: the WELL-FORMED, resolvable directive for T1 did not
    // land either — half a review is not a smaller correct one.
    const turn = getTurnById(db, t1)!;
    expect(turn.significanceGrade).toBeNull();
    expect(turn.type).toBeNull();
  });

  test("re-applying the same window's response converges rather than accumulating", () => {
    const sessionDbId = seedSession();
    const t1 = seedHoleTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    expose(sessionDbId, t1, [t1]);
    const response = emptyResponse([], [
      { turn: `S${sessionDbId}/T1`, grade: 3, type: "fix", tag: "widgets" },
    ]);

    const first = applyNoteSettlementWriteBack(db, {
      job,
      response,
      nowEpoch: NOW,
      reconstructableTurnIds: new Set(),
      reviewableTurnIds: allSeededTurnIds(),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t1,
    });
    expect(first.committed).toBe(true);

    // Simulate a retry over the same window: the job is claimable again, same
    // generation, same response.
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET status = 'claimed' WHERE id = ?",
    ).run(job.id);
    const second = applyNoteSettlementWriteBack(db, {
      job,
      response,
      nowEpoch: NOW + 1,
      reconstructableTurnIds: new Set(),
      reviewableTurnIds: allSeededTurnIds(),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t1,
    });
    expect(second.committed).toBe(true);

    const turn = getTurnById(db, t1)!;
    expect(turn.significanceGrade).toBe(3);
    expect(turn.type).toBe("fix");
    // Not duplicated — SET semantics, not append.
    expect(turn.tags).toEqual(["topic:widgets"]);
  });

  /**
   * The fence, proven by reproducing the interleave rather than asserting it
   * exists (the ticket's own instruction).
   *
   * The columns to watch are `type` and `tags`, NOT `title`/`content`: the
   * write-back never names those three in `updateTurnById` at all, so they
   * survive by construction and a test watching only them would stay green
   * against a completely unfenced implementation. `type`/`tags` are the pair
   * that both writers really do contend for — the agent's note drafts them
   * from its own title, the settlement review restates them from a view of
   * the turn taken before that note existed.
   */
  test("a note committed after the worker's read wins the columns it derives, and the review keeps the one it owns", () => {
    const sessionDbId = seedSession();
    const t1 = seedHoleTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    expose(sessionDbId, t1, [t1]);

    fireAfterNextTurnRead(() => {
      const raced = noteTool(
        db,
        {
          turn: `S${sessionDbId}/T1`,
          title: "design+scheduling: the agent's own live account",
          content: "Written by the main agent while its turn was still running.",
        },
        // Strictly after `claimWindow`'s claim at NOW — this note was not in
        // the prompt the reviewer answered.
        { now: () => NOW + 5, env: {}, eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH },
      );
      expect(isNoteSuccess(raced)).toBe(true);
    });

    const result = applyNoteSettlementWriteBack(db, {
      job,
      response: emptyResponse([], [
        { turn: `S${sessionDbId}/T1`, grade: 3, type: "fix", tag: "settlement" },
      ]),
      nowEpoch: NOW + 6,
      reconstructableTurnIds: new Set(),
      reviewableTurnIds: allSeededTurnIds(),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t1,
    });

    expect(result.committed).toBe(true);
    const turn = getTurnById(db, t1)!;
    expect(turn.title).toBe("design+scheduling: the agent's own live account");
    expect(turn.content).toBe(
      "Written by the main agent while its turn was still running.",
    );
    // The contended pair: the review's verdict described a NOTE-LESS turn, so
    // it must not restate this note's facts. Were the fence only "re-read the
    // row", these two would read `fix` / `topic:settlement`.
    expect(turn.type).toBe("design");
    expect(turn.tags).toContain("topic:scheduling");
    expect(turn.tags).not.toContain("topic:settlement");
    // Grade is the review's own column — judged from raw material, not from
    // the note — so it lands regardless.
    expect(turn.significanceGrade).toBe(3);
    expect(result.turnsReviewed).toBe(1);
    expect(result.reviewsYieldedToLateNote).toBe(1);
  });

  test("a note already in place when the window was claimed does not shield it from review", () => {
    const sessionDbId = seedSession();
    const t1 = seedHoleTurn(sessionDbId, 1);
    // The mirror image of the test above: this note predates the claim, so it
    // IS what the reviewer read, and its mechanical draft is exactly what the
    // review exists to confirm or override.
    const written = noteTool(
      db,
      {
        turn: `S${sessionDbId}/T1`,
        title: "design+scheduling: written well before the window was claimed",
        content: "Visible in the prompt the reviewer answered.",
      },
      { now: () => NOW - 60, env: {}, eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH },
    );
    expect(isNoteSuccess(written)).toBe(true);

    const job = claimWindow(sessionDbId, 1, 1);
    expose(sessionDbId, t1, [t1]);

    const result = applyNoteSettlementWriteBack(db, {
      job,
      response: emptyResponse([], [
        { turn: `S${sessionDbId}/T1`, grade: 3, type: "fix", tag: "settlement" },
      ]),
      nowEpoch: NOW + 1,
      reconstructableTurnIds: new Set(),
      reviewableTurnIds: allSeededTurnIds(),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t1,
    });

    expect(result.committed).toBe(true);
    expect(result.reviewsYieldedToLateNote).toBe(0);
    const turn = getTurnById(db, t1)!;
    expect(turn.type).toBe("fix");
    expect(turn.tags).toContain("topic:settlement");
    expect(turn.tags).not.toContain("topic:scheduling");
  });

  test("an exposed turn this prompt did not show is refused, not silently revised", () => {
    const sessionDbId = seedSession();
    const t1 = seedHoleTurn(sessionDbId, 1);
    // A real turn from an older window: it exists, and the session-lifetime
    // exposure ledger remembers showing it, so resolution alone lets it
    // through. Only "was it in THIS prompt" stops a hallucinated address from
    // landing a destructive write on it.
    const older = seedHoleTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 1);
    expose(sessionDbId, t1, [t1, older]);

    const result = applyNoteSettlementWriteBack(db, {
      job,
      response: emptyResponse([], [
        { turn: `S${sessionDbId}/T2`, grade: 4, type: "fix", tag: "hallucinated" },
      ]),
      nowEpoch: NOW,
      reconstructableTurnIds: new Set(),
      reviewableTurnIds: new Set([t1]),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t1,
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toContain("outside this window");
    expect(getTurnById(db, older)!.significanceGrade).toBeNull();
  });

  test("a reconstruction this window just wrote is still the review's to override", () => {
    const sessionDbId = seedSession();
    const t1 = seedHoleTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    expose(sessionDbId, t1, [t1]);

    // A settlement-origin note carries a timestamp newer than the claim too,
    // but it is this same reply's own work — yielding to it would mean the
    // review could never correct the note it just wrote.
    const result = applyNoteSettlementWriteBack(db, {
      job,
      response: emptyResponse(
        [
          {
            turn: `S${sessionDbId}/T1`,
            title: "design+scheduling: reconstructed in this very window",
            content: "Backfilled by settlement.",
            insight: null,
          },
        ],
        [{ turn: `S${sessionDbId}/T1`, grade: 3, type: "fix", tag: "settlement" }],
      ),
      nowEpoch: NOW + 6,
      reconstructableTurnIds: new Set([t1]),
      reviewableTurnIds: allSeededTurnIds(),
      contextBuiltAtEpoch: NOW,
      exposedSegmentIds: new Set(),
      rideTurnId: t1,
    });

    expect(result.committed).toBe(true);
    expect(result.notesReconstructed).toBe(1);
    expect(result.reviewsYieldedToLateNote).toBe(0);
    const turn = getTurnById(db, t1)!;
    expect(turn.type).toBe("fix");
    expect(turn.tags).toContain("topic:settlement");
  });
});

test("a yielded reconstruction (an agent note already won) never touches the turn's type or tag", () => {
  const sessionDbId = seedSession();
  const turnId = seedHoleTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);

  // Simulate the agent's own note landing first — upsertReconstructedShadowNote
  // refuses to overwrite an `agent`-origin row, so this window's directive for
  // the same turn must yield without drafting anything onto it either.
  db.query<unknown, [number, string, string, string, number, number]>(
    `INSERT INTO shadow_notes (
       turn_id, title, content, writer_origin, created_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'agent', ?, ?)`,
  ).run(turnId, "agent's own title", "agent's own content", NOW - 10, NOW - 10);

  const result = applyNoteSettlementWriteBack(db, {
    job,
    response: emptyResponse([
      {
        turn: `S${sessionDbId}/T1`,
        title: "implement+shadow-store: reconstructed too late",
        content: "The agent already answered.",
        insight: null,
      },
    ]),
    nowEpoch: NOW,
    reconstructableTurnIds: new Set([turnId]),
    reviewableTurnIds: allSeededTurnIds(),
    contextBuiltAtEpoch: NOW,
    exposedSegmentIds: new Set(),
    rideTurnId: turnId,
  });

  expect(result.committed).toBe(true);
  expect(result.notesYielded).toBe(1);
  expect(result.notesReconstructed).toBe(0);
  const turn = getTurnById(db, turnId)!;
  expect(turn.type).toBeNull();
  expect(turn.tags).toEqual([]);
});
