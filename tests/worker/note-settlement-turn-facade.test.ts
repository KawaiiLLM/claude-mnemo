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
import { getSession, upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import {
  claimWriterId,
  recordReadGrant,
  sessionWriterId,
  snapshotWriteGateSequence,
  stampField,
} from "../../src/db/write-gate";
import {
  evaluateSettlementTurnWrite,
  renderSettlementTurnWriteReceipt,
  settlementTurnWriteInputShape,
  settlementTurnWriteInputSchema,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteEvaluation,
  type SettlementTurnWriteInput,
} from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The settlement turn-write facade's DECISION function,
 * `evaluateSettlementTurnWrite` (spec G6/G7, D5/D5a, C7/C14; staged by spec
 * A7). Split into a pure decision function called twice — once with
 * `apply: false` (a dry run, exercised by the "stage vs apply" describe
 * block below) and once with `apply: true` (everywhere else in this file).
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): duty
 * 2 (turn prose reconstruction) retired outright. The old
 * `reconstructableTurnIds`/`rideTurnId`/`writerModel` context fields and the
 * whole "prose is writable only for reconstructable holes" describe block
 * are gone; a call naming title/content/insight is now refused outright
 * (see the "title/content/insight are refused outright" describe block).
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
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    eligibleRelationPairKeys: new Set(),
    attachedSegmentIds: new Set(),
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
  // Ticket 09 (edge-ownership-impl): `session` JOINS this surface now —
  // settlement's own session-narrative write, exclusive with `turn`. See
  // the "session-addressed narrative writes" describe block further down
  // for its own behaviour.
  test("declares no skip, crossSession, mode, or job-identity field", () => {
    const keys = Object.keys(settlementTurnWriteInputShape);
    for (const forbidden of [
      "skip",
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
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["topic:lease"] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("retired topic:");
    expect(getTurnById(db, t1)!.tags).toEqual([]);
    expect(getTurnById(db, t1)!.type).toEqual([]);
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
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["widgets"] },
      NOW,
      { apply: false },
    );

    expect(evaluation.ok).toBe(true);
    expect(evaluation.ok && evaluation.outcome.review).toEqual({
      type: { value: ["design"], landed: true },
      tags: { value: ["widgets"], landed: true },
    });
    // The load-bearing assertion: nothing landed.
    const turn = getTurnById(db, t1)!;
    expect(turn.type).toEqual([]);
    expect(turn.tags).toEqual([]);
  });

  test("a relation dry run reports what would be attached without writing an edge", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    // Ticket 08: `dependsOn` is phase-gated (delivery -> delivery) — both
    // ends need a delivery-phase type for the relation to clear the new
    // legality check before this test's own eligibility assertion runs.
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
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
      { turn: `S${sessionDbId}/T1`, type: ["design"] },
      NOW,
      { apply: false },
    );

    expect(evaluation.ok).toBe(false);
    expect(!evaluation.ok && evaluation.message).toContain("reviewable window");
  });
});

// ---------------------------------------------------------------------------
// Ticket 05 (ownership-and-note-cadence spec, "settlement demolition"): duty
// 2 (turn prose reconstruction) is gone. title/content/insight are refused
// LOUDLY — never silently ignored — and nothing lands.
// ---------------------------------------------------------------------------

