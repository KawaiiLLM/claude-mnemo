import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
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
import { loadPhaseRetypeAuditsForTurn } from "../../src/db/phase-retype-audit";
import { modeRequiredMessage } from "../../src/mcp/field-mode";
import {
  RELATION_FIELD_ENTRIES,
  RETRACTION_FIELD_ENTRIES,
} from "../../src/db/citations";
import { recallMemory } from "../../src/mcp/recall";
import { resetToolCallSyntaxRejectionsForTests } from "../../src/shared/tool-call-syntax";
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
import { correctEntry } from "../support/relation-entries";

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
let laneHomeSegmentId: number | null = null;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  laneHomeSegmentId = null;
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

/**
 * lane-declaration ticket 02 (spec D2): a tagged edge may name only a lane
 * DECLARED in the segment of BOTH endpoint turns, and a homeless turn has no
 * segment to declare in. Every fixture turn in this file therefore joins ONE
 * segment (`seedTurn` below), where the two lane tags these tests use are
 * already declared — the requirement is uniform across every relation word,
 * and a test about `indexes` should not have to restate the registry to say
 * anything about indexing. A test that wants the UNDECLARED case names a tag
 * this home does not carry.
 */
const FIXTURE_LANE_TAGS = [
  "lane-a",
  "lane-b",
  // Ticket 14: the remaining words these tests happen to write. `tags` draws
  // from a closed vocabulary now, so a fixture word has to be IN it — the
  // questions these tests ask (whole replacement, the shared mode, the
  // reviewable window, the write gate) are unchanged by which words they use.
  "first",
  "second",
  "third",
  "lease",
  "x",
  "widgets",
  "settlement",
  "auth",
] as const;

/**
 * Ticket 14 (lane-model-v12 spec D3e): membership is DERIVED from a turn's own
 * tags, so the home segment needs a NAME and every fixture turn has to carry
 * it — a tags write that dropped it would move the turn out of the home and
 * strand every lane tag beside it.
 */
const FIXTURE_SEGMENT_TAG = "lane-home";

function laneHomeSegment(): number {
  if (laneHomeSegmentId === null) {
    const segment = createSegment(db, {
      title: "lane home",
      tags: [FIXTURE_SEGMENT_TAG],
      nowEpoch: 100,
    });
    for (const tag of FIXTURE_LANE_TAGS) {
      expect(insertLane(db, segment.id, tag, 100)).not.toBeNull();
    }
    laneHomeSegmentId = segment.id;
  }
  return laneHomeSegmentId;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  const turnId = db
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
  // D2: every fixture turn gets a home, so a tagged edge between any two of
  // them has a segment to look its lane up in.
  // A TAG-LESS member of a NAMED task — the pre-cutover shape production
  // holds 98 of (settlement-read-once D5). Written directly rather than
  // through the membership primitive on purpose: the primitive derives from
  // tags, and these fixtures assert on `tags` they set themselves.
  addSegmentMembers(db, laneHomeSegment(), [turnId], 100);
  return turnId;
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
    stage: job.stage,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    ...overrides,
  };
}

/** Every edge parameter the facade accepts — relation fields and their retract… mirrors. */
const EDGE_INPUT_KEYS = [
  ...RELATION_FIELD_ENTRIES.map(([key]) => key),
  ...RETRACTION_FIELD_ENTRIES.map(([key]) => key),
];

/**
 * The relations read a real settlement run makes before it writes an edge
 * (peer round P1-8): the same `recall`, under the same claim identity, with
 * `filter.fields` selecting `relations` — which is what records the
 * completeness `checkRelationsGate` consumes.
 */
function readRelationsForWrite(
  context: SettlementTurnFacadeContext,
  turnAddress: string,
): void {
  recallMemory(db, {
    id: turnAddress,
    filter: { fields: ["relations"] },
    readerId: claimWriterId(context.jobId, context.claimGeneration, context.stage),
  });
}

/**
 * The direct descendant of the old immediate-write tool: evaluate and apply in
 * one call — preceded, when the call carries an edge field, by the relations
 * recall a real run makes first (peer round P1-8). The tests below are about
 * what an edge write DOES; the gate that admits it is pinned on its own in
 * tests/mcp/peer-round-grant-semantics.test.ts, so doing the read here keeps
 * each test's subject its own rather than turning every one of them into a
 * second copy of the gate test.
 */
function write(
  context: SettlementTurnFacadeContext,
  input: SettlementTurnWriteInput,
  nowEpoch: number,
  options: { skipRelationsRead?: boolean } = {},
): SettlementTurnWriteEvaluation {
  if (
    !options.skipRelationsRead &&
    typeof input.turn === "string" &&
    EDGE_INPUT_KEYS.some((key) => (input as Record<string, unknown>)[key] !== undefined)
  ) {
    readRelationsForWrite(context, input.turn);
  }
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

// ---------------------------------------------------------------------------
// The TAGS write gate reaches THIS surface too (ticket 14, spec D3b)
// ---------------------------------------------------------------------------

describe("the tags write gate is wired into the settlement surface (ticket 14)", () => {
  test("a word in neither vocabulary is refused here exactly as on the main agent's surface", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["not-in-any-vocabulary"] },
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('"not-in-any-vocabulary"');
    // Refused whole: the `type` that rode along never landed either.
    expect(getTurnById(db, t1)!.type).toEqual([]);
    expect(getTurnById(db, t1)!.tags).toEqual([]);
  });

  test("a lane tag without its own segment's tag is refused here, naming the missing one", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(context, { turn: `S${sessionDbId}/T1`, tags: ["lane-a"] }, NOW);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('"lane-home"');
  });

  test("but the AUTHORIZATION question is asked first — a turn outside the window hears about the window", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set<number>() });

    const result = write(context, { turn: `S${sessionDbId}/T1`, tags: ["nonsense"] }, NOW);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("reviewable window");
    void t1;
  });
});

