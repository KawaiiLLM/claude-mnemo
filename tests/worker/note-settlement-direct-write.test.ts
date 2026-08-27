import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { getLane, insertLane } from "../../src/db/lanes";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { claimWriterId } from "../../src/db/write-gate";
import { recallMemory } from "../../src/mcp/recall";
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The direct-write engine (ticket 05: `note`/`remember` land immediately;
 * ticket 06: `commit` is repurposed to claim validity + a run summary + the
 * job's terminal mark — this file covers each of those three duties with its
 * own test, plus the empty-handed-window acceptance criterion both tickets
 * name explicitly.
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
    contentSessionId: "settlement-direct-write-session",
    project: "/tmp/project-settlement-direct-write",
    title: "settlement direct-write fixture",
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

describe("note/remember land immediately, before commit is ever called (ticket 05)", () => {
  test("writeNote lands the row right away", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });

    const receipt = engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    expect(receipt.content[0]!.text).toContain("Landed");
    expect(getTurnById(db, t1)!.type).toEqual(["design"]);
    // The job is not yet marked done — only commit does that.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });
});

describe("commit — three duties, each its own test (ticket 06)", () => {
  test("duty 1: claim validity — a reclaimed lease refuses commit and marks nothing done", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    // The lease moves out from under this run (a reclaim, in production).
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(job.id);

    const receipt = engine.commit("no friction this window");

    expect(receipt.content[0]!.text).toContain("Commit refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(engine.getLastCommitMetrics()).toBeNull();
  });

  test("duty 2: a run summary counts exactly what THIS run wrote", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    const job = claimWindow(sessionDbId, 1, 2);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1, t2]) }),
      now: () => NOW,
    });

    const segmentId = createSegment(db, { title: "a lane home", tags: ["home"], nowEpoch: NOW }).id;

    engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });
    engine.writeNote({ turn: `S${sessionDbId}/T2`, type: ["research"] });
    engine.writeMembership({ action: "create", id: `E${segmentId}`, tag: "lane-a" });

    engine.commit("no friction this window");
    const metrics = engine.getLastCommitMetrics();

    expect(metrics).not.toBeNull();
    expect(metrics!.turnsReviewed).toBe(2);
    expect(metrics!.reviewsYieldedToLateNote).toBe(0);
    expect(metrics!.lanesDeclared).toBe(1);
  });

  test("duty 3: the terminal mark — the job goes done and the cursor advances", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    const receipt = engine.commit("no friction this window");

    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(1);
  });

  test("commit does not judge duty coverage — an empty-handed window (nothing written) completes exactly as cleanly", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    // No writeNote/writeMembership call at all.
    const receipt = engine.commit("no friction this window");

    expect(receipt.content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    // Ticket 11 split the counts so a receipt can no longer report an act
    // that did not happen; ticket 15 replaced the three membership buckets
    // with the three lane ones. An empty-handed window states every one of
    // them as zero. Settlement-commit-report ticket 01 adds `report` — not a
    // count, but required all the same.
    expect(engine.getLastCommitMetrics()).toEqual({
      turnsReviewed: 0,
      reviewsYieldedToLateNote: 0,
      proseWritten: 0,
      relationsWritten: 0,
      relationsRestated: 0,
      relationsRetracted: 0,
      sessionNarrativeWritten: 0,
      lanesDeclared: 0,
      lanesDeleted: 0,
      lanesMerged: 0,
      report: "no friction this window",
    });
  });

  test("a second commit call in the same run is idempotent, not a fence error", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    const FIRST_REPORT = "first call: the window forced a guess on turn ordering.";
    const SECOND_REPORT = "second call text — must never land, commit is idempotent.";
    expect(engine.commit(FIRST_REPORT).content[0]!.text).toContain("Committed");
    const second = engine.commit(SECOND_REPORT);

    expect(second.content[0]!.text).toContain("Already committed");
    expect(second.content[0]!.text).not.toContain("refused");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    // Settlement-commit-report ticket 01 (decision 5): first successful
    // commit wins — the second call's report is never read at all, so it
    // cannot displace the first, distinctly-worded one.
    expect(engine.getLastCommitMetrics()!.report).toBe(FIRST_REPORT);
  });
});

// ---------------------------------------------------------------------------
// Settlement-commit-report ticket 01 (spec "commit carries a friction report
// into the settlement metrics line"): `report` is REQUIRED, not optional —
// an optional field here would be empty forever. Four refusal shapes, each
// its own test so a future edit cannot quietly narrow the guard to only one
// of them: absent, empty, whitespace-only and over-cap. None of these calls
// ever reaches the lease/CAS logic below (a `parameterError`, `commit`'s own
// counts and job status prove that where relevant), which is also what makes
// them cheap: no lease or duty setup, just a bare claimed job.
// ---------------------------------------------------------------------------

