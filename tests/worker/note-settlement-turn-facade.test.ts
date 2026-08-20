import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges } from "../../src/db/memory-edges";
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
  recordFieldCompleteness,
  recordReadGrant,
  sessionWriterId,
  snapshotWriteGateSequence,
  stampField,
} from "../../src/db/write-gate";
import { noteInputShape } from "../../src/mcp/definitions";
import { modeRequiredMessage } from "../../src/mcp/field-mode";
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
  test("declares no skip, crossSession, or job-identity field — but DOES carry the main agent's own mode (ticket 07, spec D12)", () => {
    const keys = Object.keys(settlementTurnWriteInputShape);
    for (const forbidden of [
      "skip",
      "crossSession",
      "jobId",
      "claimGeneration",
      "job",
      "claim_generation",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // Ticket 07 (spec D12) reverses this shape's earlier "no mode" clause:
    // the vocabulary is shared now, and shared means the SAME object, not a
    // settlement-flavoured look-alike.
    expect(keys).toContain("mode");
    expect(settlementTurnWriteInputShape.mode).toBe(noteInputShape.mode);
  });
});

describe("tags are replaced whole, under the shared mode (requirement 3; ticket 07 spec D4/D12)", () => {
  test("a second call's tags list replaces the first's rather than unioning with it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    write(context, { turn: `S${sessionDbId}/T1`, tags: ["first", "second"] }, NOW);
    expect(getTurnById(db, t1)!.tags).toEqual(["first", "second"]);

    write(
      context,
      { turn: `S${sessionDbId}/T1`, tags: ["third"], mode: { tags: "write" } },
      NOW + 1,
    );
    // Whole replace: "first"/"second" are gone, not merged with "third" —
    // `write` on a set field IS the full replacement set (spec D4).
    expect(getTurnById(db, t1)!.tags).toEqual(["third"]);
  });

  test("replacing a non-empty set without declaring the mode is refused, in the main agent's own words", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    write(context, { turn: `S${sessionDbId}/T1`, tags: ["first"] }, NOW);
    const result = write(context, { turn: `S${sessionDbId}/T1`, tags: ["second"] }, NOW + 1);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe(modeRequiredMessage("tags"));
    // Refused, not partially applied.
    expect(getTurnById(db, t1)!.tags).toEqual(["first"]);
  });

  test("a retired mode literal names its replacement, and the edit form is refused on a set field", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const retired = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["design"], mode: { type: "overwrite" } },
      NOW,
    );
    expect(retired.ok).toBe(false);
    expect(!retired.ok && retired.message).toContain('"overwrite" has retired');
    expect(!retired.ok && retired.message).toContain('use "write" instead');

    const edited = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        type: ["design"],
        mode: { type: { mode: "edit", oldString: "a", newString: "b" } },
      },
      NOW,
    );
    expect(edited.ok).toBe(false);
    expect(!edited.ok && edited.message).toContain("has no meaning on a set field");
  });

  // Ticket 04 (D6) re-judged this: `mode.content` alone used to be refused as
  // a second door into a retired duty. Prose is settlement's again, so the
  // edit form reaches the field — and is answered by the field-mode engine's
  // own rejection when there is nothing there to edit, exactly as it answers
  // the main agent.
  test("an edit form on a prose field reaches the field, and fails on its own terms when the field is empty", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        type: ["design"],
        mode: { content: { mode: "edit", oldString: "a", newString: "b" } },
      },
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).not.toContain("no longer settlement's to write");
    expect(!result.ok && result.message).toContain("content");
    // Validated before anything applies: the review field on the same call
    // did not land either.
    expect(getTurnById(db, t1)!.type).toEqual([]);
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
    // ends need a delivery-phase type for the relation to clear the
    // legality check.
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);

    const evaluation = evaluateSettlementTurnWrite(
      db,
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW,
      { apply: false },
    );

    expect(evaluation.ok).toBe(true);
    expect(evaluation.ok && evaluation.outcome.relations).toEqual({
      written: 1,
      restated: 0,
      retracted: 0,
    });
    // The load-bearing assertion: nothing reached the edge table.
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);
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
// Ticket 04 (edge-mechanism-revision D6): duty 2 is REVOKED — turn prose is
// settlement's to write again, through the same mode vocabulary and the same
// three-judgment gate, complete-read requirement included ("同门同要求").
// Acceptance criterion 1: a write succeeds, and all three rejections
// (truncated / stale / never-read) are reproducible.
// ---------------------------------------------------------------------------

