import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { createSegment, getSegment } from "../../src/db/segments";

/**
 * Ticket 14 (spec K5): `segments.insight` reaches an EXISTING database.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
 * table, so a new column only arrives through `ensureSegmentInsightColumn`'s
 * ALTER. Every segment on disk today predates the column — the guard is that
 * the ALTER runs and the old row reads as "never stated one" rather than
 * blowing up every `SELECT` that names the column.
 */
function downgradeToPreInsightSegments(db: Database): void {
  db.exec("ALTER TABLE segments DROP COLUMN insight");
}

describe("segments.insight migration (ticket 14)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("an existing database gains the column, and its pre-existing rows read as NULL", () => {
    const before = createSegment(db, {
      title: "written before the column existed",
      content: "body",
      nowEpoch: 100,
    });
    downgradeToPreInsightSegments(db);
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(segments)")
        .all()
        .map((row) => row.name),
    ).not.toContain("insight");

    initializeSchema(db);

    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(segments)")
        .all()
        .map((row) => row.name),
    ).toContain("insight");
    expect(getSegment(db, before.id)?.insight).toBeNull();

    const after = createSegment(db, {
      title: "written after",
      insight: "clocks are not fences",
      nowEpoch: 200,
    });
    expect(getSegment(db, after.id)?.insight).toBe("clocks are not fences");
  });
});