describe("tags are replaced whole, under the shared mode (requirement 3; ticket 07 spec D4/D12)", () => {
  test("a second call's tags list replaces the first's rather than unioning with it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    write(context, { turn: `S${sessionDbId}/T1`, tags: ["lane-home", "first", "second"] }, NOW);
    expect(getTurnById(db, t1)!.tags).toEqual(["lane-home", "first", "second"]);

    write(
      context,
      { turn: `S${sessionDbId}/T1`, tags: ["lane-home", "third"], mode: { tags: "write" } },
      NOW + 1,
    );
    // Whole replace: "first"/"second" are gone, not merged with "third" —
    // `write` on a set field IS the full replacement set (spec D4).
    expect(getTurnById(db, t1)!.tags).toEqual(["lane-home", "third"]);
  });

  test("replacing a non-empty set without declaring the mode is refused, in the main agent's own words", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    write(context, { turn: `S${sessionDbId}/T1`, tags: ["lane-home", "first"] }, NOW);
    const result = write(context, { turn: `S${sessionDbId}/T1`, tags: ["lane-home", "second"] }, NOW + 1);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe(modeRequiredMessage("tags"));
    // Refused, not partially applied.
    expect(getTurnById(db, t1)!.tags).toEqual(["lane-home", "first"]);
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
// Staged-settlement spec Rev 5, ticket 01: the `topic:` namespace is LIVE at
// this boundary — settlement supplies missing subject words as backfill, so
// the facade has to be able to write one. What stays refused is a MALFORMED
// claim on the namespace, judged by the same grammar the main agent's tool
// uses (`checkTurnTagWrite`, the seam both writers pass through).
// ---------------------------------------------------------------------------

describe("the topic: namespace at settlement's write boundary (staged-settlement ticket 01)", () => {
  test("a staged topic word LANDS — settlement can supply one", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["topic:lease"] },
      NOW,
    );

    expect(resultText(result)).not.toContain("Parameter error");
    expect(getTurnById(db, t1)!.tags).toEqual(["topic:lease"]);
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
  });

  test("a phase-bearing topic word is refused here too, and nothing lands", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["topic:lease-implementation"] },
      NOW,
    );

    expect(resultText(result)).toContain('"implementation"');
    expect(getTurnById(db, t1)!.tags).toEqual([]);
    expect(getTurnById(db, t1)!.type).toEqual([]);
  });

  test("a non-canonical topic word is refused showing the derived candidate", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, tags: ["topic:Lease-Renewal"] },
      NOW,
    );

    expect(resultText(result)).toContain('"topic:lease-renewal"');
    expect(getTurnById(db, t1)!.tags).toEqual([]);
  });

  test("a bare tag alongside an existing bare tag is unaffected", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(context, { turn: `S${sessionDbId}/T1`, tags: ["lane-home", "lease"] }, NOW);

    expect(resultText(result)).not.toContain("Parameter error");
    expect(getTurnById(db, t1)!.tags).toEqual(["lane-home", "lease"]);
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
    const writer = claimWriterId(job.id, job.claimGeneration, job.stage);
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
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["lane-home", "x"] },
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
      { turn: `S${sessionDbId}/T1`, type: ["design"], tags: ["lane-home", "widgets"] },
      NOW,
    );

    expect(resultText(result)).not.toContain("Parameter error");
    const turn = getTurnById(db, t1)!;
    expect(turn.type).toEqual(["design"]);
    expect(turn.tags).toEqual(["lane-home", "widgets"]);
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
    const claimWriter = claimWriterId(job.id, job.claimGeneration, job.stage);

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
      { turn: `S${sessionDbId}/T1`, type: ["fix"], tags: ["lane-home", "settlement"] },
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
    const claimWriter = claimWriterId(job.id, job.claimGeneration, job.stage);

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
      { turn: `S${sessionDbId}/T1`, type: ["fix"], tags: ["lane-home", "settlement"] },
      NOW + 1,
    );

    expect(resultText(result)).not.toContain("Yielded for");
    const turn = getTurnById(db, t1)!;
    expect(turn.type).toEqual(["fix"]);
    expect(turn.tags).toEqual(["lane-home", "settlement"]);
  });

  test("a lapsed claimant's write goes stale once the new claimant (a different claim generation) has written the same field — claim fencing via the gate, no separate CAS", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const staleJob = claimWindow(sessionDbId, 1, 1);
    const staleWriter = claimWriterId(staleJob.id, staleJob.claimGeneration, staleJob.stage);
    // A displaced claimant still holds a grant from ITS OWN context build.
    recordReadGrant(db, staleWriter, "turn", t1, NOW, snapshotWriteGateSequence(db));

    // The NEW claimant (same job id, later generation — a real reclaim bumps
    // claim_generation; simulated directly here) writes the SAME field first.
    const freshWriter = claimWriterId(staleJob.id, staleJob.claimGeneration + 1, staleJob.stage);
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
      { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("1 relation");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    // INTERIM (relation-vocabulary-v13 ticket 02, ticket 05a replaces it): a
    // `use` write stores as `extends`, with the class in its own column.
    expect(edges[0]!.relation).toBe("extends");
    expect(edges[0]!.relationClass).toBe("use");
    // Settlement's attribution survives the move onto the main agent's own
    // primitive — `judged`, not `asserted`.
    expect(edges[0]!.provenance).toBe("judged");
  });

  // MAIN-AGENT-EDGES D1/D5 INVERTED THIS TEST, so it is rewritten rather than
  // deleted: the property it pinned — "ONE pair may carry two relations at
  // once", the duplicate-target mirror's absence — is exactly what one row per
  // pair retires. A logical edge IS the pair, and a pair whose two ends stand
  // in two relations at once was never a graph fact; it was a storage
  // accident that made "what does this turn say about that one" a question
  // with several answers.
  //
  // What replaces it is the same call, asserted the other way round: the two
  // entries collapse onto one row carrying the MORE SPECIFIC class
  // (`RELATION_CLASS_SPECIFICITY`: use < verify < correct), and the weaker one
  // is a no-op the receipt reports as already present rather than a second row.
  test("one pair, one row: two classes on one target collapse onto the more specific one (D1/D5)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design"], tags: ["lane-home", "lane-a"] });
    updateTurnById(db, t2, { type: ["implement", "correction"], tags: ["lane-home", "lane-a"] });
    const job = claimWindow(sessionDbId, 1, 2);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t2]) }),
      {
        turn: `S${sessionDbId}/T2`,
        verify: [`S${sessionDbId}/T1`],
        use: [{ turn: `S${sessionDbId}/T1`, tags: ["lane-a"] }],
      },
      NOW,
    );

    // One row landed, and the call is not silently half-dropped: the weaker
    // `use` is accounted for by name.
    expect(resultText(result)).toContain("1 relation");
    const edges = getOutgoingEdges(db, { kind: "turn", id: t2 });
    expect(edges).toHaveLength(1);
    // INTERIM storage words (ticket 05a replaces the mapping): `verify` ->
    // `verifies`. The stored class is the specific one, whichever order the
    // fields were processed in.
    expect(edges[0]!.relation).toBe("verifies");
    expect(edges[0]!.relationClass).toBe("verify");
  });

  // Indexes-rescope spec (ticket 01, [S15069/T1232]): `indexes` (the renamed,
  // widened `collects`) carries NO graph-state check any more — the old
  // "collects through the facade" pins (peer final-audit finding 2, S15069/
  // T1217) covered the facade sharing note.ts's collects gate, dead-branch
  // case included; these now confirm the identical dead-branch shape SUCCEEDS
  // through the facade, since the gate itself retired.
  test("convergence through the facade: a live settlement `use`s its member", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t3 = seedTurn(sessionDbId, 3);
    // tag-mandate: the setup extends names a lane both endpoints carry, and
    // its receipt is asserted — a setup call that silently stopped landing
    // would leave the `indexes` assertion below reading an empty branch.
    updateTurnById(db, t1, { type: ["design"], tags: ["lane-home", "lane-a"] });
    updateTurnById(db, t3, { type: ["correction"], tags: ["lane-home", "lane-a"] });
    const job = claimWindow(sessionDbId, 1, 3);
    const context = baseContext(job, { reviewableTurnIds: new Set([t3]) });

    const branch = write(
      context,
      { turn: `S${sessionDbId}/T3`, use: [{ turn: `S${sessionDbId}/T1`, tags: ["lane-a"] }] },
      NOW,
    );
    expect(resultText(branch)).toContain("1 relation");
    const result = write(
      context,
      { turn: `S${sessionDbId}/T3`, use: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );

    expect(resultText(result)).toContain("1 relation");
    expect(
      getOutgoingEdges(db, { kind: "turn", id: t3 }).some(
        // INTERIM (ticket 05a): a `use` write stores as `extends`. The word
        // `indexes` this test used to assert is DELETED from the write
        // vocabulary outright (user ruling S15069/T2306) — convergence is no
        // longer declared, it is read off out-degree.
        (edge) => edge.relation === "extends" && edge.relationClass === "use",
      ),
    ).toBe(true);
  });

  test("convergence through the facade: a fully corrected settlement (dead branch) can still converge — the graph-state gate retired", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t3 = seedTurn(sessionDbId, 3);
    const t4 = seedTurn(sessionDbId, 4);
    // tag-mandate: same as the test above — the branch is a real lane, and
    // the override that kills it below stays UNTAGGED (a global repudiation,
    // which keeps its bare form).
    updateTurnById(db, t1, { type: ["design"], tags: ["lane-home", "lane-a"] });
    updateTurnById(db, t3, { type: ["correction"], tags: ["lane-home", "lane-a"] });
    updateTurnById(db, t4, { type: ["design"] });
    const job = claimWindow(sessionDbId, 1, 4);

    const branch = write(
      baseContext(job, { reviewableTurnIds: new Set([t3]) }),
      { turn: `S${sessionDbId}/T3`, use: [{ turn: `S${sessionDbId}/T1`, tags: ["lane-a"] }] },
      NOW,
    );
    expect(resultText(branch)).toContain("1 relation");
    write(
      baseContext(job, { reviewableTurnIds: new Set([t4]) }),
      { turn: `S${sessionDbId}/T4`, correct: [correctEntry(`S${sessionDbId}/T3`, "full")] },
      NOW + 1,
    );
    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t3]) }),
      { turn: `S${sessionDbId}/T3`, use: [`S${sessionDbId}/T1`] },
      NOW + 2,
    );

    expect(resultText(result)).toContain("1 relation");
    expect(
      getOutgoingEdges(db, { kind: "turn", id: t3 }).some(
        // INTERIM (ticket 05a): a `use` write stores as `extends`. The word
        // `indexes` this test used to assert is DELETED from the write
        // vocabulary outright (user ruling S15069/T2306) — convergence is no
        // longer declared, it is read off out-degree.
        (edge) => edge.relation === "extends" && edge.relationClass === "use",
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
    const input = { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] };
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
      { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
      NOW,
    );

    const retracted = write(
      context,
      { turn: `S${sessionDbId}/T2`, retractUse: [`S${sessionDbId}/T1`] },
      NOW + 1,
    );
    expect(resultText(retracted)).toContain("Retracted 1 relation(s)");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

    // `no-such-edge`, named per address — "already gone" and "wrong address"
    // stay distinguishable, and nothing is deleted.
    const missing = write(
      context,
      { turn: `S${sessionDbId}/T2`, retractUse: [`S${sessionDbId}/T1`] },
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
      { turn: `S${sessionDbId}/T1`, use: [`S${sessionDbId}/T999`] },
      NOW,
    );
    expect(resultText(unresolved)).toContain("does not resolve");

    const selfLoop = write(
      context,
      { turn: `S${sessionDbId}/T1`, use: [`S${sessionDbId}/T1`] },
      NOW,
    );
    expect(resultText(selfLoop)).toContain("an edge's two ends must be DIFFERENT turns");
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toEqual([]);
  });

  // tag-mandate spec ("Write gate"): ONE rule, no carve-outs — the settlement
  // facade inherits the mandate from the same `validateRelationTarget` the
  // main agent's `note` calls, so this block is the mirror of
  // tests/mcp/note.test.ts's "the tag mandate" describe. Kept as a real
  // end-to-end pin rather than a prose claim of sameness: the two paths build
  // their validator input independently (the facade reads the citing turn's
  // tags through its own type/tags-correction yield rules), so only an
  // exercised call proves the mandate reaches this one.
  // lane-declaration [S15069/T1548]: settlement inherits the WITHDRAWAL from
  // the same one validator it inherited the mandate from. This block pins the
  // permission in the place the mandate used to be pinned.
  describe("no word requires a lane tag on the settlement path either", () => {
    test("a bare extends through the facade LANDS untagged, and a later side placement neither mints a row nor re-places the stored side", () => {
      const sessionDbId = seedSession();
      const t1 = seedTurn(sessionDbId, 1);
      const t2 = seedTurn(sessionDbId, 2);
      updateTurnById(db, t1, { type: ["design"], tags: ["lane-home", "lane-a"] });
      updateTurnById(db, t2, { type: ["design"], tags: ["lane-home", "lane-a"] });
      const job = claimWindow(sessionDbId, 1, 2);
      const context = baseContext(job, { reviewableTurnIds: new Set([t2]) });

      const result = write(
        context,
        { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })[0]?.tailTag).toBe("");

      // MAIN-AGENT-EDGES D1/D4: THE SECOND HALF SAYS THE OPPOSITE NOW.
      //
      // The placed form used to be a SECOND, independent row, because a row's
      // identity was (pair, relation, tail, head) and a side was therefore part
      // of what an edge WAS. It is not: a side is an ATTRIBUTION over one edge,
      // and the pair is the edge. So a second placement onto a pair that
      // already holds a row mints nothing — and it does not silently re-place
      // the stored side either, which is the half worth pinning: the call that
      // used to add a lane now changes nothing at all, and the one thing that
      // moves a stored side is `declareEdgeSides` (D4, the `declare`
      // parameter).
      const placed = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-a" }],
        },
        NOW + 1,
      );
      // Accounted for by name rather than dropped: the class is the same and
      // brings no coverage change, so the stored row already says everything
      // this call asserts.
      expect(resultText(placed)).toContain("already present");
      expect(
        getOutgoingEdges(db, { kind: "turn", id: t2 })
          .map((edge) => `${edge.tailTag}|${edge.headTag}`),
      ).toEqual(["\u007C"]);
    });

    test("a bare narrows through the facade lands the same way", () => {
      const sessionDbId = seedSession();
      const t1 = seedTurn(sessionDbId, 1);
      const t2 = seedTurn(sessionDbId, 2);
      updateTurnById(db, t1, { type: ["design"], tags: ["lane-home", "lane-a"] });
      updateTurnById(db, t2, { type: ["design"], tags: ["lane-home", "lane-a"] });
      const job = claimWindow(sessionDbId, 1, 2);

      const result = write(
        baseContext(job, { reviewableTurnIds: new Set([t2]) }),
        { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T1`, "partial")] },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })[0]?.tailTag).toBe("");
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })[0]?.headTag).toBe("");
    });

    // lane-declaration D2 reaches settlement from the SAME validator: the
    // registry gate is not a main-agent-only courtesy.
    test("an undeclared lane is refused on the settlement path, naming the segment and the tag", () => {
      const sessionDbId = seedSession();
      const t1 = seedTurn(sessionDbId, 1);
      const t2 = seedTurn(sessionDbId, 2);
      updateTurnById(db, t1, { type: ["design"], tags: ["lane-home", "lane-a"] });
      updateTurnById(db, t2, { type: ["design"], tags: ["lane-home", "lane-a"] });
      updateTurnById(db, t1, { tags: ["lane-home", "fresh-lane"] });
      updateTurnById(db, t2, { tags: ["lane-home", "fresh-lane"] });
      const segmentId = laneHomeSegment();
      const job = claimWindow(sessionDbId, 1, 2);
      const context = baseContext(job, { reviewableTurnIds: new Set([t2]) });

      const call = {
        turn: `S${sessionDbId}/T2`,
        use: [{ turn: `S${sessionDbId}/T1`, tailTag: "fresh-lane", headTag: "fresh-lane" }],
      };
      const refused = write(context, call, NOW);
      expect(resultText(refused)).toStartWith("Parameter error:");
      expect(resultText(refused)).toContain(`E${segmentId}`);
      expect(resultText(refused)).toContain('has not declared lane "fresh-lane"');
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

      // The ONLY change: the lane is declared in that segment, and the
      // identical call lands.
      expect(insertLane(db, segmentId, "fresh-lane", 100)).not.toBeNull();
      expect(resultText(write(context, call, NOW + 1))).toContain("1 relation");
    });

    // The assertion/retraction split: settlement is the writer that MEETS the
    // untagged stock (a window over ancient turns), so its retraction mirrors
    // are the ones that must keep working on bare addresses.
    //
    // MAIN-AGENT-EDGES D5 rewrote what this pins. The fixture seeds a legacy
    // MULTI-ROW pair — `extends` (class `use`) and `narrows` (class
    // `correct/partial`) between the same two turns — which is exactly the 109
    // pairs production still holds. Under one-pair-one-row that stock is ONE
    // logical edge and it reads as its most specific class, so the call that
    // works is the single mirror naming THAT class, and it takes the whole
    // pair with it. The mirror naming the weaker word is refused by name
    // (`stale-class`) rather than deleting half an edge on a stale reading.
    test("a legacy MULTI-ROW pair retracts as ONE edge, through the mirror naming its materialized class", () => {
      const sessionDbId = seedSession();
      const t1 = seedTurn(sessionDbId, 1);
      const t2 = seedTurn(sessionDbId, 2);
      updateTurnById(db, t1, { type: ["design"] });
      updateTurnById(db, t2, { type: ["design"] });
      // Legacy stock, and it now has to be seeded by raw SQL. It used to go
      // through `writeMemoryEdges`, which under main-agent-edges D1 is exactly
      // the path that can no longer produce this shape: the second input finds
      // the pair's row already there, sees `narrows` (class `correct`) as
      // strictly more specific than the stored `extends` (class `use`), and
      // PROMOTES that one row instead of inserting a second. The two-row pair
      // is pre-cutover STOCK — 109 of them in production, readers untouched —
      // so the fixture reaches under the write path to build one, which is the
      // only level that still can.
      const seedLegacyRow = (relation: string) => {
        db.query<unknown, [number, number, string, number]>(
          `INSERT INTO memory_edges (
             citing_kind, citing_id, cited_kind, cited_id,
             relation, provenance, tail_tag, head_tag,
             relation_class, relation_coverage, created_at_epoch
           ) VALUES ('turn', ?, 'turn', ?, ?, 'judged', '', '', '', '', ?)`,
        ).run(t2, t1, relation, NOW - 500);
      };
      seedLegacyRow("extends");
      seedLegacyRow("narrows");
      const job = claimWindow(sessionDbId, 1, 2);

      // The weaker mirror is refused: the pair's materialized class is
      // `correct`, and a `use` retraction is acting on a reading that is no
      // longer true of the edge.
      const stale = write(
        baseContext(job, { reviewableTurnIds: new Set([t2]) }),
        { turn: `S${sessionDbId}/T2`, retractUse: [`S${sessionDbId}/T1`] },
        NOW,
      );
      expect(resultText(stale)).toContain("is now `correct`, not `use`");
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toHaveLength(2);

      const result = write(
        baseContext(job, { reviewableTurnIds: new Set([t2]) }),
        { turn: `S${sessionDbId}/T2`, retractCorrect: [`S${sessionDbId}/T1`] },
        NOW,
      );

      expect(resultText(result)).toContain("2 relation");
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);
    });
  });

  // lane-model-v12 D2 (ticket 04): the settlement write path shares the SAME
  // `validateRelationTarget` the main agent's `note` calls, so the deletion
  // of the conditional self-citation permission lands on both writers at
  // once. Three tests stood here — the two-condition pass, the missing
  // declaration, and the declaration a later override had reopened — all
  // exercising a post-write terminus gate that no longer exists. One test
  // replaces them: the most-favourable shape the old rule ever admitted is
  // refused through this path too.
  test("the shape that used to be the ONE legal self edge is refused through the settlement path as well", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design", "implement"], tags: ["lane-home", "lane-a"] });
    updateTurnById(db, t2, { type: ["design"], tags: ["lane-home", "lane-a"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });

    const result = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        use: [{ turn: `S${sessionDbId}/T2`, tailTag: "lane-a", headTag: "lane-a" }],
        use: [`S${sessionDbId}/T1`],
      },
      NOW,
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("an edge's two ends must be DIFFERENT turns");
    // Whole-call rejection: not even the legal tagged `indexes` lands.
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
    const context = baseContext(job, { reviewableTurnIds: new Set([t2]) });

    // Peer round P1-8 put a SECOND gate on the same call. Satisfying the
    // relations half out-of-band (rather than through a real relations recall,
    // which would also grant the entity and so answer the `type` gate's own
    // question) is what keeps this test's subject the `type` gate.
    recordFieldCompleteness(
      db,
      claimWriterId(job.id, job.claimGeneration, job.stage),
      [{ entityType: "turn", entityId: t2, field: "relations", complete: true }],
      NOW - 5,
      snapshotWriteGateSequence(db),
    );

    const refused = write(
      context,
      { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
      NOW,
      { skipRelationsRead: true },
    );
    expect(resultText(refused)).toContain("has not been read this session");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

    // Granted, the same call lands — and the edge write leaves the `type`
    // stamp alone: it corrects no type, and stamping one would tell the next
    // pass a type correction landed when none did.
    recordReadGrant(
      db,
      claimWriterId(job.id, job.claimGeneration, job.stage),
      "turn",
      t2,
      NOW,
      snapshotWriteGateSequence(db),
    );
    const landed = write(
      context,
      { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
      NOW + 1,
      { skipRelationsRead: true },
    );
    expect(resultText(landed)).toContain("1 relation");
    const stamp = db
      .query<{ writer: string }, [number]>(
        "SELECT writer FROM write_gate_stamps WHERE entity_type = 'turn' AND entity_id = ? AND field = 'type'",
      )
      .get(t2);
    expect(stamp?.writer).toBe(sessionWriterId(sessionDbId));
  });

  // Lane-model v12 ticket 02 replaces the retired "a phase-illegal relation is
  // refused in the validator's own words" pin, in place and on the same
  // fixture: the write both surfaces share stopped judging the word by either
  // end's `type`, so the exact call that used to be refused here has to LAND —
  // and it has to land through the settlement path specifically, since one
  // validator serving two writers is the property that made the old test
  // worth having.
  test("a relation the phase gate used to refuse now lands through the settlement path too", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    // `verifies` used to need an evidence-phase citing turn; T2 has none.
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 2);

    const result = write(
      baseContext(job, { reviewableTurnIds: new Set([t2]) }),
      { turn: `S${sessionDbId}/T2`, verify: [`S${sessionDbId}/T1`] },
      NOW,
    );

    expect(resultText(result)).toContain("Landed 1 relation(s).");
    expect(resultText(result)).not.toContain("-phase");
    expect(
      getOutgoingEdges(db, { kind: "turn", id: t2 }).map((edge) => edge.relation),
    ).toEqual(["verifies"]);
  });
});

// ---------------------------------------------------------------------------
// lane-model-v12 ticket 08 (spec D1/D2/D3d): the TWO-SIDED write gate, end to
// end through the one surface that still writes edges. `tests/shared/turn-
// phase.test.ts` pins the judgment in isolation; these pin that the settlement
// facade actually reaches it with the right evidence — which endpoint's tags,
// which endpoint's segment — and that a refusal aborts the whole call.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P1-8 — the relations gate. It used to be pinned against the main agent's
// `note` (tests/mcp/peer-round-grant-semantics.test.ts); lane-model-v12 ticket
// 08 left settlement the only edge writer, so the gate is exercised here now,
// against the surface that still has edges to write.
// ---------------------------------------------------------------------------

describe("the relations gate (peer round P1-8)", () => {
  function seedPair(): {
    sessionDbId: number;
    citing: number;
    cited: number;
    third: number;
    job: NoteSettlementJob;
    context: SettlementTurnFacadeContext;
  } {
    laneHomeSegment();
    const sessionDbId = seedSession();
    const cited = seedTurn(sessionDbId, 1);
    const citing = seedTurn(sessionDbId, 2);
    const third = seedTurn(sessionDbId, 3);
    for (const id of [cited, citing, third]) {
      updateTurnById(db, id, { type: ["design"], tags: [FIXTURE_SEGMENT_TAG] });
    }
    const job = claimWindow(sessionDbId, 1, 3);
    return {
      sessionDbId,
      citing,
      cited,
      third,
      job,
      context: baseContext(job, { reviewableTurnIds: new Set([citing, cited, third]) }),
    };
  }

  function relationCount(citingId: number): number {
    return db
      .query<{ c: number }, [number]>(
        `SELECT COUNT(*) AS c FROM memory_edges
         WHERE citing_kind = 'turn' AND citing_id = ? AND relation IS NOT NULL`,
      )
      .get(citingId)!.c;
  }

  test("an attach with no relations read is refused, naming the read that earns it", () => {
    const { sessionDbId, citing, third, context } = seedPair();
    // MAIN-AGENT-EDGES D3: the gate only has something to demand once the
    // citing turn HAS an outgoing relation set. A turn with zero atoms takes
    // the fresh-turn exception (its own tests live in
    // `tests/db/logical-edge-writes.test.ts`), so this fixture seeds one edge
    // first — the state where "read the set before you change it" is a real
    // requirement rather than a round trip for an empty field.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: third },
          relation: "consume",
          provenance: "judged",
          relationClass: "use",
        },
      ],
      NOW - 500,
    );
    // The turn itself has been read — the entity grant the `type` gate asks
    // for is in hand, and it is still not enough.
    recallMemory(db, {
      id: `S${sessionDbId}/T2`,
      readerId: claimWriterId(context.jobId, context.claimGeneration, context.stage),
    });

    const refused = write(
      context,
      { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T1`, "full")] },
      NOW,
      { skipRelationsRead: true },
    );

    expect(resultText(refused)).toStartWith("Parameter error:");
    expect(resultText(refused)).toContain("relations of");
    expect(resultText(refused)).toContain('filter={fields:["relations"]}');
  });

  test("after a relations recall the same call lands", () => {
    const { sessionDbId, citing, context } = seedPair();
    readRelationsForWrite(context, `S${sessionDbId}/T2`);

    const landed = write(
      context,
      { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T1`, "full")] },
      NOW,
      { skipRelationsRead: true },
    );

    expect(resultText(landed)).toContain("1 relation");
    expect(relationCount(citing)).toBe(1);
  });

  // A LATER settlement run is the only other edge writer there is now — a
  // re-claim of the same job is a new generation, and therefore a new writer
  // identity, which is exactly what the stale reader has to be caught by.
  test("a later run's edge write moves the revision, and the stale reader is caught by it", () => {
    const { sessionDbId, citing, job, context } = seedPair();
    const laterContext = baseContext(job, {
      reviewableTurnIds: context.reviewableTurnIds,
      claimGeneration: job.claimGeneration + 1,
    });

    // Both runs read the (empty) relation set.
    readRelationsForWrite(context, `S${sessionDbId}/T2`);
    readRelationsForWrite(laterContext, `S${sessionDbId}/T2`);

    // The later run attaches first — the set is no longer what either read.
    expect(
      resultText(
        write(
          laterContext,
          { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T1`, "full")] },
          NOW,
          { skipRelationsRead: true },
        ),
      ),
    ).toContain("1 relation");

    const refused = write(
      context,
      { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T3`, "full")] },
      NOW + 1,
      { skipRelationsRead: true },
    );
    expect(resultText(refused)).toStartWith("Parameter error:");
    expect(resultText(refused)).toContain("were changed by");
    expect(relationCount(citing)).toBe(1);

    // Re-reading the current set clears it.
    readRelationsForWrite(context, `S${sessionDbId}/T2`);
    expect(
      resultText(
        write(
          context,
          { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T3`, "full")] },
          NOW + 2,
          { skipRelationsRead: true },
        ),
      ),
    ).toContain("1 relation");
    expect(relationCount(citing)).toBe(2);
  });

  test("the writer that made the current revision may keep writing without re-reading", () => {
    const { sessionDbId, citing, context } = seedPair();
    readRelationsForWrite(context, `S${sessionDbId}/T2`);

    expect(
      resultText(
        write(
          context,
          { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T1`, "full")] },
          NOW,
          { skipRelationsRead: true },
        ),
      ),
    ).toContain("1 relation");
    // Second edge, same run, no second read: writing is reading.
    expect(
      resultText(
        write(
          context,
          { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T3`, "full")] },
          NOW + 1,
          { skipRelationsRead: true },
        ),
      ),
    ).toContain("1 relation");
    expect(relationCount(citing)).toBe(2);
  });

  test("a retraction is gated identically, and stays bare-addressed", () => {
    const { sessionDbId, context } = seedPair();
    readRelationsForWrite(context, `S${sessionDbId}/T2`);
    write(
      context,
      { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T1`, "full")] },
      NOW,
      { skipRelationsRead: true },
    );

    const retracted = write(
      context,
      { turn: `S${sessionDbId}/T2`, retractCorrect: [`S${sessionDbId}/T1`] },
      NOW + 1,
      { skipRelationsRead: true },
    );
    expect(resultText(retracted)).toContain("Retracted 1 relation(s)");
  });
});

