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
 * `evaluateSettlementTurnWrite` (spec G6/G7, D5/D5a, C7/C14). Ticket 11 of
 * edge-mechanism-revision deleted the staging engine and with it the
 * `apply: false`/`true` split — the function evaluates and writes in one
 * pass now, inside the caller's own transaction, so every test here
 * exercises the one real path.
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
    // Flow-relations spec: consume needs the SAME phase on both ends.
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);

    // No bare pair is seeded: under the retired fence this call was the
    // canonical refusal ("names a pair not eligible for a relation"), and it
    // is exactly the call a from-zero rebuild has to be able to make.
    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t2]) }),
      { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("1 relation");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe("consume");
    // Settlement's attribution survives the move onto the main agent's own
    // primitive — `judged`, not `asserted`.
    expect(edges[0]!.provenance).toBe("judged");
  });

  test("one pair carries two relations at once — the duplicate-target mirror is gone (D2)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    // T1 decision-phase, T2 delivery+decision: legal for `grounds` (no
    // restriction) and for `extends` (decision -> decision).
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["implement", "correction"] });
    const job = claimWindow(sessionDbId, 1, 2);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t2]) }),
      {
        turn: `S${sessionDbId}/T2`,
        grounds: [`S${sessionDbId}/T1`],
        extends: [`S${sessionDbId}/T1`],
      },
      NOW,
    );

    expect(resultText(result)).toContain("2 relation");
    const relations = getOutgoingEdges(db, { kind: "turn", id: t2 })
      .map((edge) => edge.relation)
      .sort();
    expect(relations).toEqual(["extends", "grounds"]);
  });

  // Indexes-rescope spec (ticket 01, [S15069/T1232]): `indexes` (the renamed,
  // widened `collects`) carries NO graph-state check any more — the old
  // "collects through the facade" pins (peer final-audit finding 2, S15069/
  // T1217) covered the facade sharing note.ts's collects gate, dead-branch
  // case included; these now confirm the identical dead-branch shape SUCCEEDS
  // through the facade, since the gate itself retired.
  test("indexes through the facade: a live settlement indexes its member", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t3 = seedTurn(sessionDbId, 3);
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t3, { type: ["correction"] });
    const job = claimWindow(sessionDbId, 1, 3);
    const context = baseContext(job, { reviewableTurnIds: new Set([t3]) });

    write(context, { turn: `S${sessionDbId}/T3`, extends: [`S${sessionDbId}/T1`] }, NOW);
    const result = write(
      context,
      { turn: `S${sessionDbId}/T3`, indexes: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );

    expect(resultText(result)).toContain("1 relation");
    expect(
      getOutgoingEdges(db, { kind: "turn", id: t3 }).some(
        (edge) => edge.relation === "indexes",
      ),
    ).toBe(true);
  });

  test("indexes through the facade: an overridden settlement (dead branch) can still index — the graph-state gate retired", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t3 = seedTurn(sessionDbId, 3);
    const t4 = seedTurn(sessionDbId, 4);
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t3, { type: ["correction"] });
    updateTurnById(db, t4, { type: ["design"] });
    const job = claimWindow(sessionDbId, 1, 4);

    write(
      baseContext(job, { reviewableTurnIds: new Set([t3]) }),
      { turn: `S${sessionDbId}/T3`, extends: [`S${sessionDbId}/T1`] },
      NOW,
    );
    write(
      baseContext(job, { reviewableTurnIds: new Set([t4]) }),
      { turn: `S${sessionDbId}/T4`, override: [`S${sessionDbId}/T3`] },
      NOW + 1,
    );
    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t3]) }),
      { turn: `S${sessionDbId}/T3`, indexes: [`S${sessionDbId}/T1`] },
      NOW + 2,
    );

    expect(resultText(result)).toContain("1 relation");
    expect(
      getOutgoingEdges(db, { kind: "turn", id: t3 }).some(
        (edge) => edge.relation === "indexes",
      ),
    ).toBe(true);
  });

  test("re-asserting a stored relation is a no-op the receipt names, not new work", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);
    const input = { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] };
    const context = baseContext(job, { reviewableTurnIds: new Set([t2]) });

    write(context, input, NOW);
    const again = write(context, input, NOW + 1);

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
    const context = baseContext(job, { reviewableTurnIds: new Set([t2]) });
    write(
      context,
      { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] },
      NOW,
    );

    const retracted = write(
      context,
      { turn: `S${sessionDbId}/T2`, retractConsume: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );
    expect(resultText(retracted)).toContain("Retracted 1 relation(s)");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

    // `no-such-edge`, named per address — "already gone" and "wrong address"
    // stay distinguishable, and nothing is deleted.
    const missing = write(
      context,
      { turn: `S${sessionDbId}/T2`, retractConsume: [`S${sessionDbId}/T1`] },
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
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const unresolved = write(
      context,
      { turn: `S${sessionDbId}/T1`, consume: [`S${sessionDbId}/T999`] },
      NOW,
    );
    expect(resultText(unresolved)).toContain("does not resolve");

    const selfLoop = write(
      context,
      { turn: `S${sessionDbId}/T1`, consume: [`S${sessionDbId}/T1`] },
      NOW,
    );
    expect(resultText(selfLoop)).toContain("may ever cite the citing turn itself");
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toEqual([]);
  });

  // rubric-v10 ticket 02 ("自引用", Gate C); round-4 review #1 hardened it:
  // the settlement write path shares the SAME `validateRelationTarget`/
  // `checkSelfGroundsTerminusPostWrite` gates as the main agent's `note` —
  // only `grounds` may ever self-cite, legal iff the citing turn ALSO carries
  // a delivery-phase type (the implementer half, checked pre-write) AND,
  // after this call's edges land, is the CURRENT terminus of a lane it
  // declared via a TAGGED `indexes` edge of its own. `t1` is a COMPOSITE
  // node here (`design` + `implement`), both halves at once. A tagged-
  // indexes declaration plus the self-grounds in ONE call passes.
  test("a self-grounds is accepted through the settlement path when the same call also declares a tagged-indexes terminus", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design", "implement"], tags: ["lane-a"] });
    updateTurnById(db, t2, { type: ["design"], tags: ["lane-a"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });

    const result = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        indexes: [{ turn: `S${sessionDbId}/T2`, tags: ["lane-a"] }],
        grounds: [`S${sessionDbId}/T1`],
      },
      NOW,
    );

    expect(resultText(result)).toContain("2 relation");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t1 });
    expect(edges.some((edge) => edge.relation === "grounds" && edge.cited.id === t1)).toBe(true);
    expect(
      edges.some((edge) => edge.relation === "indexes" && edge.tags.includes("lane-a")),
    ).toBe(true);
  });

  // Mutation-critical: without the terminus-declaring edge, the identical
  // self-grounds call rejects — the settlement facade's own Gate C, not
  // borrowed pass-through behavior from `mcp/note.ts`. This test calls the
  // EVALUATOR directly (this file's own `write()` helper, matching every
  // other test here), so it checks the verdict only — whether that verdict
  // actually rolls the mutation back is `note-settlement-direct-write.ts`'s
  // own transaction wrapper's contract (see its doc comment: "a compound
  // call whose LATER half rejects after an EARLIER half already applied —
  // commits or vanishes as a UNIT" — a property of the wrapper, not of this
  // function called bare), exercised by that module's own test suite. `t1`
  // carries `implement` too, isolating Gate C from the pre-write delivery gate.
  test("the same self-grounds without any terminus-declaring edge still rejects through the settlement path", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    updateTurnById(db, t1, { type: ["design", "implement"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, grounds: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("TAGGED");
  });

  // round-4 review #1's own acceptance criterion, exercised through the
  // settlement path too: "decision-only self-grounds REJECTS" — refused
  // pre-write (`self-not-delivery`), even with a legal tagged-indexes
  // declaration in the same call.
  test("a decision-only turn's self-grounds rejects through the settlement path even with a legal declaration in the same call", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design"], tags: ["lane-a"] });
    updateTurnById(db, t2, { type: ["design"], tags: ["lane-a"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });

    const result = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        indexes: [{ turn: `S${sessionDbId}/T2`, tags: ["lane-a"] }],
        grounds: [`S${sessionDbId}/T1`],
      },
      NOW,
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("delivery");
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toEqual([]);
  });

  // round-4 review #1's own acceptance criterion, exercised through the
  // settlement path too: "stale-declaration self-grounds REJECTS" — a LATER
  // turn's tag-matched override reopens the lane a self-grounds turn
  // declared in an earlier call; a fresh self-grounds attempt after that
  // must not read the stale declaration as still legal.
  test("a stale terminus declaration — reopened by a LATER turn's tag-matched override — rejects a fresh self-grounds through the settlement path", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design", "implement"], tags: ["lane-a"] });
    updateTurnById(db, t2, { type: ["design"], tags: ["lane-a"] });
    const job = claimWindow(sessionDbId, 1, 4);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });

    const declare = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        indexes: [{ turn: `S${sessionDbId}/T2`, tags: ["lane-a"] }],
        grounds: [`S${sessionDbId}/T1`],
      },
      NOW,
    );
    expect(resultText(declare)).toContain("2 relation");

    const t4 = seedTurn(sessionDbId, 4);
    updateTurnById(db, t4, { type: ["design"], tags: ["lane-a"] });
    const laterContext = baseContext(job, { reviewableTurnIds: new Set([t4]) });
    const reopen = write(
      laterContext,
      { turn: `S${sessionDbId}/T4`, override: [{ turn: `S${sessionDbId}/T1`, tags: ["lane-a"] }] },
      NOW + 1,
    );
    expect(resultText(reopen)).toContain("1 relation");

    const staleAttempt = write(
      context,
      { turn: `S${sessionDbId}/T1`, grounds: [`S${sessionDbId}/T1`] },
      NOW + 2,
    );

    expect(resultText(staleAttempt)).toStartWith("Parameter error:");
    expect(resultText(staleAttempt)).toContain("TAGGED");
    expect(
      getOutgoingEdges(db, { kind: "turn", id: t1 }).filter(
        (edge) => edge.relation === "grounds" && edge.cited.id === t1,
      ),
    ).toHaveLength(1);
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
    const context = baseContext(job, { reviewableTurnIds: new Set([t2]) });

    const refused = write(
      context,
      { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] },
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
      context,
      { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] },
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
    // `verifies` needs an evidence-phase citing turn; T2 has none.
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t2]) }),
      { turn: `S${sessionDbId}/T2`, verifies: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("Parameter error");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rubric-v10 ticket 02 (spec "Checks, layered"): the flow-relations era's
// `grounds` mid-flow warning retires ENTIRELY from the write path — no flow
// derivation runs here any more, exercised through settlement's own write
// path so the two writers cannot silently disagree about the retirement
// either.
// ---------------------------------------------------------------------------

describe("grounds mid-flow warning retirement (rubric-v10 ticket 02)", () => {
  test("a grounds toward an earlier member of an extends chain lands with no warning at all", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const t3 = seedTurn(sessionDbId, 3);
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["design"] });
    updateTurnById(db, t3, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 3);
    const context = baseContext(job, { reviewableTurnIds: new Set([t2, t3]) });

    write(context, { turn: `S${sessionDbId}/T2`, extends: [`S${sessionDbId}/T1`] }, NOW);

    const result = write(
      context,
      { turn: `S${sessionDbId}/T3`, grounds: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );

    expect(resultText(result)).toContain("1 relation");
    expect(resultText(result)).not.toContain("warning:");
    expect(resultText(result)).not.toContain("mid-flow");
    expect(resultText(result)).not.toContain("settles at");
  });

  test("a grounds toward a target overridden by a later turn lands with no warning either", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const overrider = seedTurn(sessionDbId, 2);
    const citer = seedTurn(sessionDbId, 3);
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, overrider, { type: ["design"] });
    updateTurnById(db, citer, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 3);
    const context = baseContext(job, { reviewableTurnIds: new Set([overrider, citer]) });

    write(context, { turn: `S${sessionDbId}/T2`, override: [`S${sessionDbId}/T1`] }, NOW);

    const result = write(
      context,
      { turn: `S${sessionDbId}/T3`, grounds: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );

    expect(resultText(result)).toContain("1 relation");
    expect(resultText(result)).not.toContain("warning:");
  });
});

