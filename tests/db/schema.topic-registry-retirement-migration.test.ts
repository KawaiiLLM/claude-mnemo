import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment, getSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";

/**
 * Ticket 15 (topic registry retirement, CONTEXT.md "Topic — retired").
 *
 * `topics` and `segments.topic_id` never exist on a fresh install (they are
 * gone from SCHEMA_SQL); an EXISTING database still carrying them gets a
 * ONE-TIME migration (`retireTopicRegistry`, schema.ts) that folds each
 * segment's topic NAME into its tags — the surviving mechanism — before the
 * registry itself is dropped.
 *
 * `downgradeToLegacyTopicRegistry` hand-builds the pre-ticket-15 shape on a
 * database `initializeSchema` has ALREADY brought current (so every other
 * migration this release ships is already a no-op) — the same "add the old
 * shape back, then re-run initializeSchema" idiom
 * `schema.segment-insight-migration.test.ts`'s own downgrade helper uses,
 * `ALTER TABLE ... DROP COLUMN`'s inverse (`ADD COLUMN`, always legal SQLite,
 * no rebuild needed to simulate the legacy shape even though production code
 * itself avoids `DROP COLUMN` for the version-floor reason documented on
 * `retireTurnCitesRecordedColumn`).
 */
function downgradeToLegacyTopicRegistry(db: Database): void {
  db.exec(`
    CREATE TABLE topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      aliases TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );
    ALTER TABLE segments ADD COLUMN topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL;
  `);
}

function insertLegacyTopic(db: Database, name: string): number {
  return db
    .query<{ id: number }, [string, number, number]>(
      `INSERT INTO topics (name, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?) RETURNING id`,
    )
    .get(name, 100, 100)!.id;
}

function setSegmentTopic(db: Database, segmentId: number, topicId: number): void {
  db.query("UPDATE segments SET topic_id = ? WHERE id = ?").run(topicId, segmentId);
}

describe("topic registry retirement migration (ticket 15)", () => {
  let db: Database;
  let sessionId: number;

  function addTurn(promptNumber: number, tags: string[] = []): number {
    return db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', 100, '[]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, JSON.stringify(tags))!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "topic-retirement-session",
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

  test("a fresh install never creates topics or segments.topic_id", () => {
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'topics'",
        )
        .get(),
    ).toBeNull();
    expect(
      db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('segments')")
        .all()
        .map((row) => row.name),
    ).not.toContain("topic_id");
  });

  test("folds a segment's topic name into its members' tags (normalized, deduped) and drops the registry — zero row loss", () => {
    const memberA = addTurn(1, ["existing"]);
    const memberB = addTurn(2, []);
    const segment = createSegment(db, { title: "the segment", nowEpoch: 100 });
    addSegmentMembers(db, segment.id, [memberA, memberB], 100);

    downgradeToLegacyTopicRegistry(db);
    const topicId = insertLegacyTopic(db, "My Cool Topic");
    setSegmentTopic(db, segment.id, topicId);

    const segmentCountBefore = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments")
      .get()!.count;
    const turnCountBefore = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns")
      .get()!.count;

    initializeSchema(db);

    // The registry is gone.
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'topics'",
        )
        .get(),
    ).toBeNull();
    expect(
      db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('segments')")
        .all()
        .map((row) => row.name),
    ).not.toContain("topic_id");

    // Zero row loss: same segment/turn counts, same ids, membership intact.
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segments").get()!.count,
    ).toBe(segmentCountBefore);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns").get()!.count,
    ).toBe(turnCountBefore);
    expect(getSegment(db, segment.id)).not.toBeNull();

    // The topic name survives, normalized (lowercase, hyphenated), as a bare
    // tag — folded into the member turns and derived up onto the segment.
    const memberATags: string[] = JSON.parse(
      db.query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?").get(memberA)!.tags,
    );
    const memberBTags: string[] = JSON.parse(
      db.query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?").get(memberB)!.tags,
    );
    expect(memberATags).toContain("my-cool-topic");
    expect(memberATags).toContain("existing");
    expect(memberBTags).toContain("my-cool-topic");

    expect(getSegment(db, segment.id)?.tags).toContain("my-cool-topic");
  });

  test("a topic name already present as a tag (case-insensitively) is not duplicated", () => {
    const member = addTurn(1, ["Already-Here"]);
    const segment = createSegment(db, { title: "the segment", nowEpoch: 100 });
    addSegmentMembers(db, segment.id, [member], 100);

    downgradeToLegacyTopicRegistry(db);
    const topicId = insertLegacyTopic(db, "already-here");
    setSegmentTopic(db, segment.id, topicId);

    initializeSchema(db);

    const tags: string[] = JSON.parse(
      db.query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?").get(member)!.tags,
    );
    expect(tags.filter((tag) => tag.toLowerCase() === "already-here")).toHaveLength(1);
  });

  // Ticket 15's own flagged caveat: a segment with ZERO members has no member
  // turn to fold the tag into, so this writes directly onto the segment's own
  // `tags` — the one write in this migration not proof against a future
  // recompute (documented on `foldTopicNamesIntoSegmentTags`, schema.ts).
  test("a zero-member segment's topic name folds directly onto the segment's own tags", () => {
    const segment = createSegment(db, { title: "memberless", nowEpoch: 100 });

    downgradeToLegacyTopicRegistry(db);
    const topicId = insertLegacyTopic(db, "no members here");
    setSegmentTopic(db, segment.id, topicId);

    initializeSchema(db);

    expect(getSegment(db, segment.id)?.tags).toContain("no-members-here");
  });

  test("is idempotent — running the migration twice changes nothing further", () => {
    const member = addTurn(1);
    const segment = createSegment(db, { title: "the segment", nowEpoch: 100 });
    addSegmentMembers(db, segment.id, [member], 100);

    downgradeToLegacyTopicRegistry(db);
    const topicId = insertLegacyTopic(db, "steady-state");
    setSegmentTopic(db, segment.id, topicId);

    initializeSchema(db);
    const afterFirst = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'segments'",
      )
      .get()!.sql;
    const tagsAfterFirst = getSegment(db, segment.id)?.tags;

    initializeSchema(db);
    initializeSchema(db);

    expect(
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'segments'",
        )
        .get()!.sql,
    ).toBe(afterFirst);
    expect(getSegment(db, segment.id)?.tags).toEqual(tagsAfterFirst);
  });

  // Acceptance criterion 5 (backward compat): recall by `tag:` finds a
  // segment whose folded topic-name tag matches — the registry's old
  // resolution role now lives entirely on the tag axis every other reader
  // already uses.
  test("recall's tag: filter finds a segment by its folded topic-name tag", () => {
    const member = addTurn(1);
    const segment = createSegment(db, { title: "findable by its old topic", nowEpoch: 100 });
    addSegmentMembers(db, segment.id, [member], 100);

    downgradeToLegacyTopicRegistry(db);
    const topicId = insertLegacyTopic(db, "Segment Redesign");
    setSegmentTopic(db, segment.id, topicId);

    initializeSchema(db);

    const output = recallMemory(db, { filter: { tag: "segment-redesign" } });
    expect(output).toContain(`E${segment.id}`);
  });
});