describe("title/content/insight are refused outright (duty 2 retired, ticket 05)", () => {
  test("refuses a call naming all three prose fields, and nothing lands", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job),
      {
        turn: `S${sessionDbId}/T1`,
        title: "should be refused",
        content: "prose reconstruction is retired",
        insight: null,
      },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("no longer settlement's to write");
    expect(getShadowNote(db, t1)).toBeNull();
  });

  test("refuses a call naming just one prose field, even alongside a legal review field", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, title: "a lone title", type: ["design"] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(getTurnById(db, t1)!.type).toEqual([]);
  });

  test("an existing agent note is left untouched by a refused prose call", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own title",
      content: "agent's own content",
      nowEpoch: NOW,
    });

    const result = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T1`, title: "settlement trying to overwrite", content: "x", insight: null },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    const note = getShadowNote(db, t1)!;
    expect(note.title).toBe("agent's own title");
  });
});

// ---------------------------------------------------------------------------
// Requirement 5: type/tags only for reviewable turns, yield when stale
// ---------------------------------------------------------------------------

describe("type/tags are writable only for the window's reviewable turns (requirement 5)", () => {
  test("refuses a review write for a turn outside reviewableTurnIds", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set() }),
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["x"] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("reviewable window");
    expect(getTurnById(db, t1)!.type).toEqual([]);
  });

  test("writes type/tags whole for a reviewable turn", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["widgets"] },
      NOW,
    );

    expect(resultText(result)).not.toContain("Parameter error");
    const turn = getTurnById(db, t1)!;
    expect(turn.type).toEqual(["design"]);
    expect(turn.tags).toEqual(["widgets"]);
  });

  // Ticket 05 (read-write-contract spec): yield retired as a special check —
  // the write gate's own per-field staleness IS the new yield semantics.
  // `note.ts`'s real subsumption rule re-stamps `type` and `tags` together
  // whenever the main agent writes ANY note on a turn — reproduced directly
  // here via `stampField`/`recordReadGrant` (db/write-gate.ts) rather than
  // through `note.ts` itself, since this file tests the facade in isolation.
  test("yields type/tags when an agent note's subsumption stamp lands after this claim's own read grant", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const claimWriter = claimWriterId(job.id, job.claimGeneration);

    // Context build recorded this claim's read grant (ticket 05's own seam,
    // worker/note-settlement-context.ts) at contextBuiltAtEpoch (NOW).
    recordReadGrant(db, claimWriter, "turn", t1, NOW, snapshotWriteGateSequence(db));

    // The main agent's note lands AFTER that grant — its subsumption stamp
    // (note.ts) touches type/tags together.
    const agentWriter = sessionWriterId(sessionDbId);
    stampField(db, "turn", t1, "type", agentWriter, NOW + 5);
    stampField(db, "turn", t1, "tags", agentWriter, NOW + 5);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]), contextBuiltAtEpoch: NOW }),
      { turn: `S${sessionDbId}/T1`, type: ["fix"], tags: ["settlement"] },
      NOW + 6,
    );

    // The gate's own "stale" message, naming the other writer and pointing
    // at re-reading — this IS the new yield semantics, not a bespoke phrase.
    expect(resultText(result)).toContain("Yielded for");
    expect(resultText(result)).toContain(`recall(id="S${sessionDbId}/T1")`);
    const turn = getTurnById(db, t1)!;
    // Ticket 02 (view-render-repair spec, "grading retires whole"): every
    // reviewable field is note-derived now — type and tags both yield
    // together here, with no field left that would land regardless.
    expect(turn.type).toEqual([]);
    expect(turn.tags).toEqual([]);
  });

  test("does not yield when this claim's read grant is recorded AFTER the note's subsumption stamp", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const claimWriter = claimWriterId(job.id, job.claimGeneration);

    // The agent's note lands FIRST — this IS what the settlement prompt
    // showed, since the window rendering happens after it.
    const agentWriter = sessionWriterId(sessionDbId);
    stampField(db, "turn", t1, "type", agentWriter, NOW - 60);
    stampField(db, "turn", t1, "tags", agentWriter, NOW - 60);
    // Context build's read grant postdates it (rule 1: granted after the
    // last write admits).
    recordReadGrant(db, claimWriter, "turn", t1, NOW, snapshotWriteGateSequence(db));

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]), contextBuiltAtEpoch: NOW }),
      { turn: `S${sessionDbId}/T1`, type: ["fix"], tags: ["settlement"] },
      NOW + 1,
    );

    expect(resultText(result)).not.toContain("Yielded for");
    const turn = getTurnById(db, t1)!;
    expect(turn.type).toEqual(["fix"]);
    expect(turn.tags).toEqual(["settlement"]);
  });

  test("a lapsed claimant's write goes stale once the new claimant (a different claim generation) has written the same field — claim fencing via the gate, no separate CAS", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const staleJob = claimWindow(sessionDbId, 1, 1);
    const staleWriter = claimWriterId(staleJob.id, staleJob.claimGeneration);
    // A displaced claimant still holds a grant from ITS OWN context build.
    recordReadGrant(db, staleWriter, "turn", t1, NOW, snapshotWriteGateSequence(db));

    // The NEW claimant (same job id, later generation — a real reclaim bumps
    // claim_generation; simulated directly here) writes the SAME field first.
    const freshWriter = claimWriterId(staleJob.id, staleJob.claimGeneration + 1);
    recordReadGrant(db, freshWriter, "turn", t1, NOW + 1, snapshotWriteGateSequence(db));
    write(
      baseContext(
        { ...staleJob, claimGeneration: staleJob.claimGeneration + 1 },
        { reviewableTurnIds: new Set([t1]), contextBuiltAtEpoch: NOW + 1 },
      ),
      { turn: `S${sessionDbId}/T1`, type: ["design"] },
      NOW + 2,
    );

    // The STALE claimant's own attempt on the SAME field now yields — its
    // grant predates the fresh claimant's write, no separate per-write CAS
    // needed (pinned decision).
    const staleResult = write(
      baseContext(staleJob, { reviewableTurnIds: new Set([t1]), contextBuiltAtEpoch: NOW }),
      { turn: `S${sessionDbId}/T1`, type: ["fix"] },
      NOW + 3,
    );
    expect(resultText(staleResult)).toContain("Yielded for");
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
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
    // Ticket 08: dependsOn needs delivery-phase on both ends.
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
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
    // Ticket 08: `override` needs decision-phase on both ends (also proves
    // `supersedes` — the field this test used to name — is gone from this
    // surface: it retired to a read-only legacy value, ticket 08).
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["correction"] });
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
      { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T1`] },
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
    // Ticket 08: evidenceFor needs an evidence-phase citing turn and a
    // decision-phase cited turn.
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["research"] });
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
    // Ticket 08: dependsOn needs delivery-phase on both ends.
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
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
    // Ticket 08: dependsOn needs delivery-phase on both ends.
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
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

    const result = write(baseContext(job), { turn: `S${sessionDbId}/T999`, type: ["design"] }, NOW);

    expect(resultText(result)).toContain("Parameter error");
  });
});