describe("turn prose is settlement's again, under the main agent's own gate (ticket 04, D6)", () => {
  /** What the context build's own render pass records for a turn it showed whole. */
  function grantWholeRead(
    job: NoteSettlementJob,
    turnId: number,
    fields: readonly string[],
    atEpoch = NOW,
    complete = true,
  ): void {
    const writer = claimWriterId(job.id, job.claimGeneration);
    const sequence = snapshotWriteGateSequence(db);
    recordReadGrant(db, writer, "turn", turnId, atEpoch, sequence);
    recordFieldCompleteness(
      db,
      writer,
      fields.map((field) => ({
        entityType: "turn" as const,
        entityId: turnId,
        field,
        complete,
      })),
      atEpoch,
      sequence,
    );
  }

  test("writes a first note for a reviewable turn — title and content land together", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        title: "settlement: the window's own note",
        content: "What this turn actually settled.",
        insight: "A lesson that outlives the turn.",
      },
      NOW,
    );

    expect(resultText(result)).not.toContain("Parameter error");
    expect(resultText(result)).toContain("Landed note for");
    expect(resultText(result)).toContain("budget:");
    const note = getShadowNote(db, t1)!;
    expect(note.title).toBe("settlement: the window's own note");
    expect(note.content).toBe("What this turn actually settled.");
    expect(note.insight).toBe("A lesson that outlives the turn.");
    // The audit fact: the text that now stands is settlement's.
    expect(note.writerOrigin).toBe("settlement");
  });

  test("a first note requires both title and content, the main agent's own rule", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, title: "a lone title", type: ["design"] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("requires both title and content");
    expect(getShadowNote(db, t1)).toBeNull();
    // Validated before anything applies: the legal review field on the same
    // call did not land either.
    expect(getTurnById(db, t1)!.type).toEqual([]);
  });

  test("rewrites another writer's note when the render showed the field whole", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own title",
      content: "agent's own content",
      nowEpoch: NOW - 100,
    });
    const agentWriter = sessionWriterId(sessionDbId);
    stampField(db, "turn", t1, "content", agentWriter, NOW - 100);
    grantWholeRead(job, t1, ["title", "content"]);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        content: "In hindsight this turn settled the window shape.",
        mode: { content: "write" },
      },
      NOW + 1,
    );

    expect(resultText(result)).not.toContain("Parameter error");
    expect(resultText(result)).toContain("replaced the previous note");
    const note = getShadowNote(db, t1)!;
    expect(note.content).toBe("In hindsight this turn settled the window shape.");
    // Untouched fields survive the partial rewrite.
    expect(note.title).toBe("agent's own title");
  });

  test("REJECTION 1 (truncated): a whole-field write over content the render cut short is refused, and the edit form is the way through", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own title",
      content: "first half. second half.",
      nowEpoch: NOW - 100,
    });
    stampField(db, "turn", t1, "content", sessionWriterId(sessionDbId), NOW - 100);
    // The render showed `content` TRUNCATED — a note over the per-turn token
    // budget is exactly this case in production.
    grantWholeRead(job, t1, ["content"], NOW, false);

    const refused = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        content: "a whole new content",
        mode: { content: "write" },
      },
      NOW + 1,
    );

    expect(resultText(refused)).toContain("Parameter error");
    expect(resultText(refused)).toContain("was not delivered in full");
    expect(resultText(refused)).toContain("filter={fields:[\"content\"]}");
    expect(getShadowNote(db, t1)!.content).toBe("first half. second half.");

    // The edit form touches only the span it matched, so it needs no complete
    // read — the remedy the rejection itself names.
    const edited = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        mode: {
          content: { mode: "edit", oldString: "second half.", newString: "corrected half." },
        },
      },
      NOW + 2,
    );
    expect(resultText(edited)).not.toContain("Parameter error");
    expect(getShadowNote(db, t1)!.content).toBe("first half. corrected half.");
  });

  test("REJECTION 2 (stale): a note that landed after this claim's grant refuses the rewrite", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own title",
      content: "agent's own content",
      nowEpoch: NOW - 100,
    });
    grantWholeRead(job, t1, ["title", "content"]);
    // The main agent rewrites the same field AFTER this dispatch's context
    // was built.
    stampField(db, "turn", t1, "content", sessionWriterId(sessionDbId), NOW + 5);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        content: "settlement's late overwrite",
        mode: { content: "write" },
      },
      NOW + 6,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("was changed by");
    expect(getShadowNote(db, t1)!.content).toBe("agent's own content");
  });

  test("REJECTION 3 (never-read): a turn this claim never read refuses the rewrite", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own title",
      content: "agent's own content",
      nowEpoch: NOW - 100,
    });
    stampField(db, "turn", t1, "content", sessionWriterId(sessionDbId), NOW - 100);
    // No grant recorded for this claim at all — the context build never
    // rendered this turn, yet the caller passed it as reviewable.

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      {
        turn: `S${sessionDbId}/T1`,
        content: "settlement writing blind",
        mode: { content: "write" },
      },
      NOW + 1,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("has not been read this session");
    expect(getShadowNote(db, t1)!.content).toBe("agent's own content");
  });

  test("prose for a turn outside the rendered window is refused — rendering is authorization", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set() }),
      { turn: `S${sessionDbId}/T1`, title: "t", content: "c" },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(resultText(result)).toContain("reviewable window");
    expect(getShadowNote(db, t1)).toBeNull();
  });

  test("a non-empty prose field with no mode is refused in the main agent's own words", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own title",
      content: "agent's own content",
      nowEpoch: NOW - 100,
    });
    grantWholeRead(job, t1, ["title", "content"]);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      { turn: `S${sessionDbId}/T1`, content: "silently clobbering" },
      NOW + 1,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe(modeRequiredMessage("content"));
    expect(getShadowNote(db, t1)!.content).toBe("agent's own content");
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
      { turn: `S${sessionDbId}/T1`, type: ["fix"], mode: { type: "write" } },
      NOW + 3,
    );
    expect(resultText(staleResult)).toContain("Yielded for");
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
  });
});

