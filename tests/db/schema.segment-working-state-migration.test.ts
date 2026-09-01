import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  getAttachedSegmentIds,
  getSegment,
  getSegmentMemberTurnIds,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * Ticket 02 (ADR-0001/0005): the six Working State columns and the
 * `segment_attachments` binding table reach an EXISTING (production-shaped)
 * database.
 *
 * Every one of the six columns is plain nullable TEXT with no CHECK
 * referencing another column, so `ensureSegmentWorkingStateColumns`
 * (schema.ts) is a bare `ALTER TABLE ... ADD COLUMN` per column — the same
 * shape of migration as `election_tier` on `turns` (ticket 06), not the
 * 12-step rebuild `turns`' own type-column migration needed. This test proves
 * the ALTER path anyway, on production-shaped data (a segment with a member
 * and a topic), because a bare ALTER can still be gotten wrong (dropped rows,
 * a widened-but-not-actually-applied migration) even when it needs no
 * rebuild. `segment_attachments` is a brand-new table, reached instead
 * through `CREATE TABLE IF NOT EXISTS` — this test also proves a database
 * that predates it (and therefore never created it) gains it on the next
 * `initializeSchema`.
 */
function downgradeToPreWorkingStateSegments(db: Database): void {
  db.exec(`
    ALTER TABLE segments DROP COLUMN goal;
    ALTER TABLE segments DROP COLUMN constraints;
    ALTER TABLE segments DROP COLUMN decisions;
    ALTER TABLE segments DROP COLUMN done;
    ALTER TABLE segments DROP COLUMN next_steps;
    ALTER TABLE segments DROP COLUMN reference;
    DROP TABLE segment_attachments;
  `);
}

describe("segments Working State + attachment migration (ticket 02)", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "working-state-migration",
      project: "/tmp/project-working-state-migration",
      title: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    turnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', 100) RETURNING id`,
      )
      .get(sessionId, 1)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("an existing database gains the six columns and the binding table; pre-existing data survives untouched", () => {
    const before = createSegment(db, {
      title: "written before Working State existed",
      content: "body",
      nowEpoch: 100,
    });
    addSegmentMembers(db, before.id, [turnId], 100);

    downgradeToPreWorkingStateSegments(db);
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(segments)")
        .all()
        .map((row) => row.name),
    ).not.toContain("goal");
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'segment_attachments'",
        )
        .get(),
    ).toBeNull();

    initializeSchema(db);

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(segments)")
      .all()
      .map((row) => row.name);
    for (const column of ["goal", "constraints", "decisions", "done", "next_steps", "reference"]) {
      expect(columns).toContain(column);
    }
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'segment_attachments'",
        )
        .get(),
    ).not.toBeNull();

    // The pre-existing row — title, content and its member — survived the
    // ALTERs, and every new column reads NULL rather than blowing up.
    const reloaded = getSegment(db, before.id);
    expect(reloaded?.title).toBe("written before Working State existed");
    expect(reloaded?.content).toBe("body");
    expect(reloaded?.goal).toBeNull();
    expect(reloaded?.constraints).toBeNull();
    expect(reloaded?.reference).toBeNull();
    // The three RETIRED columns are still added by the migration (asserted on
    // `columns` above) — they are simply not on the record any more
    // (lane-impressions ticket 05).
    expect(getSegmentMemberTurnIds(db, before.id)).toEqual([turnId]);

    // Both new write paths work on the migrated row.
    const withGoal = appendSegmentWorkingStateRows(db, before.id, "goal", ["ship ticket 02"], 200);
    expect(withGoal?.goal).toBe("- ship ticket 02");

    const { attached } = attachSegmentToSession(db, sessionId, before.id, 200);
    expect(attached).toBe(true);
    expect(getAttachedSegmentIds(db, sessionId)).toEqual([before.id]);
  });

  test("is idempotent — running the migration twice changes nothing further", () => {
    const segment = createSegment(db, { title: "steady state", nowEpoch: 100 });
    appendSegmentWorkingStateRows(db, segment.id, "constraints", ["settled"], 100);
    attachSegmentToSession(db, sessionId, segment.id, 100);

    initializeSchema(db);
    const afterFirst = getSegment(db, segment.id);
    const attachmentsAfterFirst = getAttachedSegmentIds(db, sessionId);

    initializeSchema(db);
    initializeSchema(db);

    expect(getSegment(db, segment.id)).toEqual(afterFirst);
    expect(getAttachedSegmentIds(db, sessionId)).toEqual(attachmentsAfterFirst);
  });

  test("a fresh database (no downgrade) already carries every column and the table from creation", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);
    const columns = fresh
      .query<{ name: string }, []>("PRAGMA table_info(segments)")
      .all()
      .map((row) => row.name);
    for (const column of ["goal", "constraints", "decisions", "done", "next_steps", "reference"]) {
      expect(columns).toContain(column);
    }
    expect(
      fresh
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'segment_attachments'",
        )
        .get(),
    ).not.toBeNull();
    fresh.close();
  });
});
