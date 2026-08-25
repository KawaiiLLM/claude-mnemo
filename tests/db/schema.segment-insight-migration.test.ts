import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  getSegment,
  SEGMENT_FACET_REPAIR_BATCH,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

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

/**
 * Ticket 15 finding 3: the other half of the same K5a migration.
 *
 * Making `type`/`tags` derived from the members changed nothing for the
 * segments that already existed — they kept whatever the settlement agent had
 * typed, and `rebuildSearchIndex` reads the STORED fields, so the search facet
 * kept answering from them. The one-time backfill belongs in the migration that
 * introduced the derivation, and is delivered through the same
 * `segments.facets_stale` flag the cascade repair uses.
 */
describe("derived-facet backfill for segments written before K5a (ticket 15)", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(promptNumber: number, type: string[], tags: string[]): number {
    return db
      .query<{ id: number }, [number, number, string, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', 100, ?, ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, JSON.stringify(type), JSON.stringify(tags))!.id;
  }

  function readFtsExtra(segmentId: number): string {
    return (
      db
        .query<{ extra: string | null }, [number]>(
          "SELECT extra FROM memory_fts WHERE layer = 'segment' AND source_id = ?",
        )
        .get(segmentId)?.extra ?? ""
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-backfill",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  // The one-time backfill was built, measured against a copy of the live
  // database, and WITHDRAWN (user ruling, S15069/T766): all 45 live segments
  // derive to `[]` because their members were written by a path that never
  // recorded type/tags, so the backfill would erase their only structured
  // search facet to record an artefact of the old write path. This pins the
  // withdrawal, because "migrate and rederive" is the obvious thing for a
  // later reader to add back without knowing what it costs.
  test("the migration adds the flag and leaves a pre-existing model-stated facet alone", () => {
    const first = addTurn(1, ["design"], ["lease"]);
    const second = addTurn(2, ["implement"], ["lease", "fencing"]);
    const segment = createSegment(db, { title: "lease fencing", nowEpoch: 100 });
    addSegmentMembers(db, segment.id, [first, second], 100);

    // Put the database back into its pre-ticket-15 state: no staleness flag,
    // and facets a model typed rather than ones anything derived.
    db.exec("ALTER TABLE segments DROP COLUMN facets_stale");
    db.query("UPDATE segments SET type = ?, tags = ? WHERE id = ?").run(
      JSON.stringify(["research"]),
      JSON.stringify(["hand-typed-topic"]),
      segment.id,
    );
    db.query(
      "UPDATE memory_fts SET extra = 'research hand-typed-topic' WHERE layer = 'segment' AND source_id = ?",
    ).run(segment.id);

    initializeSchema(db);

    expect(getSegment(db, segment.id)?.type).toEqual(["research"]);
    expect(getSegment(db, segment.id)?.tags).toEqual(["hand-typed-topic"]);
    expect(readFtsExtra(segment.id)).toContain("hand-typed-topic");
    // Nothing is owed: the migration records no debt it did not observe.
    expect(
      db
        .query<{ facetsStale: number }, [number]>(
          "SELECT facets_stale AS facetsStale FROM segments WHERE id = ?",
        )
        .get(segment.id)?.facetsStale,
    ).toBe(0);
  });

  // Drives the backlog through the TRIGGER rather than the withdrawn backfill,
  // which is the production path anyway: a raw-SQL write to a member's facets
  // (hooks/capture-repair.ts does exactly this) flags every segment holding it.
  test("a backlog larger than one batch is finished by the following reloads, not dropped", () => {
    // Seeded with a DIFFERENT tag than the one written below: the trigger's
    // own `WHEN OLD.tags IS NOT NEW.tags` guard correctly ignores a write that
    // changes nothing, so a fixture that rewrites the same value owes nothing
    // and the batching would never be exercised.
    const member = addTurn(1, ["design"], ["before-the-write"]);
    const ids: number[] = [];
    for (let index = 0; index < SEGMENT_FACET_REPAIR_BATCH + 3; index += 1) {
      const segment = createSegment(db, { title: `arc ${index}`, nowEpoch: 100 });
      addSegmentMembers(db, segment.id, [member], 100);
      ids.push(segment.id);
    }
    // Ticket 14: a segment tag is globally unique (`idx_segments_tag_unique`),
    // so this fixture may not stamp the SAME word onto every segment any more.
    // `type` alone is what this test's derivation is about; the per-segment
    // tags below keep the rows distinct while still being non-empty.
    db.query("UPDATE segments SET type = ?").run(JSON.stringify(["research"]));
    for (const id of ids) {
      db.query<unknown, [string, number]>("UPDATE segments SET tags = ? WHERE id = ?").run(
        JSON.stringify([`hand-typed-topic-${id}`]),
        id,
      );
    }
    // One raw write to the shared member: the trigger owes every segment.
    db.query("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(["lease"]),
      member,
    );

    initializeSchema(db);
    const owedAfterFirst = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM segments WHERE facets_stale = 1",
      )
      .get().count;
    // One process start pays a bounded batch; the rest stays owed rather than
    // holding the write lock for the whole backlog.
    expect(owedAfterFirst).toBe(3);

    initializeSchema(db);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM segments WHERE facets_stale = 1",
        )
        .get().count,
    ).toBe(0);
    for (const id of ids) {
      const repaired = getSegment(db, id);
      // Rubric-v10 ticket 07: the repair sweep derives TYPE only — a
      // segment's tags are hand-curated identity now, so the raw-written
      // value SURVIVES the sweep instead of being re-derived from members.
      expect(repaired?.type).toEqual(["design"]);
      expect(repaired?.tags).toEqual([`hand-typed-topic-${id}`]);
    }
  });

  test("the backfill fires once: a second reload leaves a derived segment alone", () => {
    const member = addTurn(1, ["design"], ["lease"]);
    const segment = createSegment(db, { title: "lease fencing", nowEpoch: 100 });
    addSegmentMembers(db, segment.id, [member], 100);
    db.exec("ALTER TABLE segments DROP COLUMN facets_stale");
    initializeSchema(db);

    // A hand write between the two reloads is NOT reverted by the second one:
    // the flag is what says a derivation is owed, and nothing owes one here.
    db.query("UPDATE segments SET tags = ? WHERE id = ?").run(
      JSON.stringify(["set-by-hand"]),
      segment.id,
    );
    initializeSchema(db);
    expect(getSegment(db, segment.id)?.tags).toEqual(["set-by-hand"]);
  });
});
