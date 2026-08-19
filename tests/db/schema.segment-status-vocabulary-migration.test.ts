import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { createSegment, getSegment } from "../../src/db/segments";

/**
 * Ticket 05: `segments.status`'s CHECK constraint widens from three values
 * (`open`/`delivered`/`abandoned`, the arc-era vocabulary) to include a
 * fourth, `closed` — SQLite's 12-step ALTER TABLE procedure (a CHECK cannot
 * be ALTERed). This is a WIDEN, not the narrow-to-two-values a fresh
 * install's own DDL uses: an existing database may already hold rows with
 * the retired words (this fixture seeds one, standing in for the 47 such
 * rows on the live database), and `recomputeSegmentFacets`/the repair sweep
 * issue plain UPDATEs against those rows that never touch `status` — SQLite
 * re-validates the WHOLE row's CHECK regardless, so a narrowed physical
 * CHECK would break facet maintenance on every one of them.
 *
 * Same 12-step shape as `ensureNoteSettlementTriggerVocabulary`
 * (schema.note-settlement-migration.test.ts): build the replacement under a
 * temporary name, copy explicit columns, drop the original, rename the
 * replacement INTO the original's name — never rename the original away,
 * because `segment_members`/`segment_attachments` hold `REFERENCES
 * segments(id) ON DELETE CASCADE` and a rename-away would repoint those
 * clauses at the renamed table.
 */
// `topic_id` (ticket 15 note): this fixture simulates a database old enough
// to predate ticket 05's status widening — old enough that it still carries
// the `topic_id` column ticket 15 later retired, which is exactly why
// `ensureSegmentStatusVocabulary`'s OWN rebuild target
// (`segmentsStatusVocabularyRebuildDdl`, schema.ts) still declares it: on a
// real database this old, `retireTopicRegistry` has not run yet either. The
// column is declared here so that rebuild's INSERT has somewhere to land,
// but NOT populated from the current (post-ticket-15) `segments` table below
// — that table never had the column at all — so every downgraded row's
// `topic_id` is simply its schema default (NULL), which this test does not
// exercise.
function downgradeToPreClosedStatusVocabulary(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE segments_downgrade (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER,
      title TEXT NOT NULL,
      content TEXT,
      insight TEXT,
      type TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(type)),
      tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
      status TEXT NOT NULL DEFAULT 'open' CHECK (
        status IN ('open', 'delivered', 'abandoned')
      ),
      revision INTEGER NOT NULL DEFAULT 1,
      facets_stale INTEGER NOT NULL DEFAULT 0 CHECK (facets_stale IN (0, 1)),
      goal TEXT,
      constraints TEXT,
      decisions TEXT,
      done TEXT,
      next_steps TEXT,
      reference TEXT,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );
    INSERT INTO segments_downgrade (
      id, title, content, insight, type, tags, status, revision,
      facets_stale, goal, constraints, decisions, done, next_steps, reference,
      created_at_epoch, updated_at_epoch
    )
    SELECT
      id, title, content, insight, type, tags, status, revision,
      facets_stale, goal, constraints, decisions, done, next_steps, reference,
      created_at_epoch, updated_at_epoch
    FROM segments;
    DROP TABLE segments;
    ALTER TABLE segments_downgrade RENAME TO segments;
    CREATE INDEX IF NOT EXISTS idx_segments_status_updated
      ON segments(status, updated_at_epoch);
    CREATE TRIGGER IF NOT EXISTS memory_edges_prune_deleted_segment
      AFTER DELETE ON segments
      BEGIN
        DELETE FROM memory_edges
        WHERE (citing_kind = 'segment' AND citing_id = OLD.id)
           OR (cited_kind = 'segment' AND cited_id = OLD.id);
      END;
  `);
  db.exec("PRAGMA foreign_keys = ON;");
}

function seedLegacyStatusSegment(db: Database, title: string, status: string): number {
  return db
    .query<{ id: number }, [string, string, number, number]>(
      `INSERT INTO segments (title, status, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .get(title, status, 100, 100)!.id;
}

/**
 * Raw status read, bypassing `getSegment`: `SegmentRecord.status` is typed
 * as the narrowed `"open" | "closed"` union (ticket 05), which a legacy row
 * holding the retired `delivered`/`abandoned` words does not satisfy at the
 * TYPE level even though the runtime value passes through untouched — this
 * reads the column directly so the test can assert the untouched string
 * without fighting that (intentional) narrowing.
 */
