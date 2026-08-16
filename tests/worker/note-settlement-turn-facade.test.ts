import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, isSqliteBusy } from "../../src/db/database";
import { getOutgoingEdges, pairKey, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import {
  settlementTurnWriteInputShape,
  settlementTurnWriteTool,
  type SettlementTurnFacadeContext,
} from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 10a (spec G6/G7, D5/D5a, C7/C14) — the settlement write server's
 * turn facade. See src/worker/note-settlement-turn-facade.ts for the design;
 * this file proves the acceptance criteria the ticket names: the fence
 * shares a transaction with the write it guards (shown by an interleave, not
 * a code reading), the facade's scope gates (reconstructable/reviewable),
 * the late-note yield on both halves, whole-replace tags, the pre-run
 * relation snapshot's immunity to a call earlier in the SAME run, and the
 * omitted-whole-rewrite-field refusal.
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
    contentSessionId: "settlement-turn-facade-session",
    project: "/tmp/project-settlement-turn-facade",
    title: "settlement turn facade fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
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

function baseContext(
  job: NoteSettlementJob,
  overrides: Partial<SettlementTurnFacadeContext> = {},
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: job.sessionId,
    reconstructableTurnIds: new Set(),
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    rideTurnId: null,
    writerModel: "claude-sonnet-5",
    eligibleRelationPairKeys: new Set(),
    ...overrides,
  };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content?.[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// Requirement 3: the restricted surface
// ---------------------------------------------------------------------------

describe("settlementTurnWriteInputShape — the restricted surface (requirement 3)", () => {
  test("declares no skip, session, crossSession, mode, or job-identity field", () => {
    const keys = Object.keys(settlementTurnWriteInputShape);
    for (const forbidden of [
      "skip",
      "session",
      "crossSession",
      "mode",
      "jobId",
      "claimGeneration",
      "job",
      "claim_generation",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("tags overwrite whole, never append (requirement 3)", () => {
  test("a second call's tags list replaces the first's rather than unioning with it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    settlementTurnWriteTool(
      db,
      context,
      { turn: `S${sessionDbId}/T1`, tags: ["first", "second"] },
      NOW,
    );
    expect(getTurnById(db, t1)!.tags).toEqual(["first", "second"]);

    settlementTurnWriteTool(
      db,
      context,
      { turn: `S${sessionDbId}/T1`, tags: ["third"] },
      NOW + 1,
    );
    // Whole replace: "first"/"second" are gone, not merged with "third" —
    // there is no `mode`/append this facade could even be asked for.
    expect(getTurnById(db, t1)!.tags).toEqual(["third"]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 2 / acceptance criterion 2: the fence's own transaction
// ---------------------------------------------------------------------------

/**
 * Run `fire` the instant after the next `SELECT … FROM note_settlement_jobs`
 * reads its row, then get out of the way — the fence's own read
 * (`assertNoteSettlementJobClaimed` → `getNoteSettlementJob`). Same nested-
 * savepoint mechanism as `tests/worker/note-settlement-writeback.test.ts`'s
 * `fireAfterNextTurnRead` and `tests/db/note-settlement-completion.test.ts`'s
 * `fireAfterNextTurnsRead`, targeted at a different table because THIS
 * fence's own read is what the interleave needs to catch mid-flight.
 */
function fireAfterNextJobsRead(target: Database, fire: () => void): void {
  const originalQuery = target.query.bind(target);
  let armed = true;
  (target as unknown as { query: (sql: string) => unknown }).query = (
    sql: string,
  ) => {
    const statement = originalQuery(sql) as unknown as {
      get: (...args: unknown[]) => unknown;
    };
    if (!armed || !/^\s*SELECT/i.test(sql) || !/FROM note_settlement_jobs/i.test(sql)) {
      return statement;
    }
    const originalGet = statement.get.bind(statement);
    statement.get = (...args: unknown[]) => {
      const row = originalGet(...args);
      if (armed) {
        armed = false;
        statement.get = originalGet;
        (target as unknown as { query: unknown }).query = originalQuery;
        fire();
      }
      return row;
    };
    return statement;
  };
}

describe("the ownership fence shares a transaction with the write it guards (spec G6/G7, requirement 2)", () => {
  let directory: string;
  let other: Database;

  beforeEach(() => {
    // The outer hook made a `:memory:` database; two connections need a file
    // — a same-connection fixture cannot test transaction isolation at all,
    // since an injected write would land INSIDE the transaction under test.
    db.close();
    directory = mkdtempSync(join(tmpdir(), "mnemo-turn-facade-txn-"));
    db = createDatabase(join(directory, "mnemo.sqlite"));
    initializeSchema(db);
    // `busyTimeoutMs: 0` so the competing write fails immediately instead of
    // blocking on the lock for the default timeout.
    other = createDatabase(join(directory, "mnemo.sqlite"), { busyTimeoutMs: 0 });
  });

  afterEach(() => {
    other.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a competing connection cannot bump the claim generation between the fence's read and the business write", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    let competingBumpLanded = false;
    fireAfterNextJobsRead(db, () => {
      try {
        other
          .query<unknown, [number]>(
            "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
          )
          .run(job.id);
        competingBumpLanded = true;
      } catch (error) {
        if (!isSqliteBusy(error)) {
          throw error;
        }
      }
    });

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, grade: 3 },
      NOW,
    );

    // The load-bearing assertion: the bump was locked out. If the fence ran
    // as its own transaction ahead of a SEPARATE write transaction (the
    // "assert(); write()" TOCTOU the ticket names), nothing would hold the
    // lock in between, the bump would land, and this write would still
    // commit against a generation that had already moved.
    expect(competingBumpLanded).toBe(false);
    expect(resultText(result)).toContain("Reviewed");
    expect(getTurnById(db, t1)!.significanceGrade).toBe(3);
  });

  test("a claim generation already stale BEFORE the call starts refuses the write outright", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const staleGeneration = job.claimGeneration;

    other
      .query<unknown, [number]>(
        "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
      )
      .run(job.id);

    const result = settlementTurnWriteTool(
      db,
      baseContext(
        { ...job, claimGeneration: staleGeneration },
        { reviewableTurnIds: new Set([t1]) },
      ),
      { turn: `S${sessionDbId}/T1`, grade: 3 },
      NOW,
    );

    expect(resultText(result)).toContain("lease was reclaimed");
    expect(getTurnById(db, t1)!.significanceGrade).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Requirement 4: prose only for reconstructable holes, yields to a late note
// ---------------------------------------------------------------------------

describe("prose is writable only for this dispatch's reconstructable holes (requirement 4)", () => {
  test("refuses a title/content/insight write for a turn outside reconstructableTurnIds", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reconstructableTurnIds: new Set() }),
      {
        turn: `S${sessionDbId}/T1`,
        title: "should be refused",
        content: "not an owed hole",
        insight: null,
      },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("not a reconstructable hole");
    expect(getShadowNote(db, t1)).toBeNull();
  });

  test("writes a reconstruction note for a turn the dispatch names as a hole", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reconstructableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        title: "research+lease: reconstructed from raw material",
        content: "Backfilled by settlement.",
        insight: null,
      },
      NOW,
    );

    expect(resultText(result)).toContain("Reconstructed");
    const note = getShadowNote(db, t1)!;
    expect(note.writerOrigin).toBe("settlement");
    expect(note.title).toContain("reconstructed from raw material");
  });

  test("yields to a note the main agent landed after this dispatch's context was read", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    // The agent's own note lands (writer_origin='agent') — the exact race
    // spec D7 requires a winner for.
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own title",
      content: "agent's own content",
      nowEpoch: NOW,
    });

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reconstructableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        title: "settlement's reconstruction, too late",
        content: "The agent already answered.",
        insight: null,
      },
      NOW,
    );

    expect(resultText(result)).toContain("yielded");
    const note = getShadowNote(db, t1)!;
    expect(note.writerOrigin).toBe("agent");
    expect(note.title).toBe("agent's own title");
  });
});

// ---------------------------------------------------------------------------
// Requirement 5: grade/type/tags only for reviewable turns, yield on the
// note-derived half
// ---------------------------------------------------------------------------

describe("grade/type/tags are writable only for the window's reviewable turns (requirement 5)", () => {
  test("refuses a review write for a turn outside reviewableTurnIds", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reviewableTurnIds: new Set() }),
      { turn: `S${sessionDbId}/T1`, grade: 4, type: ["design"], tags: ["x"] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("reviewable window");
    expect(getTurnById(db, t1)!.significanceGrade).toBeNull();
  });

  test("writes grade/type/tags whole for a reviewable turn", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, grade: 2, type: ["design"], tags: ["widgets"] },
      NOW,
    );

    expect(resultText(result)).toContain("Reviewed");
    const turn = getTurnById(db, t1)!;
    expect(turn.significanceGrade).toBe(2);
    expect(turn.type).toEqual(["design"]);
    expect(turn.tags).toEqual(["widgets"]);
  });

  test("yields type/tags (but not grade) to a note landed after this dispatch's context was read", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    // Committed strictly after `contextBuiltAtEpoch` (NOW): the model never
    // saw this note.
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own live account",
      content: "written while the turn was still running",
      nowEpoch: NOW + 5,
    });

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]), contextBuiltAtEpoch: NOW }),
      { turn: `S${sessionDbId}/T1`, grade: 3, type: ["fix"], tags: ["settlement"] },
      NOW + 6,
    );

    expect(resultText(result)).toContain("yielded");
    const turn = getTurnById(db, t1)!;
    // Grade is the review's own column — judged from raw material, not the
    // note — so it lands regardless of the yield.
    expect(turn.significanceGrade).toBe(3);
    expect(turn.type).toEqual([]);
    expect(turn.tags).toEqual([]);
  });

  test("does not yield to a note that predates the dispatch's context read", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    // Written BEFORE the context was read — this IS what the model saw.
    upsertShadowNote(db, {
      turnId: t1,
      title: "written before the window was claimed",
      content: "visible in the prompt the reviewer answered",
      nowEpoch: NOW - 60,
    });
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reviewableTurnIds: new Set([t1]), contextBuiltAtEpoch: NOW }),
      { turn: `S${sessionDbId}/T1`, grade: 3, type: ["fix"], tags: ["settlement"] },
      NOW + 1,
    );

    expect(resultText(result)).not.toContain("yielded");
    const turn = getTurnById(db, t1)!;
    expect(turn.type).toEqual(["fix"]);
    expect(turn.tags).toEqual(["settlement"]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 4 (relation half): pre-run snapshot, not per-call
// ---------------------------------------------------------------------------

describe("relation eligibility comes from a pre-run snapshot, not per tool call (requirement 4/6, spec C7/C14)", () => {
  test("attaches a relation to a pair present in the pre-run snapshot", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    // A pre-existing bare pair (a prior note's citation, in production).
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
      { eligibleForRelation: "unrestricted" },
    );
    const job = claimWindow(sessionDbId, 1, 2);
    const snapshot = new Set([pairKey({ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 } })]);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { eligibleRelationPairKeys: snapshot }),
      { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("Attached 1 relation");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("depends-on");
    expect(edges[0]!.provenance).toBe("judged");
  });

  /**
   * The load-bearing case (requirement 4's own wording): an EARLIER call in
   * this same dispatch run mints a pair (by reconstructing a note that
   * cites... no — this facade has no body of its own to cite through, so the
   * pair is minted here directly, standing in for whatever mechanism landed
   * it mid-run) and a LATER call must not be able to treat that freshly-
   * minted pair as eligible, because the snapshot was taken before either
   * call ran.
   */
  test("a pair created during THIS run (after the snapshot was taken) cannot license a later call's relation", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    // The snapshot was taken before the run started — no pair exists yet.
    const snapshot = new Set<string>();

    // Mid-run, some other write in the SAME dispatch mints the bare pair
    // (e.g. another tool's body citing it) — but the snapshot this call was
    // handed is still the frozen pre-run one.
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW,
      { eligibleForRelation: "unrestricted" },
    );

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { eligibleRelationPairKeys: snapshot }),
      { turn: `S${sessionDbId}/T2`, supersedes: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("not eligible");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    // The bare pair from the mid-run write survives untouched — refusing the
    // relation must not also refuse the pair a different write legitimately
    // created.
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBeNull();
  });

  test("a relation-only edge naming a pair that never existed at all is refused", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { eligibleRelationPairKeys: new Set() }),
      { turn: `S${sessionDbId}/T2`, evidenceFor: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 7: an omitted whole-rewrite field is refused, never defaulted
// ---------------------------------------------------------------------------

describe("an omitted whole-rewrite field is refused, never defaulted to empty (requirement 7)", () => {
  test("refuses a prose write missing insight, even though title and content are present", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reconstructableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, title: "a title", content: "some content" },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("omitted field is refused");
    expect(getShadowNote(db, t1)).toBeNull();
  });

  test("refuses a prose write missing content", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reconstructableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, title: "a title", insight: null },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(getShadowNote(db, t1)).toBeNull();
  });

  test("accepts insight explicitly null — naming 'no insight' is not the same as omitting the key", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job, { reconstructableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, title: "a title", content: "some content", insight: null },
      NOW,
    );

    expect(resultText(result)).toContain("Reconstructed");
    expect(getShadowNote(db, t1)!.insight).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A parameter-shape sanity check independent of the acceptance criteria list
// ---------------------------------------------------------------------------

describe("call shape", () => {
  test("refuses a call naming no field at all", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job),
      { turn: `S${sessionDbId}/T1` },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
  });

  test("refuses an address naming no turn", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = settlementTurnWriteTool(
      db,
      baseContext(job),
      { turn: `S${sessionDbId}/T999`, grade: 1 },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
  });
});