describe("commit refuses a malformed report, naming the parameter or the cap (settlement-commit-report ticket 01)", () => {
  test("absent report refuses, naming the parameter, and commits nothing", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    const receipt = engine.commit(undefined);

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain('"report"');
    expect(receipt.content[0]!.text).toContain("required");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(engine.getLastCommitMetrics()).toBeNull();
  });

  test("empty-string report refuses the same way", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    const receipt = engine.commit("");

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain('"report"');
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(engine.getLastCommitMetrics()).toBeNull();
  });

  test("whitespace-only report refuses — trimming, not just a length check", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    const receipt = engine.commit("   \n\t  ");

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain('"report"');
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(engine.getLastCommitMetrics()).toBeNull();
  });

  test("a report over the 1000-character cap refuses, stating the cap and the actual length, and is never truncated", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({ db, context: baseContext(job), now: () => NOW });

    const overCap = "x".repeat(1001);
    const receipt = engine.commit(overCap);

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain('"report"');
    // States the cap...
    expect(receipt.content[0]!.text).toContain("1000");
    // ...and the ACTUAL length, not just the cap — the two numbers differ,
    // which is the property a mutation dropping the length from the message
    // would break without a hardcoded "1000" alone catching it.
    expect(receipt.content[0]!.text).toContain("1001");
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(engine.getLastCommitMetrics()).toBeNull();
    // A report AT the cap is accepted — the boundary is "above", not "at or above".
    const atCap = "y".repeat(1000);
    const atCapReceipt = engine.commit(atCap);
    expect(atCapReceipt.content[0]!.text).toContain("Committed");
    expect(engine.getLastCommitMetrics()!.report).toBe(atCap);
    expect(engine.getLastCommitMetrics()!.report.length).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Peer finding P1-1 (2026-08-19 commit review): each direct write must be
// check-write-stamp ATOMIC. A compound call whose relation half rejects
// AFTER its type half already applied must leave no partial state behind.
// ---------------------------------------------------------------------------

describe("a rejected direct write leaves no partial state (one transaction per call)", () => {
  test("type lands then the relation rejects: the whole call rolls back", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    updateTurnById(db, t1, { type: ["design"] });
    writeMemoryEdges(
      db,
      [{ citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: null, provenance: "text-ref" }],
      NOW - 500,
    );
    const job = claimWindow(sessionDbId, 1, 2);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, {
        reviewableTurnIds: new Set([t2]),
      }),
      now: () => NOW,
    });

    // The relation half must REJECT for this test to measure anything, and
    // lane-model v12 ticket 02 removed the rejection it used to lean on: the
    // call was `type: ["implement"]` + a same-phase `extends` at an untyped
    // T1, illegal only because of the phase pairing. With the phase gate gone
    // that exact call LANDS, so the rejection is re-pointed at a surviving
    // one — the relations-read gate (`db/write-gate.ts`), which refuses an
    // edge write whose run never read the citing turn's current relations.
    // Ticket 04 moved every rejection AHEAD of the first mutation inside
    // `evaluateSettlementTurnWrite`, so this holds twice over — the evaluator
    // writes nothing, and the engine's own per-call transaction would have
    // rolled it back anyway. The assertion is kept as the outer guard:
    // whichever layer changes, no partial state.
    const receipt = engine.writeNote({
      turn: "S" + sessionDbId + "/T2",
      type: ["implement"],
      extends: ["S" + sessionDbId + "/T1"],
    });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("were not delivered to this run");
    // And it is NOT a phase rejection any more — pinned so a future edit
    // cannot quietly reintroduce a `type`-derived refusal here.
    expect(receipt.content[0]!.text).not.toContain("-phase");
    expect(getTurnById(db, t2)!.type).toEqual([]);
    const stamp = db
      .query("SELECT writer FROM write_gate_stamps WHERE entity_type = 'turn' AND entity_id = ? AND field = 'type'")
      .get(t2);
    expect(stamp).toBeNull();
  });

  // lane-model-v12 ticket 04 CHANGED WHAT THIS TEST CAN PROVE, and the
  // change is worth stating rather than quietly re-pointing.
  //
  // It used to be the suite's one genuinely POST-MUTATION rejection: the
  // self-`grounds` edge was written by `attachTurnRelations` first, and only
  // then did Gate C re-read the graph, find no tagged terminus and refuse —
  // so the surviving edge, or its absence, really did measure the per-call
  // transaction wrapper's rollback. Gate C is deleted with the whole
  // conditional self-citation rule, and a self edge is now refused BEFORE
  // anything is written. What remains is the outer guard every rejection in
  // this suite shares: whichever layer refuses, no partial state.
  //
  // NOTE for whoever adds the next graph-state gate: this file no longer
  // exercises the wrapper against a rejection that fires after a real write.
  test("a self-grounds is refused and nothing lands — the last post-mutation rejection retired with Gate C", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    // Kept `design`+`implement`: the most-favourable type set the retired
    // rule ever accepted, so this is the shape that used to get furthest.
    updateTurnById(db, t1, { type: ["design", "implement"] });
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });

    // Peer round P1-8: the relations read every edge write now rests on —
    // the same `recall` a real run makes, under this claim's own identity.
    // Without it the call is refused by the relations gate first, and the
    // self-edge refusal under test is never reached.
    recallMemory(db, {
      id: `S${sessionDbId}/T1`,
      filter: { fields: ["relations"] },
      readerId: claimWriterId(job.id, job.claimGeneration),
    });

    const receipt = engine.writeNote({
      turn: `S${sessionDbId}/T1`,
      grounds: [`S${sessionDbId}/T1`],
    });

    expect(receipt.content[0]!.text).toContain("Parameter error");
    expect(receipt.content[0]!.text).toContain("an edge's two ends must be DIFFERENT turns");
    expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ticket 08 (edge-mechanism-revision, peer 终审必改 5): the lease is checked at
