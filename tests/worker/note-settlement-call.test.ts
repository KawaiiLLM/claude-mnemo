import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession, getSession } from "../../src/db/sessions";
import { upsertShadowNote, getShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  createSegment,
  getSegment,
  getSegmentMemberTurnIds,
  listOpenSegments,
  listTopics,
} from "../../src/db/segments";
import {
  countMemoryEdges,
  getOutgoingEdges,
  writeMemoryEdges,
} from "../../src/db/memory-edges";
import {
  buildNoteSettlementContext,
  NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET,
} from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import { parseNoteSettlementResponse } from "../../src/worker/note-settlement-response";
import {
  createNoteSettlementDispatch,
  NOTE_SETTLEMENT_METRICS_PREFIX,
  type NoteSettlementQuery,
  type NoteSettlementWindowMetrics,
} from "../../src/worker/note-settlement-dispatch";
import { createNoteSettlementScheduler } from "../../src/worker/note-settlement";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from "../support/settlement-config";

/**
 * Ticket 07 — the settlement call itself, tested at the worker seam: a fake
 * window in a real database, a STUBBED model reply, and assertions on the rows
 * that land. No network, no subprocess: the query seam is the injection point
 * precisely so the judgement quality (which is offline-eval territory) never
 * enters a unit test, while the transactional behaviour fully does.
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

function seedSession(contentSessionId = "session-a"): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-settlement-call",
    title: "settlement fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

interface SeedTurnOptions {
  note?: { title: string; content: string } | null;
  userPrompt?: string;
  assistantResponse?: string;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  options: SeedTurnOptions = {},
): number {
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
      options.userPrompt ?? `prompt ${promptNumber}`,
      options.assistantResponse ?? `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;

  if (options.note) {
    upsertShadowNote(db, {
      turnId,
      title: options.note.title,
      content: options.note.content,
      nowEpoch: NOW - 900,
    });
  }

  return turnId;
}

function seedDebt(
  turnId: number,
  sessionDbId: number,
  promptNumber: number,
  status: "noted" | "skipped" | "pending",
  reason: string | null,
): void {
  db.query<unknown, [number, number, number, string, string | null, number, number]>(
    `INSERT INTO note_debt (
       turn_id, session_id, prompt_number, status, reason,
       opened_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(turnId, sessionDbId, promptNumber, status, reason, NOW - 950, NOW - 950);
}

function classifyThrough(sessionDbId: number, promptNumber: number): void {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO note_debt_cursor (
       session_id, last_classified_prompt_number, updated_at_epoch
     ) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_classified_prompt_number = excluded.last_classified_prompt_number,
       updated_at_epoch = excluded.updated_at_epoch`,
  ).run(sessionDbId, promptNumber, NOW);
}

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [
      {
        sessionId: sessionDbId,
        windowStart,
        windowEnd,
        triggerType: "consecutive",
      },
    ],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

interface Fixture {
  sessionDbId: number;
  turnIds: number[];
  job: NoteSettlementJob;
}

/**
 * Four turns: two noted, and two written off by residual settlement (reason
 * `closed`) with no note of their own — T2 has a later noted turn (T3), T4
 * does not. Ticket 05 deletes the old interior/trailing distinction: BOTH are
 * now plain holes the payload mechanically backfills, position irrelevant.
 */
function seedInteriorHoleWindow(): Fixture {
  const sessionDbId = seedSession();
  // The stubbed replies below cite `S1/...` literally, which is only the right
  // address if this fixture owns database id 1.
  if (sessionDbId !== 1) {
    throw new Error(`fixture expected session id 1, got ${sessionDbId}`);
  }
  const t1 = seedTurn(sessionDbId, 1, {
    note: { title: "design+settlement: window shape", content: "Chose windows." },
  });
  seedDebt(t1, sessionDbId, 1, "noted", null);
  const t2 = seedTurn(sessionDbId, 2, {
    userPrompt: "INTERIOR HOLE PROMPT about the lease",
    assistantResponse: "INTERIOR HOLE RESPONSE about the lease",
  });
  seedDebt(t2, sessionDbId, 2, "skipped", "closed");
  const t3 = seedTurn(sessionDbId, 3, {
    note: { title: "implement+settlement: lease fence", content: "Fenced it." },
  });
  seedDebt(t3, sessionDbId, 3, "noted", null);
  const t4 = seedTurn(sessionDbId, 4, {
    userPrompt: "TRAILING HOLE PROMPT never followed up",
    assistantResponse: "TRAILING HOLE RESPONSE never followed up",
  });
  seedDebt(t4, sessionDbId, 4, "skipped", "closed");
  classifyThrough(sessionDbId, 4);

  return { sessionDbId, turnIds: [t1, t2, t3, t4], job: claimWindow(sessionDbId, 1, 4) };
}

function stubQuery(...replies: string[]): NoteSettlementQuery & { calls: number } {
  let index = 0;
  const query = (async () => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? "{}";
    index += 1;
    query.calls = index;
    return reply;
  }) as NoteSettlementQuery & { calls: number };
  query.calls = 0;
  return query;
}

