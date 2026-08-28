import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

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
  hasFullLaneReadCoverage,
  hasLaneDispositionJustification,
  recordLaneDispositionJustification,
  recordLaneReadReceipt,
} from "../../src/db/lane-disposition";

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
    expect(hasLaneDispositionJustification(conn, segment, "lane", "fp-1")).toBe(false);
    recordLaneDispositionJustification(conn, {
      jobId,
      segmentId: segment,
      laneTag: "lane",
      componentFingerprint: "fp-1",
      representativeA: turnA,
      representativeB: turnB,
      reason: "two independent lines of work",
      createdAtEpoch: NOW,
    });
    expect(hasLaneDispositionJustification(conn, segment, "lane", "fp-1")).toBe(true);
    // A DIFFERENT fingerprint (the topology moved) is not covered by this row.
    expect(hasLaneDispositionJustification(conn, segment, "lane", "fp-2")).toBe(false);
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

describe("lane-read receipts — coverage accumulates page over page, never a one-shot requirement", () => {
  test("no receipt at all is not covered", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    expect(hasAnyLaneReadReceipt(conn, "claim:1:1", segment, "lane")).toBe(false);
    expect(hasFullLaneReadCoverage(conn, "claim:1:1", segment, "lane", 25)).toBe(false);
    conn.close();
  });

  test("a zero/negative member count is vacuously covered", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    expect(hasFullLaneReadCoverage(conn, "claim:1:1", segment, "lane", 0)).toBe(true);
    conn.close();
  });

  test("coverage accumulates ACROSS separate receipts (page 1 then page 2), never requiring one call to cover everything", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    // 25 members, page size 10 -> 3 pages required.
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: [1, 2, 3],
      pagesCovered: [1],
      sequence: 1,
      createdAtEpoch: NOW,
    });
    expect(hasFullLaneReadCoverage(conn, "claim:1:1", segment, "lane", 25)).toBe(false);
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: [4, 5, 6],
      pagesCovered: [2],
      sequence: 2,
      createdAtEpoch: NOW,
    });
    expect(hasFullLaneReadCoverage(conn, "claim:1:1", segment, "lane", 25)).toBe(false);
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: [7],
      pagesCovered: [3],
      sequence: 3,
      createdAtEpoch: NOW,
    });
    expect(hasFullLaneReadCoverage(conn, "claim:1:1", segment, "lane", 25)).toBe(true);
    conn.close();
  });

  test("a DIFFERENT reader's receipts do not count toward this reader's coverage", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: [1],
      pagesCovered: [1],
      sequence: 1,
      createdAtEpoch: NOW,
    });
    expect(hasAnyLaneReadReceipt(conn, "claim:9:9", segment, "lane")).toBe(false);
    conn.close();
  });
});