// ---------------------------------------------------------------------------
// Ticket 04 (edge-mechanism-revision D1/D3/D6): the relation half. Spec C7's
// pre-existence fence is DELETED — the frozen pre-run snapshot, its
// intersection with current state, and the one-relation-per-pair
// `duplicate-target` mirror all went with it. What is left is what a claim
// cannot be right about by construction: the address resolves, it is not this
// turn, its phase pair is legal, and the citing turn's own write gate admits.
// ---------------------------------------------------------------------------

describe("a relation stands on its own — no pre-existing pair, no eligibility snapshot (D1)", () => {
  test("attaches a relation between two turns that share no prior edge at all", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    // Ticket 08: dependsOn needs delivery-phase on both ends.
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);

    // No bare pair is seeded: under the retired fence this call was the
    // canonical refusal ("names a pair not eligible for a relation"), and it
    // is exactly the call a from-zero rebuild has to be able to make.
    const result = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("1 relation");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("depends-on");
    // Settlement's attribution survives the move onto the main agent's own
    // primitive — `judged`, not `asserted`.
    expect(edges[0]!.provenance).toBe("judged");
  });

  test("one pair carries two relations at once — the duplicate-target mirror is gone (D2)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    // T1 decision-phase, T2 delivery+decision: legal for `encodes` (delivery
    // -> decision) and for `refines` (decision -> decision).
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["implement", "correction"] });
    const job = claimWindow(sessionDbId, 1, 2);

    const result = write(
      baseContext(job),
      {
        turn: `S${sessionDbId}/T2`,
        encodes: [`S${sessionDbId}/T1`],
        refines: [`S${sessionDbId}/T1`],
      },
      NOW,
    );

    expect(resultText(result)).toContain("2 relation");
    const relations = getOutgoingEdges(db, { kind: "turn", id: t2 })
      .map((edge) => edge.relation)
      .sort();
    expect(relations).toEqual(["encodes", "refines"]);
  });

  test("re-asserting a stored relation is a no-op the receipt names, not new work", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);
    const input = { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] };

    write(baseContext(job), input, NOW);
    const again = write(baseContext(job), input, NOW + 1);

    expect(resultText(again)).toContain("already present, nothing added");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toHaveLength(1);
  });

  test("retracts an edge through the same primitive the main agent uses, and refuses one that is not there", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);
    write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW,
    );

    const retracted = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, retractDependsOn: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );
    expect(resultText(retracted)).toContain("Retracted 1 relation(s)");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

    // `no-such-edge`, named per address — "already gone" and "wrong address"
    // stay distinguishable, and nothing is deleted.
    const missing = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, retractDependsOn: [`S${sessionDbId}/T1`] },
      NOW + 2,
    );
    expect(resultText(missing)).toContain("Parameter error");
    expect(resultText(missing)).toContain("is not a relation this turn currently carries");
  });

  test("an unresolvable address and a self-reference are still refused, whole-call", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    updateTurnById(db, t1, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 1);

    const unresolved = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T1`, dependsOn: [`S${sessionDbId}/T999`] },
      NOW,
    );
    expect(resultText(unresolved)).toContain("does not resolve");

    const selfLoop = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T1`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW,
    );
    expect(resultText(selfLoop)).toContain("cannot cite itself");
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toEqual([]);
  });

  test("an edge write is gated on the CITING turn's `type` — checked, never stamped", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);
    // Another writer owns the citing turn's `type` and this claim never read
    // it — the gate field an edge write is judged by (mcp/note.ts's
    // EDGE_WRITE_GATE_FIELD, mirrored here).
    stampField(db, "turn", t2, "type", sessionWriterId(sessionDbId), NOW - 10);

    const refused = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW,
    );
    expect(resultText(refused)).toContain("has not been read this session");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

    // Granted, the same call lands — and the edge write leaves the `type`
    // stamp alone: it corrects no type, and stamping one would tell the next
    // pass a type correction landed when none did.
    recordReadGrant(
      db,
      claimWriterId(job.id, job.claimGeneration),
      "turn",
      t2,
      NOW,
      snapshotWriteGateSequence(db),
    );
    const landed = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, dependsOn: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );
    expect(resultText(landed)).toContain("1 relation");
    const stamp = db
      .query<{ writer: string }, [number]>(
        "SELECT writer FROM write_gate_stamps WHERE entity_type = 'turn' AND entity_id = ? AND field = 'type'",
      )
      .get(t2);
    expect(stamp?.writer).toBe(sessionWriterId(sessionDbId));
  });

  test("a phase-illegal relation is refused in the validator's own words, and nothing lands", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    // `evidenceFor` needs an evidence-phase citing turn; T2 has none.
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);

    const result = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, evidenceFor: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
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
      {
        session: `S${sessionDbId}`,
        title: "a session title",
        content: "what happened this window",
        // The fixture session already carries a title, so replacing it is a
        // declared `write` now (ticket 07, spec D12) — `content` is still
        // empty and needs none.
        mode: { title: "write" },
      },
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

  test("content alone lands without touching an existing title; a second call replaces or edits it", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    write(
      baseContext(job),
      { session: `S${sessionDbId}`, title: "first title", mode: { title: "write" } },
      NOW,
    );

    const result = write(baseContext(job), { session: `S${sessionDbId}`, content: "increment one" }, NOW + 1);

    expect(result.ok).toBe(true);
    const session = getSession(db, sessionDbId)!;
    expect(session.title).toBe("first title");
    expect(session.content).toBe("increment one");

    // `write` on a non-empty field REPLACES it — the caller composes the
    // whole finished text itself.
    write(
      baseContext(job),
      { session: `S${sessionDbId}`, content: "increment two", mode: { content: "write" } },
      NOW + 2,
    );
    expect(getSession(db, sessionDbId)?.content).toBe("increment two");

    // Ticket 07 (spec D3/D12): the same field's OTHER expression — the edit
    // form, anchored on the tail of the text the writer was shown. The value
    // itself is not supplied; the new text lives in `newString`.
    const edited = write(
      baseContext(job),
      {
        session: `S${sessionDbId}`,
        mode: {
          content: {
            mode: "edit",
            oldString: "increment two",
            newString: "increment two\nincrement three",
          },
        },
      },
      NOW + 3,
    );
    expect(edited.ok).toBe(true);
    expect(getSession(db, sessionDbId)?.content).toBe("increment two\nincrement three");
  });

  test("a non-empty session field with no mode is refused, in the main agent's own words", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job),
      { session: `S${sessionDbId}`, title: "silently clobbering the fixture title" },
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe(modeRequiredMessage("title"));
    expect(getSession(db, sessionDbId)?.title).toBe("settlement turn facade fixture");
  });

  test("an edit whose oldString does not match exactly once is refused, naming which", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);
    write(baseContext(job), { session: `S${sessionDbId}`, content: "row\nrow" }, NOW);

    const missing = write(
      baseContext(job),
      {
        session: `S${sessionDbId}`,
        mode: { content: { mode: "edit", oldString: "absent", newString: "x" } },
      },
      NOW + 1,
    );
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.message).toContain("not found in content");

    const ambiguous = write(
      baseContext(job),
      {
        session: `S${sessionDbId}`,
        mode: { content: { mode: "edit", oldString: "row", newString: "x" } },
      },
      NOW + 2,
    );
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.message).toContain("matches 2 times in content");
    expect(getSession(db, sessionDbId)?.content).toBe("row\nrow");
  });

  test("a mode naming a turn field on a session call is refused as a turn field", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(sessionDbId, 1, 1);

    const result = write(
      baseContext(job),
      { session: `S${sessionDbId}`, content: "x", mode: { type: "write" } },
      NOW,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe(
      "mode.type is a turn field; this call addresses a session.",
    );
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
      { session: `S${sessionDbId}`, title: "would-be title", mode: { title: "write" } },
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
