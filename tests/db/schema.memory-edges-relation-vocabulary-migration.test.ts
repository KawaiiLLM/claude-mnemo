import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";

/**
 * The production shape `ensureMemoryEdgesRelationVocabulary` exists for:
 * pair-identity PRIMARY KEY already in place, relation CHECK still carrying
 * only the four legacy words — captured verbatim from a real pre-migration
 * installation (sqlite_master, 2026-08-19). Without the rebuild, every
 * new-vocabulary edge is rejected at the INSERT — the release blocker
 * edge-ownership ticket 01 flagged.
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

describe("memory_edges relation vocabulary migration", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    db.exec(LEGACY_MEMORY_EDGES_DDL);
    db.exec(`
      INSERT INTO memory_edges VALUES
        ('turn', 1, 'turn', 2, 'supersedes', 'asserted', 100),
        ('turn', 3, 'segment', 4, 'evidence-for', 'judged', 200);
    `);
  });

  afterEach(() => {
    db.close();
  });

  test("a four-word CHECK rejects the new vocabulary; the migration widens it with rows intact", () => {
    // Before: the legacy constraint is the bug being fixed.
    expect(() =>
      db.exec(
        "INSERT INTO memory_edges VALUES ('turn', 5, 'turn', 6, 'grounded-on', 'asserted', 300)",
      ),
    ).toThrow();

    const before = allEdges(db);
    initializeSchema(db);

    expect(storedTableSql(db)).toContain("'grounded-on'");
    expect(allEdges(db)).toEqual(before);

    // After: all four new words insert cleanly; garbage still does not.
    db.exec(
      "INSERT INTO memory_edges VALUES ('turn', 5, 'turn', 6, 'grounded-on', 'asserted', 300)",
    );
    db.exec(
      "INSERT INTO memory_edges VALUES ('turn', 7, 'turn', 8, 'refines', 'asserted', 400)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO memory_edges VALUES ('turn', 9, 'turn', 10, 'bogus-word', 'asserted', 500)",
      ),
    ).toThrow();
  });

  test("the cited-side index survives the rebuild attached to the NEW table", () => {
    // A rename drags the index (and its name) to the old table, so the DDL's
    // IF NOT EXISTS alone would leave the new table unindexed after the drop.
    initializeSchema(db);
    const index = db
      .query<{ tblName: string }, []>(
        "SELECT tbl_name AS tblName FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_edges_cited'",
      )
      .get();
    expect(index?.tblName).toBe("memory_edges");
  });

  test("idempotent: a second initializeSchema neither rebuilds nor loses rows", () => {
    initializeSchema(db);
    const after = allEdges(db);
    initializeSchema(db);
    initializeSchema(db);
    expect(allEdges(db)).toEqual(after);
    expect(storedTableSql(db)).toContain("'grounded-on'");
  });

  test("a fresh database skips the migration entirely and already accepts the new words", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);
    fresh.exec(
      "INSERT INTO memory_edges VALUES ('turn', 1, 'turn', 2, 'encodes', 'asserted', 100)",
    );
    expect(storedTableSql(fresh)).toContain("'grounded-on'");
    fresh.close();
  });
});
