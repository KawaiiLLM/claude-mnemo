import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";

/**
 * The pre-ticket-01 production shape (indexes-rescope's final word list,
 * ticket 01's own starting point): no surrogate `id`, no lane column at all,
 * identity is (pair, relation) alone. `ensureMemoryEdgesTagSetIdentity`
 * (schema.ts) migrates every database still shaped like this.
 *
 * Every test below drives the FULL `initializeSchema`, so what it observes is
 * the end of the whole chain — which since lane-model-v12 ticket 09 means the
 * merged `tags` set this migration introduced has already been replaced by
 * `tail_tag`/`head_tag` before control returns. The assertions therefore name
 * the lane surface the chain LANDS, while the property each one tests
 * (surrogate ids, lanes in the identity key, zero data change) is this
 * migration's own and unchanged.
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
  /**
   * lane-model-v12 ticket 09: the merged `tags` column this migration
   * introduced no longer exists at the END of a full open — M-E is the last
   * phase `initializeSchema` runs, and every test here goes through that
   * entry point. What the chain lands instead is the two SIDES, unsettled for
   * every row this migration created (it lands them all untagged, and M-A
   * turns "untagged" into "both sides `''`").
   */
  tailTag: string;
  headTag: string;
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
         relation, provenance, tail_tag AS tailTag, head_tag AS headTag,
         created_at_epoch AS createdAtEpoch
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
        -- [S15069/T1728] These two keep their CROSS-KIND shapes, which is what
        -- they are here to prove survives the rebuild, but lose their relation
        -- words: D10 narrowed a relation-carrying row to turn->turn, so a
        -- cross-kind row can now only exist BARE. The variety under test is the
        -- endpoint kinds, not the words, so nothing this test measures moves.
        ('turn', 11, 'segment', 1, NULL, 'text-ref', 700),
        ('session', 1, 'segment', 2, NULL, 'text-ref', 800);
    `);
  });

  afterEach(() => {
    db.close();
  });

  test("adds `id` and the lane columns (all unsettled) with ZERO data change to every existing column/row", () => {
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
      // The migration's own contract: every existing row lands untagged —
      // which, once the chain's later phases have run, reads as both sides
      // carrying the unsettled sentinel.
      expect(migrated.tailTag).toBe("");
      expect(migrated.headTag).toBe("");
    }

    // Every row gets a distinct surrogate id.
    expect(new Set(after.map((row) => row.id)).size).toBe(after.length);
  });

  test("the rebuilt UNIQUE keeps lanes in identity — a differently-LANED row on an existing (pair, relation) is legal", () => {
    initializeSchema(db);

    // This migration widened identity with the merged tag set; ticket 09's
    // M-E swapped that component for the two sides at the end of the same
    // open. The PROPERTY under test is unchanged — a pair/relation may hold
    // several rows, one per lane attribution — so the assertion follows the
    // column that carries it rather than the one that used to.
    expect(storedTableSql(db)).toContain("tail_tag TEXT NOT NULL");
    expect(storedTableSql(db)).not.toContain("tags TEXT NOT NULL");
    expect(() =>
      db.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tail_tag, head_tag, created_at_epoch)
         VALUES ('turn', 1, 'turn', 2, 'consume', 'asserted', 'laneA', 'laneA', 900)`,
      ),
    ).not.toThrow();
    expect(countRows(db)).toBe(9);

    // The unsettled row and the laneA row are two DISTINCT rows on the same
    // (pair, relation) — confirming the uniqueness key, not merely that the
    // insert succeeded.
    const relatedRows = db
      .query<{ tailTag: string }, [number, number]>(
        `SELECT tail_tag AS tailTag FROM memory_edges
         WHERE citing_kind = 'turn' AND citing_id = 1
           AND cited_kind = 'turn' AND cited_id = 2`,
      )
      .all(1, 2);
    expect(relatedRows.map((row) => row.tailTag).sort()).toEqual(["", "laneA"]);
  });

  function countRows(database: Database): number {
    return (
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_edges").get()
        ?.count ?? 0
    );
  }

  /**
   * The merged index this migration created is created and then RETIRED
   * inside one open (lane-model-v12 ticket 09): `ensureMemoryEdgesSchema`
   * only builds it while the column it indexes is still there, and M-E drops
   * both at the end of the chain. What a caller finds afterwards is the SIDE
   * index — empty here for the same reason the old one was, every migrated
   * row being unattributed.
   */
  test("memory_edge_tags does not survive the open that creates it; the side index does", () => {
    initializeSchema(db);

    const tableNames = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('memory_edge_tags', 'memory_edge_side_tags')`,
      )
      .all()
      .map((row) => row.name);
    expect(tableNames).toEqual(["memory_edge_side_tags"]);

    const rowCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_edge_side_tags")
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

  test("a fresh database ends its first open with id and both lane columns, never needing this migration", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);

    expect(storedTableSql(fresh)).toContain("tail_tag TEXT NOT NULL");
    const row = fresh
      .query<{ id: number; tailTag: string; headTag: string }, []>(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
         VALUES ('turn', 1, 'turn', 2, 'consume', 'asserted', 100)
         RETURNING id, tail_tag AS tailTag, head_tag AS headTag`,
      )
      .get();
    expect(row?.tailTag).toBe("");
    expect(row?.headTag).toBe("");
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

    expect(storedTableSql(legacy)).toContain("tail_tag TEXT NOT NULL");
    const rows = legacy
      .query<{ tailTag: string; headTag: string }, []>(
        "SELECT tail_tag AS tailTag, head_tag AS headTag FROM memory_edges",
      )
      .all();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.tailTag).toBe("");
      expect(row.headTag).toBe("");
    }
    expect(
      legacy.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all(),
    ).toEqual([]);
    legacy.close();
  });
});
