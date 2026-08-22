import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";

/**
 * The pre-ticket-01 production shape (indexes-rescope's final word list,
 * ticket 01's own starting point): no surrogate `id`, no `tags` column,
 * identity is (pair, relation) alone. `ensureMemoryEdgesTagSetIdentity`
 * (schema.ts) migrates every database still shaped like this.
 */
const PRE_TAG_IDENTITY_MEMORY_EDGES_DDL = `
  CREATE TABLE memory_edges (
    citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
    cited_id INTEGER NOT NULL,
    relation TEXT CHECK (
      relation IS NULL OR
      relation IN (
        'override', 'narrows', 'extends', 'indexes', 'consume',
        'grounds', 'verifies', 'refutes', 'supersedes'
      )
    ),
    provenance TEXT NOT NULL CHECK (
      provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
    ),
    created_at_epoch INTEGER NOT NULL,
    CHECK (citing_kind <> cited_kind OR citing_id <> cited_id OR relation IS NOT NULL),
    UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation)
  );
  CREATE INDEX idx_memory_edges_cited
    ON memory_edges(cited_kind, cited_id, relation);
  CREATE UNIQUE INDEX idx_memory_edges_bare_pair
    ON memory_edges(citing_kind, citing_id, cited_kind, cited_id)
    WHERE relation IS NULL;
`;

function storedTableSql(db: Database): string {
  return (
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? ""
  );
}

interface LegacyEdgeRow {
  citingKind: string;
  citingId: number;
  citedKind: string;
  citedId: number;
  relation: string | null;
  provenance: string;
  createdAtEpoch: number;
}

interface NewEdgeRow extends LegacyEdgeRow {
  id: number;
  tags: string;
}

function allLegacyEdges(db: Database): LegacyEdgeRow[] {
  return db
    .query<LegacyEdgeRow, []>(
      `SELECT
         citing_kind AS citingKind, citing_id AS citingId,
         cited_kind AS citedKind, cited_id AS citedId,
         relation, provenance, created_at_epoch AS createdAtEpoch
       FROM memory_edges ORDER BY citing_id, cited_id, relation`,
    )
    .all();
}

function allNewEdges(db: Database): NewEdgeRow[] {
  return db
    .query<NewEdgeRow, []>(
      `SELECT
         id, citing_kind AS citingKind, citing_id AS citingId,
         cited_kind AS citedKind, cited_id AS citedId,
         relation, provenance, tags, created_at_epoch AS createdAtEpoch
       FROM memory_edges ORDER BY citing_id, cited_id, relation`,
    )
    .all();
}

