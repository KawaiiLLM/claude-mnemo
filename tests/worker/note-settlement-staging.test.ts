import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, isSqliteBusy } from "../../src/db/database";
import { getOutgoingEdges, pairKey, reconcileCitedPairs, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  listNoteSettlementSegmentExclusions,
  recordNoteSettlementSegmentExclusion,
} from "../../src/db/note-settlement-completion";
import { initializeSchema } from "../../src/db/schema";
import { createSegment, getSegment, getSegmentMemberTurnIds } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { createSettlementStagingEngine } from "../../src/worker/note-settlement-staging";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 10b (spec A7) — the settlement staging engine: `note`/`segment`
 * calls stage, `commit` is the only writer. This file proves the ticket's
 * acceptance criteria at the one seam that sees the whole staged-write
 * lifecycle — see `note-settlement-turn-facade.test.ts` and
 * `note-settlement-segment-facade.test.ts` for the per-field decision logic
 * this engine composes.
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
    contentSessionId: "settlement-staging-session",
    project: "/tmp/project-settlement-staging",
    title: "settlement staging fixture",
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
  target: Database,
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    target,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(target, sessionDbId, NOW, NOW * 1000);
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

/** Satisfy the completion gate's duty 1 (a stated type) without going through the note tool — this file's tests exercise ONE facade's fields at a time. */
function markTyped(turnIds: readonly number[]): void {
  for (const turnId of turnIds) {
    updateTurnById(db, turnId, { type: ["discuss"] });
  }
}

/** Satisfy the completion gate's duty 2 (a note on file) without going through the note tool. */
function markNoted(turnIds: readonly number[]): void {
  for (const turnId of turnIds) {
    upsertShadowNote(db, {
      turnId,
      title: "fixture title",
      content: "fixture content",
      nowEpoch: NOW - 100,
    });
  }
}

// Ticket 10d test-gap finding: this counted shadow_notes/segments/
// segment_members/memory_edges but not `topics`, and the fixture never
// created one — so a topic minted at STAGE time (before commit) would have
// gone unnoticed by every "nothing moved" assertion below. `topics` is
// counted here and the fixture (acceptance criterion 1) now mints one via a
// real `topic` field on its staged create.
function tableCounts(target: Database) {
  const count = (sql: string) =>
    target.query<{ count: number }, []>(sql).get()?.count ?? 0;
  return {
    shadowNotes: count("SELECT COUNT(*) AS count FROM shadow_notes"),
    segments: count("SELECT COUNT(*) AS count FROM segments"),
    segmentMembers: count("SELECT COUNT(*) AS count FROM segment_members"),
    memoryEdges: count("SELECT COUNT(*) AS count FROM memory_edges"),
    topics: count("SELECT COUNT(*) AS count FROM topics"),
  };
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: nothing reaches a live table before commit
// ---------------------------------------------------------------------------

describe("acceptance criterion 1 — a staged write reaches no live table before commit", () => {
  test("note and segment calls change no row anywhere; commit lands them all", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
      reconstructableTurnIds: new Set([t1]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const before = tableCounts(db);
    const beforeTurn = getTurnById(db, t1)!;

    const noteReceipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      title: "design+lease: reconstructed",
      content: "Filled in from raw material.",
      insight: null,
      grade: 3,
      type: ["design"],
      tags: ["lease"],
    });
    const segmentReceipt = engine.stageSegmentWrite({
      action: "create",
      handle: "chapter",
      title: "design+lease: staged chapter",
      content: "Body.",
      noCandidateReason: "nothing open covers this",
      topic: "lease fencing",
      type: ["design"],
      tags: ["lease"],
      members: [`S${sessionDbId}/T1`],
    });

    expect(noteReceipt.content[0]!.text).toContain("Staged");
    expect(segmentReceipt.content[0]!.text).toContain("Staged");
    expect(engine.pendingCount()).toBe(2);

    // Inspecting the TABLES, not the code: nothing moved.
    expect(tableCounts(db)).toEqual(before);
    expect(getTurnById(db, t1)!).toEqual(beforeTurn);

    // commit's completion gate also needs coverage/notes on t1 to be
    // satisfied; the staged writes above already carry those, but t1's
    // segmentation coverage is the SAME staged segment write.
    const commitReceipt = engine.commit();

    expect(commitReceipt.content[0]!.text).toContain("Committed");
    expect(getTurnById(db, t1)!.significanceGrade).toBe(3);
    const after = tableCounts(db);
    expect(after.shadowNotes).toBe(before.shadowNotes + 1);
    expect(after.segments).toBe(before.segments + 1);
    expect(after.segmentMembers).toBe(before.segmentMembers + 1);
    expect(after.topics).toBe(before.topics + 1);
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: a staged write validates fully, real receipt
// ---------------------------------------------------------------------------

describe("acceptance criterion 2 — a staged write validates fully and returns a real receipt", () => {
  test("an invalid staged call is rejected immediately and never enters the staged list", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set() });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 3 });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("reviewable window");
    expect(engine.pendingCount()).toBe(0);
  });

  test("a valid staged call reports the SAME decision a real write would make", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      grade: 2,
      type: ["fix"],
      tags: ["widgets"],
    });

    expect(receipt.content[0]!.text).toContain("grade 2");
    expect(receipt.content[0]!.text).toContain("fix");
    expect(receipt.content[0]!.text).toContain("widgets");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: the segment tool stages every field
