import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE,
  MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE,
} from "../../src/db/main-agent-edges-cutover";
import { initializeSchema } from "../../src/db/schema";

/**
 * The production shape `ensureMemoryEdgesRelationVocabulary` exists for:
 * pair-identity PRIMARY KEY already in place, relation CHECK still carrying
 * only the four legacy words — captured verbatim from a real pre-migration
 * installation (sqlite_master, 2026-08-19). Without the rebuild, every
 * new-vocabulary edge is rejected at the INSERT — the release blocker
 * edge-ownership ticket 01 flagged.
 *
 * main-agent-edges ticket 01: `initializeSchema` now ENDS with the cutover,
 * which rebuilds `memory_edges` without the `relation` column. The legacy
 * chain still runs on this fixture, in the same open, right before it — and
 * the cutover archives the table exactly as the chain left it: every row in
 * `main_agent_edges_cutover_edge_archive` (`relation` included) and the
 * stored DDL in `main_agent_edges_cutover_ddl_archive`. Those archives are
 * where this file reads the chain's result from now.
 */
const LEGACY_MEMORY_EDGES_DDL = `
  CREATE TABLE memory_edges (
    citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
    cited_id INTEGER NOT NULL,
    relation TEXT CHECK (
      relation IS NULL OR
      relation IN ('evidence-for', 'evidence-against', 'supersedes', 'depends-on')
    ),
    provenance TEXT NOT NULL CHECK (
      provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
    ),
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (citing_kind, citing_id, cited_kind, cited_id)
  );
  CREATE INDEX idx_memory_edges_cited
    ON memory_edges(cited_kind, cited_id, relation);
`;

/** The `memory_edges` DDL as the legacy chain left it — archived by the cutover right before its own rebuild. */
function preCutoverTableSql(db: Database): string {
  return (
    db
      .query<{ sql: string | null }, []>(
        `SELECT sql FROM ${MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE}
          WHERE kind = 'table' AND name = 'memory_edges'`,
      )
      .get()?.sql ?? ""
  );
}

function storedTableSql(db: Database): string {
  return (
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? ""
  );
}

function allEdges(db: Database): unknown[] {
  return db
    .query<Record<string, unknown>, []>(
      `SELECT citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch
       FROM memory_edges ORDER BY citing_id`,
    )
    .all();
}

/** Every row the chain handed the cutover, word included, in the fixture's own column order. */
function archivedEdges(db: Database): unknown[] {
  return db
    .query<Record<string, unknown>, []>(
      `SELECT citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch
       FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE} ORDER BY citing_id`,
    )
    .all();
}

function finalEdges(db: Database): unknown[] {
  return db
    .query<Record<string, unknown>, []>(
      `SELECT citing_kind, citing_id, cited_kind, cited_id, relation_class, relation_coverage,
              provenance, created_at_epoch
       FROM memory_edges ORDER BY citing_id`,
    )
    .all();
}