function dispatchWith(
  runQuery: NoteSettlementQuery,
  metrics?: (value: NoteSettlementWindowMetrics) => void,
) {
  return createNoteSettlementDispatch({
    db,
    config: SETTLEMENT_ENABLED_CONFIG,
    now: () => NOW,
    runQuery,
    metrics,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
}

describe("settlement context assembly", () => {
  test("injects raw material for every hole regardless of what follows it (spec D7, ticket 05)", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;

    const kinds = Object.fromEntries(
      context.windowTurns.map((turn) => [turn.promptNumber, turn.kind]),
    );
    expect(kinds).toEqual({
      1: "noted",
      2: "hole",
      3: "noted",
      4: "hole",
    });
    // Both holes, position irrelevant — the old interior/trailing split (and
    // its "trailing gets nothing" refusal) is gone.
    expect(context.interiorHoles.map((turn) => turn.promptNumber)).toEqual([
      2, 4,
    ]);

    expect(
      context.windowTurns.map((turn) => turn.rawMaterial !== null),
    ).toEqual([false, true, false, true]);

    // Assert on the window section rather than the whole prompt: the arc
    // rendering above it is the production timeline view, which quotes prompt
    // prefixes of its own selection — that is a different surface with its own
    // rules, and this criterion is about the window's material budget.
    const prompt = renderNoteSettlementPrompt(context);
    const window = prompt.slice(prompt.indexOf("## Window turns"));
    expect(window).toContain("raw> user: INTERIOR HOLE PROMPT");
    expect(window).toContain("raw> assistant: INTERIOR HOLE RESPONSE");
    expect(window).toContain("raw> user: TRAILING HOLE PROMPT");
    expect(window).toContain("raw> assistant: TRAILING HOLE RESPONSE");
    // The window's notes are the material for turns that have one.
    expect(window).toContain("implement+settlement: lease fence");
  });

  test("caps hole material at the per-turn token budget", () => {
    const sessionDbId = seedSession();
    const long = "lease".repeat(4_000);
    const t1 = seedTurn(sessionDbId, 1, {
      userPrompt: long,
      assistantResponse: long,
    });
    seedDebt(t1, sessionDbId, 1, "skipped", "closed");
    const t2 = seedTurn(sessionDbId, 2, {
      note: { title: "fix+lease: done", content: "Done." },
    });
    seedDebt(t2, sessionDbId, 2, "noted", null);
    classifyThrough(sessionDbId, 2);

    const job = claimWindow(sessionDbId, 1, 2);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const hole = context.interiorHoles[0]!;
    expect(hole.rawMaterial).not.toBeNull();
    // 0.6 weight per Latin code point × 1.2 → ~2 code points per token.
    expect(hole.rawMaterial!.length).toBeLessThan(
      NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET * 3,
    );
    expect(hole.rawMaterial).toContain("lease");
  });

  /**
   * ticket 02 (spec B1): the mechanical title-to-type derivation is retired,
   * not kept as a fallback — a window turn's line carries only mechanical
   * facts (kind, tool count, files, gap), never a drafted type/tag, and the
   * model states type/tags itself through `turn_review`.
   */
  test("the window's rendered line carries no drafted type or tag", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;

    const t1 = context.windowTurns.find((turn) => turn.promptNumber === 1)!;
    expect(t1).not.toHaveProperty("typeDraft");
    expect(t1).not.toHaveProperty("tagDraft");

    const prompt = renderNoteSettlementPrompt(context);
    const window = prompt.slice(prompt.indexOf("## Window turns"));
    expect(window).not.toContain("type_draft=");
    expect(window).not.toContain("tag_draft=");
  });

  test("the prompt states the rubric verbatim (imported, not restated) and the three-step order with segmentation last", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;
    const prompt = renderNoteSettlementPrompt(context);

    // The rubric's own words, not a paraphrase — a snippet unique enough
    // that only the imported constant, never a rewrite, would produce it.
    expect(prompt).toContain(
      "Grade 4 — task origin or re-foundation",
    );
    expect(prompt).toContain("Misleading-turn downgrade");

    // The three duties appear in this order, and duty 1 is the turn review
    // while segmentation (duty 3, "SEGMENT ATTACHMENT") comes after both duty
    // 1 (review) and duty 2 (reconstruction).
    const reviewIndex = prompt.indexOf("1. TURN REVIEW");
    const reconstructionIndex = prompt.indexOf("RECONSTRUCTION.");
    const segmentIndex = prompt.indexOf("SEGMENT ATTACHMENT");
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(reconstructionIndex).toBeGreaterThan(reviewIndex);
    expect(segmentIndex).toBeGreaterThan(reconstructionIndex);
    expect(prompt).toContain("segmentation is LAST because it");
    expect(prompt).toContain("turn_review");
  });

  // Requirement 7 (ticket 07, spec C3/C4): the four ordered questions,
  // first-yes-wins, and specifically question 3's exact counterfactual
  // wording must reach the prompt verbatim — the note tool description
  // cannot carry it (487/500 tokens, 13 of headroom; see mcp/definitions.ts),
  // so this is the ONE place the decision procedure is stated in full.
  test("C3/C4's decision procedure reaches the prompt verbatim (spec C3/C4)", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;
    const prompt = renderNoteSettlementPrompt(context);

    expect(prompt.toLowerCase()).toContain("first yes wins");
    expect(prompt).toContain("(1) Did the citing turn overturn it? -> supersedes.");
    expect(prompt).toContain(
      "(2) Did the citing turn test its claim, supporting or undermining it?",
    );
    // Question 3's wording, verbatim and on ONE line — C4 makes this
    // normative and forbids softening it to "used" or "built on".
    expect(prompt).toContain(
      "If the cited turn were wrong, would the citing turn's conclusion also be wrong? -> depends-on.",
    );
    expect(prompt).toContain("(4) None of the above -> no relation");
    expect(prompt).toContain('"used"');
    expect(prompt).toContain('"built on"');
    // The pre-state eligibility rule (spec C7) is also stated, so the model
    // is told the constraint rather than only discovering it by rejection.
    expect(prompt).toContain("already existed before this");
    expect(prompt).toContain("you may not invent a relation for a pair a segment");
  });
});