// ---------------------------------------------------------------------------
// Ticket 07 (edge-mechanism-revision; peer final-review must-fix 1,
// [S15069/T1138]): the reviewable-window check is UNCONDITIONAL for every
// turn-addressed call. It used to run only when the call also named type/tags
// or prose, which left a pure-relation or pure-retraction call to be caught (if
// at all) by the edge write gate — and the gate's third judgment admits a field
// nobody has ever written, so a turn with no type chapter took edges from
// outside the window. That is the peer's own reproduction, below.
// ---------------------------------------------------------------------------

describe("the reviewable-window check is unconditional (ticket 07, spec D6 渲染即授权)", () => {
  /** The peer's repro shape: two turns, delivery phase on both, nothing stamped. */
  function seedHiddenCitingTurn(): {
    sessionDbId: number;
    t1: number;
    t2: number;
    job: NoteSettlementJob;
  } {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["implement"] });
    updateTurnById(db, t2, { type: ["implement"] });
    return { sessionDbId, t1, t2, job: claimWindow(sessionDbId, 1, 2) };
  }

  test("PEER REPRO: a relation-only call on an unrendered turn with no type chapter is refused — the gate alone let it through", () => {
    const { sessionDbId, t2, job } = seedHiddenCitingTurn();
    // T2 is deliberately absent from reviewableTurnIds and carries NO write-gate
    // stamp on `type`, so the edge gate's own three judgments all admit.
    const input = { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] };

    const refused = write(baseContext(job), input, NOW);

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain("reviewable window");
    // Distinguishable from a write-gate refusal: the gate speaks of reading,
    // this speaks of range. A reader who cannot tell them apart re-reads the
    // turn and retries forever.
    expect(!refused.ok && refused.message).not.toContain("has not been read this session");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

    // The load-bearing half: range is the ONLY thing refusing it. The same call,
    // same database, from a context that rendered T2, lands.
    const landed = write(
      baseContext(job, { reviewableTurnIds: new Set([t2]) }),
      input,
      NOW + 1,
    );
    expect(resultText(landed)).toContain("1 relation");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toHaveLength(1);
  });

  test("a retraction-only call on an unrendered turn is refused too, and the edge survives", () => {
    const { sessionDbId, t2, job } = seedHiddenCitingTurn();
    write(
      baseContext(job, { reviewableTurnIds: new Set([t2]) }),
      { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] },
      NOW,
    );

    const refused = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, retractConsume: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain("reviewable window");
    expect(!refused.ok && refused.message).not.toContain("is not a relation this turn currently carries");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toHaveLength(1);
  });

  test("the dry run refuses it as well — range is decided before anything a real write could do differently", () => {
    const { sessionDbId, t2, job } = seedHiddenCitingTurn();

    const evaluation = evaluateSettlementTurnWrite(
      db,
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(evaluation.ok).toBe(false);
    expect(!evaluation.ok && evaluation.message).toContain("reviewable window");
  });

  test("range is checked on the CITING turn only — an in-window turn may still cite one the window never showed ([S15069/T1124])", () => {
    const { sessionDbId, t1, t2, job } = seedHiddenCitingTurn();

    // T1 (the CITED side) is NOT in reviewableTurnIds and gets no check of any
    // kind: that is what lets a window connect to what came before it.
    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t2]) }),
      { turn: `S${sessionDbId}/T2`, consume: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("1 relation");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.cited).toEqual({ kind: "turn", id: t1 });
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
      { verifies: ["S1/T1"] },
      { consume: ["S1/T1"] },
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
