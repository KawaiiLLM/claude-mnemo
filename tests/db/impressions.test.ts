import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  ackClaimedImpressionDebts,
  claimOpenImpressionDebtsForSegments,
  collapseImpressionDebtsToSurvivor,
  dbImpressionAnchorResolver,
  insertImpressionDebt,
  listOpenImpressionDebts,
  rekeyLaneImpressionDebts,
  releaseImpressionDebtClaims,
} from "../../src/db/impressions";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import { createSegment, type SegmentRecord } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * Lane-impressions ticket 01 — storage foundation: the additive schema (lane
 * impression columns, segment task-tier bookkeeping, the lifecycle-debt and
 * backfill-job tables) and the debt table's KEY SEMANTICS (rename re-key,
 * merge survivor-key, claim/release/ack). Writers land in tickets 02/03; this
 * suite pins the shapes they will write through.
 */

const EPOCH = 1_756_600_000;

function makeDb(): Database {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  return db;
}

function makeTask(db: Database, title: string): SegmentRecord {
  return createSegment(db, { title, tags: [title], nowEpoch: EPOCH });
}

function columnNames(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

// ---------------------------------------------------------------------------
// Schema: additive columns and tables.
// ---------------------------------------------------------------------------

describe("impression schema", () => {
  test("fresh database: lanes carry impression text + revision fence + origin + stale; segments carry the task-tier bookkeeping; both new tables exist", () => {
    const db = makeDb();
    const lanes = columnNames(db, "lanes");
    expect(lanes).toEqual(
      expect.arrayContaining([
        "impression",
        "impression_revision",
        "impression_origin",
        "impression_stale",
      ]),
    );
    const segments = columnNames(db, "segments");
    expect(segments).toEqual(
      expect.arrayContaining([
        "impression_revision",
        "impression_origin",
        "impression_stale",
      ]),
    );
    // The task-tier impression TEXT home is the EXISTING content column — no
    // second text home (spec "Storage").
    expect(segments).toContain("content");
    expect(segments).not.toContain("impression");

    for (const table of ["impression_debts", "impression_backfill_jobs"]) {
      expect(
        db
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table)?.name,
      ).toBe(table);
    }
    db.close();
  });

  test("a new lane row reads as 'no impression yet': text NULL, revision 0 (the CAS base), origin NULL, stale 0", () => {
    const db = makeDb();
    const task = makeTask(db, "task-a");
    insertLane(db, task.id, "alpha", EPOCH);
    const row = db
      .query<
        {
          impression: string | null;
          impression_revision: number;
          impression_origin: string | null;
          impression_stale: number;
        },
        [number]
      >(
        `SELECT impression, impression_revision, impression_origin, impression_stale
           FROM lanes WHERE segment_id = ?`,
      )
      .get(task.id)!;
    expect(row).toEqual({
      impression: null,
      impression_revision: 0,
      impression_origin: null,
      impression_stale: 0,
    });
    db.close();
  });

  test("EXISTING database path: an old-shape lanes table gains the columns additively, its rows untouched", () => {
    const db = createDatabase(":memory:");
    // The 0.27.0 lanes shape, verbatim minus the FK (no segments table exists
    // yet on this raw handle; the FK is irrelevant to the ALTER under test).
    db.exec(`
      CREATE TABLE lanes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(segment_id, tag)
      );
    `);
    db.query("INSERT INTO lanes (segment_id, tag, created_at_epoch) VALUES (1, 'alpha', ?)").run(
      EPOCH,
    );

    initializeSchema(db);

    const row = db
      .query<
        {
          tag: string;
          impression: string | null;
          impression_revision: number;
          impression_stale: number;
        },
        []
      >(
        "SELECT tag, impression, impression_revision, impression_stale FROM lanes",
      )
      .get()!;
    expect(row).toEqual({
      tag: "alpha",
      impression: null,
      impression_revision: 0,
      impression_stale: 0,
    });
    db.close();
  });

  test("initializeSchema is idempotent over the new shapes", () => {
    const db = makeDb();
    initializeSchema(db);
    expect(columnNames(db, "lanes").filter((c) => c === "impression")).toHaveLength(1);
    db.close();
  });

  // Lane-impressions ticket 05: `segments.impression_origin` keeps ONE job —
  // it marks whose the `content` bytes are — and `lanes.impression_origin`
  // keeps none. The CHECK still admits the now-unreachable 'backfill' value:
  // tightening it would mean rebuilding the table, which this batch's own
  // inert-column discipline refuses.
  test("origin vocabulary is still CHECK-bound, 'backfill' now unreachable but legal at the SQL level", () => {
    const db = makeDb();
    const task = makeTask(db, "task-a");
    insertLane(db, task.id, "alpha", EPOCH);
    expect(() =>
      db
        .query("UPDATE lanes SET impression_origin = 'manual' WHERE segment_id = ?")
        .run(task.id),
    ).toThrow();
    db.query("UPDATE lanes SET impression_origin = 'backfill' WHERE segment_id = ?").run(
      task.id,
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle debts: qualified key semantics.
// ---------------------------------------------------------------------------

describe("impression debts", () => {
  test("insert + open listing: lane debts key (segment, tag); task-tier debts key (segment, NULL)", () => {
    const db = makeDb();
    const task = makeTask(db, "task-a");
    insertImpressionDebt(db, { segmentId: task.id, laneTag: "alpha", kind: "declare", nowEpoch: EPOCH });
    insertImpressionDebt(db, { segmentId: task.id, laneTag: null, kind: "task-merge", nowEpoch: EPOCH + 1 });

    const open = listOpenImpressionDebts(db, task.id);
    expect(open).toHaveLength(2);
    expect(open[0]).toMatchObject({ laneTag: "alpha", kind: "declare", claimedByJobId: null, ackedAtEpoch: null });
    expect(open[1]).toMatchObject({ laneTag: null, kind: "task-merge" });
    db.close();
  });

  test("RENAME re-keys open debts to the new tag; an acked debt keeps the old key as audit; task-tier (NULL-key) debts do not move", () => {
    const db = makeDb();
    const task = makeTask(db, "task-a");
    const openDebt = insertImpressionDebt(db, { segmentId: task.id, laneTag: "old-tag", kind: "declare", nowEpoch: EPOCH });
    insertImpressionDebt(db, { segmentId: task.id, laneTag: null, kind: "task-retag", nowEpoch: EPOCH });
    // A discharged historical debt under the old key.
    claimOpenImpressionDebtsForSegments(db, [task.id], 77, EPOCH + 1);
    releaseImpressionDebtClaims(db, 77);
    insertImpressionDebt(db, { segmentId: task.id, laneTag: "old-tag", kind: "rename", nowEpoch: EPOCH + 2 });
    db.query("UPDATE impression_debts SET acked_at_epoch = ?, claimed_at_epoch = ?, claimed_by_job_id = 5 WHERE id = ?").run(
      EPOCH + 3,
      EPOCH + 3,
      openDebt.id,
    );

    const rekeyed = rekeyLaneImpressionDebts(db, task.id, "old-tag", "new-tag");
    expect(rekeyed).toBe(1); // the open rename debt; not the acked one, not the NULL key

    const open = listOpenImpressionDebts(db, task.id);
    expect(open.map((d) => d.laneTag).sort()).toEqual([null, "new-tag"].sort());
    const acked = db
      .query<{ laneTag: string | null }, [number]>(
        "SELECT lane_tag AS laneTag FROM impression_debts WHERE id = ?",
      )
      .get(openDebt.id)!;
    expect(acked.laneTag).toBe("old-tag");
    db.close();
  });

  test("MERGE leaves only the survivor's key: source-tag debts re-key, exact unclaimed duplicates collapse to the earliest, a claimed duplicate survives as its own row", () => {
    const db = makeDb();
    const task = makeTask(db, "task-a");
    insertImpressionDebt(db, { segmentId: task.id, laneTag: "keep", kind: "merge", nowEpoch: EPOCH });
    insertImpressionDebt(db, { segmentId: task.id, laneTag: "gone-1", kind: "merge", nowEpoch: EPOCH + 1 });
    insertImpressionDebt(db, { segmentId: task.id, laneTag: "gone-2", kind: "merge", nowEpoch: EPOCH + 2 });
    const claimed = insertImpressionDebt(db, { segmentId: task.id, laneTag: "gone-2", kind: "declare", nowEpoch: EPOCH + 3 });
    db.query("UPDATE impression_debts SET claimed_at_epoch = ?, claimed_by_job_id = 9 WHERE id = ?").run(
      EPOCH + 4,
      claimed.id,
    );

    const receipt = collapseImpressionDebtsToSurvivor(db, task.id, ["gone-1", "gone-2"], "keep");
    expect(receipt.rekeyed).toBe(3);
    expect(receipt.collapsed).toBe(2); // three unclaimed 'merge' rows became one

    const open = listOpenImpressionDebts(db, task.id);
    expect(open.every((debt) => debt.laneTag === "keep")).toBe(true);
    expect(open.filter((debt) => debt.kind === "merge")).toHaveLength(1);
    expect(open.find((debt) => debt.id === claimed.id)).toMatchObject({
      laneTag: "keep",
      claimedByJobId: 9,
    });
    db.close();
  });

  test("claim/release/ack discipline: a claim is exclusive, a failed run's release re-opens, a successful ack closes and keeps the claiming identity", () => {
    const db = makeDb();
    const taskA = makeTask(db, "task-a");
    const taskB = makeTask(db, "task-b");
    insertImpressionDebt(db, { segmentId: taskA.id, laneTag: "alpha", kind: "declare", nowEpoch: EPOCH });
    insertImpressionDebt(db, { segmentId: taskB.id, laneTag: "beta", kind: "declare", nowEpoch: EPOCH });

    const claimedByOne = claimOpenImpressionDebtsForSegments(db, [taskA.id], 1, EPOCH + 1);
    expect(claimedByOne).toHaveLength(1);
    expect(claimedByOne[0]).toMatchObject({ claimedByJobId: 1, claimedAtEpoch: EPOCH + 1 });
    // Job 2 attached to the same task claims nothing — the lease is exclusive.
    expect(claimOpenImpressionDebtsForSegments(db, [taskA.id], 2, EPOCH + 2)).toHaveLength(0);

    // Job 1 fails: its claims release; job 2 can now claim.
    expect(releaseImpressionDebtClaims(db, 1)).toBe(1);
    const reclaimed = claimOpenImpressionDebtsForSegments(db, [taskA.id], 2, EPOCH + 3);
    expect(reclaimed).toHaveLength(1);

    // Job 2's terminal commit acks ONLY its own claims.
    expect(ackClaimedImpressionDebts(db, 2, EPOCH + 4)).toBe(1);
    expect(listOpenImpressionDebts(db, taskA.id)).toHaveLength(0);
    expect(listOpenImpressionDebts(db, taskB.id)).toHaveLength(1);
    const audit = db
      .query<{ claimedByJobId: number }, [number]>(
        "SELECT claimed_by_job_id AS claimedByJobId FROM impression_debts WHERE segment_id = ?",
      )
      .get(taskA.id)!;
    expect(audit.claimedByJobId).toBe(2);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// The backfill-job table: INERT (lane-impressions ticket 05, user ruling
// S15069/T2320). It is still DECLARED — dropping a table is irreversible
// against live data and buys nothing, the same call the disposition ledger and
// the justify tables got — and no code path touches it any more.
// ---------------------------------------------------------------------------

describe("impression_backfill_jobs is inert", () => {
  test("the table exists, and db/impressions.ts exports no way to reach it", async () => {
    const db = makeDb();
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'impression_backfill_jobs'",
        )
        .get()?.name,
    ).toBe("impression_backfill_jobs");

    const moduleExports = Object.keys(await import("../../src/db/impressions"));
    expect(moduleExports.filter((name) => /Backfill/i.test(name))).toEqual([]);
    db.close();
  });

  test("a fresh schema leaves it empty — nothing enqueues on initialisation", () => {
    const db = makeDb();
    makeTask(db, "task-a");
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM impression_backfill_jobs")
        .get()!.n,
    ).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// The DB-backed anchor resolver (the existing citation-validation lookup).
// ---------------------------------------------------------------------------

describe("dbImpressionAnchorResolver", () => {
  test("resolves an existing turn's address and refuses a missing one", () => {
    const db = makeDb();
    const sessionId = upsertSession(db, {
      contentSessionId: "impression-anchors",
      project: "/projects/impressions",
      title: "anchors",
      insight: null,
      createdAtEpoch: EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch)
       VALUES (?, 3, 'extracted', 'asked', 'answered', ?)`,
    ).run(sessionId, EPOCH);

    const resolve = dbImpressionAnchorResolver(db);
    expect(resolve(sessionId, 3)).toBe(true);
    expect(resolve(sessionId, 4)).toBe(false);
    expect(resolve(sessionId + 999, 3)).toBe(false);
    db.close();
  });
});