describe("settlement write-back", () => {
  test("lands segments, members, edges, type/tag, summary and holes in one pass", async () => {
    const fixture = seedInteriorHoleWindow();
    const existing = createSegment(db, {
      title: "implement+lease: fencing the claim",
      content: "Earlier chapter.",
      type: ["implement"],
      tags: ["note-settlement"],
      nowEpoch: NOW - 5_000,
    });

    // Ticket 07 (spec C7): a judged relation is legal only on a pair present
    // BEFORE this window's write-back transaction — seed the T3->T1 pair
    // here (a prior bare citation, in production) so the `depends-on` edge
    // in the reply below is attaching to an existing pair, not minting one.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: fixture.turnIds[2]! },
          cited: { kind: "turn", id: fixture.turnIds[0]! },
          relation: null,
          provenance: "text-ref",
        },
      ],
      NOW - 4_000,
      { eligibleForRelation: "unrestricted" },
    );

    const reply = JSON.stringify({
      segments: [
        {
          action: "extend",
          segment_id: existing.id,
          expected_revision: existing.revision,
          title: "implement+lease: fencing the claim",
          content:
            "Lease fencing landed. The generation check in [S1/T3] is what " +
            "makes a late dispatch harmless; the shape came from [S1/T1].",
          type: ["implement", "correction"],
          tags: ["note-settlement", "lease"],
          status: "open",
          members: ["S1/T1", "S1/T3"],
        },
        {
          action: "create",
          topic: "hole reconstruction",
          topic_aliases: ["interior holes"],
          no_candidate_reason:
            "No open segment and no registered topic covers hole reconstruction.",
          title: "design+holes: reconstructing written-off turns",
          content: "Every gap in this window gets a note now. [S1/T2]",
          type: ["design"],
          tags: ["hole reconstruction"],
          status: "open",
          members: ["S1/T2"],
        },
      ],
      edges: [
        { citing: "S1/T3", cited: "S1/T1", relation: "depends-on" },
        // Ticket 07 (spec C7): the T1->T3 direction has never been paired —
        // no anchor, no bare mention, nothing — before this window runs.
        // Settlement naming it is minting a free-standing relation-only
        // edge, which the pre-state gate must drop even though both
        // endpoints are real turns this writer was shown.
        { citing: "S1/T1", cited: "S1/T3", relation: "evidence-for" },
        { citing: `E${existing.id}`, cited: "S1/T9999", relation: "supersedes" },
      ],
      reconstructed_notes: [
        {
          turn: "S1/T2",
          title: "research+lease: what the hole covered",
          content: "Reconstructed from the raw material.",
          insight: "",
        },
        {
          turn: "S1/T4",
          title: "research+lease: what the trailing gap covered",
          content: "The old refusal is gone (spec D7, ticket 05): position no",
        },
        {
          // T1 already has an agent note — reconstruction is refused for any
          // turn that is not a `hole` of this window, noted or otherwise.
          turn: "S1/T1",
          title: "should be refused",
          content: "T1 is already noted, not a hole.",
        },
      ],
      session_summary: {
        title: "settlement fixture",
        content: "Settled one window.",
        decision: "Every gap gets reconstructed.",
        done: "window 1-4",
        current: "waiting for the next window",
        next_steps: "settle 5-8",
        reference: "",
      },
    });

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(stubQuery(reply), (value) =>
      metricsSeen.push(value),
    )({ job: fixture.job });
    expect(outcome).toEqual({ ok: true });

    // Segments: one extended (multi-valued type, spec B5), one created
    // against a freshly minted topic.
    const extended = getSegment(db, existing.id)!;
    expect(extended.revision).toBe(existing.revision + 1);
    expect(extended.type).toEqual(["implement", "correction"]);
    expect(extended.tags).toEqual(["note-settlement", "lease"]);
    const created = listOpenSegments(db).find(
      (segment) => segment.id !== existing.id,
    )!;
    expect(created.title).toContain("reconstructing written-off turns");
    expect(listTopics(db, "active").map((topic) => topic.name)).toEqual([
      "hole reconstruction",
    ]);

    // Membership.
    expect(getSegmentMemberTurnIds(db, existing.id)).toEqual([
      fixture.turnIds[0]!,
      fixture.turnIds[2]!,
    ]);
    expect(getSegmentMemberTurnIds(db, created.id)).toEqual([
      fixture.turnIds[1]!,
    ]);

    // Anchors parsed out of the bodies, plus the judged edge. The edge naming a
    // turn that does not exist (S1/T9999) is dropped, never stored.
    const anchors = getOutgoingEdges(db, { kind: "segment", id: existing.id });
    expect(anchors.map((edge) => edge.cited.id).sort()).toEqual(
      [fixture.turnIds[0]!, fixture.turnIds[2]!].sort(),
    );
    expect(anchors.every((edge) => edge.provenance === "text-ref")).toBe(true);
    const judged = getOutgoingEdges(db, {
      kind: "turn",
      id: fixture.turnIds[2]!,
    });
    expect(judged).toHaveLength(1);
    expect(judged[0]!.provenance).toBe("judged");
    expect(judged[0]!.relation).toBe("depends-on");
    // The ineligible T1->T3 edge never landed (ticket 07, spec C7): T1's own
    // outgoing set stays empty, and it carries no segment-membership anchor
    // either (anchors are segment->turn, never turn->turn).
    expect(getOutgoingEdges(db, { kind: "turn", id: fixture.turnIds[0]! })).toEqual([]);

    // BOTH holes reconstructed with settlement provenance now (spec D7, ticket
    // 05 — the old interior/trailing split, and the trailing refusal, are gone).
    const holeNote = getShadowNote(db, fixture.turnIds[1]!)!;
    expect(holeNote.writerOrigin).toBe("settlement");
    expect(holeNote.title).toContain("what the hole covered");
    const trailingNote = getShadowNote(db, fixture.turnIds[3]!)!;
    expect(trailingNote.writerOrigin).toBe("settlement");
    expect(trailingNote.title).toContain("what the trailing gap covered");
    // The agent's own notes keep their origin — and reconstruction is refused
    // for a turn that is not a `hole` of this window, T1 included.
    expect(getShadowNote(db, fixture.turnIds[0]!)!.writerOrigin).toBe("agent");
    expect(getShadowNote(db, fixture.turnIds[0]!)!.title).not.toContain(
      "should be refused",
    );

    // Session summary and job/cursor resolution.
    const session = getSession(db, fixture.sessionDbId)!;
    expect(session.current).toBe("waiting for the next window");
    expect(session.decision).toBe("Every gap gets reconstructed.");
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(4);

    // Minting-rate counter reaches monitoring.
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.topicsMinted).toBe(1);
    expect(metricsSeen[0]!.topicsReused).toBe(0);
    expect(metricsSeen[0]!.segmentsCreated).toBe(1);
    expect(metricsSeen[0]!.segmentsExtended).toBe(1);
    expect(metricsSeen[0]!.notesReconstructed).toBe(2);
    expect(metricsSeen[0]!.notesYielded).toBe(0);
    expect(metricsSeen[0]!.notesRejected).toBe(1);
    expect(metricsSeen[0]!.rejectedReferences).toBeGreaterThan(0);
  });

  test("discards the whole write-back when the job generation expired", async () => {
    const fixture = seedInteriorHoleWindow();
    const reply = JSON.stringify({
      segments: [
        {
          action: "create",
          topic: "late window",
          no_candidate_reason: "nothing open",
          title: "implement+late: should not land",
          content: "Never committed. [S1/T1]",
          type: ["implement"],
          tags: ["late window"],
          members: ["S1/T1"],
        },
      ],
      session_summary: {
        title: "should not land",
        content: "",
        decision: "",
        done: "",
        current: "should not land",
        next_steps: "",
        reference: "",
      },
    });

    // Another worker reclaimed the window while this dispatch was thinking.
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(fixture.job.id);

    const outcome = await dispatchWith(stubQuery(reply))({ job: fixture.job });
    expect(outcome.ok).toBe(false);
    expect(listOpenSegments(db)).toHaveLength(0);
    expect(listTopics(db)).toHaveLength(0);
    expect(countMemoryEdges(db)).toBe(0);
    expect(getSession(db, fixture.sessionDbId)!.current).toBeNull();
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(0);
  });

  /**
   * Spec D7 (ticket 05), the race a mechanical backfill must lose on purpose:
   * the main agent can write a hole's real note WHILE the model call is in
   * flight — after `buildNoteSettlementContext` already classified the turn
   * as a hole, before this write-back ever runs. The agent's own account of
   * its turn wins, `writer_origin` stays `agent`, and the yield is counted
   * separately from a genuine rejection.
   */
  test("a mid-flight agent note wins over settlement's own reconstruction of the same turn", async () => {
    const fixture = seedInteriorHoleWindow();
    const reply = JSON.stringify({
      segments: [],
      reconstructed_notes: [
        {
          turn: "S1/T2",
          title: "settlement's reconstruction",
          content: "Written from the raw material.",
        },
        // The fixture's OTHER hole (T4) — covered here so the write-back's
        // gap-coverage guard (P1-2) sees this window fully backfilled; this
        // test's own subject is the T2 race, not gap coverage.
        {
          turn: "S1/T4",
          title: "settlement's reconstruction of the trailing hole",
          content: "Written from the raw material.",
        },
      ],
    });
    const racingQuery: NoteSettlementQuery = async () => {
      upsertShadowNote(db, {
        turnId: fixture.turnIds[1]!,
        title: "agent+lease: the turn's own account",
        content: "Written by the agent while settlement was thinking.",
        nowEpoch: NOW,
      });
      return reply;
    };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(racingQuery, (value) =>
      metricsSeen.push(value),
    )({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    const note = getShadowNote(db, fixture.turnIds[1]!)!;
    expect(note.writerOrigin).toBe("agent");
    expect(note.title).toBe("agent+lease: the turn's own account");
    // T2 yields to the agent's own note; T4 has no racing write and lands.
    expect(metricsSeen[0]!.notesReconstructed).toBe(1);
    expect(metricsSeen[0]!.notesYielded).toBe(1);
    expect(metricsSeen[0]!.notesRejected).toBe(0);
  });

  test("replays a CAS-conflicted segment without rolling back the committed writes", async () => {
    const fixture = seedInteriorHoleWindow();
    const contested = createSegment(db, {
      title: "implement+lease: contested",
      content: "Body as this settlement read it.",
      type: ["implement"],
      tags: ["lease"],
      nowEpoch: NOW - 5_000,
    });
    const staleRevision = contested.revision;
    // A concurrent settlement rewrote the open segment first.
    db.query<unknown, [number]>(
      "UPDATE segments SET revision = revision + 1, content = 'body written by the other pass' WHERE id = ?",
    ).run(contested.id);

    const mainReply = JSON.stringify({
      segments: [
        {
          action: "extend",
          segment_id: contested.id,
          expected_revision: staleRevision,
          title: "implement+lease: contested",
          content: "This body was composed against the stale revision. [S1/T1]",
          type: ["implement"],
          tags: ["lease"],
          members: ["S1/T1"],
        },
        {
          action: "create",
          topic: "committed alongside",
          no_candidate_reason: "no candidate covers this",
          title: "design+alongside: committed anyway",
          content: "Must survive the conflict. [S1/T3]",
          type: ["design"],
          tags: ["committed alongside"],
          members: ["S1/T3"],
        },
      ],
      // The fixture's two holes — covered here so the write-back's
      // gap-coverage guard (P1-2) sees this window fully backfilled; this
      // test's own subject is the CAS replay, not gap coverage.
      reconstructed_notes: [
        { turn: "S1/T2", title: "hole T2 reconstructed", content: "Filled in." },
        { turn: "S1/T4", title: "hole T4 reconstructed", content: "Filled in." },
      ],
    });
    const replayReply = JSON.stringify({
      segments: [
        {
          action: "extend",
          segment_id: contested.id,
          expected_revision: staleRevision + 1,
          title: "implement+lease: contested",
          content: "Merged body over the other pass. [S1/T3]",
          type: ["implement"],
          tags: ["lease"],
          members: ["S1/T3"],
        },
      ],
    });

    const query = stubQuery(mainReply, replayReply);
    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(query, (value) =>
      metricsSeen.push(value),
    )({ job: fixture.job });
    expect(outcome).toEqual({ ok: true });
    expect(query.calls).toBe(2);

    // The unrelated create committed and stayed committed.
    const alongside = listOpenSegments(db).find(
      (segment) => segment.id !== contested.id,
    )!;
    expect(alongside.title).toContain("committed anyway");

    // The contested segment carries the replayed body at the newer revision.
    const settled = getSegment(db, contested.id)!;
    expect(settled.content).toBe("Merged body over the other pass. [S1/T3]");
    expect(settled.revision).toBe(staleRevision + 2);
    expect(getSegmentMemberTurnIds(db, contested.id)).toEqual([
      fixture.turnIds[2]!,
    ]);
    expect(metricsSeen[0]!.casConflicts).toBe(1);
    expect(metricsSeen[0]!.casReplaysApplied).toBe(1);
  });

  /**
   * P1-2 (spec D7): the mechanical backfill's contract is coverage, not just a
   * parseable reply. `{"reconstructed_notes":[]}` parses fine — it is not
   * malformed — but the window's two genuine holes (T2, T4) still have no
   * note after it runs, and the old code committed the window as `done`
   * anyway, permanently walking the cursor past the gap.
   */
  test("an empty reconstruction batch against a real gap fails the job and writes nothing", async () => {
    const fixture = seedInteriorHoleWindow();
    const reply = JSON.stringify({ segments: [], reconstructed_notes: [] });

    const outcome = await dispatchWith(stubQuery(reply))({ job: fixture.job });

    expect(outcome.ok).toBe(false);
    // Nothing committed — not even the fact that the job was attempted.
    expect(listOpenSegments(db)).toHaveLength(0);
    expect(getShadowNote(db, fixture.turnIds[1]!)).toBeNull();
    expect(getShadowNote(db, fixture.turnIds[3]!)).toBeNull();
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(0);
  });

  /**
   * The counterpart: a batch that covers every hole EXCEPT one still fails
   * whole and rolls back the segments it also produced — half a judgement is
   * not a smaller correct one (note-settlement-response.ts's own rule).
   */
  test("a reconstruction batch that misses one of two holes fails the whole window", async () => {
    const fixture = seedInteriorHoleWindow();
    const reply = JSON.stringify({
      segments: [
        {
          action: "create",
          topic: "partial gap coverage",
          no_candidate_reason: "no open segment covers this",
          title: "design+partial: should not survive",
          content: "Committed alongside a partial reconstruction. [S1/T1]",
          type: ["design"],
          tags: ["partial gap coverage"],
          members: ["S1/T1"],
        },
      ],
      reconstructed_notes: [
        {
          turn: "S1/T2",
          title: "research+partial: only the interior hole covered",
          content: "T4 (the trailing hole) is left open on purpose.",
        },
      ],
    });

    const outcome = await dispatchWith(stubQuery(reply))({ job: fixture.job });

    expect(outcome.ok).toBe(false);
    expect(listOpenSegments(db)).toHaveLength(0);
    expect(getShadowNote(db, fixture.turnIds[1]!)).toBeNull();
    expect(getShadowNote(db, fixture.turnIds[3]!)).toBeNull();
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
  });

  test("rejects malformed output whole and writes nothing", async () => {
    const fixture = seedInteriorHoleWindow();
    const outcome = await dispatchWith(
      stubQuery("I settled the window, trust me."),
    )({ job: fixture.job });
    expect(outcome.ok).toBe(false);
    expect(listOpenSegments(db)).toHaveLength(0);
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(0);
  });

  test("reuses a registered topic instead of minting a second one", async () => {
    const fixture = seedInteriorHoleWindow();
    const reply = JSON.stringify({
      segments: [
        {
          action: "create",
          topic: "Note Settlement",
          no_candidate_reason: "the open segments cover other topics",
          title: "implement+note-settlement: window two",
          content: "Second chapter on the same topic. [S1/T1]",
          type: ["implement"],
          tags: ["note settlement"],
          members: ["S1/T1"],
        },
      ],
      // The fixture's two holes — covered here so the write-back's
      // gap-coverage guard (P1-2) sees this window fully backfilled; this
      // test's own subject is topic reuse, not gap coverage.
      reconstructed_notes: [
        { turn: "S1/T2", title: "hole T2 reconstructed", content: "Filled in." },
        { turn: "S1/T4", title: "hole T4 reconstructed", content: "Filled in." },
      ],
    });
    db.query<unknown, [number, number]>(
      `INSERT INTO topics (name, aliases, status, created_at_epoch, updated_at_epoch)
       VALUES ('note settlement', '[]', 'active', ?, ?)`,
    ).run(NOW - 9_000, NOW - 9_000);

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    await dispatchWith(stubQuery(reply), (value) => metricsSeen.push(value))({
      job: fixture.job,
    });

    expect(listTopics(db)).toHaveLength(1);
    expect(metricsSeen[0]!.topicsMinted).toBe(0);
    expect(metricsSeen[0]!.topicsReused).toBe(1);
  });

  /**
   * Spec D4/D6, ticket 05: the subagent may revise a turn from an earlier
   * window that is still in its context — not a loophole, the mechanism the
   * rubric's own Grade-4 "provisional, confirmed or demoted later" language
   * assumes. T1's Grade 4 from window one is demoted in window two, once T1
   * is a PRECEDING turn rather than a window turn.
   */
  test("turn_review revises a turn settled by an earlier window once it is only in the preceding-turns context", async () => {
    const fixture = seedInteriorHoleWindow();
    const firstReply = JSON.stringify({
      reconstructed_notes: [
        { turn: "S1/T2", title: "research+lease: hole reconstructed", content: "Filled in." },
        { turn: "S1/T4", title: "research+lease: trailing hole reconstructed", content: "Filled in." },
      ],
      turn_review: [
        { turn: "S1/T1", grade: 4, type: ["design"], tag: "settlement" },
        { turn: "S1/T2", grade: 1, type: ["research"], tag: "lease" },
        { turn: "S1/T3", grade: 2, type: ["implement"], tag: "settlement" },
        { turn: "S1/T4", grade: 1, type: ["research"], tag: "lease" },
      ],
    });
    const firstOutcome = await dispatchWith(stubQuery(firstReply))({
      job: fixture.job,
    });
    expect(firstOutcome).toEqual({ ok: true });
    expect(getTurnById(db, fixture.turnIds[0]!)!.significanceGrade).toBe(4);

    // A second window, T5-T8: T1-T4 are now PRECEDING turns in its context,
    // not window turns — buildNoteSettlementContext still exposes them (the
    // previous-50 lookback), which is what makes citing S1/T1 legal here.
    for (let promptNumber = 5; promptNumber <= 8; promptNumber += 1) {
      const turnId = seedTurn(fixture.sessionDbId, promptNumber, {
        note: {
          title: `implement+seam: turn ${promptNumber}`,
          content: "Noted.",
        },
      });
      seedDebt(turnId, fixture.sessionDbId, promptNumber, "noted", null);
    }
    classifyThrough(fixture.sessionDbId, 8);
    const secondJob = claimWindow(fixture.sessionDbId, 5, 8);

    const secondReply = JSON.stringify({
      // T1's arc turned out short-lived — demoted now that its real scale is
      // visible, exactly what the rubric's own Grade-4 language expects.
      turn_review: [{ turn: "S1/T1", grade: 0, type: ["design"], tag: "settlement" }],
    });

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const secondOutcome = await dispatchWith(
      stubQuery(secondReply),
      (value) => metricsSeen.push(value),
    )({ job: secondJob });

    expect(secondOutcome).toEqual({ ok: true });
    expect(getTurnById(db, fixture.turnIds[0]!)!.significanceGrade).toBe(0);
    expect(metricsSeen[0]!.turnsReviewed).toBe(1);
    expect(metricsSeen[0]!.gradeHistogram).toEqual([1, 0, 0, 0, 0]);
    expect(metricsSeen[0]!.gradeTargets).toBeDefined();
  });
});

