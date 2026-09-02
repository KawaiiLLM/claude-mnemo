import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE,
  MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE,
} from "../../src/db/main-agent-edges-cutover";
import { initializeSchema } from "../../src/db/schema";

/**
 * The production shape `ensureMemoryEdgesRelationContract` migrates away
 * from (flow-relations spec, ticket 03's "contract half"): (pair, relation)
 * identity and the self-loop CHECK's widened arm already in place (ticket
 * 05's shape), the relation CHECK still carrying the OLD∪NEW union ticket
 * 02's "expand half" left behind. Every row here is already a NEW-vocabulary
 * value — the common, incremental (one release at a time) upgrade path,
 * where `ensureMemoryEdgesVocabularyFlip` already ran to completion in an
 * earlier release's open() before this one ever sees the database.
 */
const UNION_MEMORY_EDGES_DDL = `
  CREATE TABLE memory_edges (
    citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
    cited_id INTEGER NOT NULL,
    relation TEXT CHECK (
      relation IS NULL OR
      relation IN (
        'evidence-for', 'evidence-against', 'supersedes', 'depends-on',
        'refines', 'override', 'encodes', 'grounded-on',
        'narrows', 'extends', 'collects', 'consume', 'grounds',
        'verifies', 'refutes'
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
        `SELECT sql FROM ${MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE}
            WHERE kind = 'table' AND name = 'memory_edges'`,
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
       FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE} ORDER BY citing_id, cited_id, relation`,
    )
    .all();
}

/**
 * main-agent-edges ticket 01: `initializeSchema` now ENDS with the cutover,
 * which rebuilds `memory_edges` without the `relation` column and with one row
 * per pair. The legacy chain under test still runs on this fixture, in the same
 * open, right before it — and the cutover ARCHIVES the table exactly as the
 * chain left it (`main_agent_edges_cutover_ddl_archive` /
 * `main_agent_edges_cutover_edge_archive`). The two accessors below therefore
 * read the chain's result out of the archive rather than out of the live table,
 * which is the same state a rollback would restore.
 */
