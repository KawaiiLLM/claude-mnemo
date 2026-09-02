import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  ensureMemoryEdgesLaneModelV12MergedTagSetRetired,
  ensureMemoryEdgesLaneModelV12TwoSidedTags,
  initializeSchema,
  LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT,
  LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT,
  type LaneModelV12MergedTagSetRetiredReceipt,
} from "../../src/db/schema";
import { MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE } from "../../src/db/main-agent-edges-cutover";
import { downgradeToPreV12EdgeShape } from "../support/pre-v12-edge-shape";

/**
 * lane-model-v12 M-E (spec D1, ticket 09) — the CONTRACT half: the merged
 * `tags` column and its index table leave, and `(pair, relation, tail_tag,
 * head_tag)` becomes the whole of an edge's identity.
 *
 * WHAT THESE TESTS EXIST TO CATCH, phase by phase, since none of it is
 * observable from the row values alone (M-E moves no data — it copies every
 * column but one, verbatim):
 *
 *   - the column and the index table are BOTH gone, and stay gone across a
 *     reopen. The second half is not paranoia: `ensureMemoryEdgesSchema`
 *     creates the index unconditionally in earlier builds, and an earlier
 *     migration's staleness probe keyed on the column's own DDL text — so a
 *     contracted table read as PRISTINE and was rebuilt straight back into
 *     the merged shape, losing both lane columns on the way (see
 *     `memoryEdgesTagSetIdentityIsStale`).
 *   - the SIDE index survives the table swap ROW FOR ROW. It is preserved,
 *     not regenerated, so this is a real claim about the `PRAGMA
 *     foreign_keys = OFF` around the `DROP TABLE`: with it on, the
 *     `ON DELETE CASCADE` off `memory_edges(id)` empties the index the moment
 *     the parent goes.
 *   - and that same cascade still FIRES afterwards, on the rebuilt table.
 *     SQLite rewrites a child's `REFERENCES` clause under some
 *     `legacy_alter_table` settings, so "the FK still points at the table it
 *     names" is a behaviour to check, not to assume.
 */