describe("settlement payload at the scheduler seam", () => {
  test("a trigger drains the window through the real payload", async () => {
    const sessionDbId = seedSession();
    if (sessionDbId !== 1) {
      throw new Error("fixture expected session id 1");
    }
    for (let promptNumber = 1; promptNumber <= 4; promptNumber += 1) {
      const turnId = seedTurn(sessionDbId, promptNumber, {
        note: {
          title: `implement+seam: turn ${promptNumber}`,
          content: "Noted.",
        },
      });
      seedDebt(turnId, sessionDbId, promptNumber, "noted", null);
    }
    // A 5th, still-open turn: turn 4 alone is not yet decided (spec D10) —
    // this is what makes it so, and it stays outside window 1-4.
    seedTurn(sessionDbId, 5, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 4);

    const reply = JSON.stringify({
      segments: [
        {
          action: "create",
          topic: "scheduler seam",
          no_candidate_reason: "first window of this topic",
          title: "implement+seam: the payload plugs in unchanged",
          content: "Landed through the scheduler. [S1/T4]",
          type: ["implement"],
          tags: ["scheduler seam"],
          members: ["S1/T1", "S1/T4"],
        },
      ],
    });

    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      nowMs: () => NOW * 1000,
      consecutiveTurns: 4,
      dispatch: dispatchWith(stubQuery(reply)),
      logger: { warn: () => {}, error: () => {} },
    });

    const pass = await scheduler.onTurnStop(sessionDbId);
    expect(pass.created).toHaveLength(1);
    expect(pass.dispatched).toHaveLength(1);

    const segment = listOpenSegments(db)[0]!;
    expect(segment.title).toContain("plugs in unchanged");
    expect(getSegmentMemberTurnIds(db, segment.id)).toHaveLength(2);
    // The write-back already completed the job and moved the cursor inside its
    // own transaction; the scheduler's completion re-asserts the same facts.
    expect(getNoteSettlementJob(db, pass.created[0]!.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(4);
  });

  /**
   * Acceptance criterion (spec D7, ticket 05): a genuine gap scenario run all
   * the way from the scheduler trigger through the real payload seam to the
   * write-back must produce a `notesReconstructed > 0` LOG LINE — the
   * observability the ticket requires, not just a row in the database.
   */
  test("a genuine gap end to end produces a notesReconstructed > 0 log line", async () => {
    const sessionDbId = seedSession();
    if (sessionDbId !== 1) {
      throw new Error("fixture expected session id 1");
    }
    const t1 = seedTurn(sessionDbId, 1, {
      note: { title: "design+seam: window shape", content: "Chose windows." },
    });
    seedDebt(t1, sessionDbId, 1, "noted", null);
    // T2 has no note AND no note_debt row at all — a plain gap. Spec D7: a
    // missing debt row no longer reads as "trivial", it is a hole like any
    // other.
    const t2 = seedTurn(sessionDbId, 2, {
      userPrompt: "GAP PROMPT never written up",
      assistantResponse: "GAP RESPONSE never written up",
    });
    // Turn 3, still open: turn 2 alone is not yet decided (spec D10).
    seedTurn(sessionDbId, 3, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 2);

    const reply = JSON.stringify({
      segments: [],
      reconstructed_notes: [
        {
          turn: "S1/T2",
          title: "research+seam: reconstructed end to end",
          content: "Filled in from raw material.",
        },
      ],
    });

    const lines: string[] = [];
    const dispatch = createNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      runQuery: stubQuery(reply),
      logger: {
        warn: () => {},
        error: () => {},
        log: (line: string) => lines.push(line),
      },
    });
    const scheduler = createNoteSettlementScheduler({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      nowMs: () => NOW * 1000,
      consecutiveTurns: 2,
      dispatch,
      logger: { warn: () => {}, error: () => {} },
    });

    const pass = await scheduler.onTurnStop(sessionDbId);
    expect(pass.dispatched).toHaveLength(1);

    const note = getShadowNote(db, t2)!;
    expect(note.writerOrigin).toBe("settlement");
    expect(note.title).toContain("reconstructed end to end");

    const metricsLine = lines.find((line) =>
      line.startsWith(NOTE_SETTLEMENT_METRICS_PREFIX),
    );
    expect(metricsLine).toBeDefined();
    const parsedMetrics = JSON.parse(
      metricsLine!.slice(NOTE_SETTLEMENT_METRICS_PREFIX.length + 1),
    );
    expect(parsedMetrics.notesReconstructed).toBeGreaterThan(0);
  });
});