// EVERY direct write, in that write's own transaction — not only at `commit`.
// The membership verbs are why: `create`/`reassign`/`propose` create state
// rather than overwrite a stamped field, so before this ticket a claimant that
// had already lost its lease could plant a segment on the session and only be
// told at `commit` — with the segment already visible to the next window.
// ---------------------------------------------------------------------------

function reclaimLease(jobId: number): void {
  db.query<unknown, [number]>(
    "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
  ).run(jobId);
}

describe("a reclaimed lease refuses every direct write, naming the lease (ticket 08)", () => {
  test("note: the turn write is refused and the row is untouched", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    reclaimLease(job.id);

    const receipt = engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    expect(receipt.content[0]!.text).toContain("Write refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    // The reason is named, not merely alluded to — a stale generation reads
    // differently from a job that is no longer claimed at all.
    expect(receipt.content[0]!.text).toContain("claim generation");
    expect(getTurnById(db, t1)!.type).toEqual([]);
  });

  test("remember(create) at the lane tier: no lane row is minted", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segmentId = createSegment(db, { title: "a lane home", tags: ["home"], nowEpoch: NOW }).id;
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    reclaimLease(job.id);

    const receipt = engine.writeMembership({
      action: "create",
      id: `E${segmentId}`,
      tag: "planted-by-a-lapsed-claimant",
    });

    expect(receipt.content[0]!.text).toContain("Write refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(getLane(db, segmentId, "planted-by-a-lapsed-claimant")).toBeNull();
  });

  // The write ticket 08 was written for, at its widest: `merge` rewrites turn
  // tags AND edge sides AND deletes a registry row. A lapsed claimant reaching
  // any of those would leave state the next window renders.
  test("remember(merge): not one member tag moves and both lanes stay declared", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segmentId = createSegment(db, { title: "a lane home", tags: ["home"], nowEpoch: NOW }).id;
    addSegmentMembers(db, segmentId, [t1], NOW);
    updateTurnById(db, t1, { tags: ["home", "lane-a"] });
    insertLane(db, segmentId, "lane-a", NOW);
    insertLane(db, segmentId, "lane-b", NOW);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    reclaimLease(job.id);

    const receipt = engine.writeMembership({
      action: "merge",
      id: `E${segmentId}`,
      tag: "lane-a",
      into: "lane-b",
    });

    expect(receipt.content[0]!.text).toContain("Write refused");
    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(getTurnById(db, t1)!.tags).toEqual(["home", "lane-a"]);
    expect(getLane(db, segmentId, "lane-a")).not.toBeNull();
    expect(getLane(db, segmentId, "lane-b")).not.toBeNull();
  });

  test("a job already marked done refuses with the not-claimed reason, not a generation mismatch", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET status = 'done' WHERE id = ?",
    ).run(job.id);

    const receipt = engine.writeNote({ turn: `S${sessionDbId}/T1`, type: ["design"] });

    expect(receipt.content[0]!.text).toContain("not claimed");
    expect(getTurnById(db, t1)!.type).toEqual([]);
  });
});