// ---------------------------------------------------------------------------
// Ticket 06 (ownership-and-note-cadence spec, "选举机器拆除"): the election
// tier (ADR-0003) is retired outright — `tier` is no longer a field this
// facade accepts, and there is no more era-gating. The describe block that
// used to live here (era-gated tier election, grade/tier mutual exclusivity)
// tested a mechanism that no longer exists — `grade` itself is ALSO gone
// now (ticket 02, view-render-repair spec, "grading retires whole"), so
// there is no longer an "ordinary grade writing" case left to point at
// either; ordinary type/tags writing is covered by "writes type/tags whole
// for a reviewable turn" above.
// ---------------------------------------------------------------------------

describe("tier is not a field this facade accepts any more (ticket 06)", () => {
  test("a call naming tier is refused as an unknown field by the strict schema", () => {
    expect(
      settlementTurnWriteInputSchema.safeParse({
        turn: "S1/T1",
        tier: "A",
      }).success,
    ).toBe(false);
  });

  test("settlementTurnWriteInputShape declares no tier field", () => {
    expect(Object.keys(settlementTurnWriteInputShape)).not.toContain("tier");
  });
});

// ---------------------------------------------------------------------------
// Ticket 09 (edge-ownership-impl, "结算顺手维护 session 叙事"): the
// session-addressed branch — settlement's own session narrative write,
// exclusive with `turn`, through the SAME evaluate/stage/commit shape as
// every turn write above.
// ---------------------------------------------------------------------------

