import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";

/**
 * The production shape `ensureMemoryEdgesSelfReferenceCheck` migrates away
 * from: (pair, relation) identity already holds (ticket 01's own multi-
 * relation rebuild), but the self-loop CHECK still bans EVERY self row
 * outright, relation or not. Relation-matrix spec ticket 05 ("自引用") widens
 * it to admit a relation-carrying self row, leaving only the bare one banned.
 */
const PRE_SELF_REFERENCE_MEMORY_EDGES_DDL = `
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
    CHECK (citing_kind <> cited_kind OR citing_id <> cited_id),
    UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation)
  );
  CREATE INDEX idx_memory_edges_cited
    ON memory_edges(cited_kind, cited_id, relation);
  CREATE UNIQUE INDEX idx_memory_edges_bare_pair
    ON memory_edges(citing_kind, citing_id, cited_kind, cited_id)
    WHERE relation IS NULL;
`;

describe("memory_edges self-reference migration (relation-matrix spec, ticket 05)", () => {
  let db: Database;
  let sessionId: number;
  let turnIds: number[];
  let segmentIds: number[];

  function allEdges(db: Database): unknown[] {
    return db
      .query<Record<string, unknown>, []>(
        `SELECT citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch
         FROM memory_edges
         ORDER BY citing_kind, citing_id, cited_kind, cited_id, relation`,
      )
      .all();
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

  function insertEdge(
    citingKind: string,
    citingId: number,
    citedKind: string,
    citedId: number,
    relation: string | null,
    provenance: string,
    createdAtEpoch: number,
  ): void {
    db.query<unknown, [string, number, string, number, string | null, string, number]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(citingKind, citingId, citedKind, citedId, relation, provenance, createdAtEpoch);
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    // A real database first (turns/segments have to exist for FK validity),
    // then its edge table is replaced with the pre-ticket-05 shape — the
    // sqlite_master state an installation reopens with.
    initializeSchema(db);
    sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('self-reference-migration', '/tmp/project', 100) RETURNING id`,
      )
      .get()!.id;
    turnIds = [1, 2, 3].map(
      (promptNumber) =>
        db
          .query<{ id: number }, [number, number]>(
            `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
             VALUES (?, ?, 'extracted', 100) RETURNING id`,
          )
          .get(sessionId, promptNumber)!.id,
    );
    segmentIds = ["chapter one", "chapter two"].map(
      (title) =>
        db
          .query<{ id: number }, [string]>(
            `INSERT INTO segments (title, content, created_at_epoch, updated_at_epoch)
             VALUES (?, NULL, 100, 100) RETURNING id`,
          )
          .get(title)!.id,
    );

    db.exec("DROP TABLE memory_edges");
    db.exec(PRE_SELF_REFERENCE_MEMORY_EDGES_DDL);

    // Every endpoint combination the live table holds, and all five
    // provenances — none of them a self row, since the fixture's own CHECK
    // (matching production pre-ticket-05) still refuses one outright.
    insertEdge("turn", turnIds[0]!, "turn", turnIds[1]!, "depends-on", "asserted", 100);
    insertEdge("turn", turnIds[0]!, "segment", segmentIds[0]!, null, "text-ref", 110);
    insertEdge("segment", segmentIds[0]!, "turn", turnIds[1]!, "encodes", "judged", 120);
    insertEdge("session", sessionId, "segment", segmentIds[0]!, "grounded-on", "retrieval", 130);
    insertEdge("turn", turnIds[2]!, "turn", turnIds[1]!, "supersedes", "rollback", 140);
    insertEdge("segment", segmentIds[0]!, "segment", segmentIds[1]!, "refines", "text-ref", 150);
  });

  afterEach(() => {
    db.close();
  });

  test("the fixture really is the pre-ticket-05 shape: every self row, bare or not, is refused", () => {
    expect(() =>
      insertEdge("turn", turnIds[0]!, "turn", turnIds[0]!, "depends-on", "asserted", 160),
    ).toThrow();
    expect(() =>
      insertEdge("turn", turnIds[0]!, "turn", turnIds[0]!, null, "text-ref", 160),
    ).toThrow();
  });

  test("carries every row across unchanged, column for column (data lossless)", () => {
    const before = allEdges(db);
    expect(before).toHaveLength(6);

    initializeSchema(db);

    // `initializeSchema` runs the FULL chain, flow-relations ticket 03's
    // relation-contract narrow included — the fixture's old-vocabulary
    // values (depends-on/encodes/grounded-on/refines) are renamed on the
    // way, not just carried across byte-identical. Row COUNT and STRUCTURE
    // are what "lossless" asserts here; the `relation` column's rename is
    // covered by the vocabulary-flip and relation-contract migration tests.
    const RENAME: Record<string, string> = {
      "depends-on": "consume",
      encodes: "grounds",
      "grounded-on": "grounds",
      refines: "extends",
    };
    const expected = before.map((edge) => {
      const row = edge as { relation: string | null };
      return row.relation === null
        ? row
        : { ...row, relation: RENAME[row.relation] ?? row.relation };
    });
    expect(allEdges(db)).toEqual(expected);
    expect(storedTableSql(db)).toContain("relation IS NOT NULL");
  });

  test("a bare self insert is still rejected by the CHECK", () => {
    initializeSchema(db);

    expect(() =>
      insertEdge("turn", turnIds[0]!, "turn", turnIds[0]!, null, "text-ref", 160),
    ).toThrow();
    expect(() =>
      insertEdge("segment", segmentIds[0]!, "segment", segmentIds[0]!, null, "text-ref", 160),
    ).toThrow();
  });

  test("a relation-carrying self insert is now accepted", () => {
    initializeSchema(db);

    // 'encodes' is retired by flow-relations ticket 03's relation contract
    // (the narrow CHECK no longer admits it) — 'grounds' is its replacement,
    // and this test is only about the self-loop CHECK's own arm, not which
    // word carries it.
    expect(() =>
      insertEdge("turn", turnIds[0]!, "turn", turnIds[0]!, "grounds", "asserted", 160),
    ).not.toThrow();
    expect(
      db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) AS count FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ?
             AND cited_kind = 'turn' AND cited_id = ? AND relation = 'grounds'`,
        )
        .get(turnIds[0]!, turnIds[0]!)!.count,
    ).toBe(1);
  });

  test("idempotent: reopening neither rebuilds nor loses rows", () => {
    initializeSchema(db);
    const after = allEdges(db);

    initializeSchema(db);
    initializeSchema(db);

    expect(allEdges(db)).toEqual(after);
    expect(storedTableSql(db)).toContain("relation IS NOT NULL");
    // A rebuild that ran again would have left the temporary table behind on
    // its way through, so its absence is the cheap check that nothing ran.
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edges_self_reference_rebuild'`,
        )
        .get()!.count,
    ).toBe(0);
  });

  test("the endpoint prune triggers still fire against the rebuilt table", () => {
    initializeSchema(db);

    db.query("DELETE FROM turns WHERE id = ?").run(turnIds[1]!);
    expect(
      db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) AS count FROM memory_edges
           WHERE (citing_kind = 'turn' AND citing_id = ?)
              OR (cited_kind = 'turn' AND cited_id = ?)`,
        )
        .get(turnIds[1]!, turnIds[1]!)!.count,
    ).toBe(0);
  });

  test("the indexes survive the rebuild attached to the NEW table", () => {
    initializeSchema(db);

    const indexes = db
      .query<{ name: string; tblName: string }, []>(
        `SELECT name, tbl_name AS tblName FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'idx_memory_edges%'
         ORDER BY name`,
      )
      .all();
    expect(indexes).toEqual([
      { name: "idx_memory_edges_bare_pair", tblName: "memory_edges" },
      { name: "idx_memory_edges_cited", tblName: "memory_edges" },
    ]);
  });

  test("a fresh database is already born in the widened shape and skips the migration", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);

    expect(storedTableSql(fresh)).toContain("relation IS NOT NULL");
    fresh.close();
  });
});