describe("the lease check and the write share one transaction (ticket 08)", () => {
  test("a reclaim landing INSIDE the write's own transaction takes the whole call with it", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segmentId = createSegment(db, { title: "a lane home", tags: ["home"], nowEpoch: NOW }).id;
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
      // The competing reclaim runs after BEGIN IMMEDIATE and before the
      // engine's own body — the one interleaving that tells the two designs
      // apart. A fence evaluated OUTSIDE the transaction (at construction, or
      // ahead of the BEGIN) would still see the generation it captured, let
      // the `create` through, and commit the reclaim and the new lane
      // together. Because the refusal rolls the transaction back, the injected
      // reclaim is rolled back with it — which is why the assertion below is
      // about the lane, not about the job row.
      runWriteTransaction: (database, fn) =>
        runWriteTransaction(database, () => {
          reclaimLease(job.id);
          return fn();
        }),
    });

    const receipt = engine.writeMembership({
      action: "create",
      id: `E${segmentId}`,
      tag: "raced-against-a-reclaim",
    });

    expect(receipt.content[0]!.text).toContain("lease was reclaimed");
    expect(getLane(db, segmentId, "raced-against-a-reclaim")).toBeNull();
  });
});

describe("a valid claimant's direct writes are unchanged by the lease check (ticket 08)", () => {
  test("create (lane tier), merge and delete all land, and commit reports each in its own bucket", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segmentId = createSegment(db, { title: "a real task", tags: ["home"], nowEpoch: NOW }).id;
    addSegmentMembers(db, segmentId, [t1], NOW);
    updateTurnById(db, t1, { tags: ["home", "lane-a"] });
    insertLane(db, segmentId, "lane-a", NOW);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });

    expect(
      engine.writeMembership({ action: "create", id: `E${segmentId}`, tag: "lane-b" })
        .content[0]!.text,
    ).toContain('Landed create: lane "lane-b"');

    const merged = engine.writeMembership({
      action: "merge",
      id: `E${segmentId}`,
      tag: "lane-a",
      into: "lane-b",
    });
    expect(merged.content[0]!.text).toContain('folded into "lane-b"');
    expect(getTurnById(db, t1)!.tags).toEqual(["home", "lane-b"]);
    expect(getLane(db, segmentId, "lane-a")).toBeNull();

    // Clearing the survivor's last member is what makes `delete` legal —
    // the guard counts member turns, and merge moved them all onto lane-b.
    updateTurnById(db, t1, { tags: ["home"] });
    expect(
      engine.writeMembership({ action: "delete", id: `E${segmentId}`, tag: "lane-b" })
        .content[0]!.text,
    ).toContain('Landed delete: lane "lane-b"');

    expect(engine.commit("no friction this window").content[0]!.text).toContain("Committed");
    const metrics = engine.getLastCommitMetrics()!;
    expect(metrics.lanesDeclared).toBe(1);
    expect(metrics.lanesMerged).toBe(1);
    expect(metrics.lanesDeleted).toBe(1);
  });

  /**
   * ATOMICITY AT THE PRODUCTION BOUNDARY. `tests/db/lanes.merge.test.ts` proves
   * the primitive rolls back inside an explicit transaction; this proves the
   * ENGINE is that transaction. No `runWriteTransaction` wrapper here — if
   * `writeMembership` stopped opening one, the member retag below would survive
   * the aborted merge and the database would hold a half-merged lane.
   */
  test("failpoint: an aborted merge inside writeMembership leaves nothing behind", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const segmentId = createSegment(db, { title: "a real task", tags: ["home"], nowEpoch: NOW }).id;
    addSegmentMembers(db, segmentId, [t1], NOW);
    updateTurnById(db, t1, { tags: ["home", "lane-a"] });
    insertLane(db, segmentId, "lane-a", NOW);
    insertLane(db, segmentId, "lane-b", NOW);
    const job = claimWindow(sessionDbId, 1, 1);
    const engine = createSettlementDirectWriteEngine({
      db,
      context: baseContext(job, { reviewableTurnIds: new Set([t1]) }),
      now: () => NOW,
    });

    db.exec(
      `CREATE TRIGGER engine_merge_failpoint BEFORE DELETE ON lanes
       WHEN OLD.tag = 'lane-a'
       BEGIN SELECT RAISE(ABORT, 'injected crash'); END`,
    );
    expect(() =>
      engine.writeMembership({
        action: "merge",
        id: `E${segmentId}`,
        tag: "lane-a",
        into: "lane-b",
      }),
    ).toThrow(/injected crash/);

    expect(getTurnById(db, t1)!.tags).toEqual(["home", "lane-a"]);
    expect(getLane(db, segmentId, "lane-a")).not.toBeNull();

    db.exec("DROP TRIGGER engine_merge_failpoint");
    expect(
      engine.writeMembership({
        action: "merge",
        id: `E${segmentId}`,
        tag: "lane-a",
        into: "lane-b",
      }).content[0]!.text,
    ).toContain('folded into "lane-b"');
    expect(getTurnById(db, t1)!.tags).toEqual(["home", "lane-b"]);
    expect(getLane(db, segmentId, "lane-a")).toBeNull();
  });
});
