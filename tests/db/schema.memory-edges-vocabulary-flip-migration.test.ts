import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";

/**
 * The production shape `ensureMemoryEdgesVocabularyFlip` exists for
 * (flow-relations spec, ticket 02's "expand half"): (pair, relation)
 * identity and the self-loop CHECK already in place (ticket 05's shape),
 * relation CHECK still carrying only the eight retired words. Without this
 * migration, every renamed word (consume/verifies/refutes/grounds/extends)
 * is rejected at the INSERT and no existing row is ever renamed.
 */
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

describe("memory_edges vocabulary flip migration (flow-relations spec, ticket 02)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    db.exec(LEGACY_MEMORY_EDGES_DDL);
    db.exec(`
      INSERT INTO memory_edges VALUES
        ('turn', 1, 'turn', 2, 'depends-on', 'asserted', 100),
        ('turn', 3, 'turn', 4, 'evidence-for', 'asserted', 200),
        ('turn', 5, 'turn', 6, 'evidence-against', 'asserted', 300),
        ('turn', 7, 'turn', 8, 'grounded-on', 'asserted', 400),
        ('turn', 9, 'turn', 10, 'refines', 'asserted', 500),
        ('turn', 11, 'turn', 12, 'override', 'asserted', 600),
        ('turn', 13, 'turn', 14, 'supersedes', 'asserted', 700),
        ('turn', 15, 'turn', 16, NULL, 'text-ref', 800),
        -- The merge collision: this pair carries BOTH encodes and
        -- grounded-on, which the migration must collapse to ONE grounds
        -- row rather than violate the UNIQUE (pair, relation) constraint.
        ('turn', 17, 'turn', 18, 'encodes', 'judged', 1000),
        ('turn', 17, 'turn', 18, 'grounded-on', 'asserted', 900),
        -- The non-collision control: this pair carries an UNRENAMED word
        -- (override) alongside a RENAMED one (depends-on) — grouping by
        -- pair alone (rather than by pair+NEW-relation) would wrongly
        -- collapse these two into one row and silently drop a relation
        -- nobody merged. They must survive as two distinct rows.
        ('turn', 19, 'turn', 20, 'override', 'asserted', 1100),
        ('turn', 19, 'turn', 20, 'depends-on', 'judged', 1200);
    `);
  });

  afterEach(() => {
    db.close();
  });

  test("an eight-word CHECK rejects the new vocabulary; the migration widens it AND renames every existing row", () => {
    expect(() =>
      db.exec(
        "INSERT INTO memory_edges VALUES ('turn', 90, 'turn', 91, 'narrows', 'asserted', 50)",
      ),
    ).toThrow();

    initializeSchema(db);

    expect(storedTableSql(db)).toContain("'narrows'");
    // `initializeSchema` runs the FULL chain, flow-relations ticket 03's
    // relation-contract narrow included — 'depends-on' does NOT survive to
    // the final stored CHECK, even though this migration's own job (widen +
    // rename) is what ticket 03 depends on having already run.
    expect(storedTableSql(db)).not.toContain("'depends-on'");

    expect(relationsOf(db, 1)).toEqual(["consume"]);
    expect(relationsOf(db, 3)).toEqual(["verifies"]);
    expect(relationsOf(db, 5)).toEqual(["refutes"]);
    expect(relationsOf(db, 7)).toEqual(["grounds"]);
    expect(relationsOf(db, 9)).toEqual(["extends"]);
    // Unrenamed words survive untouched.
    expect(relationsOf(db, 11)).toEqual(["override"]);
    expect(relationsOf(db, 13)).toEqual(["supersedes"]);
    expect(relationsOf(db, 15)).toEqual(["(bare)"]);
    // The non-collision control: an unrenamed word (override) and a renamed
    // one (depends-on -> consume) on the SAME pair survive as TWO rows, not
    // collapsed into one — the group key is (pair, NEW relation), not pair
    // alone.
    expect(relationsOf(db, 19)).toEqual(["consume", "override"]);

    // No row anywhere still carries a retired word's literal value.
    const retiredWords = new Set([
      "depends-on",
      "evidence-for",
      "evidence-against",
      "grounded-on",
      "refines",
      "encodes",
    ]);
    for (const edge of allEdges(db)) {
      expect(retiredWords.has(edge.relation ?? "")).toBe(false);
    }

    // New words insert cleanly; garbage still does not. `indexes`, not the
    // retired `collects` — `initializeSchema` runs the FULL chain, the
    // indexes-rescope rename (ticket 01, `.scratch/indexes-rescope/spec.md`)
    // included, so `collects` does not survive to the final stored CHECK any
    // more than `depends-on` does above.
    db.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', 90, 'turn', 91, 'narrows', 'asserted', 50)`,
    );
    db.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', 92, 'turn', 93, 'indexes', 'asserted', 55)`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
         VALUES ('turn', 94, 'turn', 95, 'bogus-word', 'asserted', 60)`,
      ),
    ).toThrow();
  });

  // The encodes/grounded-on merge collision (spec.md's migration item 2):
  // collapsed to exactly one `grounds` row, winner picked by the SAME
  // provenance-rank tie-break `pickWinningLegacyRelation` (ticket 05's
  // pair-identity collapse) already established — `asserted` (rank 4)
  // outranks `judged` (rank 3) — and the timestamp is pooled to the
  // EARLIEST across both candidates regardless of which one's provenance won.
  test("the encodes/grounded-on merge collision collapses to one grounds row, provenance-rank winner, earliest timestamp", () => {
    initializeSchema(db);

    const merged = allEdges(db).filter((edge) => edge.citingId === 17 && edge.citedId === 18);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      relation: "grounds",
      provenance: "asserted",
      createdAtEpoch: 900,
    });
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

  test("idempotent: a second initializeSchema neither re-renames nor loses rows", () => {
    initializeSchema(db);
    const after = allEdges(db);
    initializeSchema(db);
    initializeSchema(db);
    expect(allEdges(db)).toEqual(after);
    expect(storedTableSql(db)).toContain("'narrows'");
  });

  test("a fresh database skips the migration entirely and already accepts the new words", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);
    fresh.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES ('turn', 1, 'turn', 2, 'grounds', 'asserted', 100)`,
    );
    expect(storedTableSql(fresh)).toContain("'narrows'");
    fresh.close();
  });

  test("no row count is lost across the rebuild", () => {
    const before = allEdges(db).length;
    initializeSchema(db);
    // The merge collision drops the count by exactly one (two source rows,
    // one surviving row) — every other row copies straight across.
    expect(allEdges(db).length).toBe(before - 1);
  });
});