describe("the two-sided edge write gate (lane-model-v12 ticket 08)", () => {
  /**
   * A SECOND segment with its own globally unique tag, declaring lane tags of
   * its own. It exists for exactly one property: a lane's identity is
   * (segment, tag), so `lane-a` here and `lane-a` in the home segment are TWO
   * different lanes, and an edge between them is a legal crossing.
   */
  function awaySegment(): number {
    const existing = db
      .query<{ id: number }, []>(
        "SELECT id FROM segments WHERE json_extract(tags, '$[0]') = 'lane-away'",
      )
      .get();
    if (existing) {
      return existing.id;
    }
    const segment = createSegment(db, {
      title: "lane away",
      tags: ["lane-away"],
      nowEpoch: 100,
    });
    for (const tag of ["lane-a", "lane-z"]) {
      expect(insertLane(db, segment.id, tag, 100)).not.toBeNull();
    }
    return segment.id;
  }

  /** Two turns, the citing one in the home segment, plus a claimed window over both. */
  function pair(options: {
    citingTags?: readonly string[];
    citedTags?: readonly string[];
  } = {}) {
    laneHomeSegment();
    const sessionDbId = seedSession();
    const cited = seedTurn(sessionDbId, 1);
    const citing = seedTurn(sessionDbId, 2);
    updateTurnById(db, cited, {
      type: ["design"],
      tags: [...(options.citedTags ?? [FIXTURE_SEGMENT_TAG, "lane-a"])],
    });
    updateTurnById(db, citing, {
      type: ["design"],
      tags: [...(options.citingTags ?? [FIXTURE_SEGMENT_TAG, "lane-a"])],
    });
    const job = claimWindow(sessionDbId, 1, 2);
    return {
      sessionDbId,
      cited,
      citing,
      context: baseContext(job, { reviewableTurnIds: new Set([citing, cited]) }),
    };
  }

  function sidesOf(citingId: number): Array<[string, string]> {
    return getOutgoingEdges(db, { kind: "turn", id: citingId }).map((edge) => [
      edge.tailTag,
      edge.headTag,
    ]);
  }

  // TICKET 20 REVERSES TICKET 08 HERE, at the one write face that can reach
  // this gate. A DRAFT — either side empty, or both — now LANDS; the refusal
  // moved to the checker (error class E6) and the commit gate. What this block
  // pins is that the acceptance is of the SHAPE only: the side that IS placed
  // still answers to all three per-side checks below.
  describe("a draft edge lands — either side may be left empty (ticket 20)", () => {
    test("an edge with NEITHER side placed is accepted — that is the draft an edge starts as", () => {
      const { sessionDbId, citing, context } = pair();

      const result = write(
        context,
        { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(sidesOf(citing)).toEqual([["", ""]]);
    });

    test("an edge with only the TAIL placed LANDS, storing the half it was given", () => {
      const { sessionDbId, citing, context } = pair();

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "" }],
        },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(sidesOf(citing)).toEqual([["lane-a", ""]]);
    });

    test("an edge with only the HEAD placed LANDS the same way", () => {
      const { sessionDbId, citing, context } = pair();

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "", headTag: "lane-a" }],
        },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(sidesOf(citing)).toEqual([["", "lane-a"]]);
    });

    // MAIN-AGENT-EDGES D5 INVERTED THIS. It used to pin that the same class
    // under two DIFFERENT lane placements was two independent claims — D2's
    // multi-row identity, and the mechanism that produced 109 multi-row pairs
    // in production. One pair is one row now: the two entries are ONE claim,
    // the first placement is the one that lands, and "a second side placement
    // → never a new row" is what the assertion says.
    test("the same pair placed twice in one call is ONE row, not two", () => {
      const { sessionDbId, citing, context } = pair();

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [
            { turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-a" },
            { turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "" },
          ],
        },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(sidesOf(citing)).toEqual([["lane-a", "lane-a"]]);
    });

    // main-agent-edges D4/D5: the ONE outcome the attach/declare split could
    // have made silent. A placement onto a pair that already has a row changes
    // nothing, and "already present" is a truthful receipt that reads as
    // success — so the receipt says the placement was not applied and names
    // the parameter that would apply it.
    test("a placement onto an existing pair is reported, not silently dropped", () => {
      const { sessionDbId, citing, context } = pair();

      write(context, { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] }, NOW);

      const second = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-a" }],
        },
        NOW + 1,
      );

      expect(resultText(second)).toContain("named a lane side that was NOT applied");
      expect(resultText(second)).toContain("`declare`");
      expect(sidesOf(citing)).toEqual([["", ""]]);
    });

    // The mirror case, and the reason the notice is computed from the STORED
    // sides rather than from "was this pair already there": a placement that
    // landed with the row says nothing.
    test("a placement that DID land is not reported as unapplied", () => {
      const { sessionDbId, citing, context } = pair();

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-a" }],
        },
        NOW,
      );

      expect(resultText(result)).not.toContain("NOT applied");
      expect(sidesOf(citing)).toEqual([["lane-a", "lane-a"]]);
    });

    // The acceptance is of the SHAPE, not the content: without this, "a draft
    // lands" would let an UNDECLARED lane reach storage on the placed half —
    // the exact hole ticket 08's per-side checks exist to close.
    test("the PLACED side of a half-settled edge is still judged, and a bad one writes nothing", () => {
      const { sessionDbId, citing, context } = pair();

      const undeclared = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "never-declared", headTag: "" }],
        },
        NOW,
      );
      expect(resultText(undeclared)).toStartWith("Parameter error:");
      expect(resultText(undeclared)).toContain("not declared where that side lives");
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);

      const nonCanonical = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "", headTag: "Lane-A" }],
        },
        NOW,
      );
      expect(resultText(nonCanonical)).toStartWith("Parameter error:");
      expect(resultText(nonCanonical)).toContain("not in canonical form");
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });

    // The retired refusal must not come back under its own words.
    test("no refusal this face can produce still teaches both-or-neither", () => {
      const { sessionDbId, context } = pair();
      const refused = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "never-declared", headTag: "" }],
        },
        NOW,
      );
      expect(resultText(refused)).not.toContain("BOTH sides or on NEITHER");
    });
  });

  describe("the three per-side checks", () => {
    test("check 1 — a NON-CANONICAL side tag is refused, quoting the canonical form", () => {
      const { sessionDbId, citing, context } = pair();

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "Lane-A", headTag: "lane-a" }],
        },
        NOW,
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("not in canonical form");
      expect(resultText(result)).toContain("tail side");
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });

    test("check 2 — a lane the side's OWN segment never declared is refused, naming that segment", () => {
      const segmentId = laneHomeSegment();
      const { sessionDbId, citing, context } = pair({
        citingTags: [FIXTURE_SEGMENT_TAG, "undeclared-lane"],
        citedTags: [FIXTURE_SEGMENT_TAG, "undeclared-lane"],
      });

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [
            { turn: `S${sessionDbId}/T1`, tailTag: "undeclared-lane", headTag: "undeclared-lane" },
          ],
        },
        NOW,
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain(`E${segmentId}`);
      expect(resultText(result)).toContain('has not declared lane "undeclared-lane"');
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });

    test("check 2 — an endpoint carrying NO segment tag is refused, naming that turn", () => {
      const { sessionDbId, citing, cited, context } = pair({ citedTags: [] });
      void cited;

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-a" }],
        },
        NOW,
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("NO segment");
      expect(resultText(result)).toContain(`S${sessionDbId}/T1`);
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });

    test("check 3 — a side tag missing from THAT side's own turn is refused, naming the side", () => {
      const { sessionDbId, citing, context } = pair({
        citingTags: [FIXTURE_SEGMENT_TAG],
      });

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-a" }],
        },
        NOW,
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("tail side");
      expect(resultText(result)).toContain("lane-a");
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });

    test("check 3 — the tag being on the OTHER endpoint buys this side nothing", () => {
      const { sessionDbId, citing, context } = pair({
        citingTags: [FIXTURE_SEGMENT_TAG, "lane-b"],
        citedTags: [FIXTURE_SEGMENT_TAG, "lane-a", "lane-b"],
      });

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-a" }],
        },
        NOW,
      );

      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain("tail side");
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });

    test("a side's tags reflect THIS SAME call's own tags correction", () => {
      // The citing turn does not carry `lane-b` yet — this call gives it that
      // tag and writes the edge in one go, and the gate judges the edge
      // against where the turn ENDS UP.
      const { sessionDbId, citing, context } = pair({
        citingTags: [FIXTURE_SEGMENT_TAG],
        citedTags: [FIXTURE_SEGMENT_TAG, "lane-b"],
      });

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          tags: [FIXTURE_SEGMENT_TAG, "lane-b"],
          mode: { tags: "write" },
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-b", headTag: "lane-b" }],
        },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(sidesOf(citing)).toEqual([["lane-b", "lane-b"]]);
    });
  });

  describe("a lane's identity is (segment, tag), so a crossing is legal", () => {
    // THE ONE THAT IS EASIEST TO GET BACKWARDS. Both sides carry the literal
    // word `lane-a`, but the two endpoints live in different segments — so
    // these are TWO lanes, and the edge crosses between them.
    test("the SAME WORD on both sides, endpoints in DIFFERENT segments, is ACCEPTED as a crossing", () => {
      awaySegment();
      const { sessionDbId, citing, context } = pair({
        citingTags: [FIXTURE_SEGMENT_TAG, "lane-a"],
        citedTags: ["lane-away", "lane-a"],
      });

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-a" }],
        },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(sidesOf(citing)).toEqual([["lane-a", "lane-a"]]);
      // The assertion that used to sit here pinned THE LIMIT OF THE LEGACY
      // COLUMN — a same-word crossing projected into the merged set as one
      // lane, because the projection saw two words and no segments — so that
      // nobody would "fix" it by teaching the storage primitive about
      // segments. Ticket 09 deleted the column, so the limit describes
      // nothing; the assertion went with it rather than being left to
      // document a shape the database no longer has.
    });

    test("TWO DIFFERENT lanes, one per side, is accepted inside one segment too", () => {
      const { sessionDbId, citing, context } = pair({
        citingTags: [FIXTURE_SEGMENT_TAG, "lane-a"],
        citedTags: [FIXTURE_SEGMENT_TAG, "lane-b"],
      });

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-a", headTag: "lane-b" }],
        },
        NOW,
      );

      expect(resultText(result)).toContain("1 relation");
      expect(sidesOf(citing)).toEqual([["lane-a", "lane-b"]]);
    });

    test("a lane declared only in the OTHER side's segment is still refused — each side answers to its own", () => {
      awaySegment();
      const { sessionDbId, citing, context } = pair({
        citingTags: [FIXTURE_SEGMENT_TAG, "lane-b"],
        citedTags: ["lane-away", "lane-b"],
      });

      const result = write(
        context,
        {
          turn: `S${sessionDbId}/T2`,
          use: [{ turn: `S${sessionDbId}/T1`, tailTag: "lane-b", headTag: "lane-b" }],
        },
        NOW,
      );

      // `lane-b` is declared in the HOME segment but not in the away one, so
      // the head side has no lane by that name.
      expect(resultText(result)).toStartWith("Parameter error:");
      expect(resultText(result)).toContain('has not declared lane "lane-b"');
      expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
    });
  });

  // Ticket 04 owns the implementation; this ticket only confirms it holds on
  // the one write path that survives.
  test("a self edge is refused whatever its lanes (ticket 04, confirmed here)", () => {
    const { sessionDbId, citing, context } = pair();

    const result = write(
      context,
      {
        turn: `S${sessionDbId}/T2`,
        use: [{ turn: `S${sessionDbId}/T2`, tailTag: "lane-a", headTag: "lane-a" }],
      },
      NOW,
    );

    expect(resultText(result)).toStartWith("Parameter error:");
    expect(resultText(result)).toContain("an edge's two ends must be DIFFERENT turns");
    expect(getOutgoingEdges(db, { kind: "turn", id: citing })).toEqual([]);
  });

  // DELETED (main-agent-edges D1 + D4, ruling T2432 P1): "a placed edge and its
  // own draft coexist, and a retraction addresses exactly one".
  //
  // It pinned two things that are now both false, and each on its own would
  // have retired it:
  //
  //   - a draft (`''`/`''`) and a placed (`lane-a`/`lane-a`) write onto the
  //     SAME pair produced two rows, because a side was part of a row's
  //     identity. One pair now holds one row, and a second placement onto it
  //     mints nothing and re-places nothing (D1) — pinned in this file's own
  //     "a bare extends through the facade LANDS untagged" test, which asserts
  //     that inverted outcome directly.
  //   - a retraction was addressed BY those sides, picking one of the two rows
  //     out. A retraction now addresses the PAIR and takes every row of it
  //     (D4): the side tags left the address entirely, so "addresses exactly
  //     one of a pair's rows" is not a thing a caller can express or a thing
  //     the mirrors can do. The surviving behaviour — a legacy multi-row pair
  //     retracting as ONE edge through the mirror naming its materialized
  //     class — is pinned above, in "a legacy MULTI-ROW pair retracts as ONE
  //     edge".
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
    // tag-mandate: the chain is a real lane; the `grounds` under test stays
    // bare (cross-phase words never carry lane tags).
    updateTurnById(db, t1, { type: ["design"], tags: ["lane-home", "lane-a"] });
    updateTurnById(db, t2, { type: ["design"], tags: ["lane-home", "lane-a"] });
    updateTurnById(db, t3, { type: ["implement"] });
    const job = claimWindow(sessionDbId, 1, 3);
    const context = baseContext(job, { reviewableTurnIds: new Set([t2, t3]) });

    const chain = write(
      context,
      { turn: `S${sessionDbId}/T2`, use: [{ turn: `S${sessionDbId}/T1`, tags: ["lane-a"] }] },
      NOW,
    );
    expect(resultText(chain)).toContain("1 relation");

    const result = write(
      context,
      { turn: `S${sessionDbId}/T3`, use: [`S${sessionDbId}/T1`] },
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

    write(context, { turn: `S${sessionDbId}/T2`, correct: [correctEntry(`S${sessionDbId}/T1`, "full")] }, NOW);

    const result = write(
      context,
      { turn: `S${sessionDbId}/T3`, use: [`S${sessionDbId}/T1`] },
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
    const input = { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] };

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
      { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
      NOW,
    );

    const refused = write(
      baseContext(job),
      { turn: `S${sessionDbId}/T2`, retractUse: [`S${sessionDbId}/T1`] },
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
      { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
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
      { turn: `S${sessionDbId}/T2`, use: [`S${sessionDbId}/T1`] },
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
      { tags: ["lane-home", "auth"] },
      { verify: ["S1/T1"] },
      { use: ["S1/T1"] },
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
    const writerA = claimWriterId(job.id, job.claimGeneration, job.stage);
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
      claimWriterId(job.id, job.claimGeneration + 1, job.stage),
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

// ---------------------------------------------------------------------------
// write-gate-hardening ticket 01: the tool-call-syntax rejection on THIS
// surface. Settlement writes through the same field-mode engine the main agent
// does, so it inherits the shape echo for free — what needed wiring is the
// consecutive-rejection counter, which is keyed on the address this facade
// resolves for itself (`ref`), not on anything the guard can see.
//
// Markup fixtures are assembled from fragments, never written whole: a literal
// antml-prefixed closing tag in a source file is read as the end of a tool
// call by the harness writing the file, and a complete call in a test file is
// one more exemplar for whatever reads this repo next.
// ---------------------------------------------------------------------------

const SYNTAX_LT = "<";
const syntaxOpen = (name: string): string => `${SYNTAX_LT}parameter name="${name}">`;
const syntaxFieldNamedClosing = (name: string): string => `${SYNTAX_LT}/${name}>`;
const SYNTAX_GLUED_CONTENT =
  `What this turn settled.${syntaxFieldNamedClosing("content")}\n` +
  `${syntaxOpen("insight")}A reusable lesson.`;

describe("tool-call-syntax rejection: shape echo and loop naming (write-gate-hardening 01)", () => {
  beforeEach(() => {
    resetToolCallSyntaxRejectionsForTests();
  });

  test("the first rejection echoes the shape in prose; the second for the same turn names the loop", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const call = (): SettlementTurnWriteEvaluation =>
      write(
        context,
        {
          turn: `S${sessionDbId}/T1`,
          title: "settlement: a title",
          content: SYNTAX_GLUED_CONTENT,
        },
        NOW,
      );

    const first = call();
    expect(first.ok).toBe(false);
    const firstMessage = first.ok ? "" : first.message;
    expect(firstMessage).toContain("content");
    expect(firstMessage).toContain("insight");
    expect(firstMessage).toContain("literal text");
    expect(firstMessage).not.toContain(SYNTAX_LT);
    expect(firstMessage).not.toContain("in a row");
    expect(getShadowNote(db, t1)).toBeNull();

    const second = call();
    const secondMessage = second.ok ? "" : second.message;
    expect(secondMessage).toContain("rejection 2 in a row");
    expect(secondMessage).toContain(`S${sessionDbId}/T1`);
    expect(secondMessage.toLowerCase()).toContain("settlement");
  });

  test("a landed write ends the run for that turn", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const reject = (): SettlementTurnWriteEvaluation =>
      write(
        context,
        {
          turn: `S${sessionDbId}/T1`,
          title: "settlement: a title",
          content: SYNTAX_GLUED_CONTENT,
        },
        NOW,
      );

    reject();
    reject();
    const landed = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        title: "settlement: a well-formed title",
        content: "Well-formed conclusions.",
      },
      NOW,
    );
    expect(landed.ok).toBe(true);

    const after = reject();
    expect(after.ok).toBe(false);
    expect(after.ok ? "" : after.message).not.toContain("in a row");
  });

  test("a different turn address does not inherit the run", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });
    const reject = (promptNumber: number): SettlementTurnWriteEvaluation =>
      write(
        context,
        {
          turn: `S${sessionDbId}/T${promptNumber}`,
          title: "settlement: a title",
          content: SYNTAX_GLUED_CONTENT,
        },
        NOW,
      );

    reject(1);
    reject(1);
    const other = reject(2);
    expect(other.ok ? "" : other.message).not.toContain("in a row");
  });
});

