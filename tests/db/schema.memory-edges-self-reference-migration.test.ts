import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  MAIN_AGENT_EDGES_CUTOVER_DDL_ARCHIVE,
  MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE,
} from "../../src/db/main-agent-edges-cutover";
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
describe("memory_edges self-reference migration (relation-matrix spec, ticket 05)", () => {
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
    // LIVE before, archive after: the archive does not exist until the cutover
    // runs, and it IS this table one chain later.
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
    // are what "lossless" asserts here; the `relation` column's rename is
    // covered by the vocabulary-flip and relation-contract migration tests.
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
    // The FULL chain ends in lane-model-v12's contracted shape, whose CHECK
    // bans every self row again (D2, ticket 04) — so the widened arm this
    // migration installs is no longer in the table's text at the end of an
    // open. What proves this migration ran is the row set above plus the
    // surrogate `id` every later shape carries; see the marker-monotonicity
    // test at the bottom of this file for why the text alone cannot say.
    expect(storedTableSql(db)).not.toContain("relation IS NOT NULL");
    expect(storedTableSql(db)).toContain("citing_kind <> cited_kind");
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

  // Ticket 05's widening is RETRACTED by lane-model-v12 D2 (ticket 04) for
  // the shape a database ends an open in: an edge's two ends must be
  // different nodes, whatever the word. The widened arm is still real — it
  // lives in the intermediate shapes this migration and its two successors
  // copy through — but nothing that survives the full chain carries it.
  test("a relation-carrying self insert is refused again after the full chain (v12 D2)", () => {
    initializeSchema(db);

    // 'encodes' is retired by flow-relations ticket 03's relation contract
    // (the narrow CHECK no longer admits it) — 'grounds' is its replacement,
    // and this test is only about the self-loop CHECK's own arm, not which
    // word carries it.
    // The post-cutover table has no `relation` column, so the probe states the
    // self row in the CLASS vocabulary; the CHECK arm under test
    // (`citing_id <> cited_id`) is the same one.
    expect(() =>
      db
        .query<unknown, [number, number]>(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, 'use', 'asserted', 160)`,
        )
        .run(turnIds[0]!, turnIds[0]!),
    ).toThrow(/CHECK constraint failed/);
    expect(
      db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) AS count FROM memory_edges
           WHERE citing_kind = 'turn' AND citing_id = ?
             AND cited_kind = 'turn' AND cited_id = ?`,
        )
        .get(turnIds[0]!, turnIds[0]!)!.count,
    ).toBe(0);
  });

  test("idempotent: reopening neither rebuilds nor loses rows", () => {
    initializeSchema(db);
    const after = allEdges(db);

    initializeSchema(db);
    initializeSchema(db);

    expect(allEdges(db)).toEqual(after);
    expect(storedTableSql(db)).not.toContain("relation IS NOT NULL");
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

    // Both indexes key on the dropped `relation` column, so the cutover
    // replaced them with its side index; that THIS rebuild reattached them is
    // read from the DDL archive.
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

  test("a fresh database is already born past this migration and skips it", () => {
    const fresh = createDatabase(":memory:");
    initializeSchema(fresh);

    // Not the DDL text — see the next test for why that stopped being able to
    // answer. The surrogate `id` is what every shape from ticket 01 onward
    // carries and nothing since removes.
    expect(
      fresh
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
        .all()
        .map((row) => row.name),
    ).toContain("id");
    expect(
      fresh
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edges_self_reference_rebuild'`,
        )
        .get()!.count,
    ).toBe(0);
    fresh.close();
  });

  /**
   * THE STALENESS MARKER IS NOT THE CHECK TEXT ANY MORE, and this test is the
   * only thing that can tell.
   *
   * `memoryEdgesSelfReferenceCheckIsStale` used to read the stored DDL for
   * this migration's own arm (`relation IS NOT NULL`). That is sound only
   * while no LATER migration can take the marker back out — and lane-model-v12
   * D2 does exactly that: M-E's contracted table bans every self row again, so
   * its text carries no such phrase, and a fully migrated database read as
   * pristine pre-ticket-05 stock.
   *
   * The damage is not a wasted rebuild. This migration's copy names the
   * PRE-SURROGATE columns only, so every reopen would rewrite `memory_edges`
   * without `id`, `tail_tag` or `head_tag` — dropping every lane attribution
   * in the database and un-keying both tag index tables. It is ticket 09's
   * incident, one marker over, and the reason the probe now also asks for the
   * `id` column.
   *
   * Written as a REOPEN over a table carrying a settled lane edge, because
   * that is the only observation that separates "the rebuild ran" from "the
   * rebuild ran and happened to be harmless": a database whose rows are
   * unattributed anyway cannot see the loss.
   */
  test("reopening a fully migrated database never re-runs this rebuild, so lane attribution survives", () => {
    initializeSchema(db);

    db.query(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance,
          tail_tag, head_tag, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, 'use', 'asserted', 'lane-a', 'lane-b', 400)`,
    ).run(turnIds[0]!, turnIds[1]!);
    const before = db
      .query<{ id: number; tailTag: string; headTag: string }, []>(
        `SELECT id, tail_tag AS tailTag, head_tag AS headTag FROM memory_edges
         WHERE tail_tag <> '' ORDER BY id`,
      )
      .all();
    expect(before).toHaveLength(1);
    const columnsBefore = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
      .all()
      .map((row) => row.name);

    initializeSchema(db);
    initializeSchema(db);

    // The two side columns are the ones the stale rebuild's copy would have
    // silently left behind; `tags` coming BACK would be the same event seen
    // from the other side.
    expect(
      db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
        .all()
        .map((row) => row.name),
    ).toEqual(columnsBefore);
    expect(columnsBefore).toContain("tail_tag");
    expect(columnsBefore).not.toContain("tags");
    expect(
      db
        .query<{ id: number; tailTag: string; headTag: string }, []>(
          `SELECT id, tail_tag AS tailTag, head_tag AS headTag FROM memory_edges
           WHERE tail_tag <> '' ORDER BY id`,
        )
        .all(),
    ).toEqual(before);
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edges_self_reference_rebuild'`,
        )
        .get()!.count,
    ).toBe(0);
  });
});
