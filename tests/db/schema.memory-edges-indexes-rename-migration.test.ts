import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";

/**
 * The production shape `ensureMemoryEdgesIndexesRename` migrates away from
 * (indexes-rescope spec, `.scratch/indexes-rescope/spec.md`'s migration item
 * 1, ticket 01): the eight-word + `supersedes` contract flow-relations
 * ticket 03 shipped, `collects` still named in the CHECK and possibly still
 * stored on rows. Every row here is a CURRENT-vocabulary value already —
 * flow-relations tickets 02/03 already ran to completion in an earlier
 * release's open() before this one ever sees the database, the common,
 * incremental (one release at a time) upgrade path.
 */
const CONTRACT_MEMORY_EDGES_DDL = `
  CREATE TABLE memory_edges (
    citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
    cited_id INTEGER NOT NULL,
    relation TEXT CHECK (
      relation IS NULL OR
      relation IN (
        'override', 'narrows', 'extends', 'collects', 'consume',
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

/** The pre-flow-relations legacy shape — used to exercise a full-chain jump in one open(). */
const LEGACY_MEMORY_EDGES_DDL = `
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

interface EdgeRow {
  citingKind: string;
  citingId: number;
  citedKind: string;
  citedId: number;
  relation: string | null;
  provenance: string;
  createdAtEpoch: number;
}

function allEdges(db: Database): EdgeRow[] {
  return db
    .query<EdgeRow, []>(
      `SELECT
         citing_kind AS citingKind, citing_id AS citingId,
         cited_kind AS citedKind, cited_id AS citedId,
         relation, provenance, created_at_epoch AS createdAtEpoch
       FROM memory_edges ORDER BY citing_id, cited_id, relation`,
    )
    .all();
}

function relationsOf(db: Database, citingId: number): string[] {
  return allEdges(db)
    .filter((edge) => edge.citingId === citingId)
    .map((edge) => edge.relation ?? "(bare)")
    .sort();
}