// ---------------------------------------------------------------------------
// Phase-connectivity ticket 01 — the compound-retype audit trigger
// ---------------------------------------------------------------------------

describe("phase-connectivity ticket 01 — a compound retype requires typeReason and is audited", () => {
  test("adding a basis word to a landing-only turn WITHOUT typeReason yields, naming the requirement", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    db.query<unknown, [number]>(`UPDATE turns SET type = '["fix"]' WHERE id = ?`).run(t1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["fix", "measure"], mode: { type: "write" } },
      NOW,
    );
    expect(resultText(result)).toContain("typeReason");
    // The field YIELDED — the type column is untouched and no audit exists.
    expect(getTurnById(db, t1)!.type).toEqual(["fix"]);
    expect(loadPhaseRetypeAuditsForTurn(db, t1)).toEqual([]);
  });

  test("the SAME retype WITH typeReason lands and writes the persistent audit record", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    db.query<unknown, [number]>(`UPDATE turns SET type = '["fix"]' WHERE id = ?`).run(t1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        type: ["fix", "measure"],
        mode: { type: "write" },
        typeReason: "a benchmark run in this turn genuinely measured the fix's effect",
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(getTurnById(db, t1)!.type).toEqual(["fix", "measure"]);

    const audits = loadPhaseRetypeAuditsForTurn(db, t1);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.oldTypes).toEqual(["fix"]);
    expect(audits[0]!.newTypes).toEqual(["fix", "measure"]);
    expect(audits[0]!.basisWord).toBe("measure");
    expect(audits[0]!.reason).toBe(
      "a benchmark run in this turn genuinely measured the fix's effect",
    );
    expect(audits[0]!.jobId).toBe(job.id);
  });

  test("a whitespace-only typeReason is treated as absent — still yields", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    db.query<unknown, [number]>(`UPDATE turns SET type = '["fix"]' WHERE id = ?`).run(t1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        type: ["fix", "measure"],
        mode: { type: "write" },
        typeReason: "   ",
      },
      NOW,
    );
    expect(resultText(result)).toContain("typeReason");
    expect(loadPhaseRetypeAuditsForTurn(db, t1)).toEqual([]);
  });

  test("a landing-to-landing retype (no basis word added) needs no typeReason and writes no audit", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    db.query<unknown, [number]>(`UPDATE turns SET type = '["fix"]' WHERE id = ?`).run(t1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["fix", "refactor"], mode: { type: "write" } },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(getTurnById(db, t1)!.type).toEqual(["fix", "refactor"]);
    expect(loadPhaseRetypeAuditsForTurn(db, t1)).toEqual([]);
  });

  test("a turn that was ALREADY compound reasserting its type needs no typeReason (not a NEW retype)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    db.query<unknown, [number]>(`UPDATE turns SET type = '["fix","design"]' WHERE id = ?`).run(t1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["fix", "design"], mode: { type: "write" } },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(loadPhaseRetypeAuditsForTurn(db, t1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// STAGED SETTLEMENT (spec Rev 5, §Identity and authorization + §Stage-1 final
// projection) — ticket 05.
// ---------------------------------------------------------------------------

describe("staged settlement — the grant principal is (job, generation), not the full stage-keyed string (ticket 05)", () => {
  /**
   * ACCEPTANCE 1, UPDATED BY TICKET 05 (settlement-execution-repair, spec
   * Rev 5 "Two-layer identity" clause (b)). This describe block used to pin
   * the OPPOSITE of what it pins now: "stage 2 authorizes every write with
   * its OWN reads", i.e. a stage-1 grant never counted for stage 2. Ticket 04
   * made same-generation two-context impossible (cold resume is always a NEW
   * generation), which is what makes it SAFE to widen the grant principal
   * from the full `claim:<job>:<gen>:<stage>` string to the pair
   * `(job, generation)` — one run, one set of eyes, across the transition.
   * The write-gate freshness comparison itself is untouched (see the second
   * test below): a grant still has to be at least as fresh as the field's
   * last write, from EITHER stage-keyed sibling.
   *
   * The subject is `type`, and the setup is the one case where a grant is
   * actually load-bearing — a whole-field `write` over a value ANOTHER writer
   * put there. `checkFieldGate` admits a never-written field (rule 3) and a
   * self-owned one (rule 2) with no grant at all, so a test without a foreign
   * stamp and a non-empty prior value would pass no matter how the identity
   * were keyed and would prove nothing.
   */
  test("a grant earned by stage 1, still the freshest fact about the field, authorizes a stage-2 write with no re-read", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const ref = `S${sessionDbId}/T1`;

    // Another writer owns `type`, so the gate genuinely has to consult a grant
    // rather than admitting under rule 2 or rule 3.
    updateTurnById(db, t1, { type: ["fix"] }, NOW - 10);
    stampField(db, "turn", t1, "type", sessionWriterId(999), NOW - 10);

    const stage1 = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    expect(stage1.stage).toBe("topics");
    const grant = (context: SettlementTurnFacadeContext): void => {
      const writer = claimWriterId(context.jobId, context.claimGeneration, context.stage);
      const sequence = snapshotWriteGateSequence(db);
      recordReadGrant(db, writer, "turn", t1, NOW, sequence);
      recordFieldCompleteness(
        db,
        writer,
        [{ entityType: "turn", entityId: t1, field: "type", complete: true }],
        NOW,
        sequence,
      );
    };

    // Stage 1 reads `type` LAST — nothing writes it again after this grant,
    // so it stays the freshest fact about the field into stage 2. (A grant
    // that predates stage 1's OWN later write is a DIFFERENT case — the
    // freshness pin right below this test.)
    grant(stage1);

    // The transition. The claim generation deliberately does NOT move, so
    // nothing but the stage tells the two contexts apart — which is exactly
    // why the identity has to carry it.
    const transitioned = transitionNoteSettlementJobToEdges(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );
    expect(transitioned).not.toBeNull();
    expect(transitioned!.stage).toBe("edges");
    expect(transitioned!.claimGeneration).toBe(job.claimGeneration);

    // Stage 2 writes `type` WITHOUT calling `grant(stage2)` first — the whole
    // point of ticket 05: this is the SAME generation's own eyes.
    const stage2 = baseContext(transitioned!, { reviewableTurnIds: new Set([t1]) });
    const carried = write(
      stage2,
      { turn: ref, type: ["fix"], mode: { type: "write" } },
      NOW + 1,
    );
    expect(carried.ok).toBe(true);
    expect(carried.ok && carried.outcome.review?.type?.landed).toBe(true);
    expect(getTurnById(db, t1)!.type).toEqual(["fix"]);
  });

  /**
   * FRESHNESS STAYS UNTOUCHED under the widened principal (ticket 05
   * acceptance: "a same-generation grant over a field changed since is still
   * stale"). Here stage 1 reads `type`, THEN writes it itself — the write-gate
   * rejects the resulting stage-2 write as STALE (the field moved since the
   * grant), not as licensed by carry and not as "never read": the widened
   * lookup finds stage 1's grant, compares it against the field's actual last
   * write exactly as it would for any single writer, and the comparison still
   * loses because stage 1's OWN later write outran its OWN earlier read.
   */
  test("a stage-1 grant that predates stage 1's OWN later write on the same field is stale under stage 2 too", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const ref = `S${sessionDbId}/T1`;

    updateTurnById(db, t1, { type: ["fix"] }, NOW - 10);
    stampField(db, "turn", t1, "type", sessionWriterId(999), NOW - 10);

    const stage1 = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const grant = (context: SettlementTurnFacadeContext): void => {
      const writer = claimWriterId(context.jobId, context.claimGeneration, context.stage);
      const sequence = snapshotWriteGateSequence(db);
      recordReadGrant(db, writer, "turn", t1, NOW, sequence);
      recordFieldCompleteness(
        db,
        writer,
        [{ entityType: "turn", entityId: t1, field: "type", complete: true }],
        NOW,
        sequence,
      );
    };

    grant(stage1);
    const underStage1 = write(
      stage1,
      { turn: ref, type: ["refactor"], mode: { type: "write" } },
      NOW,
    );
    expect(underStage1.ok).toBe(true);
    expect(underStage1.ok && underStage1.outcome.review?.type?.landed).toBe(true);
    expect(getTurnById(db, t1)!.type).toEqual(["refactor"]);

    const transitioned = transitionNoteSettlementJobToEdges(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );
    expect(transitioned).not.toBeNull();

    const stage2 = baseContext(transitioned!, { reviewableTurnIds: new Set([t1]) });
    const stale = write(
      stage2,
      { turn: ref, type: ["fix"], mode: { type: "write" } },
      NOW + 1,
    );
    expect(stale.ok).toBe(true);
    expect(stale.ok && stale.outcome.review?.type?.landed).toBe(false);
    expect(stale.ok && stale.outcome.review?.type?.yieldedReason).toContain(
      "was changed by",
    );
    expect(getTurnById(db, t1)!.type).toEqual(["refactor"]);

    // Stage 2 does its own reading; the same call now lands.
    grant(stage2);
    const earned = write(
      stage2,
      { turn: ref, type: ["fix"], mode: { type: "write" } },
      NOW + 2,
    );
    expect(earned.ok).toBe(true);
    expect(earned.ok && earned.outcome.review?.type?.landed).toBe(true);
    expect(getTurnById(db, t1)!.type).toEqual(["fix"]);
  });

  /**
   * NON-INHERITANCE: a RECLAIMED job's new generation inherits nothing from
   * its predecessor generation, even though the field it wants is otherwise
   * identical to the carry test above. Same fixture shape as the first test
   * in this block, except the stage-2 context's `claimGeneration` is bumped
   * past the generation stage 1's grant was recorded under.
   */
  test("a grant recorded under an EARLIER generation of the same job is invisible to a later generation's stage-2 write", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const ref = `S${sessionDbId}/T1`;

    updateTurnById(db, t1, { type: ["fix"] }, NOW - 10);
    stampField(db, "turn", t1, "type", sessionWriterId(999), NOW - 10);

    const stage1 = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const writer = claimWriterId(stage1.jobId, stage1.claimGeneration, stage1.stage);
    const sequence = snapshotWriteGateSequence(db);
    recordReadGrant(db, writer, "turn", t1, NOW, sequence);
    recordFieldCompleteness(
      db,
      writer,
      [{ entityType: "turn", entityId: t1, field: "type", complete: true }],
      NOW,
      sequence,
    );

    const transitioned = transitionNoteSettlementJobToEdges(
      db,
      job.id,
      job.claimGeneration,
      NOW,
    );
    expect(transitioned).not.toBeNull();

    // A reclaim: the generation rises past the one the grant above was
    // recorded under, exactly as ticket 04's scheduler bumps it on retry.
    const reclaimed: NoteSettlementJob = {
      ...transitioned!,
      claimGeneration: transitioned!.claimGeneration + 1,
    };
    const stage2 = baseContext(reclaimed, { reviewableTurnIds: new Set([t1]) });
    const refused = write(
      stage2,
      { turn: ref, type: ["fix"], mode: { type: "write" } },
      NOW + 1,
    );
    expect(refused.ok).toBe(true);
    expect(refused.ok && refused.outcome.review?.type?.landed).toBe(false);
    expect(refused.ok && refused.outcome.review?.type?.yieldedReason).toContain(
      "has not been read this session",
    );
    expect(getTurnById(db, t1)!.type).toEqual(["fix"]);
  });
});