describe("memory_edges relation vocabulary migration", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    db.exec(LEGACY_MEMORY_EDGES_DDL);
    db.exec(`
      INSERT INTO memory_edges VALUES
        ('turn', 1, 'turn', 2, 'supersedes', 'asserted', 100),
        -- [S15069/T1728] turn->turn, not turn->segment: this row exists to be
        -- RENAMED, and after D10 only a turn->turn row may carry a word at all.
        -- A bare row would have nothing to rename and would test nothing.
        ('turn', 3, 'turn', 4, 'evidence-for', 'judged', 200);
    `);
  });

  afterEach(() => {
    db.close();
  });

  test("a four-word CHECK rejects the new vocabulary; the migration widens it, and later migrations in the same open carry it to the final contract", () => {
    // Before: the legacy constraint is the bug being fixed.
    expect(() =>
      db.exec(
        "INSERT INTO memory_edges VALUES ('turn', 5, 'turn', 6, 'grounded-on', 'asserted', 300)",
      ),
    ).toThrow();

    const before = allEdges(db);
    initializeSchema(db);

    // `initializeSchema` runs the FULL chain in one open — this migration's
    // OWN widen is what lets flow-relations ticket 02's rename and ticket
    // 03's relation-contract narrow run right behind it, so the CHECK the
    // chain hands the cutover is the narrow eight-word + supersedes contract,
    // not the four-word-plus-new-vocabulary union this migration alone
    // produces. The cutover archives that DDL before dropping the column.
    expect(preCutoverTableSql(db)).not.toContain("'grounded-on'");
    expect(preCutoverTableSql(db)).toContain("'grounds'");
    // The fixture's pre-existing rows are RENAMED by that same chain
    // (evidence-for -> verifies); supersedes never moves.
    const RENAME: Record<string, string> = {
      "evidence-for": "verifies",
      // lane-model-v12 ticket 03: `supersedes` leaves the vocabulary and the
      // table CHECK, so the full chain lands it on `override`.
      supersedes: "override",
    };
    const expected = before.map((edge) => {
      const row = edge as { relation: string | null };
      return row.relation === null
        ? row
        : { ...row, relation: RENAME[row.relation] ?? row.relation };
    });
    expect(archivedEdges(db)).toEqual(expected);

    // After: the cutover carried each renamed word to its class; the final
    // table speaks the class vocabulary, and garbage still does not insert.
    expect(finalEdges(db)).toEqual([
      {
        citing_kind: "turn", citing_id: 1, cited_kind: "turn", cited_id: 2,
        relation_class: "correct", relation_coverage: "full", provenance: "asserted", created_at_epoch: 100,
      },
      {
        citing_kind: "turn", citing_id: 3, cited_kind: "turn", cited_id: 4,
        relation_class: "verify", relation_coverage: "", provenance: "judged", created_at_epoch: 200,
      },
    ]);
    expect(storedTableSql(db)).not.toContain("relation TEXT");
    db.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
       VALUES ('turn', 5, 'turn', 6, 'use', 'asserted', 300)`,
    );
    db.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
       VALUES ('turn', 7, 'turn', 8, 'verify', 'asserted', 400)`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
         VALUES ('turn', 9, 'turn', 10, 'grounded-on', 'asserted', 500)`,
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
         VALUES ('turn', 9, 'turn', 10, 'bogus-word', 'asserted', 500)`,
      ),
    ).toThrow();
  });

  test("the cited-side index survives the rebuild attached to the NEW table", () => {
    // A rename drags the index (and its name) to the old table, so the DDL's
    // IF NOT EXISTS alone would leave the new table unindexed after the drop.
    // The chain's result is the table the cutover archived, index rows
    // included (`sqlite_master` verbatim, `tbl_name` and all).
    initializeSchema(db);
    const index = db
      .query<{ tblName: string }, []>(
        `SELECT tbl_name AS tblName FROM ${MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE}
          WHERE kind = 'index' AND name = 'idx_memory_edges_cited'`,
      )
      .get();
    expect(index?.tblName).toBe("memory_edges");
    // And the cutover's own rebuild leaves the final table indexed on the cited node.
    expect(
      db
        .query<{ tblName: string }, []>(
          "SELECT tbl_name AS tblName FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_edges_cited_node'",
        )
        .get()?.tblName,
    ).toBe("memory_edges");
  });

  test("idempotent: a second initializeSchema neither rebuilds nor loses rows", () => {
    initializeSchema(db);
    const after = finalEdges(db);
    const archived = archivedEdges(db);
    initializeSchema(db);
    initializeSchema(db);
    expect(finalEdges(db)).toEqual(after);
    // The archive is written once: a reopen re-runs neither the chain nor the cutover.
    expect(archivedEdges(db)).toEqual(archived);
    expect(preCutoverTableSql(db)).not.toContain("'grounded-on'");
    expect(preCutoverTableSql(db)).toContain("'grounds'");
  });

  test("a fresh database skips the migration entirely and already accepts the new words", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);
    // The table a fresh database is born with (the one the cutover archived)
    // never carried the four-word CHECK: it spoke the final vocabulary from
    // its first open.
    expect(preCutoverTableSql(fresh)).not.toContain("'grounded-on'");
    expect(preCutoverTableSql(fresh)).toContain("'grounds'");
    fresh.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
       VALUES ('turn', 1, 'turn', 2, 'use', 'asserted', 100)`,
    );
    fresh.close();
  });
});