describe("memory_edges indexes rename migration (indexes-rescope spec, ticket 01)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    db.exec(CONTRACT_MEMORY_EDGES_DDL);
    db.exec(`
      INSERT INTO memory_edges VALUES
        ('turn', 1, 'turn', 2, 'collects', 'asserted', 100),
        ('turn', 3, 'turn', 4, 'narrows', 'asserted', 200),
        ('turn', 5, 'turn', 6, 'extends', 'asserted', 300),
        ('turn', 7, 'turn', 8, 'consume', 'asserted', 400),
        ('turn', 9, 'turn', 10, 'grounds', 'asserted', 500),
        ('turn', 11, 'turn', 12, 'verifies', 'asserted', 600),
        ('turn', 13, 'turn', 14, 'refutes', 'asserted', 700),
        ('turn', 15, 'turn', 16, 'override', 'asserted', 800),
        ('turn', 17, 'turn', 18, 'supersedes', 'asserted', 900),
        ('turn', 19, 'turn', 20, NULL, 'text-ref', 1000),
        -- The non-collision control: this pair carries an UNRENAMED word
        -- (override) alongside the RENAMED one (collects) — grouping by pair
        -- alone (rather than pair+NEW-relation) would wrongly collapse these
        -- into one row. They must survive as two distinct rows.
        ('turn', 21, 'turn', 22, 'override', 'asserted', 1100),
        ('turn', 21, 'turn', 22, 'collects', 'judged', 1200);
    `);
  });

  afterEach(() => {
    db.close();
  });

  test("a collects-bearing CHECK rejects indexes; the migration renames it AND rebuilds the CHECK", () => {
    expect(() =>
      db.exec(
        "INSERT INTO memory_edges VALUES ('turn', 90, 'turn', 91, 'indexes', 'asserted', 50)",
      ),
    ).toThrow();

    initializeSchema(db);

    expect(storedTableSql(db)).toContain("'indexes'");
    expect(storedTableSql(db)).not.toContain("'collects'");

    expect(relationsOf(db, 1)).toEqual(["indexes"]);
    // Every other word survives untouched.
    expect(relationsOf(db, 3)).toEqual(["narrows"]);
    expect(relationsOf(db, 5)).toEqual(["extends"]);
    expect(relationsOf(db, 7)).toEqual(["consume"]);
    expect(relationsOf(db, 9)).toEqual(["grounds"]);
    expect(relationsOf(db, 11)).toEqual(["verifies"]);
    expect(relationsOf(db, 13)).toEqual(["refutes"]);
    expect(relationsOf(db, 15)).toEqual(["override"]);
    expect(relationsOf(db, 17)).toEqual(["supersedes"]);
    expect(relationsOf(db, 19)).toEqual(["(bare)"]);
    // The non-collision control: an unrenamed word (override) and a renamed
    // one (collects -> indexes) on the SAME pair survive as TWO rows, not
    // collapsed into one.
    expect(relationsOf(db, 21)).toEqual(["indexes", "override"]);

    // No row anywhere still carries the retired word's literal value.
    for (const edge of allEdges(db)) {
      expect(edge.relation).not.toBe("collects");
    }

    // The new word inserts cleanly; the retired one is now refused. Explicit
    // column list (rubric-v10 ticket 01): the post-migration table carries
    // `id`/`tags` too, which default cleanly when omitted from the list.
    db.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', 90, 'turn', 91, 'indexes', 'asserted', 50)`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
         VALUES ('turn', 92, 'turn', 93, 'collects', 'asserted', 55)`,
      ),
    ).toThrow();
  });

  /**
   * LOAD-BEARING CASE. `indexes` never existed as a stored word before this
   * migration (spec.md: "narrows/collects start empty" at flow-relations
   * ticket 02's own time, and no code path has ever written `indexes` since —
   * it is this ticket's own new word), so a `collects` row and a pre-existing
   * `indexes` row for the SAME pair cannot both exist going in: there is
   * nothing for the rename to collide against. Confirms the migration is
   * zero-loss (row count identical before/after) rather than merely
   * UNIQUE-safe by accident — contrast the flow-relations encodes/
   * grounded-on merge, which genuinely drops one row per collision.
   */
  test("zero row loss: renaming collects to indexes cannot collide, so no row is dropped", () => {
    const before = allEdges(db).length;
    initializeSchema(db);
    expect(allEdges(db).length).toBe(before);
  });

  test("the cited-side and bare-pair indexes survive the rebuild attached to the NEW table", () => {
    initializeSchema(db);
    const citedIndex = db
      .query<{ tblName: string }, []>(
        "SELECT tbl_name AS tblName FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_edges_cited'",
      )
      .get();
    expect(citedIndex?.tblName).toBe("memory_edges");
    const bareIndex = db
      .query<{ tblName: string }, []>(
        "SELECT tbl_name AS tblName FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_edges_bare_pair'",
      )
      .get();
    expect(bareIndex?.tblName).toBe("memory_edges");
  });

  test("idempotent: a second initializeSchema is a byte-for-byte no-op", () => {
    initializeSchema(db);
    const afterFirst = allEdges(db);
    const ddlAfterFirst = storedTableSql(db);

    initializeSchema(db);
    initializeSchema(db);

    expect(allEdges(db)).toEqual(afterFirst);
    expect(storedTableSql(db)).toBe(ddlAfterFirst);
    // A rebuild that ran again would have left the temporary table behind on
    // its way through, so its absence is the cheap check that nothing ran.
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edges_pre_vocabulary_flip'`,
        )
        .get()!.count,
    ).toBe(0);
  });

  test("a fresh database is born already speaking indexes, never collects", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);

    expect(storedTableSql(fresh)).toContain("'indexes'");
    expect(storedTableSql(fresh)).not.toContain("'collects'");
    fresh.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', 1, 'turn', 2, 'indexes', 'asserted', 100)`,
    );
    expect(() =>
      fresh.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
         VALUES ('turn', 3, 'turn', 4, 'collects', 'asserted', 100)`,
      ),
    ).toThrow();
    fresh.close();
  });

  test("a full-chain jump in one open (legacy pre-flow-relations shape straight to indexes) renames cleanly, no crash", () => {
    const legacy = createDatabase(":memory:");
    legacy.exec(LEGACY_MEMORY_EDGES_DDL);
    legacy.exec(`
      INSERT INTO memory_edges VALUES
        ('turn', 1, 'turn', 2, 'depends-on', 'asserted', 100),
        ('turn', 3, 'turn', 4, 'override', 'asserted', 200),
        ('turn', 5, 'turn', 6, NULL, 'text-ref', 300);
    `);

    initializeSchema(legacy);

    expect(storedTableSql(legacy)).toContain("'indexes'");
    expect(storedTableSql(legacy)).not.toContain("'collects'");
    expect(storedTableSql(legacy)).not.toContain("'depends-on'");
    expect(
      legacy
        .query<{ relation: string | null }, [number]>(
          "SELECT relation FROM memory_edges WHERE citing_id = ?",
        )
        .get(1)?.relation,
    ).toBe("consume");
    // No `collects` row can exist yet on this path (the word was never
    // stored pre-migration), so this is really just re-confirming the
    // chain reaches the final CHECK without throwing.
    expect(
      legacy.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all(),
    ).toEqual([]);
    legacy.close();
  });

  test("PRAGMA foreign_key_check stays clean across the rebuild", () => {
    initializeSchema(db);
    expect(
      db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all(),
    ).toEqual([]);
  });
});
