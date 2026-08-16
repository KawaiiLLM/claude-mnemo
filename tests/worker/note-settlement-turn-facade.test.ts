import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  getOutgoingEdges,
  pairKey,
  reconcileCitedPairs,
  writeMemoryEdges,
} from "../../src/db/memory-edges";
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
  evaluateSettlementTurnWrite,
  renderSettlementTurnWriteReceipt,
  settlementTurnWriteInputShape,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteEvaluation,
  type SettlementTurnWriteInput,
} from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 10a (spec G6/G7, D5/D5a, C7/C14), staged by ticket 10b (spec A7) —
 * the settlement turn-write facade's DECISION function,
 * `evaluateSettlementTurnWrite`. This file used to drive the facade's own
 * write tool directly, which wrote immediately; ticket 10b removed that tool
 * (staging now owns the actual write, in `note-settlement-staging.ts`) and
 * split the facade into a pure decision function called twice — once with
 * `apply: false` (a dry run, exercised by the "stage vs apply" describe
 * block below) and once with `apply: true` (everywhere else in this file,
 * which is the direct descendant of what the old immediate-write tool did).
 *
 * The ownership-fence test that used to live here moved to
 * `note-settlement-staging.test.ts`: the fence is no longer this function's
 * own concern (it never opens a transaction any more) — it is `commit`'s,
 * shared with the staged replay it guards.
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
    exposedSegmentIds: new Set(),
    contextBuiltAtEpoch: NOW,
    rideTurnId: null,
    writerModel: "claude-sonnet-5",
    eligibleRelationPairKeys: new Set(),
    ...overrides,
  };
}

/** The direct descendant of the old immediate-write tool: evaluate and apply in one call. */
function write(
  context: SettlementTurnFacadeContext,
  input: SettlementTurnWriteInput,
  nowEpoch: number,
): SettlementTurnWriteEvaluation {
  return evaluateSettlementTurnWrite(db, context, input, nowEpoch, { apply: true });
}

function resultText(evaluation: SettlementTurnWriteEvaluation): string {
  return evaluation.ok
    ? renderSettlementTurnWriteReceipt(evaluation.outcome, { staged: false })
    : `Parameter error: ${evaluation.message}`;
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

    write(context, { turn: `S${sessionDbId}/T1`, tags: ["first", "second"] }, NOW);
    expect(getTurnById(db, t1)!.tags).toEqual(["first", "second"]);

    write(context, { turn: `S${sessionDbId}/T1`, tags: ["third"] }, NOW + 1);
    // Whole replace: "first"/"second" are gone, not merged with "third" —
    // there is no `mode`/append this facade could even be asked for.
    expect(getTurnById(db, t1)!.tags).toEqual(["third"]);
  });
});

// ---------------------------------------------------------------------------
// Ticket 10d: the retired `topic:` tag namespace (spec B6) must stay
// retired at this write boundary too — the facade used to pass tags raw.
// ---------------------------------------------------------------------------

describe("the retired topic: tag namespace is refused, not silently revived (ticket 10d)", () => {
  test("a staged tag with the topic: prefix is refused, and nothing lands", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, grade: 2, tags: ["topic:lease"] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("retired topic:");
    expect(getTurnById(db, t1)!.tags).toEqual([]);
    expect(getTurnById(db, t1)!.significanceGrade).toBeNull();
  });

  test("a bare tag alongside an existing bare tag is unaffected", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(context, { turn: `S${sessionDbId}/T1`, tags: ["lease"] }, NOW);

    expect(resultText(result)).not.toContain("Parameter error");
    expect(getTurnById(db, t1)!.tags).toEqual(["lease"]);
  });
});

// ---------------------------------------------------------------------------
// Stage vs apply (ticket 10b, spec A7 requirements 1/2): a dry run performs
// no write and still reports the same decision a real write would.
// ---------------------------------------------------------------------------