// ---------------------------------------------------------------------------

describe("acceptance criterion 3 — the segment tool stages create, extend, members, insight, body", () => {
  test("create carries body/insight/members; extend rewrites them, all staged and landed only at commit", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    markTyped([t1, t2]);
    markNoted([t1, t2]);
    const job = claimWindow(db, sessionDbId, 1, 2);
    const context = baseContext(job, {});
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageSegmentWrite({
      action: "create",
      handle: "chapter",
      title: "implement+lease: chapter",
      content: "First body.",
      noCandidateReason: "nothing open covers this",
      insight: "the lease route was ruled out: a fence outlives its claim",
      members: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
    });
    expect(engine.pendingCount()).toBe(1);

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");

    const created = db
      .query<{ id: number }, []>("SELECT id FROM segments ORDER BY id DESC LIMIT 1")
      .get()!.id;
    // Ticket 14: `insight` has to survive the stage -> replay round trip, and
    // type is DERIVED from the members `markTyped` gave `discuss` (spec K5a) —
    // nothing in the staged call states it.
    expect(getSegment(db, created)!.insight).toBe(
      "the lease route was ruled out: a fence outlives its claim",
    );
    expect(getSegment(db, created)!.type).toEqual(["discuss"]);
    expect(getSegmentMemberTurnIds(db, created).sort()).toEqual([t1, t2].sort());

    // A second staging run on the same job would find it already `done`;
    // this test's own point is field coverage, so extend is exercised as a
    // fresh, separately-claimed job over a segment already exposed as open.
    const secondJob = claimWindow(db, sessionDbId, 3, 3);
    const t3 = seedTurn(sessionDbId, 3);
    markTyped([t3]);
    markNoted([t3]);
    const extendContext = baseContext(secondJob, {
      exposedSegmentIds: new Set([created]),
    });
    const extendEngine = createSettlementStagingEngine({ db, context: extendContext, now: () => NOW + 10 });
    const current = getSegment(db, created)!;
    extendEngine.stageSegmentWrite({
      action: "extend",
      segmentId: created,
      expectedRevision: current.revision,
      insight: "and the fence has to be renewed, not re-taken",
      members: [`S${sessionDbId}/T2`, `S${sessionDbId}/T3`],
    });
    const extendCommit = extendEngine.commit();
    expect(extendCommit.content[0]!.text).toContain("Committed");
    const extended = getSegment(db, created)!;
    expect(extended.insight).toBe("and the fence has to be renewed, not re-taken");
    expect(extended.type).toEqual(["discuss"]);
    expect(getSegmentMemberTurnIds(db, created).sort()).toEqual([t1, t2, t3].sort());
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4: E#n handles resolve in staging order at commit
// ---------------------------------------------------------------------------

describe("acceptance criterion 4 — E#n handles resolve to real ids at commit, in staging order", () => {
  test("a member and an anchor edge naming a segment the same run creates both resolve", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    markTyped([t1]);
    markNoted([t1]);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {});
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    // Entry 1: creates a segment, addressable within this run as E#fenced
    // (spec A7a: MODEL-named, not server-issued).
    const first = engine.stageSegmentWrite({
      action: "create",
      handle: "fenced",
      title: "implement+lease: the fenced chapter",
      content: "First chapter body.",
      noCandidateReason: "nothing open covers this",
      members: [`S${sessionDbId}/T1`], // an ordinary member, resolved through the same replay path
    });
    expect(first.content[0]!.text).toContain("E#fenced");

    // Entry 2: a second segment whose body cites the FIRST by handle,
    // before the first has any real id at all.
    engine.stageSegmentWrite({
      action: "create",
      handle: "followup",
      title: "design+lease: the follow-up chapter",
      content: "Builds on the fencing in [E#fenced].",
      noCandidateReason: "nothing open covers this",
    });

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");

    const rows = db
      .query<{ id: number; title: string }, []>("SELECT id, title FROM segments ORDER BY id ASC")
      .all();
    expect(rows).toHaveLength(2);
    const firstId = rows.find((row) => row.title.includes("fenced chapter"))!.id;
    const secondId = rows.find((row) => row.title.includes("follow-up chapter"))!.id;

    expect(getSegmentMemberTurnIds(db, firstId)).toEqual([t1]);
    const anchors = getOutgoingEdges(db, { kind: "segment", id: secondId });
    expect(anchors.map((edge) => edge.cited)).toEqual([{ kind: "segment", id: firstId }]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 5: commit re-validates — the world moving changes the
// outcome
// ---------------------------------------------------------------------------

describe("acceptance criterion 5 — commit re-validates inside its own transaction", () => {
  test("a review staged before an agent note landed yields at commit, though stage time reported it would write", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(db, sessionDbId, 1, 2);
    markTyped([t2]);
    markNoted([t2]);
    // No segment tool call in this test — its subject is the review yield,
    // not segmentation — so both turns are explicitly excluded, matching a
    // settlement job's own "reviewed, joins no segment" verdict (spec G7).
    recordNoteSettlementSegmentExclusion(db, job.id, t1, NOW);
    recordNoteSettlementSegmentExclusion(db, job.id, t2, NOW);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    const receipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      grade: 3,
      type: ["fix"],
      tags: ["settlement"],
    });
    // Stage time's own report: it would write, plainly — nothing about the
    // world has moved yet.
    expect(receipt.content[0]!.text).not.toContain("yielded");

    // The world moves: the main agent's own note lands, strictly after
    // `contextBuiltAtEpoch` — the exact race the note-derived half of a
    // review must yield to. A real agent write also states the turn's OWN
    // type in the same call (mcp/note.ts) — reproduced here directly so
    // duty 1 (coverage) reads t1 as typed by the AGENT, not by the stale
    // review this test is about to show yields.
    upsertShadowNote(db, {
      turnId: t1,
      title: "agent's own live account",
      content: "written while the turn was still running",
      nowEpoch: NOW + 5,
    });
    updateTurnById(db, t1, { type: ["research"] });

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");

    const turn = getTurnById(db, t1)!;
    // Grade still lands (judged from raw material, not the note); type/tags
    // do not — the agent's own type (["research"]) survives untouched by the
    // stale review, the exact divergence between the stage-time preview
    // (which reported it would overwrite to ["fix"]) and the commit-time
    // truth.
    expect(turn.significanceGrade).toBe(3);
    expect(turn.type).toEqual(["research"]);
    expect(turn.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 6: the gate runs inside the commit transaction, under
// the fence — file database, second connection
// ---------------------------------------------------------------------------

/**
 * Run `fire` the instant after the next `SELECT … FROM note_settlement_jobs`
 * reads its row — the fence's own read, `assertNoteSettlementJobClaimed` →
 * `getNoteSettlementJob`, which is `commit`'s FIRST statement. Same nested-
 * savepoint mechanism as `tests/worker/note-settlement-turn-facade.test.ts`'s
 * (now-retired) `fireAfterNextJobsRead` and
 * `tests/db/note-settlement-completion.test.ts`'s `fireAfterNextTurnsRead`.
 */
function fireAfterNextJobsRead(target: Database, fire: () => void): void {
  const originalQuery = target.query.bind(target);
  let armed = true;
  (target as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
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

describe("acceptance criterion 6 — the gate runs inside commit's transaction, under the fence", () => {
  let directory: string;
  let other: Database;

  beforeEach(() => {
    db.close();
    directory = mkdtempSync(join(tmpdir(), "mnemo-staging-txn-"));
    db = createDatabase(join(directory, "mnemo.sqlite"));
    initializeSchema(db);
    other = createDatabase(join(directory, "mnemo.sqlite"), { busyTimeoutMs: 0 });
  });

  afterEach(() => {
    other.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a competing connection cannot bump the claim generation between the fence's read and the gate's own compare-and-set", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    markNoted([t1]);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 2, type: ["discuss"], tags: [] });
    engine.stageSegmentWrite({
      action: "create",
      handle: "chapter",
      title: "discuss+lease: chapter",
      noCandidateReason: "nothing open covers this",
      members: [`S${sessionDbId}/T1`],
    });

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

    const receipt = engine.commit();

    // The load-bearing assertion: the bump was locked out for the ENTIRE
    // commit — the replay AND the gate's own completion compare-and-set,
    // not just the fence's own read. If the gate ran in a SEPARATE
    // transaction from the replay/fence, nothing would hold the lock across
    // the gap and this bump would land.
    expect(competingBumpLanded).toBe(false);
    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 7: a refused commit keeps the staging
// ---------------------------------------------------------------------------

describe("acceptance criterion 7 — a refused commit reports what is missing and keeps the staging", () => {
  test("a gate refusal (segmentation gap) keeps every staged write; filling the gap and committing again succeeds", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    markNoted([t1, t2]);
    const job = claimWindow(db, sessionDbId, 1, 2);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1, t2]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    // Both turns typed, but only t1 is segmented — t2 is a genuine
    // segmentation gap when commit's gate runs.
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 2, type: ["discuss"], tags: [] });
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T2`, grade: 2, type: ["discuss"], tags: [] });
    engine.stageSegmentWrite({
      action: "create",
      handle: "first-chapter",
      title: "discuss+lease: chapter",
      noCandidateReason: "nothing open covers this",
      members: [`S${sessionDbId}/T1`],
    });
    expect(engine.pendingCount()).toBe(3);

    const refusal = engine.commit();
    expect(refusal.content[0]!.text).toContain("Commit refused");
    expect(refusal.content[0]!.text).toContain("Staging kept");
    // Nothing landed — this is the load-bearing half of the requirement.
    expect(getTurnById(db, t1)!.significanceGrade).toBeNull();
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count).toBe(0);
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(engine.pendingCount()).toBe(3);

    // Fill the gap with one more staged call — t2 explicitly joins the same
    // segment — and commit again: the WHOLE staged list (old and new)
    // replays together.
    engine.stageSegmentWrite({
      action: "create",
      handle: "second-chapter",
      title: "discuss+lease: second gap turn",
      noCandidateReason: "nothing open covers this",
      members: [`S${sessionDbId}/T2`],
    });
    expect(engine.pendingCount()).toBe(4);

    const success = engine.commit();
    expect(success.content[0]!.text).toContain("Committed");
    expect(getTurnById(db, t1)!.significanceGrade).toBe(2);
    expect(getTurnById(db, t2)!.significanceGrade).toBe(2);
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    expect(engine.pendingCount()).toBe(0);
  });

  test("a replay conflict (a segment extend whose revision moved) refuses the whole commit and keeps every staged write, including the unrelated ones", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const existing = createSegment(db, { title: "chapter", nowEpoch: NOW - 1000 });
    // The world moves between staging and commit: another writer bumps the
    // revision this staged extend was composed against.
    db.query<unknown, [number]>("UPDATE segments SET revision = revision + 1 WHERE id = ?").run(
      existing.id,
    );

    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
      exposedSegmentIds: new Set([existing.id]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 1, type: ["discuss"], tags: [] });
    engine.stageSegmentWrite({
      action: "extend",
      segmentId: existing.id,
      expectedRevision: existing.revision,
      members: [`S${sessionDbId}/T1`],
    });

    const refusal = engine.commit();
    expect(refusal.content[0]!.text).toContain("Commit refused");
    expect(refusal.content[0]!.text).toContain("Staging kept");
    expect(getTurnById(db, t1)!.significanceGrade).toBeNull();
    expect(engine.pendingCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 8: settlement exposes no `check` tool (see
// note-settlement-sdk-query.test.ts / server wiring for the tool-list proof;
// this engine itself simply never exposes one).
// ---------------------------------------------------------------------------

describe("acceptance criterion 8 — the staging engine exposes no check", () => {
  test("SettlementStagingEngine has exactly stageNoteWrite/stageSegmentWrite/commit/pendingCount/getLastCommitMetrics", () => {
    const sessionDbId = seedSession();
    const job = claimWindow(db, sessionDbId, 1, 1);
    const engine = createSettlementStagingEngine({ db, context: baseContext(job) });
    // `getLastCommitMetrics` (ticket 10c) and `previewCommit` (ticket 11)
    // widen this list but not the MODEL-FACING one:
    // `note-settlement-sdk-query.ts` never registers either with the SDK's
    // `tool()` the way `note`/`segment`/`commit` are — this assertion is
    // about the engine's own JS surface, and a `check`-shaped tool would show
    // up in `note-settlement-sdk-query.ts`'s tool list, not here.
    // `previewCommit` is spec G8's folded check reached from the Stop hook,
    // which the model cannot call.
    expect(Object.keys(engine).sort()).toEqual(
      [
        "commit",
        "getLastCommitMetrics",
        "pendingCount",
        "previewCommit",
        "stageNoteWrite",
        "stageSegmentWrite",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Ticket 10c — `commit`'s own replay is the source of the operator job-log
// metrics (worker/note-settlement-dispatch.ts), and the per-grade histogram
// inside it must never reach the agent (spec G9). Both checked at the lowest
// level that can see a leak: the engine itself, not the dispatch wrapper
// around it (that end-to-end path is covered in note-settlement-call.test.ts).
// ---------------------------------------------------------------------------

describe("ticket 10c — commit's own result feeds the job log, never the agent", () => {
  test("commit's agent-visible receipt is the fixed 'Committed' sentence — no count or grade data rides along (spec G9)", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
      reconstructableTurnIds: new Set([t1]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      title: "design+lease: reconstructed",
      content: "Filled in from raw material.",
      insight: null,
      grade: 4,
      type: ["design"],
      tags: ["lease"],
    });
    engine.stageSegmentWrite({
      action: "create",
      handle: "chapter",
      title: "design+lease: staged chapter",
      content: "Body.",
      noCandidateReason: "nothing open covers this",
      type: ["design"],
      tags: ["lease"],
      members: [`S${sessionDbId}/T1`],
    });

    const commitReceipt = engine.commit();
    // Exact-string, not "does not contain" — a substring check could miss a
    // count folded into different wording. Grade 4 is chosen deliberately:
    // if the histogram (or the grade itself) leaked into this text at all,
    // the literal "4" would be the easiest thing to spot and the easiest to
    // miss with a looser assertion.
    expect(commitReceipt.content[0]!.text).toBe(
      `Committed. S${sessionDbId} window settled — job complete.`,
    );
  });

  test("getLastCommitMetrics reflects exactly what commit's replay landed, including the grade histogram", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const t3 = seedTurn(sessionDbId, 3);
    const t4 = seedTurn(sessionDbId, 4);
    const existing = createSegment(db, {
      title: "existing chapter",
      content: "Prior body.",
      type: ["design"],
      tags: [],
      nowEpoch: NOW - 5_000,
    });
    // T1/T3 are reviewed but not reconstructed (not owed a note) — pre-seed
    // their shadow notes directly, bypassing the note TOOL, so the gate's
    // note-coverage clause (G1a) is satisfied without adding to `commit`'s
    // OWN counted metrics, which is exactly the distinction this test is
    // checking. T4 needs no review at all — typed and noted directly, and
    // covered by the segment `extend` below.
    markNoted([t1, t3]);
    markTyped([t4]);
    markNoted([t4]);
    const job = claimWindow(db, sessionDbId, 1, 4);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1, t2, t3]),
      reconstructableTurnIds: new Set([t2]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    expect(engine.getLastCommitMetrics()).toBeNull();

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 2, type: ["discuss"], tags: [] });
    engine.stageNoteWrite({
      turn: `S${sessionDbId}/T2`,
      title: "reconstructed",
      content: "Filled in.",
      insight: null,
      grade: 1,
      type: ["research"],
      tags: [],
    });
    // Same grade as T1, to prove the histogram ACCUMULATES rather than
    // overwriting per turn.
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T3`, grade: 2, type: ["discuss"], tags: [] });
    engine.stageSegmentWrite({
      action: "create",
      handle: "chapter",
      title: "new chapter",
      content: "Body.",
      noCandidateReason: "nothing open fits",
      type: ["discuss"],
      tags: [],
      members: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
    });
    engine.stageSegmentWrite({ action: "exclude", turn: `S${sessionDbId}/T3` });
    engine.stageSegmentWrite({
      action: "extend",
      segmentId: existing.id,
      expectedRevision: existing.revision,
      members: [`S${sessionDbId}/T4`],
    });

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");

    expect(engine.getLastCommitMetrics()).toEqual({
      notesReconstructed: 1,
      notesYielded: 0,
      turnsReviewed: 3,
      reviewsYieldedToLateNote: 0,
      gradeHistogram: [0, 1, 2, 0, 0],
      relationsWritten: 0,
      segmentsCreated: 1,
      segmentsExtended: 1,
      segmentsExcluded: 1,
      membersAdded: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Ticket 10d finding 1 — frozen relation eligibility must not resurrect a
// pair the main agent deleted between the snapshot and commit. This is the
// FULL failure sequence the review named, through the real engine and a
// REAL commit — not just the decision function in isolation (that revalidation
// test lives in note-settlement-turn-facade.test.ts).
// ---------------------------------------------------------------------------

describe("ticket 10d finding 1 — commit-time relation eligibility is frozen ∩ current, never frozen alone", () => {
  test("T2's staged dependsOn(T1) is refused at commit after the main agent's own edit deletes the pair; nothing is resurrected", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(db, sessionDbId, 1, 2);

    // T2's body cites T1 AT SNAPSHOT TIME — a real, pre-existing bare pair,
    // exactly what `getExistingEdgePairKeys` (worker/note-settlement-dispatch.ts)
    // would have captured before this dispatch's model run began.
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
      { eligibleForRelation: "unrestricted" },
    );
    const frozenSnapshot = new Set([
      pairKey({ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 } }),
    ]);
    const context = baseContext(job, {
      eligibleRelationPairKeys: frozenSnapshot,
      reviewableTurnIds: new Set([t1, t2]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    // The REST of the window is fully satisfied — duty 1/2/segmentation for
    // BOTH turns — so the relation check is the ONLY thing that can refuse
    // this commit. Without isolating this, a disabled guard would still
    // show "Commit refused" for an unrelated gate gap, and the test could
    // not tell "correctly blocked" from "resurrected, then rolled back for
    // an unrelated reason" apart.
    markNoted([t1, t2]);
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 1, type: ["discuss"], tags: [] });
    // Settlement stages dependsOn(T1) for T2 — legal at stage time, the
    // pair is both frozen-eligible and currently present.
    const staged = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T2`,
      grade: 2,
      type: ["research"],
      tags: [],
      dependsOn: [`S${sessionDbId}/T1`],
    });
    expect(staged.content[0]!.text).toContain("Staged");
    engine.stageSegmentWrite({ action: "exclude", turn: `S${sessionDbId}/T1` });
    engine.stageSegmentWrite({ action: "exclude", turn: `S${sessionDbId}/T2` });

    // BEFORE commit, the main agent rewrites T2's body and its own
    // `reconcileCitedPairs` call (mcp/note.ts's live write path) drops the
    // citation — the pair no longer exists. The frozen snapshot above is
    // untouched; it still names this pair.
    reconcileCitedPairs(db, { kind: "turn", id: t2 }, [], NOW + 5, "text-ref");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);

    const commitReceipt = engine.commit();

    // The load-bearing assertion: commit does NOT resurrect the pair, and —
    // because every OTHER duty was satisfied — the ONLY possible reason for
    // a refusal here is the relation check itself (not an unrelated gate
    // gap that would refuse regardless of this fix).
    expect(commitReceipt.content[0]!.text).toContain("Commit refused");
    expect(commitReceipt.content[0]!.text).toContain("no longer exists");
    expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toEqual([]);
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });
});

// ---------------------------------------------------------------------------
// Ticket 10d finding 3 — `segment` gains `action: "exclude"`, the only
// model-facing path to the job-scoped no-segment verdict. Full failure
// sequence: a window with one legitimately unsegmented turn could not
// complete before this ticket (no caller of
// `recordNoteSettlementSegmentExclusion` existed on the model-facing side).
// ---------------------------------------------------------------------------

describe("ticket 10d finding 3 — a window holding one legitimately unsegmented turn now completes", () => {
  test("segment exclude + commit lands the exclusion and the window completes, through the tool path only", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    // Duty 1 (type) and duty 2 (note) satisfied normally; segmentation is
    // the ONLY thing left, and this turn genuinely belongs to no segment.
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 1, type: ["discuss"], tags: [] });
    markNoted([t1]);
    const excludeReceipt = engine.stageSegmentWrite({
      action: "exclude",
      turn: `S${sessionDbId}/T1`,
    });
    expect(excludeReceipt.content[0]!.text).toContain("Staged");
    expect(excludeReceipt.content[0]!.text).toContain(`S${sessionDbId}/T1`);
    // Nothing landed yet — this is still staged.
    expect(listNoteSettlementSegmentExclusions(db, job.id)).toEqual([]);

    const commitReceipt = engine.commit();

    expect(commitReceipt.content[0]!.text).toContain("Committed");
    expect(listNoteSettlementSegmentExclusions(db, job.id)).toEqual([t1]);
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Spec A7a — staged entries are keyed, and re-staging a key REPLACES it
// (ticket 10d finding 4/5).
// ---------------------------------------------------------------------------

describe("spec A7a — re-staging a key replaces its entry rather than appending", () => {
  // The merge is field-LEVEL (spec A7a, user ruling S15069/T735): a second
  // call overwrites only the fields it states. Whole-entry replacement would
  // also satisfy every other test in this block, which is why this one exists
  // — it is the only case that tells the two apart, and under whole-entry
  // replacement the prose staged first is silently destroyed by a later call
  // that only names a grade.
  test("a second call naming only the review fields keeps the prose the first call staged", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {
      reviewableTurnIds: new Set([t1]),
      reconstructableTurnIds: new Set([t1]),
    });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      title: "fix+staging: the merge is field-level",
      content: "Prose staged by the first call.",
      insight: null,
    });
    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 3, type: ["fix"], tags: [] });
    expect(engine.pendingCount()).toBe(1);

    engine.stageSegmentWrite({ action: "exclude", turn: `S${sessionDbId}/T1` });
    expect(engine.commit().content[0]!.text).toContain("Committed");

    const turn = getTurnById(db, t1)!;
    expect(turn.significanceGrade).toBe(3);
    expect(turn.type).toEqual(["fix"]);
    // The load-bearing assertion: the first call's prose survived a second
    // call that never mentioned it.
    expect(getShadowNote(db, t1)?.title).toBe("fix+staging: the merge is field-level");
    expect(getShadowNote(db, t1)?.content).toBe("Prose staged by the first call.");
  });

  test("restaging the same turn's note does not grow pendingCount, and only the LATEST content lands", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });
    markNoted([t1]); // duty 2 satisfied outside this test's own subject (keyed replace of duty 1)

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 2, type: ["discuss"], tags: [] });
    expect(engine.pendingCount()).toBe(1);

    // A same-run correction — the model noticed a better grade — restates
    // the SAME turn address.
    const secondReceipt = engine.stageNoteWrite({
      turn: `S${sessionDbId}/T1`,
      grade: 4,
      type: ["design"],
      tags: [],
    });
    expect(engine.pendingCount()).toBe(1); // replaced, not appended
    expect(secondReceipt.content[0]!.text).toContain("replaces");

    engine.stageSegmentWrite({
      action: "exclude",
      turn: `S${sessionDbId}/T1`,
    });
    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");
    expect(getTurnById(db, t1)!.significanceGrade).toBe(4);
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
  });

  test("restaging the same create handle does not grow pendingCount, and only ONE segment lands, with the latest title", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    markTyped([t1]);
    markNoted([t1]);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, {});
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageSegmentWrite({
      action: "create",
      handle: "chapter",
      title: "implement+lease: first draft",
      noCandidateReason: "nothing open covers this",
      members: [`S${sessionDbId}/T1`],
    });
    expect(engine.pendingCount()).toBe(1);

    const secondReceipt = engine.stageSegmentWrite({
      action: "create",
      handle: "chapter",
      title: "implement+lease: corrected title",
      noCandidateReason: "nothing open covers this",
      members: [`S${sessionDbId}/T1`],
    });
    expect(engine.pendingCount()).toBe(1); // replaced, not a second segment
    expect(secondReceipt.content[0]!.text).toContain("replaces");

    const commitReceipt = engine.commit();
    expect(commitReceipt.content[0]!.text).toContain("Committed");
    const rows = db.query<{ id: number; title: string }, []>("SELECT id, title FROM segments").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("implement+lease: corrected title");
  });

  test("restaging the same extend segmentId does not grow pendingCount", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const existing = createSegment(db, { title: "chapter", nowEpoch: NOW - 1000 });
    const context = baseContext(job, { exposedSegmentIds: new Set([existing.id]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageSegmentWrite({
      action: "extend",
      segmentId: existing.id,
      expectedRevision: existing.revision,
      tags: ["lease"],
    });
    expect(engine.pendingCount()).toBe(1);

    engine.stageSegmentWrite({
      action: "extend",
      segmentId: existing.id,
      expectedRevision: existing.revision,
      tags: ["lease", "fencing"],
    });
    expect(engine.pendingCount()).toBe(1);
    void t1;
  });

  test("restaging the same exclude turn does not grow pendingCount", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context });

    engine.stageSegmentWrite({ action: "exclude", turn: `S${sessionDbId}/T1` });
    expect(engine.pendingCount()).toBe(1);
    engine.stageSegmentWrite({ action: "exclude", turn: `S${sessionDbId}/T1` });
    expect(engine.pendingCount()).toBe(1);
  });

  test("a note and a segment exclude on the SAME turn are different staged keys and coexist", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(db, sessionDbId, 1, 1);
    const context = baseContext(job, { reviewableTurnIds: new Set([t1]) });
    const engine = createSettlementStagingEngine({ db, context, now: () => NOW });

    engine.stageNoteWrite({ turn: `S${sessionDbId}/T1`, grade: 1, type: ["discuss"], tags: [] });
    engine.stageSegmentWrite({ action: "exclude", turn: `S${sessionDbId}/T1` });
    expect(engine.pendingCount()).toBe(2);
  });
});