describe("staged settlement — relation-only authority on a removed-side citer", () => {
  const removedSideOnly = (turnId: number) =>
    new Map([[turnId, new Set(["removed-side-citer" as const])]]);

  /** ACCEPTANCE 5: a removed-side citer's note-field write is refused. */
  test("every note field is refused on a turn whose only provenance is removed-side-citer", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
      writableProvenance: removedSideOnly(t1),
    });
    const ref = `S${sessionDbId}/T1`;

    for (const input of [
      { turn: ref, title: "a title" },
      { turn: ref, content: "some content" },
      { turn: ref, insight: "an insight" },
      { turn: ref, type: ["fix"], mode: { type: "write" } },
      { turn: ref, tags: [FIXTURE_SEGMENT_TAG, "lane-a"], mode: { tags: "write" } },
    ] as SettlementTurnWriteInput[]) {
      const result = write(context, input, NOW);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain("RELATIONS ONLY");
    }
    // Nothing landed: the refusal is a whole-call rejection, not a per-field yield.
    const turn = getTurnById(db, t1)!;
    expect(turn.title).toBeNull();
    expect(turn.type).toEqual([]);
  });

  test("a relation write on the same turn is NOT refused by the authority check", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { tags: [FIXTURE_SEGMENT_TAG, "lane-a"] }, NOW - 10);
    updateTurnById(db, t2, { tags: [FIXTURE_SEGMENT_TAG, "lane-a"] }, NOW - 10);
    const job = claimWindow(sessionDbId, 1, 2);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1, t2]),
      writableProvenance: removedSideOnly(t1),
    });

    const result = write(
      context,
      {
        turn: `S${sessionDbId}/T1`,
        use: [
          { turn: `S${sessionDbId}/T2`, tailTag: "lane-a", headTag: "lane-a" },
        ],
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toHaveLength(1);
  });

  /**
   * REVIEWER GUARDRAIL 1 (spec §Further Notes): the provenance model is a
   * permission UNION, never the old mutually-exclusive three-way. A turn that
   * is BOTH an ordinary window member and a removed-side citer keeps full
   * field authority.
   */
  test("window + removed-side provenance takes the UNION and keeps field authority", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
      writableProvenance: new Map([
        [t1, new Set(["window" as const, "removed-side-citer" as const])],
      ]),
    });

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["fix"], mode: { type: "write" } },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(getTurnById(db, t1)!.type).toEqual(["fix"]);
  });

  test("no provenance snapshot at all means full authority — the pre-staging behaviour", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    expect(context.writableProvenance).toBeUndefined();

    const result = write(
      context,
      { turn: `S${sessionDbId}/T1`, type: ["fix"], mode: { type: "write" } },
      NOW,
    );
    expect(result.ok).toBe(true);
  });
});