describe("lane-model-v12 M-E — the merged tag set is retired", () => {
  let db: Database;
  let citing: number;
  let cited: number;
  let other: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    db.exec(
      `INSERT INTO sessions (content_session_id, project, created_at_epoch)
       VALUES ('merged-tag-set-retired', '/tmp/project', 100)`,
    );
    [citing, cited, other] = [1, 2, 3].map(
      (promptNumber) =>
        db
          .query<{ id: number }, [number]>(
            `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back)
             VALUES (1, ?, 'active', 100, 0) RETURNING id`,
          )
          .get(promptNumber)!.id,
    ) as [number, number, number];
  });

  afterEach(() => {
    db.close();
  });

  const columnNames = (): string[] =>
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
      .all()
      .map((row) => row.name);

  const tableNames = (): string[] =>
    db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('memory_edge_tags', 'memory_edge_side_tags')
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

  const sideRows = (): Array<{ edgeRowId: number; side: string; tag: string }> =>
    db
      .query<{ edgeRowId: number; side: string; tag: string }, []>(
        `SELECT edge_row_id AS edgeRowId, side, tag FROM memory_edge_side_tags
         ORDER BY edge_row_id, side`,
      )
      .all();

  /** The same shape, read out of the cutover's receipt archive. */
  const archivedEdges = (): Array<{
    id: number;
    relation: string | null;
    provenance: string;
    tailTag: string;
    headTag: string;
    createdAtEpoch: number;
  }> =>
    db
      .query<
        {
          id: number;
          relation: string | null;
          provenance: string;
          tailTag: string;
          headTag: string;
          createdAtEpoch: number;
        },
        []
      >(
        `SELECT id, relation, provenance, tail_tag AS tailTag, head_tag AS headTag,
                created_at_epoch AS createdAtEpoch
         FROM ${MAIN_AGENT_EDGES_CUTOVER_EDGE_ARCHIVE} ORDER BY id`,
      )
      .all();

  const edges = (): Array<{
    id: number;
    relation: string | null;
    provenance: string;
    tailTag: string;
    headTag: string;
    createdAtEpoch: number;
  }> =>
    db
      .query<
        {
          id: number;
          relation: string | null;
          provenance: string;
          tailTag: string;
          headTag: string;
          createdAtEpoch: number;
        },
        []
      >(
        `SELECT id, relation, provenance, tail_tag AS tailTag, head_tag AS headTag,
                created_at_epoch AS createdAtEpoch
         FROM memory_edges ORDER BY id`,
      )
      .all();

  const receipt = (): LaneModelV12MergedTagSetRetiredReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT)!.payload,
    ) as LaneModelV12MergedTagSetRetiredReceipt;

  /**
   * Put the database back where an UPGRADING one is when M-E runs: the
   * two-sided EXPAND shape, M-E pending. Getting there by running M-A over the
   * pre-v12 shape (rather than hand-building a table) means the rows M-E meets
   * are the ones the previous phase actually produces, index rows included.
   */
  function pending(seed: (insert: typeof seedEdge) => void): void {
    downgradeToPreV12EdgeShape(db);
    seed(seedEdge);
    // Only THESE two receipts are cleared. The other v12 phases (M-B in
    // particular) must stay settled: their own ordering guards refuse to face
    // a table whose lane columns have already moved, which is exactly what
    // the reopen test below would otherwise trip on.
    db.query<unknown, [string, string]>(
      "DELETE FROM migration_receipts WHERE name IN (?, ?)",
    ).run(
      LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT,
      LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT,
    );
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 150);
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT,
    );
  }

  function seedEdge(
    id: number,
    citingId: number,
    citedId: number,
    relation: string | null,
    tags: string,
    provenance = "asserted",
  ): void {
    db.query<unknown, [number, number, number, string | null, string, string]>(
      `INSERT INTO memory_edges
         (id, citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
       VALUES (?, 'turn', ?, 'turn', ?, ?, ?, ?, 100)`,
    ).run(id, citingId, citedId, relation, provenance, tags);
  }

  test("the column and its index table both leave, and every row keeps its id, sides and audit columns", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a"]');
      insert(2, citing, other, "grounds", "[]");
    });
    expect(columnNames()).toContain("tags");
    const before = edges();

    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 200);

    expect(columnNames()).not.toContain("tags");
    expect(columnNames()).toEqual(expect.arrayContaining(["tail_tag", "head_tag"]));
    expect(tableNames()).toEqual(["memory_edge_side_tags"]);
    expect(edges()).toEqual(before);
    expect(receipt()).toEqual({
      disposition: "contracted",
      rowsBefore: 2,
      rowsAfter: 2,
      mergedIndexRows: 1,
      sideIndexRows: 2,
    });
  });

  /**
   * The identity key's new last two components, as BEHAVIOUR rather than DDL
   * text. Ticket 05 could not pin this: while `tags` was still in the key the
   * two sides were a FUNCTION of it, so a key that named only `tags` accepted
   * and rejected exactly the same writes. Removing the merged component is
   * what makes it independently true.
   *
   * MUTATION: drop `tail_tag, head_tag` from `memoryEdgesTableDdl`'s
   * `sides-only` UNIQUE and the second insert collides instead of landing.
   */
  test("after the contraction the two SIDES carry identity: same pair/relation, two side combinations, two rows", () => {
    pending((insert) => insert(1, citing, cited, "extends", '["lane-a"]'));
    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 200);

    db.query<unknown, [number, number]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tail_tag, head_tag, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, 'extends', 'asserted', 'lane-a', 'lane-b', 200)`,
    ).run(citing, cited);

    expect(edges().map((row) => [row.tailTag, row.headTag])).toEqual([
      ["lane-a", "lane-a"],
      ["lane-a", "lane-b"],
    ]);
    // …and a genuine restatement of the FIRST row is still refused by that
    // same key, so the widening above is not simply "the key stopped working".
    expect(() =>
      db.query<unknown, [number, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tail_tag, head_tag, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'extends', 'asserted', 'lane-a', 'lane-a', 300)`,
      ).run(citing, cited),
    ).toThrow(/UNIQUE constraint failed/);
  });

  /**
   * The side index is PRESERVED across the rebuild, not regenerated — the
   * evidence for the `PRAGMA foreign_keys = OFF` that wraps the `DROP TABLE`.
   *
   * MUTATION: remove that pragma and the `DROP TABLE memory_edges` cascades
   * every child row away; the phase then stops with its own named error
   * ("memory_edge_side_tags lost N row(s)…") rather than committing a silently
   * empty index.
   */
  test("the rebuild preserves the SIDE index row for row, ids included", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a"]');
      insert(2, cited, other, "consume", '["lane-b"]');
    });
    const before = sideRows();
    expect(before).toEqual([
      { edgeRowId: 1, side: "head", tag: "lane-a" },
      { edgeRowId: 1, side: "tail", tag: "lane-a" },
      { edgeRowId: 2, side: "head", tag: "lane-b" },
      { edgeRowId: 2, side: "tail", tag: "lane-b" },
    ]);

    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 200);

    expect(sideRows()).toEqual(before);
  });

  /**
   * And the FK that index rides on still points at the table it names after
   * the drop-and-rename. A rebuild that left the clause aimed at the dropped
   * table would look identical to this one until the first retraction, at
   * which point the index would start accumulating rows for edges that no
   * longer exist.
   */
  test("ON DELETE CASCADE still fires on the rebuilt table", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a"]');
      insert(2, cited, other, "consume", '["lane-b"]');
    });
    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 200);

    db.exec("PRAGMA foreign_keys = ON;");
    db.query<unknown, []>("DELETE FROM memory_edges WHERE id = 1").run();

    expect(sideRows()).toEqual([
      { edgeRowId: 2, side: "head", tag: "lane-b" },
      { edgeRowId: 2, side: "tail", tag: "lane-b" },
    ]);
  });

  /**
   * FAILPOINT. A receipt row plus an idempotent second run does not prove
   * crash safety on its own, so the receipt insert is made to abort and the
   * database is inspected mid-flight: the rebuild is DDL, and DDL is
   * transactional in SQLite, so a rollback has to take the whole contraction
   * with it.
   */
  test("failpoint: the rebuild and its receipt commit together or not at all", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a"]');
      insert(2, citing, other, "grounds", "[]");
    });
    const before = edges();
    const sidesBefore = sideRows();

    db.exec(
      `CREATE TRIGGER merged_tag_set_failpoint BEFORE INSERT ON migration_receipts
       WHEN NEW.name = '${LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT}'
       BEGIN SELECT RAISE(ABORT, 'injected crash'); END`,
    );
    expect(() => ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 200)).toThrow(
      /injected crash/,
    );

    // Nothing moved: the column is back (never left), the merged index table
    // is back, every row is byte-identical, the side index is intact, and
    // nothing claims the phase ran.
    expect(columnNames()).toContain("tags");
    expect(tableNames()).toEqual(["memory_edge_side_tags", "memory_edge_tags"]);
    expect(edges()).toEqual(before);
    expect(sideRows()).toEqual(sidesBefore);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT)!.n,
    ).toBe(0);

    // The RESTART: the same call, once the crash is out of the way, finishes
    // the phase exactly once.
    db.exec("DROP TRIGGER merged_tag_set_failpoint");
    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 300);
    expect(columnNames()).not.toContain("tags");
    expect(edges()).toEqual(before);
    expect(sideRows()).toEqual(sidesBefore);
    expect(receipt().rowsAfter).toBe(2);
  });

  test("a second run is a no-op — no rebuild, and the receipt still describes the run that happened", () => {
    pending((insert) => insert(1, citing, cited, "extends", '["lane-a"]'));
    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 200);
    const after = edges();
    const sides = sideRows();
    const ddl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;
    const stamp = db
      .query<{ appliedAtEpoch: number }, [string]>(
        "SELECT applied_at_epoch AS appliedAtEpoch FROM migration_receipts WHERE name = ?",
      )
      .get(LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT)!.appliedAtEpoch;

    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 400);

    expect(edges()).toEqual(after);
    expect(sideRows()).toEqual(sides);
    expect(
      db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
        )
        .get()!.sql,
    ).toBe(ddl);
    expect(
      db
        .query<{ appliedAtEpoch: number }, [string]>(
          "SELECT applied_at_epoch AS appliedAtEpoch FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT)!.appliedAtEpoch,
    ).toBe(stamp);
    // A rebuild that ran again would have left its temporary table behind on
    // the way through, so its absence is the cheap check that nothing ran.
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edges_sides_only_rebuild'`,
        )
        .get()!.count,
    ).toBe(0);
  });

  test("a database already in the contract shape records the phase rather than leaving a hole in the audit trail", () => {
    // The bootstrap in `beforeEach` already contracted this database. Clearing
    // the receipt is the only way to reach the `born-sides-only` arm.
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT,
    );
    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 200);
    expect(receipt().disposition).toBe("born-sides-only");
  });

  /**
   * The precondition M-A guarantees, asserted on M-E ITSELF: inside the real
   * slot M-A always runs first, so this is unreachable there by construction,
   * and that is exactly why the guard needs its own test. A future ticket
   * reordering the phases would otherwise learn about it through a raw
   * SQLITE_CONSTRAINT from a table copy.
   */
  test("rows that only the merged set kept apart refuse the contraction BY NAME", () => {
    pending((insert) => insert(1, citing, cited, "extends", '["lane-a"]'));
    // Two rows on one (pair, relation) whose sides are identical and whose tag
    // sets are not — the shape M-A cannot leave behind, since after it `tags`
    // is a function of the two sides.
    db.query<unknown, [number, number]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, tail_tag, head_tag, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, 'extends', 'asserted', '[]', 'lane-a', 'lane-a', 200)`,
    ).run(citing, cited);

    expect(() => ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 300)).toThrow(
      /identity key\(s\) that only the retired merged tag set kept apart/,
    );
    // Refused, not half-done.
    expect(columnNames()).toContain("tags");
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_MERGED_TAG_SET_RETIRED_RECEIPT)!.n,
    ).toBe(0);
  });

  /**
   * The reopen. `ensureMemoryEdgesSchema` runs the whole pre-v12 chain on
   * every open, and TWO of its steps used to undo this one: an unconditional
   * `CREATE TABLE IF NOT EXISTS memory_edge_tags`, and a staleness probe that
   * read a contracted table as pristine pre-tag-identity stock and rebuilt it
   * into the merged shape — dropping both lane columns, since that rebuild's
   * copy names neither.
   */
  test("a reopen leaves the contraction alone: no column, no merged index, lane values intact", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a"]');
      insert(2, cited, other, "consume", '["lane-b"]');
    });
    ensureMemoryEdgesLaneModelV12MergedTagSetRetired(db, 200);
    const after = edges();
    const sides = sideRows();

    initializeSchema(db);
    initializeSchema(db);

    expect(columnNames()).not.toContain("tags");
    expect(tableNames()).toEqual(["memory_edge_side_tags"]);
    // Read off the cutover's receipt archive: `initializeSchema` ends PAST the
    // main-agent-edges cutover, which drops the word column `edges()` selects
    // — the archive is the table exactly as M-E left it.
    expect(archivedEdges()).toEqual(after);
    // The SIDE INDEX is not preserved across that open, and must not be: the
    // cutover's transform 3 clears every stored declaration whose endpoint is
    // not in two or more lanes (spec D9), and these fixture turns are in none
    // at all. The declarations this file made are exactly that population, so
    // the rebuilt index is empty — while `sides` records what M-E itself left.
    expect(sides.length).toBeGreaterThan(0);
    expect(sideRows()).toEqual([]);
  });
});