describe("memory_edges relation contract migration (flow-relations spec, ticket 03)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    db.exec(UNION_MEMORY_EDGES_DDL);
    db.exec(`
      INSERT INTO memory_edges VALUES
        ('turn', 1, 'turn', 2, 'consume', 'asserted', 100),
        ('turn', 3, 'turn', 4, 'verifies', 'asserted', 200),
        ('turn', 5, 'turn', 6, 'refutes', 'asserted', 300),
        ('turn', 7, 'turn', 8, 'grounds', 'asserted', 400),
        ('turn', 9, 'turn', 10, 'extends', 'asserted', 500),
        ('turn', 11, 'turn', 12, 'override', 'asserted', 600),
        ('turn', 13, 'turn', 14, 'supersedes', 'asserted', 700),
        ('turn', 15, 'turn', 16, NULL, 'text-ref', 800);
    `);
  });

  afterEach(() => {
    db.close();
  });

  test("a union CHECK still admits the retired words; the migration narrows it to the eight-word + supersedes contract", () => {
    db.exec(
      "INSERT INTO memory_edges VALUES ('turn', 90, 'turn', 91, 'depends-on', 'asserted', 50)",
    );
    db.exec("DELETE FROM memory_edges WHERE citing_id = 90");

    initializeSchema(db);

    expect(storedTableSql(db)).not.toContain("'depends-on'");
    expect(storedTableSql(db)).not.toContain("'evidence-for'");
    expect(storedTableSql(db)).not.toContain("'evidence-against'");
    expect(storedTableSql(db)).not.toContain("'grounded-on'");
    expect(storedTableSql(db)).not.toContain("'refines'");
    expect(storedTableSql(db)).not.toContain("'encodes'");
    // `indexes`, not the retired `collects` — `initializeSchema` runs the
    // FULL chain, the indexes-rescope rename (ticket 01, `.scratch/
    // indexes-rescope/spec.md`) included.
    for (const word of ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"]) {
      expect(storedTableSql(db)).toContain(`'${word}'`);
    }
    // lane-model-v12 ticket 03 narrows the SAME CHECK once more, at the far
    // end of the chain: the storage vocabulary is now exactly the write one.
    expect(storedTableSql(db)).not.toContain("'refutes'");
    expect(storedTableSql(db)).not.toContain("'supersedes'");

    // Every already-new-vocabulary row survives untouched — the narrow is
    // not a rename here, since nothing left to rename.
    expect(allEdges(db)).toEqual([
      { citingKind: "turn", citingId: 1, citedKind: "turn", citedId: 2, relation: "consume", provenance: "asserted", createdAtEpoch: 100 },
      { citingKind: "turn", citingId: 3, citedKind: "turn", citedId: 4, relation: "verifies", provenance: "asserted", createdAtEpoch: 200 },
      { citingKind: "turn", citingId: 5, citedKind: "turn", citedId: 6, relation: "override", provenance: "asserted", createdAtEpoch: 300 },
      { citingKind: "turn", citingId: 7, citedKind: "turn", citedId: 8, relation: "grounds", provenance: "asserted", createdAtEpoch: 400 },
      { citingKind: "turn", citingId: 9, citedKind: "turn", citedId: 10, relation: "extends", provenance: "asserted", createdAtEpoch: 500 },
      { citingKind: "turn", citingId: 11, citedKind: "turn", citedId: 12, relation: "override", provenance: "asserted", createdAtEpoch: 600 },
      { citingKind: "turn", citingId: 13, citedKind: "turn", citedId: 14, relation: "override", provenance: "asserted", createdAtEpoch: 700 },
      { citingKind: "turn", citingId: 15, citedKind: "turn", citedId: 16, relation: null, provenance: "text-ref", createdAtEpoch: 800 },
    ]);

    // The live INSERT probe ("a new word inserts, a retired one is refused")
    // is DELETED: after the cutover the live table has no `relation` column,
    // so both halves would fail to prepare rather than exercise a CHECK. The
    // archived CHECK asserted above is the same fact, read where it survives.
  });

  /**
   * LOAD-BEARING CASE. `ensureMemoryEdgesVocabularyFlip`'s own staleness
   * probe (`'narrows'` presence in the stored DDL) can be satisfied by an
   * EARLIER migration's rebuild in the SAME `ensureMemoryEdgesSchema` pass
   * — every earlier rebuild in this file targets "today's" full DDL
   * (whichever word list its own caller passes), so if that word list
   * already includes `'narrows'` (it does, in the union list ticket 02
   * shipped), a database old enough to still need one of those EARLIER
   * migrations can reach `ensureMemoryEdgesVocabularyFlip` with the table
   * ALREADY showing `'narrows'` in its CHECK — before vocabularyFlip's own
   * rename logic ever ran a single row. This is not hypothetical: it is
   * exactly what fires against the real production database (rehearsed
   * 2026-08-21 on a full /tmp copy) — production's stored DDL had already
   * passed the self-loop-CHECK migration but not yet ticket 02's rename, so
   * `ensureMemoryEdgesSelfReferenceCheck`'s rebuild (targeting the union
   * list) satisfied vocabularyFlip's marker as a side effect, leaving ~700
   * old-vocabulary rows un-renamed in a CHECK that (at that instant) still
   * admitted them.
   *
   * `ensureMemoryEdgesRelationContract` MUST still resolve every one of
   * those leftover old words to its final replacement rather than either
   * (a) crashing the whole migration on the narrow CHECK, or (b) silently
   * dropping the relation. It does this by reusing
   * `collapseAndRebuildVocabularyFlip`'s remap-and-collapse pass (schema.ts)
   * instead of a bare `SELECT *` narrow-copy — this test is a mutation
   * target: replacing that reused call with a plain filtered copy makes
   * this test fail (either a thrown CHECK violation, since the old words
   * are still literally present in the copy's source rows, or a silently
   * un-renamed leftover if the copy target were left wide instead of
   * narrow).
   */
  test("an old word that survived vocabularyFlip's own marker-coincidence is still renamed, not dropped or fatal", () => {
    // Simulates the exact production shape: vocabularyFlip's marker
    // ('narrows' in the CHECK) is ALREADY satisfied, yet real rows still
    // carry old words — including the encodes/grounded-on collision on one
    // pair, which the migration must still collapse to one 'grounds' row.
    db.exec(
      "INSERT INTO memory_edges VALUES ('turn', 20, 'turn', 21, 'depends-on', 'asserted', 900)",
    );
    db.exec(
      "INSERT INTO memory_edges VALUES ('turn', 22, 'turn', 23, 'evidence-for', 'judged', 1000)",
    );
    db.exec(
      "INSERT INTO memory_edges VALUES ('turn', 24, 'turn', 25, 'encodes', 'judged', 1100)",
    );
    db.exec(
      "INSERT INTO memory_edges VALUES ('turn', 24, 'turn', 25, 'grounded-on', 'asserted', 1050)",
    );

    // Read LIVE: the fixture's own table, before any archive exists.
    expect(
      db
        .query<{ sql: string | null }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
        )
        .get()?.sql ?? "",
    ).toContain("'narrows'");

    initializeSchema(db);

    expect(storedTableSql(db)).not.toContain("'depends-on'");
    const byPair = new Map(
      allEdges(db).map((edge) => [`${edge.citingId}->${edge.citedId}`, edge]),
    );
    expect(byPair.get("20->21")?.relation).toBe("consume");
    expect(byPair.get("22->23")?.relation).toBe("verifies");
    // The collision collapses to ONE row, provenance-rank winner ('asserted'
    // outranks 'judged'), earliest timestamp pooled across both candidates —
    // the same tie-break `ensureMemoryEdgesVocabularyFlip` itself uses.
    const collapsed = allEdges(db).filter((edge) => edge.citingId === 24 && edge.citedId === 25);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      relation: "grounds",
      provenance: "asserted",
      createdAtEpoch: 1050,
    });
    // No row anywhere still carries a retired word.
    const retiredWords = new Set([
      "depends-on", "evidence-for", "evidence-against", "grounded-on", "refines", "encodes",
    ]);
    for (const edge of allEdges(db)) {
      expect(retiredWords.has(edge.relation ?? "")).toBe(false);
    }
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

  test("a fresh database is born already narrow", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);

    expect(storedTableSql(fresh)).not.toContain("'depends-on'");
    // The live table speaks classes, not words: the narrow this migration
    // produced is archived, and what a writer meets is the class CHECK.
    fresh.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
       VALUES ('turn', 1, 'turn', 2, 'use', 'asserted', 100)`,
    );
    expect(() =>
      fresh.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
         VALUES ('turn', 3, 'turn', 4, 'encodes', 'asserted', 100)`,
      ),
    ).toThrow();
    fresh.close();
  });

  test("PRAGMA foreign_key_check stays clean across the rebuild", () => {
    initializeSchema(db);
    expect(
      db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all(),
    ).toEqual([]);
  });
});