describe("evaluateSettlementTurnWrite with apply:false performs no write (spec A7 requirement 1/2)", () => {
  test("a review dry run reports the write it would make without touching the row", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const evaluation = evaluateSettlementTurnWrite(
      db,
      context,
      { turn: `S${sessionDbId}/T1`, grade: 3, type: ["design"], tags: ["widgets"] },
      NOW,
      { apply: false },
    );

    expect(evaluation.ok).toBe(true);
    expect(evaluation.ok && evaluation.outcome.review).toEqual({
      kind: "written",
      grade: 3,
      type: ["design"],
      tags: ["widgets"],
    });
    // The load-bearing assertion: nothing landed.
    const turn = getTurnById(db, t1)!;
    expect(turn.significanceGrade).toBeNull();
    expect(turn.type).toEqual([]);
    expect(turn.tags).toEqual([]);
  });

  test("a reconstruction dry run reports it would write without creating a shadow note", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reconstructableTurnIds: new Set([t1]) });

    const evaluation = evaluateSettlementTurnWrite(
      db,
      context,
      { turn: `S${sessionDbId}/T1`, title: "a title", content: "some content", insight: null },
      NOW,
      { apply: false },
    );

    expect(evaluation.ok).toBe(true);
    expect(evaluation.ok && evaluation.outcome.prose).toEqual({ kind: "written" });
    expect(getShadowNote(db, t1)).toBeNull();
  });

  test("a relation dry run reports what would be attached without writing an edge", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    // The frozen snapshot names a pair only ever taken from a real row in
    // THIS same database — a real pre-existing bare pair, so the fixture
    // matches what a real pre-run snapshot would only ever contain (ticket
    // 10d: eligibility is frozen INTERSECTED with current, so a key with no
    // backing row is not a state the real snapshot builder ever produces).
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
      { eligibleForRelation: "unrestricted" },
    );
    const snapshot = new Set([
      pairKey({ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 } }),
    ]);
    const context = baseContext(job, { eligibleRelationPairKeys: snapshot });

    const evaluation = evaluateSettlementTurnWrite(
      db,
      context,
      { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW,
      { apply: false },
    );

    expect(evaluation.ok).toBe(true);
    expect(evaluation.ok && evaluation.outcome.relations).toEqual({ written: 1 });
    // The dry run wrote nothing NEW — the one edge present is the fixture's
    // own pre-existing BARE pair (relation still null), not a relation this
    // `apply: false` call landed.
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBeNull();
  });

  test("a dry run rejects exactly what a real write would reject — full validation, not a shape check", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set() });

    const evaluation = evaluateSettlementTurnWrite(
      db,
      context,
      { turn: `S${sessionDbId}/T1`, grade: 4 },
      NOW,
      { apply: false },
    );

    expect(evaluation.ok).toBe(false);
    expect(!evaluation.ok && evaluation.message).toContain("reviewable window");
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

    const result = write(
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

    const result = write(
      baseContext(job, { reconstructableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        title: "research+lease: reconstructed from raw material",
        content: "Backfilled by settlement.",
        insight: null,
      },
      NOW,
    );

    expect(resultText(result)).toContain("reconstruction");
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

    const result = write(
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

    const result = write(
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

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, grade: 2, type: ["design"], tags: ["widgets"] },
      NOW,
    );

    expect(resultText(result)).not.toContain("Parameter error");
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

    const result = write(
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

    const result = write(
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
// Requirement 4 (relation half): pre-run snapshot, not per-call — and spec
// A7 requirement 5: commit-time re-validation is a genuinely different check
// from stage time, proven here by re-evaluating with a snapshot that moved.
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

    const result = write(
      baseContext(job, { eligibleRelationPairKeys: snapshot }),
      { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("1 relation");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("depends-on");
    expect(edges[0]!.provenance).toBe("judged");
  });

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

    const result = write(
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

    const result = write(
      baseContext(job, { eligibleRelationPairKeys: new Set() }),
      { turn: `S${sessionDbId}/T2`, evidenceFor: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);
  });

  test("commit-time re-evaluation is truth: a pair present at stage time can be gone by commit time, and the outcome differs (spec A7 requirement 5)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    // A real pre-existing bare pair — what the pre-run snapshot builder only
    // ever takes a key FROM (ticket 10d: frozen alone is never enough).
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
      { eligibleForRelation: "unrestricted" },
    );
    const snapshot = new Set([pairKey({ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 } })]);
    const context = baseContext(job, { eligibleRelationPairKeys: snapshot });
    const input: SettlementTurnWriteInput = {
      turn: `S${sessionDbId}/T2`,
      dependsOn: [`S${sessionDbId}/T1`],
    };

    // Stage time: the caller's own snapshot says this pair is eligible —
    // evaluate() alone cannot see anything that would refuse it.
    const staged = evaluateSettlementTurnWrite(db, context, input, NOW, { apply: false });
    expect(staged.ok).toBe(true);
    expect(staged.ok && staged.outcome.relations).toEqual({ written: 1 });

    // The world moves: the SAME context object is reused for the commit-time
    // call (as the staging engine does — one context per request), but here
    // a fresh context with an emptied snapshot stands in for "the pre-run
    // eligibility this run was handed no longer covers this pair" — the
    // shape a real commit sees when the pair it staged against was itself
    // struck from eligibility upstream. Re-evaluating with `apply: true`
    // against that changed input is exactly what `commit`'s replay does.
    const movedContext = baseContext(job, { eligibleRelationPairKeys: new Set() });
    const atCommit = evaluateSettlementTurnWrite(db, movedContext, input, NOW + 10, {
      apply: true,
    });
    expect(atCommit.ok).toBe(false);
    expect(!atCommit.ok && atCommit.message).toContain("not eligible");
    // The pre-existing BARE pair survives untouched — refusing the relation
    // must not also erase the citation that made the pair eligible in the
    // first place; only the relation itself never lands.
    const survivingEdges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(survivingEdges).toHaveLength(1);
    expect(survivingEdges[0]!.relation).toBeNull();
  });

  // Ticket 10d (review test-gap finding): the test above replaces the
  // FROZEN Set but never touches the DATABASE pair, which is precisely why
  // it could not have caught the resurrection bug — a stale frozen key and
  // a genuinely-deleted current pair are two different kinds of "the world
  // moved", and only this second one is the bug the review found. This test
  // holds the frozen snapshot FIXED (as `commit`'s own replay does — the
  // snapshot never changes mid-run) and instead deletes the underlying
  // `memory_edges` row between stage and commit, the way the main agent's
  // own `reconcileCitedPairs` would when a body stops citing something.
  test("a pair the frozen snapshot still names, but that the CURRENT database no longer has, is refused at commit — frozen alone must not resurrect it (ticket 10d finding 1, spec C6/C7)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    // T2's body cites T1 at snapshot time — a real, pre-existing bare pair.
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
      { eligibleForRelation: "unrestricted" },
    );
    const snapshot = new Set([pairKey({ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 } })]);
    // The SAME context/snapshot throughout — nothing about the frozen set
    // ever changes; only the database does.
    const context = baseContext(job, { eligibleRelationPairKeys: snapshot });
    const input: SettlementTurnWriteInput = {
      turn: `S${sessionDbId}/T2`,
      dependsOn: [`S${sessionDbId}/T1`],
    };

    const staged = evaluateSettlementTurnWrite(db, context, input, NOW, { apply: false });
    expect(staged.ok).toBe(true);

    // The main agent rewrites T2's body; `reconcileCitedPairs` deletes the
    // pair because the new body no longer cites T1. The frozen snapshot
    // above is untouched — it still names this pair as eligible.
    reconcileCitedPairs(db, { kind: "turn", id: t2 }, [], NOW + 5, "text-ref");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

    const atCommit = evaluateSettlementTurnWrite(db, context, input, NOW + 10, { apply: true });
    expect(atCommit.ok).toBe(false);
    expect(!atCommit.ok && atCommit.message).toContain("no longer exists");
    // The load-bearing assertion: nothing got resurrected.
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

    const result = write(
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

    const result = write(
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

    const result = write(
      baseContext(job, { reconstructableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, title: "a title", content: "some content", insight: null },
      NOW,
    );

    expect(resultText(result)).not.toContain("Parameter error");
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

    const result = write(baseContext(job), { turn: `S${sessionDbId}/T1` }, NOW);

    expect(resultText(result)).toContain("Parameter error");
  });

  test("refuses an address naming no turn", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(baseContext(job), { turn: `S${sessionDbId}/T999`, grade: 1 }, NOW);

    expect(resultText(result)).toContain("Parameter error");
  });
});