describe("memory_edges tag-set identity migration (rubric-v10 ticket 01)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    db.exec(PRE_TAG_IDENTITY_MEMORY_EDGES_DDL);
    db.exec(`
      INSERT INTO memory_edges VALUES
        ('turn', 1, 'turn', 2, 'consume', 'asserted', 100),
        ('turn', 3, 'turn', 4, 'grounds', 'judged', 200),
        ('turn', 5, 'turn', 6, 'override', 'asserted', 300),
        ('turn', 7, 'turn', 8, NULL, 'text-ref', 400),
        -- A pair holding TWO relations (legal under the pre-ticket-01 key
        -- already): the migration must not collapse or drop either.
        ('turn', 9, 'turn', 10, 'consume', 'asserted', 500),
        ('turn', 9, 'turn', 10, 'grounds', 'asserted', 600),
        ('turn', 11, 'segment', 1, 'indexes', 'judged', 700),
        ('session', 1, 'segment', 2, 'consume', 'asserted', 800);
    `);
  });

  afterEach(() => {
    db.close();
  });

  test("adds `id` and `tags` (defaulted to the empty set) with ZERO data change to every existing column/row", () => {
    const before = allLegacyEdges(db);
    expect(before).toHaveLength(8);

    initializeSchema(db);

    const after = allNewEdges(db);
    expect(after).toHaveLength(before.length);

    // Every pre-existing column's VALUE is byte-identical, row for row (same
    // ORDER BY on both sides makes this a positional comparison).
    for (let index = 0; index < before.length; index += 1) {
      const legacy = before[index]!;
      const migrated = after[index]!;
      expect(migrated.citingKind).toBe(legacy.citingKind);
      expect(migrated.citingId).toBe(legacy.citingId);
      expect(migrated.citedKind).toBe(legacy.citedKind);
      expect(migrated.citedId).toBe(legacy.citedId);
      expect(migrated.relation).toBe(legacy.relation);
      expect(migrated.provenance).toBe(legacy.provenance);
      expect(migrated.createdAtEpoch).toBe(legacy.createdAtEpoch);
      // The migration's own contract: every existing row lands untagged.
      expect(migrated.tags).toBe("[]");
    }

    // Every row gets a distinct surrogate id.
    expect(new Set(after.map((row) => row.id)).size).toBe(after.length);
  });

  test("the rebuilt CHECK/UNIQUE constraint now includes tags in identity — a differently-tagged row on an existing (pair, relation) is legal", () => {
    initializeSchema(db);

    expect(storedTableSql(db)).toContain("tags TEXT NOT NULL");
    expect(() =>
      db.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
         VALUES ('turn', 1, 'turn', 2, 'consume', 'asserted', '["laneA"]', 900)`,
      ),
    ).not.toThrow();
    expect(countRows(db)).toBe(9);

    // The untagged row and the {laneA} row are two DISTINCT rows on the same
    // (pair, relation) — confirming the widened uniqueness key, not merely
    // that the insert succeeded.
    const relatedRows = db
      .query<{ tags: string }, [number, number]>(
        `SELECT tags FROM memory_edges
         WHERE citing_kind = 'turn' AND citing_id = 1
           AND cited_kind = 'turn' AND cited_id = 2`,
      )
      .all(1, 2);
    expect(relatedRows.map((row) => row.tags).sort()).toEqual(['["laneA"]', "[]"]);
  });

  function countRows(database: Database): number {
    return (
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_edges").get()
        ?.count ?? 0
    );
  }

  test("memory_edge_tags is created (empty — every migrated row is untagged)", () => {
    initializeSchema(db);

    const tableExists = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_edge_tags'",
      )
      .get();
    expect(tableExists?.name).toBe("memory_edge_tags");

    const rowCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_edge_tags")
      .get()?.count;
    expect(rowCount).toBe(0);
  });

  test("PRAGMA integrity_check and foreign_key_check stay clean across the rebuild", () => {
    initializeSchema(db);

    expect(
      db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all(),
    ).toEqual([{ integrity_check: "ok" }]);
    expect(
      db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all(),
    ).toEqual([]);
  });

  test("idempotent: a second (and third) initializeSchema is a byte-for-byte no-op", () => {
    initializeSchema(db);
    const afterFirst = allNewEdges(db);
    const ddlAfterFirst = storedTableSql(db);

    initializeSchema(db);
    initializeSchema(db);

    expect(allNewEdges(db)).toEqual(afterFirst);
    expect(storedTableSql(db)).toBe(ddlAfterFirst);
    // A rebuild that ran again would have left the temporary table behind on
    // its way through, so its absence is the cheap check that nothing ran.
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edges_pre_tag_identity'`,
        )
        .get()!.count,
    ).toBe(0);
  });

  test("a fresh database is born already carrying id/tags, never needing this migration", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);

    expect(storedTableSql(fresh)).toContain("tags TEXT NOT NULL");
    const row = fresh
      .query<{ id: number; tags: string }, []>(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
         VALUES ('turn', 1, 'turn', 2, 'consume', 'asserted', 100)
         RETURNING id, tags`,
      )
      .get();
    expect(row?.tags).toBe("[]");
    expect(row?.id).toBeGreaterThan(0);
    fresh.close();
  });

  test("a full-chain jump in one open (legacy pre-flow-relations shape straight to tag-set identity) migrates cleanly, no crash", () => {
    const legacy = createDatabase(":memory:");
    legacy.exec(`
      CREATE TABLE memory_edges (
        citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
        citing_id INTEGER NOT NULL,
        cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
        cited_id INTEGER NOT NULL,
        relation TEXT CHECK (
          relation IS NULL OR
          relation IN (
            'evidence-for', 'evidence-against', 'supersedes', 'depends-on',
            'refines', 'override', 'encodes', 'grounded-on'
          )
        ),
        provenance TEXT NOT NULL CHECK (
          provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
        ),
        created_at_epoch INTEGER NOT NULL,
        CHECK (citing_kind <> cited_kind OR citing_id <> cited_id OR relation IS NOT NULL),
        UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation)
      );
      CREATE INDEX idx_memory_edges_cited
        ON memory_edges(cited_kind, cited_id, relation);
      CREATE UNIQUE INDEX idx_memory_edges_bare_pair
        ON memory_edges(citing_kind, citing_id, cited_kind, cited_id)
        WHERE relation IS NULL;
      INSERT INTO memory_edges VALUES
        ('turn', 1, 'turn', 2, 'depends-on', 'asserted', 100),
        ('turn', 3, 'turn', 4, 'override', 'asserted', 200),
        ('turn', 5, 'turn', 6, NULL, 'text-ref', 300);
    `);

    initializeSchema(legacy);

    expect(storedTableSql(legacy)).toContain("tags TEXT NOT NULL");
    const rows = legacy
      .query<{ tags: string }, []>("SELECT tags FROM memory_edges")
      .all();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.tags).toBe("[]");
    }
    expect(
      legacy.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all(),
    ).toEqual([]);
    legacy.close();
  });
});
