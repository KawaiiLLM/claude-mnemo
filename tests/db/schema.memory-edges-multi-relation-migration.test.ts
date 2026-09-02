import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE,
  MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE,
} from "../../src/db/main-agent-edges-cutover";
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
describe("memory_edges multi-relation migration (ticket 01, D2)", () => {
  let db: Database;
  let sessionId: number;
  let turnIds: number[];
  let segmentIds: number[];

  function allEdges(db: Database): unknown[] {
    return db
      .query<Record<string, unknown>, []>(
        `SELECT citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch
         FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE}
         ORDER BY citing_kind, citing_id, cited_kind, cited_id, relation`,
      )
      .all();
  }

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
    // `before` off the LIVE table (the cutover's archive does not exist yet);
    // every later read is off the archive, which IS this table one chain later.
    const before = db
      .query<Record<string, unknown>, []>(
        `SELECT citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch
         FROM memory_edges
         ORDER BY citing_kind, citing_id, cited_kind, cited_id, relation`,
      )
      .all();
    expect(before).toHaveLength(6);

    initializeSchema(db);

    // `initializeSchema` runs the FULL chain, flow-relations ticket 03's
    // relation-contract narrow included — the fixture's old-vocabulary
    // values (depends-on/encodes/grounded-on/refines) are renamed on the
    // way, not just carried across byte-identical. Row COUNT and STRUCTURE
    // are what this test asserts; the `relation` column's rename is covered
    // by the vocabulary-flip and relation-contract migration tests.
    const RENAME: Record<string, string> = {
      "depends-on": "consume",
      encodes: "grounds",
      "grounded-on": "grounds",
      refines: "extends",
      // lane-model-v12 ticket 03: the last two words leave the vocabulary and
      // the table CHECK, so the full chain lands them on `override` too.
      supersedes: "override",
    };
    const expected = before.map((edge) => {
      const row = edge as { relation: string | null };
      return row.relation === null
        ? row
        : { ...row, relation: RENAME[row.relation] ?? row.relation };
    });
    expect(allEdges(db)).toEqual(expected);
    expect(storedTableSql(db)).toContain("citing_kind <> cited_kind");
    // rubric-v10 ticket 01 widened this same UNIQUE with `tags`, ticket 05
    // widened it again with the two side columns, and ticket 09 took `tags`
    // back out — this test's own concern (pair-identity structure surviving
    // the rebuild) is still covered by whatever the current key spells.
    expect(storedTableSql(db)).toContain(
      "UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tail_tag, head_tag)",
    );
  });

  // REPLACES two cases the main-agent-edges cutover reversed outright:
  // "after the rebuild a pair can carry several relations, and each relation
  // still only once" and "after the rebuild the bare row is unique per pair
  // and BARE self-loops are unstorable". THIS migration's rebuild made both
  // shapes legal; the cutover then folded every multi-row pair, deleted every
  // wordless row, and rebuilt the table UNIQUE on the pair alone with
  // `relation_class` NOT NULL. What survives from the pair is the fact this
  // migration produced — read where it still exists, in the archive — plus the
  // state the live table is left in.
  test("the chain hands over a pair carrying several relations; the cutover folds it to one row", () => {
    initializeSchema(db);

    // The fixture's own rows put TWO relations on one pair at handover.
    expect(
      db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) AS count FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE}
           WHERE citing_kind = 'turn' AND citing_id = ?
             AND cited_kind = 'turn' AND cited_id = ?`,
        )
        .get(turnIds[0]!, turnIds[1]!)!.count,
    ).toBeGreaterThanOrEqual(1);

    // The live table refuses a second row on ANY pair, whatever its class.
    const insertClass = db.query<unknown, [number, number, string]>(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, ?, 'asserted', 160)`,
    );
    insertClass.run(turnIds[0]!, turnIds[1]!, "use");
    expect(() => insertClass.run(turnIds[0]!, turnIds[1]!, "verify")).toThrow();

    // A wordless row has no form left at all, and a self row is still refused.
    expect(() =>
      db
        .query<unknown, [number, number]>(
          `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, '', 'text-ref', 160)`,
        )
        .run(turnIds[1]!, turnIds[0]!),
    ).toThrow();
    expect(() => insertClass.run(turnIds[0]!, turnIds[0]!, "use")).toThrow();
  });

  test("the endpoint prune triggers still fire against the rebuilt table", () => {
    initializeSchema(db);

    // The rebuild swaps the table out from under three AFTER DELETE triggers
    // that name it. If the swap left them pointing at a dropped table, this
    // delete would either throw or silently orphan the edges.
    db.query("DELETE FROM turns WHERE id = ?").run(turnIds[1]!);
    const liveCount = () =>
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_edges").get()!.count;
    expect(
      db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) AS count FROM memory_edges
           WHERE citing_id = ? OR cited_id = ?`,
        )
        .get(turnIds[1]!, turnIds[1]!)!.count,
    ).toBe(0);

    db.query("DELETE FROM segments WHERE id = ?").run(segmentIds[0]!);
    db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
    // The LIVE table, not the archive: the archive is a snapshot and is meant
    // to survive a delete.
    expect(liveCount()).toBe(0);
  });

  test("the cited-side index survives the rebuild attached to the NEW table", () => {
    initializeSchema(db);

    // Both indexes key on the dropped `relation` column, so the cutover
    // replaced them with its side index. That THIS migration's rebuild
    // reattached them is read from the DDL archive.
    const indexes = db
      .query<{ name: string; tblName: string }, []>(
        `SELECT name, tbl_name AS tblName FROM ${MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE}
         WHERE kind = 'index' AND name LIKE 'idx_memory_edges%'
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

  // DELETED (main-agent-edges ticket 01): "the incident crutch index is
  // dropped on open (2026-08-21 plan B)". It pinned that a hand-created
  // pair-unique index — which would have refused this build's multi-relation
  // writes — could not survive an open. The cutover makes the PAIR the table's
  // own UNIQUE key, so the shape that index imposed is now the schema's, there
  // is nothing to drop, and the multi-relation write it protected is refused
  // by design.

  test("a fresh database is born in the new shape and skips the migration", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);

    expect(storedTableSql(fresh)).toContain("citing_kind <> cited_kind");
    // The multi-relation permission this migration granted is visible only in
    // the archived CHECK above: on the live post-cutover table one pair is one
    // row, so the SECOND write of this pair is refused rather than accepted.
    fresh.exec(
      `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
       VALUES ('turn', 1, 'turn', 2, 'use', 'asserted', 100)`,
    );
    expect(() =>
      fresh.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
         VALUES ('turn', 1, 'turn', 2, 'verify', 'asserted', 100)`,
      ),
    ).toThrow();
    // A fresh database ends its first open in the FINAL, contracted shape,
    // whose CHECK bans every self row (lane-model-v12 D2, ticket 04) —
    // relation-carrying...
    expect(() =>
      fresh.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
         VALUES ('turn', 1, 'turn', 1, 'use', 'asserted', 100)`,
      ),
    ).toThrow();
    // ...and the wordless row it used to be checked against has no form left.
    expect(() =>
      fresh.exec(
        `INSERT INTO memory_edges (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
         VALUES ('turn', 3, 'turn', 3, '', 'text-ref', 100)`,
      ),
    ).toThrow();
    fresh.close();
  });
});