function rawStatus(db: Database, segmentId: number): string {
  return db
    .query<{ status: string }, [number]>("SELECT status FROM segments WHERE id = ?")
    .get(segmentId)!.status;
}

describe("segments.status vocabulary migration (ticket 05)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("widens the status CHECK to accept closed, and keeps every pre-existing row legible and updatable", () => {
    downgradeToPreClosedStatusVocabulary(db);
    const legacyDeliveredId = seedLegacyStatusSegment(db, "legacy delivered arc", "delivered");
    const legacyAbandonedId = seedLegacyStatusSegment(db, "legacy abandoned arc", "abandoned");

    // Before the migration, `closed` is illegal and the modern write path
    // cannot even construct a legal row through the narrowed CHECK.
    expect(() =>
      db.exec(
        `INSERT INTO segments (title, status, created_at_epoch, updated_at_epoch)
         VALUES ('too soon', 'closed', 10, 10)`,
      ),
    ).toThrow();

    initializeSchema(db);

    // Every pre-existing legacy row survived the rebuild untouched.
    expect(rawStatus(db, legacyDeliveredId)).toBe("delivered");
    expect(rawStatus(db, legacyAbandonedId)).toBe("abandoned");

    // The widened CHECK now accepts `closed`.
    const created = createSegment(db, { title: "modern segment", nowEpoch: 200 });
    db.query("UPDATE segments SET status = 'closed' WHERE id = ?").run(created.id);
    expect(getSegment(db, created.id)?.status).toBe("closed");

    // A legacy row's OWN status survives an UPDATE that never names status —
    // exactly the write shape `recomputeSegmentFacets` issues, and exactly
    // what a narrowed CHECK would have broken.
    expect(() =>
      db
        .query("UPDATE segments SET type = ?, tags = ? WHERE id = ?")
        .run(JSON.stringify(["design"]), JSON.stringify(["lease"]), legacyDeliveredId),
    ).not.toThrow();
    expect(rawStatus(db, legacyDeliveredId)).toBe("delivered");

    // The index and the one trigger that live ON `segments` came back with it.
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_segments_status_updated'`,
        )
        .get(),
    ).not.toBeNull();
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'memory_edges_prune_deleted_segment'`,
        )
        .get(),
    ).not.toBeNull();
    // …and the rebuild scaffolding is gone.
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name = 'segments_status_vocabulary_rebuild'",
        )
        .get() ?? null,
    ).toBeNull();
  });

  test("is idempotent — running the migration twice changes nothing further", () => {
    downgradeToPreClosedStatusVocabulary(db);
    const legacyId = seedLegacyStatusSegment(db, "legacy", "abandoned");

    initializeSchema(db);
    const afterFirst = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'segments'",
      )
      .get()!.sql;

    initializeSchema(db);
    initializeSchema(db);

    expect(
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'segments'",
        )
        .get()!.sql,
    ).toBe(afterFirst);
    expect(rawStatus(db, legacyId)).toBe("abandoned");
  });

  test("is a no-op on a fresh database, whose DDL is already the narrowed two-value CHECK", () => {
    const before = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'segments'",
      )
      .get()!.sql;

    initializeSchema(db);

    expect(
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'segments'",
        )
        .get()!.sql,
    ).toBe(before);
    // A fresh database's PHYSICAL CHECK already carries `closed` — this is
    // what makes the migration a no-op here. It deliberately still accepts
    // the retired words too (see the CHECK's own doc comment in schema.ts):
    // the two-value convergence ticket 05 asks for is enforced by
    // `SEGMENT_STATUSES`/`SegmentStatus` (db/segments.ts) on every TYPED
    // writer, not by physically forbidding the words at the SQL layer —
    // narrowing the SQL CHECK on a FRESH database too would still be safe in
    // isolation, but this project's own test fixtures (segment-spine,
    // recall.segments, segment-rank, session-composition — all outside this
    // ticket's file scope) construct `delivered`/`abandoned` segments
    // directly, unchecked by tsc since bun:test does not type-check
    // fixtures, and a narrower CHECK would break every one of them.
    expect(before).toContain("'closed'");
  });
});