describe("session-addressed narrative writes (ticket 09)", () => {
  test("writes title and content whole, and reports which fields landed", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job),
      { session: `S${sessionDbId}`, title: "a session title", content: "what happened this window" },
      NOW,
    );

    expect(result.ok).toBe(true);
    const session = getSession(db, sessionDbId)!;
    expect(session.title).toBe("a session title");
    expect(session.content).toBe("what happened this window");
    expect(resultText(result)).toContain("session narrative");
    expect(resultText(result)).toContain("title");
    expect(resultText(result)).toContain("content");
  });

  test("content alone lands without touching an existing title (whole-overwrite, no append)", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    write(baseContext(job), { session: `S${sessionDbId}`, title: "first title" }, NOW);

    const result = write(baseContext(job), { session: `S${sessionDbId}`, content: "increment one" }, NOW + 1);

    expect(result.ok).toBe(true);
    const session = getSession(db, sessionDbId)!;
    expect(session.title).toBe("first title");
    expect(session.content).toBe("increment one");

    // A second content-only call REPLACES rather than appending — the model
    // is expected to compose the incremented text itself.
    write(baseContext(job), { session: `S${sessionDbId}`, content: "increment two" }, NOW + 2);
    expect(getSession(db, sessionDbId)?.content).toBe("increment two");
  });

  test("rejects a call naming neither title nor content", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(baseContext(job), { session: `S${sessionDbId}` }, NOW);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("at least one of title, content");
  });

  test("rejects type/tags/relations on a session address, naming them turn fields", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    for (const extra of [
      { type: ["design"] },
      { tags: ["auth"] },
      { evidenceFor: ["S1/T1"] },
      { dependsOn: ["S1/T1"] },
    ]) {
      const result = write(
        baseContext(job),
        { session: `S${sessionDbId}`, title: "x", ...extra },
        NOW,
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain("is a turn field");
    }
  });

  test("rejects a session address outside this dispatch's own session", () => {
    const sessionDbId = seedSession();
    const otherSessionDbId = upsertSession(db, {
      contentSessionId: "settlement-turn-facade-other-session",
      project: "/tmp/project-settlement-turn-facade",
      title: "a different session",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 5_000,
      updatedAtEpoch: NOW - 5_000,
      completedAtEpoch: null,
    }).id;
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job),
      { session: `S${otherSessionDbId}`, title: "not mine to write" },
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("not this dispatch's own session");
    expect(getSession(db, otherSessionDbId)?.title).toBe("a different session");
  });

  test("rejects a malformed session address", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(baseContext(job), { session: "not-an-address", title: "x" }, NOW);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('"S<session>" address');
  });

  test("turn and session together are refused, not silently resolved to one", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, session: `S${sessionDbId}`, title: "x", type: ["design"] },
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("not both");
  });

  test("neither turn nor session is refused", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(baseContext(job), {} as unknown as SettlementTurnWriteInput, NOW);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("exactly one of turn or session");
  });

  test("apply:false stages the receipt without writing — the mirror of the turn-write dry-run behaviour", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const dryRun = evaluateSettlementTurnWrite(
      db,
      baseContext(job),
      { session: `S${sessionDbId}`, title: "would-be title" },
      NOW,
      { apply: false },
    );

    expect(dryRun.ok).toBe(true);
    expect(getSession(db, sessionDbId)?.title).toBe("settlement turn facade fixture");
  });
});

// ---------------------------------------------------------------------------
// The stitch (read-write-contract, ticket 07's deferred half): the session
// narrative is a MANAGED surface — granted by the context render, gated and
// stamped under the claim identity.
// ---------------------------------------------------------------------------

describe("stitch — the session narrative write is gated under the claim identity", () => {
  test("granted by the render it lands and stamps; a successor's stamp turns the next write stale", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const writerA = claimWriterId(job.id, job.claimGeneration);
    recordReadGrant(db, writerA, "session", sessionDbId, NOW, snapshotWriteGateSequence(db));

    const landed = write(
      baseContext(job),
      { session: `S${sessionDbId}`, content: "window one increment" },
      NOW + 1,
    );
    expect(resultText(landed)).not.toContain("Parameter error");
    expect(getSession(db, sessionDbId)?.content).toBe("window one increment");
    const stamp = db
      .query<{ writer: string }, [number]>(
        "SELECT writer FROM write_gate_stamps WHERE entity_type = 'session' AND entity_id = ? AND field = 'content'",
      )
      .get(sessionDbId);
    expect(stamp?.writer).toBe(writerA);

    // A successor claim re-narrates; the lapsed claimant's next write is
    // refused as stale instead of whole-overwriting the newer narrative.
    stampField(
      db,
      "session",
      sessionDbId,
      "content",
      claimWriterId(job.id, job.claimGeneration + 1),
      NOW + 2,
    );
    const stale = write(
      baseContext(job),
      { session: `S${sessionDbId}`, content: "late overwrite from the lapsed claimant" },
      NOW + 3,
    );
    expect(resultText(stale)).toContain("was changed by");
    expect(resultText(stale)).toContain("recall(id=");
    expect(getSession(db, sessionDbId)?.content).toBe("window one increment");
  });
});
