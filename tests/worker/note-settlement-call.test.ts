import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession, getSession } from "../../src/db/sessions";
import { upsertShadowNote, getShadowNote } from "../../src/db/shadow-notes";
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
} from "../../src/db/memory-edges";
import {
  buildNoteSettlementContext,
  NOTE_SETTLEMENT_HOLE_TOKEN_BUDGET,
} from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import { parseNoteSettlementResponse } from "../../src/worker/note-settlement-response";
import {
  createNoteSettlementDispatch,
  type NoteSettlementQuery,
  type NoteSettlementWindowMetrics,
} from "../../src/worker/note-settlement-dispatch";
import { createNoteSettlementScheduler } from "../../src/worker/note-settlement";
import { SETTLEMENT_ENABLED_CONFIG } from "../support/settlement-config";

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
 * Four turns: two noted, one interior hole (written off, but T4 after it was
 * noted) and one trailing hole (written off with nothing noted after it).
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
  test("injects raw material for an interior hole and none for a trailing hole", () => {
    const fixture = seedInteriorHoleWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;

    const kinds = Object.fromEntries(
      context.windowTurns.map((turn) => [turn.promptNumber, turn.kind]),
    );
    expect(kinds).toEqual({
      1: "noted",
      2: "interior-hole",
      3: "noted",
      4: "trailing-hole",
    });
    expect(context.interiorHoles.map((turn) => turn.promptNumber)).toEqual([2]);

    expect(
      context.windowTurns.map((turn) => turn.rawMaterial !== null),
    ).toEqual([false, true, false, false]);

    // Assert on the window section rather than the whole prompt: the arc
    // rendering above it is the production timeline view, which quotes prompt
    // prefixes of its own selection — that is a different surface with its own
    // rules, and this criterion is about the window's material budget.
    const prompt = renderNoteSettlementPrompt(context);
    const window = prompt.slice(prompt.indexOf("## Window turns"));
    expect(window).toContain("raw> user: INTERIOR HOLE PROMPT");
    expect(window).toContain("raw> assistant: INTERIOR HOLE RESPONSE");
    expect(window).not.toContain("TRAILING HOLE PROMPT");
    expect(window).not.toContain("TRAILING HOLE RESPONSE");
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

  test("records the rendered window ids in the exposure ledger", () => {
    const fixture = seedInteriorHoleWindow();
    buildNoteSettlementContext(db, fixture.job, { nowEpoch: NOW });

    const exposed = db
      .query<{ exposedTurnId: number }, [number]>(
        `SELECT exposed_turn_id AS exposedTurnId FROM note_id_exposures
         WHERE session_id = ? AND source = 'injection'`,
      )
      .all(fixture.sessionDbId)
      .map((row) => row.exposedTurnId)
      .sort((a, b) => a - b);
    expect(exposed).toEqual([...fixture.turnIds].sort((a, b) => a - b));
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
          type: ["implement", "rolled-back"],
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
          content: "Interior holes get a note; trailing holes do not. [S1/T2]",
          type: ["design"],
          tags: ["hole reconstruction"],
          status: "open",
          members: ["S1/T2"],
        },
      ],
      edges: [
        { citing: "S1/T3", cited: "S1/T1", relation: "builds-on" },
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
          title: "should be refused",
          content: "Trailing hole, no dependency after it.",
        },
      ],
      session_summary: {
        title: "settlement fixture",
        content: "Settled one window.",
        decision: "Interior holes are reconstructed.",
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

    // Segments: one extended (with the settlement-only `rolled-back` type), one
    // created against a freshly minted topic.
    const extended = getSegment(db, existing.id)!;
    expect(extended.revision).toBe(existing.revision + 1);
    expect(extended.type).toEqual(["implement", "rolled-back"]);
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
    expect(judged[0]!.relation).toBe("builds-on");

    // Interior hole reconstructed with settlement provenance; trailing refused.
    const holeNote = getShadowNote(db, fixture.turnIds[1]!)!;
    expect(holeNote.writerOrigin).toBe("settlement");
    expect(holeNote.title).toContain("what the hole covered");
    expect(getShadowNote(db, fixture.turnIds[3]!)).toBeNull();
    // The agent's own notes keep their origin.
    expect(getShadowNote(db, fixture.turnIds[0]!)!.writerOrigin).toBe("agent");

    // Session summary and job/cursor resolution.
    const session = getSession(db, fixture.sessionDbId)!;
    expect(session.current).toBe("waiting for the next window");
    expect(session.decision).toBe("Interior holes are reconstructed.");
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(4);

    // Minting-rate counter reaches monitoring.
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.topicsMinted).toBe(1);
    expect(metricsSeen[0]!.topicsReused).toBe(0);
    expect(metricsSeen[0]!.segmentsCreated).toBe(1);
    expect(metricsSeen[0]!.segmentsExtended).toBe(1);
    expect(metricsSeen[0]!.notesReconstructed).toBe(1);
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
          type: ["refactor"],
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
});
