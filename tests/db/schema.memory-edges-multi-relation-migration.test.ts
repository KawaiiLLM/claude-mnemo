import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";

/**
 * The production shape `ensureMemoryEdgesMultiRelation` exists for: the
 * four-column pair-identity PRIMARY KEY, relation CHECK already carrying the
 * full eight-word vocabulary (0.12.1's own shape), no self-loop CHECK and no
 * bare-pair index. Edge-mechanism-revision ticket 01 widens identity to
 * (pair, relation), which is a PRIMARY KEY change and therefore a rebuild.
 */
const PRE_MULTI_RELATION_MEMORY_EDGES_DDL = `
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
    PRIMARY KEY (citing_kind, citing_id, cited_kind, cited_id)
  );
  CREATE INDEX idx_memory_edges_cited
    ON memory_edges(cited_kind, cited_id, relation);
`;

describe("memory_edges multi-relation migration (ticket 01, D2)", () => {
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
    // A real database first (turns, segments and the endpoint triggers have to
    // exist for the cascade assertion), then its edge table is replaced with
    // the pre-migration one — the sqlite_master state an installation reopens
    // with.
    initializeSchema(db);
    sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('multi-relation-migration', '/tmp/project', 100) RETURNING id`,
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
    db.exec(PRE_MULTI_RELATION_MEMORY_EDGES_DDL);

    // Every endpoint combination the live table holds, and all five
    // provenances, so "lossless" is asserted over the real shape rather than
    // over a turn→turn sample.
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

  test("the fixture really is the old shape: one relation per pair, self-loops storable", () => {
    // Without this the migration test could pass against a fixture that never
    // had the constraint being migrated away from.
    expect(() =>
      insertEdge("turn", turnIds[0]!, "turn", turnIds[1]!, "encodes", "asserted", 160),
    ).toThrow();
    expect(() =>
      insertEdge("turn", turnIds[0]!, "turn", turnIds[0]!, "depends-on", "asserted", 160),
    ).not.toThrow();
  });

  test("carries every row across unchanged, column for column", () => {
    const before = allEdges(db);
    expect(before).toHaveLength(6);

    initializeSchema(db);

    expect(allEdges(db)).toEqual(before);
    expect(storedTableSql(db)).toContain("citing_kind <> cited_kind");
    expect(storedTableSql(db)).toContain(
      "UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation)",
    );
  });

  test("after the rebuild a pair can carry several relations, and each relation still only once", () => {
    initializeSchema(db);

    insertEdge("turn", turnIds[0]!, "turn", turnIds[1]!, "encodes", "asserted", 160);
    expect(
      db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) AS count FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ?
             AND cited_kind = 'turn' AND cited_id = ?`,
        )
        .get(turnIds[0]!, turnIds[1]!)!.count,
    ).toBe(2);
    expect(() =>
      insertEdge("turn", turnIds[0]!, "turn", turnIds[1]!, "encodes", "judged", 170),
    ).toThrow();
  });

  test("after the rebuild the bare row is unique per pair and self-loops are unstorable", () => {
    initializeSchema(db);

    // The migrated bare row is already there (turn → segment), so a second one
    // must be refused by the partial unique index.
    expect(() =>
      insertEdge("turn", turnIds[0]!, "segment", segmentIds[0]!, null, "retrieval", 160),
    ).toThrow();
    // A bare row for a DIFFERENT pair is fine — the index is partial, not a
    // ban on NULL relations.
    expect(() =>
      insertEdge("turn", turnIds[1]!, "segment", segmentIds[0]!, null, "retrieval", 160),
    ).not.toThrow();

    expect(() =>
      insertEdge("turn", turnIds[0]!, "turn", turnIds[0]!, "depends-on", "asserted", 160),
    ).toThrow();
    expect(() =>
      insertEdge("segment", segmentIds[0]!, "segment", segmentIds[0]!, null, "text-ref", 160),
    ).toThrow();
  });

  test("a self-loop already in the old table is dropped rather than aborting the open", () => {
    insertEdge("turn", turnIds[0]!, "turn", turnIds[0]!, "depends-on", "asserted", 160);

    expect(() => initializeSchema(db)).not.toThrow();

    expect(allEdges(db)).toHaveLength(6);
    expect(storedTableSql(db)).toContain("citing_kind <> cited_kind");
  });

  test("the endpoint prune triggers still fire against the rebuilt table", () => {
    initializeSchema(db);

    // The rebuild swaps the table out from under three AFTER DELETE triggers
    // that name it. If the swap left them pointing at a dropped table, this
    // delete would either throw or silently orphan the edges.
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

    db.query("DELETE FROM segments WHERE id = ?").run(segmentIds[0]!);
    db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
    expect(allEdges(db)).toEqual([]);
  });

  test("the cited-side index survives the rebuild attached to the NEW table", () => {
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

  test("idempotent: reopening neither rebuilds nor loses rows", () => {
    initializeSchema(db);
    const after = allEdges(db);

    initializeSchema(db);
    initializeSchema(db);

    expect(allEdges(db)).toEqual(after);
    expect(storedTableSql(db)).toContain("citing_kind <> cited_kind");
    // A rebuild that ran again would have left the temporary table behind on
    // its way through, so its absence is the cheap check that nothing ran.
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edges_multi_relation_rebuild'`,
        )
        .get()!.count,
    ).toBe(0);
  });

  test("a fresh database is born in the new shape and skips the migration", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);

    expect(storedTableSql(fresh)).toContain("citing_kind <> cited_kind");
    fresh.exec(
      `INSERT INTO memory_edges VALUES ('turn', 1, 'turn', 2, 'encodes', 'asserted', 100)`,
    );
    fresh.exec(
      `INSERT INTO memory_edges VALUES ('turn', 1, 'turn', 2, 'depends-on', 'asserted', 100)`,
    );
    expect(() =>
      fresh.exec(
        `INSERT INTO memory_edges VALUES ('turn', 1, 'turn', 1, 'depends-on', 'asserted', 100)`,
      ),
    ).toThrow();
    fresh.close();
  });
});