describe("settlement response schema", () => {
  test("accepts a fenced object and rejects schema violations whole", () => {
    const fenced = "```json\n" + JSON.stringify({ segments: [] }) + "\n```";
    expect(parseNoteSettlementResponse(fenced).ok).toBe(true);

    const noReason = JSON.stringify({
      segments: [
        { action: "create", title: "t", content: "c", type: [], tags: [] },
      ],
    });
    const rejected = parseNoteSettlementResponse(noReason);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toContain(
      "no_candidate_reason",
    );

    const badType = JSON.stringify({
      segments: [
        {
          action: "extend",
          segment_id: 1,
          expected_revision: 1,
          title: "t",
          content: "c",
          // A retired legacy word — never in the current vocabulary (spec B2).
          type: ["bugfix"],
          tags: [],
        },
      ],
    });
    expect(parseNoteSettlementResponse(badType).ok).toBe(false);

    const badRelation = JSON.stringify({
      edges: [{ citing: "S1/T1", cited: "S1/T2", relation: "relates-to" }],
    });
    expect(parseNoteSettlementResponse(badRelation).ok).toBe(false);
  });

  test("turn_review: accepts a full verdict and rejects an out-of-range grade or an unknown type whole (ticket 05)", () => {
    const good = JSON.stringify({
      turn_review: [
        { turn: "S1/T1", grade: 4, type: ["design"], tag: "widgets" },
        { turn: "S1/T2", grade: 0, type: [], tag: null },
      ],
    });
    const parsed = parseNoteSettlementResponse(good);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.response.turnReview).toEqual([
      { turn: "S1/T1", grade: 4, type: ["design"], tag: "widgets" },
      { turn: "S1/T2", grade: 0, type: [], tag: null },
    ]);

    const outOfRangeHigh = JSON.stringify({
      turn_review: [{ turn: "S1/T1", grade: 5, type: [], tag: null }],
    });
    const rejectedHigh = parseNoteSettlementResponse(outOfRangeHigh);
    expect(rejectedHigh.ok).toBe(false);
    expect(rejectedHigh.ok === false && rejectedHigh.reason).toContain(
      "grade",
    );

    const outOfRangeLow = JSON.stringify({
      turn_review: [{ turn: "S1/T1", grade: -1, type: [], tag: null }],
    });
    expect(parseNoteSettlementResponse(outOfRangeLow).ok).toBe(false);

    const missingGrade = JSON.stringify({
      turn_review: [{ turn: "S1/T1", type: [], tag: null }],
    });
    expect(parseNoteSettlementResponse(missingGrade).ok).toBe(false);

    const badVocabWord = JSON.stringify({
      // A retired legacy word — never in the current vocabulary (spec B2).
      turn_review: [{ turn: "S1/T1", grade: 2, type: ["bugfix"], tag: null }],
    });
    const rejectedType = parseNoteSettlementResponse(badVocabWord);
    expect(rejectedType.ok).toBe(false);
    expect(rejectedType.ok === false && rejectedType.reason).toContain(
      "type",
    );

    // Omitting the array entirely — like every other duty array — is not
    // malformed; "nothing to report" is a legal, empty answer.
    expect(parseNoteSettlementResponse("{}").ok).toBe(true);
    const empty = parseNoteSettlementResponse("{}");
    expect(empty.ok && empty.response.turnReview).toEqual([]);
  });
});
