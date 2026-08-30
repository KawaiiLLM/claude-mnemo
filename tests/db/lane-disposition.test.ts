import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { claimNextNoteSettlementJob, enqueueNoteSettlementWindows } from "../../src/db/note-settlement";
import { createSegment } from "../../src/db/segments";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import type { LaneComponentReport } from "../../src/shared/lane-checker";
import {
  computeComponentFingerprint,
  computeDuplicateReasonRate,
  computeLaneFractures,
  hasAnyLaneReadReceipt,
  checkLaneDispositionJustification,
  laneTouchSegmentTagKey,
  laneTouchTurnTagKey,
  loadRunLaneTouches,
  recordLaneDispositionJustification,
  recordLaneReadReceipt,
  recordLaneTouch,
  laneRepresentativeContentSequence,
  unreadLaneMembers,
} from "../../src/db/lane-disposition";
import { claimWriterId, stampField } from "../../src/db/write-gate";

const NOW = 1_800_000_000;
const ERA_CUTOFF = NOW - 100_000;

function db(): Database {
  const database = createDatabase(":memory:");
  initializeSchema(database);
  return database;
}

/** A real, FK-satisfiable job id + two real turn ids — the ledger's own tables carry real FKs on purpose (no dummy scalar rows). */
function seedJobAndTurns(conn: Database): { jobId: number; turnA: number; turnB: number } {
  const sessionId = upsertSession(conn, {
    contentSessionId: `lane-disposition-${Math.random()}`,
    project: "/tmp/project-lane-disposition",
    title: "lane-disposition fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const insertTurn = (promptNumber: number): number =>
    conn
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch, type
         ) VALUES (?, ?, 'active', ?, ?, 1, ?, '["design"]')
         RETURNING id`,
      )
      .get(sessionId, promptNumber, `prompt ${promptNumber}`, `response ${promptNumber}`, NOW - 900 + promptNumber)!
      .id;
  const turnA = insertTurn(1);
  const turnB = insertTurn(2);
  enqueueNoteSettlementWindows(
    conn,
    [{ sessionId, windowStart: 1, windowEnd: 2, triggerType: "consecutive" }],
    NOW,
    ERA_CUTOFF,
  );
  const job = claimNextNoteSettlementJob(conn, sessionId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { jobId: job.id, turnA, turnB };
}

function component(islands: readonly number[][]): LaneComponentReport {
  return {
    key: { segment: "3", tag: "some-lane" },
    componentCount: islands.length,
    islands: islands.map((memberIds) => ({ representative: memberIds[0]!, memberIds })),
  };
}

describe("computeComponentFingerprint — order-independent, deterministic", () => {
  test("the two representatives in either order fingerprint identically", () => {
    expect(computeComponentFingerprint(3, "lane", 1, 5)).toBe(computeComponentFingerprint(3, "lane", 5, 1));
  });

  test("a different segment, tag or representative pair fingerprints differently", () => {
    const base = computeComponentFingerprint(3, "lane", 1, 5);
    expect(computeComponentFingerprint(4, "lane", 1, 5)).not.toBe(base);
    expect(computeComponentFingerprint(3, "other-lane", 1, 5)).not.toBe(base);
    expect(computeComponentFingerprint(3, "lane", 1, 6)).not.toBe(base);
  });
});

describe("computeLaneFractures — N-1 consecutive-pair fractures for N islands", () => {
  test("a whole lane (1 island) owes no fracture", () => {
    expect(computeLaneFractures(3, component([[1, 2]]))).toEqual([]);
  });

  test("a severed lane (2 islands) owes exactly ONE fracture, between the two representatives", () => {
    const fractures = computeLaneFractures(3, component([[1, 2], [5, 6]]));
    expect(fractures).toHaveLength(1);
    expect(fractures[0]!.representativeA).toBe(1);
    expect(fractures[0]!.representativeB).toBe(5);
    expect(fractures[0]!.fingerprint).toBe(computeComponentFingerprint(3, "some-lane", 1, 5));
  });

  test("a lane split into 3 islands owes exactly TWO fractures — the spanning-tree minimum", () => {
    const fractures = computeLaneFractures(3, component([[1], [5], [9]]));
    expect(fractures).toHaveLength(2);
    expect(fractures.map((f) => [f.representativeA, f.representativeB])).toEqual([[1, 5], [5, 9]]);
  });

  test("a stitch that merges the two islands changes the representative pair, so the OLD fingerprint no longer matches any current fracture", () => {
    const before = computeLaneFractures(3, component([[1, 2], [5, 6]]))[0]!.fingerprint;
    // Merged: one island now, {1,2,5,6} — representative 1, no fracture at all.
    const after = computeLaneFractures(3, component([[1, 2, 5, 6]]));
    expect(after).toEqual([]);
    // And a lane that split differently afterwards (e.g. {1,5} vs {2,6})
    // fingerprints to something the old justify was never bound to.
    const reshaped = computeLaneFractures(3, component([[1, 5], [2, 6]]))[0]!.fingerprint;
    expect(reshaped).not.toBe(before);
  });
});

describe("the justify ledger — presence and binding, never truth", () => {
  test("no record exists until one is written, and existence is fingerprint-exact", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const { jobId, turnA, turnB } = seedJobAndTurns(conn);
    expect(checkLaneDispositionJustification(conn, segment, "lane", "fp-1").status).toBe("none");
    recordLaneDispositionJustification(conn, {
      jobId,
      segmentId: segment,
      laneTag: "lane",
      componentFingerprint: "fp-1",
      representativeA: turnA,
      representativeB: turnB,
      representativeAContentSequence: laneRepresentativeContentSequence(conn, turnA),
      representativeBContentSequence: laneRepresentativeContentSequence(conn, turnB),
      reason: "two independent lines of work",
      createdAtEpoch: NOW,
    });
    expect(checkLaneDispositionJustification(conn, segment, "lane", "fp-1").status).toBe("fresh");
    // A DIFFERENT fingerprint (the topology moved) is not covered by this row.
    expect(checkLaneDispositionJustification(conn, segment, "lane", "fp-2").status).toBe("none");
    conn.close();
  });
});

/**
 * PHASE-CONNECTIVITY TICKET 08, decision 3. `hasLaneDispositionJustification`
 * selected on (segment_id, lane_tag, component_fingerprint) alone — no job
 * scope and no freshness — so a justification was fresh for one instant and
 * durable forever, and every LATER job inherited it. Ticket 05's fingerprint
 * ruling covers a topology that moved; nothing covered the two representatives'
 * own text moving underneath a judgment about it.
 */
describe("a justification carries the evidence it was granted on (ticket 08)", () => {
  function seedJustified(conn: Database): { segment: number; turnA: number; turnB: number } {
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const { jobId, turnA, turnB } = seedJobAndTurns(conn);
    stampField(conn, "turn", turnA, "content", "writer-a", NOW);
    stampField(conn, "turn", turnB, "content", "writer-b", NOW);
    recordLaneDispositionJustification(conn, {
      jobId,
      segmentId: segment,
      laneTag: "lane",
      componentFingerprint: "fp-1",
      representativeA: turnA,
      representativeB: turnB,
      representativeAContentSequence: laneRepresentativeContentSequence(conn, turnA),
      representativeBContentSequence: laneRepresentativeContentSequence(conn, turnB),
      reason: "two independent lines of work",
      createdAtEpoch: NOW,
    });
    return { segment, turnA, turnB };
  }

  test("a later write to EITHER representative's content turns the record stale, naming the moved side", () => {
    const conn = db();
    const { segment, turnA, turnB } = seedJustified(conn);
    expect(checkLaneDispositionJustification(conn, segment, "lane", "fp-1").status).toBe("fresh");

    stampField(conn, "turn", turnB, "content", "someone-else", NOW + 5);
    const after = checkLaneDispositionJustification(conn, segment, "lane", "fp-1");
    expect(after.status).toBe("stale");
    expect(after.status === "stale" ? after.moved.map((entry) => entry.turnId) : []).toEqual([turnB]);
    // The OTHER representative did not move, and the report does not claim it did.
    expect(after.status === "stale" ? after.moved.map((entry) => entry.turnId) : []).not.toContain(
      turnA,
    );
    conn.close();
  });

  test("a row written before this ticket (sequence 0) fails closed against a representative that carries a stamp", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const { jobId, turnA, turnB } = seedJobAndTurns(conn);
    // The legacy shape's rows: the ALTER's DEFAULT 0 is what they read back as.
    recordLaneDispositionJustification(conn, {
      jobId,
      segmentId: segment,
      laneTag: "lane",
      componentFingerprint: "fp-legacy",
      representativeA: turnA,
      representativeB: turnB,
      representativeAContentSequence: 0,
      representativeBContentSequence: 0,
      reason: "recorded before evidence was carried",
      createdAtEpoch: NOW,
    });
    // Nobody has written either field, so 0 is the honest answer and the row stands.
    expect(checkLaneDispositionJustification(conn, segment, "lane", "fp-legacy").status).toBe(
      "fresh",
    );
    stampField(conn, "turn", turnA, "content", "writer-a", NOW);
    expect(checkLaneDispositionJustification(conn, segment, "lane", "fp-legacy").status).toBe(
      "stale",
    );
    conn.close();
  });

  test("a fresh re-justification after the write rehabilitates the fracture, without deleting the stale row", () => {
    const conn = db();
    const { segment, turnA, turnB } = seedJustified(conn);
    stampField(conn, "turn", turnB, "content", "someone-else", NOW + 5);
    expect(checkLaneDispositionJustification(conn, segment, "lane", "fp-1").status).toBe("stale");

    const { jobId: laterJob } = seedJobAndTurns(conn);
    recordLaneDispositionJustification(conn, {
      jobId: laterJob,
      segmentId: segment,
      laneTag: "lane",
      componentFingerprint: "fp-1",
      representativeA: turnA,
      representativeB: turnB,
      representativeAContentSequence: laneRepresentativeContentSequence(conn, turnA),
      representativeBContentSequence: laneRepresentativeContentSequence(conn, turnB),
      reason: "re-read after the edit, still two independent lines",
      createdAtEpoch: NOW + 6,
    });
    expect(checkLaneDispositionJustification(conn, segment, "lane", "fp-1").status).toBe("fresh");
    conn.close();
  });
});

describe("computeDuplicateReasonRate — anomaly signal, never a machine truth check", () => {
  test("fewer than the minimum sample yields no verdict at all (not a false 0%)", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const { jobId, turnA, turnB } = seedJobAndTurns(conn);
    for (let i = 0; i < 3; i += 1) {
      recordLaneDispositionJustification(conn, {
        jobId,
        segmentId: segment,
        laneTag: "lane",
        componentFingerprint: `fp-${i}`,
        representativeA: turnA,
        representativeB: turnB,
        representativeAContentSequence: laneRepresentativeContentSequence(conn, turnA),
        representativeBContentSequence: laneRepresentativeContentSequence(conn, turnB),
        reason: "same reason every time",
        createdAtEpoch: NOW,
      });
    }
    expect(computeDuplicateReasonRate(conn, segment)).toBeNull();
    conn.close();
  });

  test("a high duplicate-reason rate is reported once the sample is large enough", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const { jobId, turnA, turnB } = seedJobAndTurns(conn);
    for (let i = 0; i < 4; i += 1) {
      recordLaneDispositionJustification(conn, {
        jobId,
        segmentId: segment,
        laneTag: "lane",
        componentFingerprint: `fp-${i}`,
        representativeA: turnA,
        representativeB: turnB,
        representativeAContentSequence: laneRepresentativeContentSequence(conn, turnA),
        representativeBContentSequence: laneRepresentativeContentSequence(conn, turnB),
        reason: "same reason every time",
        createdAtEpoch: NOW,
      });
    }
    const rate = computeDuplicateReasonRate(conn, segment);
    expect(rate).not.toBeNull();
    expect(rate!.total).toBe(4);
    expect(rate!.duplicateCount).toBe(4);
    expect(rate!.rate).toBe(1);
    conn.close();
  });

  test("varied reasons at the same sample size report a low (non-anomalous) rate", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const { jobId, turnA, turnB } = seedJobAndTurns(conn);
    for (let i = 0; i < 4; i += 1) {
      recordLaneDispositionJustification(conn, {
        jobId,
        segmentId: segment,
        laneTag: "lane",
        componentFingerprint: `fp-${i}`,
        representativeA: turnA,
        representativeB: turnB,
        representativeAContentSequence: laneRepresentativeContentSequence(conn, turnA),
        representativeBContentSequence: laneRepresentativeContentSequence(conn, turnB),
        reason: `distinct reason ${i}`,
        createdAtEpoch: NOW,
      });
    }
    const rate = computeDuplicateReasonRate(conn, segment);
    expect(rate!.duplicateCount).toBe(0);
    expect(rate!.rate).toBe(0);
    conn.close();
  });
});

describe("lane-read receipts — coverage is over MEMBER IDS, and accumulates call over call", () => {
  const MEMBERS = [11, 12, 13, 14, 15];

  test("no receipt at all leaves every member unread", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    expect(hasAnyLaneReadReceipt(conn, "claim:1:1", segment, "lane")).toBe(false);
    expect(unreadLaneMembers(conn, "claim:1:1", segment, "lane", MEMBERS)).toEqual(MEMBERS);
    conn.close();
  });

  test("an empty obligation is vacuously covered", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    expect(unreadLaneMembers(conn, "claim:1:1", segment, "lane", [])).toEqual([]);
    conn.close();
  });

  /**
   * THE LAUNDERING PATH THE PEER FOUND (ticket 05). `recall` honours a
   * caller-supplied `pageSize`, and the predecessor divided the member count
   * by a hardcoded 10 — so three receipts stamped `pages 1, 2, 3` "covered" a
   * lane of any size. Here those three receipts each rendered exactly ONE
   * member, and two members are still unread; the count is over ids now, so
   * the page numbers buy nothing.
   */
  test("three receipts at pageSize 1 do NOT cover a five-member component — the unread ids are named", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    for (let page = 1; page <= 3; page += 1) {
      recordLaneReadReceipt(conn, {
        readerId: "claim:1:1",
        segmentId: segment,
        laneTag: "lane",
        membershipTurnIds: MEMBERS,
        renderedTurnIds: [MEMBERS[page - 1]!],
        sequence: page,
        createdAtEpoch: NOW,
      });
    }
    expect(unreadLaneMembers(conn, "claim:1:1", segment, "lane", MEMBERS)).toEqual([14, 15]);
    conn.close();
  });

  test("coverage accumulates ACROSS calls with DIFFERENT page sizes, never requiring one call to see everything", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    // Call 1: pageSize 2, page 1.
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: MEMBERS,
      renderedTurnIds: [11, 12],
      sequence: 1,
      createdAtEpoch: NOW,
    });
    expect(unreadLaneMembers(conn, "claim:1:1", segment, "lane", MEMBERS)).toEqual([13, 14, 15]);
    // Call 2: pageSize 1, page 3 — a different size AND out of order.
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: MEMBERS,
      renderedTurnIds: [13],
      sequence: 2,
      createdAtEpoch: NOW,
    });
    expect(unreadLaneMembers(conn, "claim:1:1", segment, "lane", MEMBERS)).toEqual([14, 15]);
    // Call 3: pageSize 10 — the rest in one go.
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: MEMBERS,
      renderedTurnIds: [14, 15],
      sequence: 3,
      createdAtEpoch: NOW,
    });
    expect(unreadLaneMembers(conn, "claim:1:1", segment, "lane", MEMBERS)).toEqual([]);
    conn.close();
  });

  test("a DIFFERENT reader's receipts do not count toward this reader's coverage", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: MEMBERS,
      renderedTurnIds: MEMBERS,
      sequence: 1,
      createdAtEpoch: NOW,
    });
    expect(hasAnyLaneReadReceipt(conn, "claim:9:9", segment, "lane")).toBe(false);
    expect(unreadLaneMembers(conn, "claim:9:9", segment, "lane", MEMBERS)).toEqual(MEMBERS);
    conn.close();
  });
});

/**
 * TICKET 05 (settlement-execution-repair, spec Rev 5 "Two-layer identity"
 * clause (b)): the lane-read-receipt reader-side lookups are one of the
 * families the grant-principal resolver widens — a job's `edges`-stage
 * reader sees receipts its OWN generation's `topics`-stage reader already
 * earned. `claim:1:1`-shaped strings used throughout the describe block above
 * are the pre-ticket-05, non-stage-keyed shape and stay exact-string-matched
 * (the resolver does not recognize them as claim-shaped) — this block uses
 * the REAL `claimWriterId(job, generation, stage)` encoding to exercise the
 * widening itself.
 */
describe("lane-read receipts — grant-principal widening across a claim's own stages (ticket 05)", () => {
  const MEMBERS = [11, 12, 13, 14, 15];

  test("an edges-stage reader sees a receipt its SAME generation's topics-stage reader recorded", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const topicsReader = claimWriterId(7, 2, "topics");
    const edgesReader = claimWriterId(7, 2, "edges");
    recordLaneReadReceipt(conn, {
      readerId: topicsReader,
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: MEMBERS,
      renderedTurnIds: MEMBERS,
      sequence: 1,
      createdAtEpoch: NOW,
    });

    expect(hasAnyLaneReadReceipt(conn, edgesReader, segment, "lane")).toBe(true);
    expect(unreadLaneMembers(conn, edgesReader, segment, "lane", MEMBERS)).toEqual([]);
    conn.close();
  });

  test("coverage accumulates ACROSS the two stage-keyed siblings, same as across calls by one writer", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const topicsReader = claimWriterId(7, 2, "topics");
    const edgesReader = claimWriterId(7, 2, "edges");
    recordLaneReadReceipt(conn, {
      readerId: topicsReader,
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: MEMBERS,
      renderedTurnIds: [11, 12, 13],
      sequence: 1,
      createdAtEpoch: NOW,
    });
    recordLaneReadReceipt(conn, {
      readerId: edgesReader,
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: MEMBERS,
      renderedTurnIds: [14],
      sequence: 2,
      createdAtEpoch: NOW,
    });

    expect(unreadLaneMembers(conn, edgesReader, segment, "lane", MEMBERS)).toEqual([15]);
    conn.close();
  });

  test("non-inheritance: a DIFFERENT generation of the SAME job sees none of it", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const gen2Topics = claimWriterId(7, 2, "topics");
    const gen3Edges = claimWriterId(7, 3, "edges");
    recordLaneReadReceipt(conn, {
      readerId: gen2Topics,
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: MEMBERS,
      renderedTurnIds: MEMBERS,
      sequence: 1,
      createdAtEpoch: NOW,
    });

    expect(hasAnyLaneReadReceipt(conn, gen3Edges, segment, "lane")).toBe(false);
    expect(unreadLaneMembers(conn, gen3Edges, segment, "lane", MEMBERS)).toEqual(MEMBERS);
    conn.close();
  });
});

describe("the durable touch ledger (phase-connectivity ticket 04)", () => {
  test("both key shapes round-trip, repeats collapse, and rows are keyed by JOB alone", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const { jobId, turnA } = seedJobAndTurns(conn);

    expect(loadRunLaneTouches(conn, jobId).turnTagPairs.size).toBe(0);

    recordLaneTouch(conn, {
      jobId,
      kind: "turn-tag",
      entityId: turnA,
      laneTag: "lane",
      createdAtEpoch: NOW,
    });
    // The SAME touch again — a restated edge side, a re-asserted tag. One row.
    recordLaneTouch(conn, {
      jobId,
      kind: "turn-tag",
      entityId: turnA,
      laneTag: "lane",
      createdAtEpoch: NOW + 1,
    });
    recordLaneTouch(conn, {
      jobId,
      kind: "lane",
      entityId: segment,
      laneTag: "lane",
      createdAtEpoch: NOW,
    });

    expect(conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lane_run_touches").get()!.n).toBe(2);

    const touches = loadRunLaneTouches(conn, jobId);
    expect([...touches.turnTagPairs]).toEqual([laneTouchTurnTagKey(turnA, "lane")]);
    expect([...touches.laneKeys]).toEqual([laneTouchSegmentTagKey(segment, "lane")]);

    // A DIFFERENT job sees none of it — the ledger is scoped to the job, and
    // to nothing narrower: `loadRunLaneTouches` takes no claim generation at
    // all, so a reclaimed claimant inherits its predecessor's obligation by
    // construction rather than by a comparison someone could get wrong.
    const other = loadRunLaneTouches(conn, jobId + 1_000);
    expect(other.turnTagPairs.size).toBe(0);
    expect(other.laneKeys.size).toBe(0);
    conn.close();
  });
});

describe("the lane_read_receipts page-coverage migration (phase-connectivity ticket 05)", () => {
  test("a legacy page_coverage-shaped table is rebuilt on the member-id shape, and its rows go with it", () => {
    const conn = db();
    // Put the PREDECESSOR shape back, rows and all — a database created by
    // the unreleased severed-lane ticket 02 build.
    conn.exec("DROP TABLE lane_read_receipts");
    conn.exec(`
      CREATE TABLE lane_read_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reader_id TEXT NOT NULL,
        segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        lane_tag TEXT NOT NULL,
        membership_snapshot TEXT NOT NULL CHECK (json_valid(membership_snapshot)),
        page_coverage TEXT NOT NULL CHECK (json_valid(page_coverage)),
        sequence INTEGER NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )`);
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    conn
      .query<unknown, [number]>(
        `INSERT INTO lane_read_receipts
           (reader_id, segment_id, lane_tag, membership_snapshot, page_coverage, sequence, created_at_epoch)
         VALUES ('claim:1:1', ?, 'lane', '[11,12,13]', '[1]', 1, 1)`,
      )
      .run(segment);

    initializeSchema(conn);

    const columns = conn
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('lane_read_receipts')")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("rendered_member_ids");
    expect(columns).not.toContain("page_coverage");
    // The legacy row is GONE rather than translated: a page number cannot be
    // turned into the ids that page showed, because the page SIZE that
    // produced it was never recorded — which is the defect itself.
    expect(
      conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lane_read_receipts").get()!.n,
    ).toBe(0);
    // And the new shape is writable, which a half-applied migration would not be.
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: [11, 12, 13],
      renderedTurnIds: [11],
      sequence: 1,
      createdAtEpoch: NOW,
    });
    expect(unreadLaneMembers(conn, "claim:1:1", segment, "lane", [11, 12, 13])).toEqual([12, 13]);
    conn.close();
  });
});

/**
 * PHASE-CONNECTIVITY TICKET 08, decision 4. The migration above ran
 * check-shape-then-unconditional-`DROP TABLE`, with nothing serializing the
 * two. `initializeSchema` runs from every entry point and Claude Code starts
 * two hook processes in parallel for a single event (the model documented at
 * `addColumnIfMissing` in db/schema.ts), so both could read the legacy shape:
 * one dropped and the other threw `no such table`, or the late one dropped a
 * table the early one had already recreated and was writing into.
 *
 * The fixture is two REAL PROCESSES contending for one SQLite write lock —
 * the ticket's own requirement, and the reason the test above (a single
 * connection, statements in the order the test body writes them) cannot
 * speak to this at all. The lock is what pins the interleaving: the parent
 * holds it while the racer's pre-check reads the legacy shape, so the racer
 * resumes with a belief that is exactly one commit out of date, which is the
 * losing side of the race in its worst form.
 */
describe("the lane_read_receipts migration under two concurrent initializations (ticket 08)", () => {
  test("the process that loses the race neither throws nor drops the winner's table", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-lane-receipt-race-"));
    const databasePath = join(directory, "memory.db");
    const readyMarkerPath = join(directory, "racer-ready");

    const setup = createDatabase(databasePath);
    initializeSchema(setup);
    const segment = createSegment(setup, { title: "seg", nowEpoch: NOW }).id;
    // The PREDECESSOR shape, as a database built by the unreleased
    // severed-lane ticket 02 carries it.
    setup.exec("DROP TABLE lane_read_receipts");
    setup.exec(`
      CREATE TABLE lane_read_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reader_id TEXT NOT NULL,
        segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        lane_tag TEXT NOT NULL,
        membership_snapshot TEXT NOT NULL CHECK (json_valid(membership_snapshot)),
        page_coverage TEXT NOT NULL CHECK (json_valid(page_coverage)),
        sequence INTEGER NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )`);
    setup.close();

    // The lock is taken BEFORE the racer exists, so the racer's shape
    // pre-check is guaranteed to run against the legacy table and its drop is
    // guaranteed to wait. Taking it afterwards would let the racer finish
    // first, which is a race nobody loses and therefore proves nothing.
    const winner = createDatabase(databasePath);
    winner.exec("BEGIN IMMEDIATE");

    const racer = Bun.spawn({
      cmd: [
        "bun",
        "run",
        join(import.meta.dir, "..", "support", "lane-receipt-migration-racer.ts"),
        databasePath,
        readyMarkerPath,
        String(segment),
      ],
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // The racer opens its connection and announces itself; the slack after
      // that is what puts it inside the migration, blocked on the lock this
      // process is about to take.
      const deadline = Date.now() + 20_000;
      while (!existsSync(readyMarkerPath)) {
        if (Date.now() > deadline) {
          throw new Error("the racer never announced itself");
        }
        await Bun.sleep(20);
      }

      await Bun.sleep(500);
      // The WINNER's own migration, inside the lock the racer is waiting on.
      winner.exec("DROP TABLE lane_read_receipts");
      winner.exec(`
        CREATE TABLE lane_read_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reader_id TEXT NOT NULL,
          segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
          lane_tag TEXT NOT NULL,
          membership_snapshot TEXT NOT NULL CHECK (json_valid(membership_snapshot)),
          rendered_member_ids TEXT NOT NULL CHECK (json_valid(rendered_member_ids)),
          sequence INTEGER NOT NULL,
          created_at_epoch INTEGER NOT NULL
        )`);
      winner
        .query<unknown, [number]>(
          `INSERT INTO lane_read_receipts
             (reader_id, segment_id, lane_tag, membership_snapshot, rendered_member_ids, sequence, created_at_epoch)
           VALUES ('claim:winner:1', ?, 'lane', '[7]', '[7]', 1, 1)`,
        )
        .run(segment);
      winner.exec("COMMIT");

      const exitCode = await racer.exited;
      const stderr = await new Response(racer.stderr).text();
      // NO THROW: a schema-init failure propagates out and takes the caller's
      // real work with it.
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      const rows = winner
        .query<{ readerId: string }, []>(
          "SELECT reader_id AS readerId FROM lane_read_receipts ORDER BY reader_id",
        )
        .all()
        .map((row) => row.readerId);
      // NO DROP OF A LIVE TABLE: the winner's row is still there, beside the
      // one the loser went on to write into the same table.
      expect(rows).toEqual(["claim:racer:1", "claim:winner:1"]);
      winner.close();
    } finally {
      racer.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
