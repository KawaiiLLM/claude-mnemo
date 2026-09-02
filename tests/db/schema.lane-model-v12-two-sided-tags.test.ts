import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  rebuildMemoryEdgeSideTagsIndex,
  retractMemoryEdges,
  writeMemoryEdges,
} from "../../src/db/memory-edges";
import {
  ensureMemoryEdgesLaneModelV12TwoSidedTags,
  initializeSchema,
  LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT,
  runLaneModelV12EdgeMigration,
  type LaneModelV12TwoSidedTagsReceipt,
} from "../../src/db/schema";
import { downgradeToPreV12EdgeShape } from "../support/pre-v12-edge-shape";

/**
 * lane-model-v12 M-A (spec D1/D4, ticket 05) — the EXPAND half of the
 * two-sided tag change: `tail_tag`/`head_tag` arrive beside `tags`, every
 * write path maintains both, and `tags` stays the authoritative read source
 * until tickets 06/07/08 move the readers.
 *
 * Two things here are load bearing rather than incidental, and each has a
 * test that fails if it stops being true:
 *
 *   - the columns are NOT NULL with `''` as the unsettled sentinel, so the
 *     identity key still de-duplicates (SQLite's UNIQUE does not de-duplicate
 *     NULLs, and an unsettled edge is the most common shape there is);
 *   - the side index knows WHICH SIDE a tag is on, which the old
 *     `memory_edge_tags` key structurally could not say.
 */

interface EdgeRow {
  id: number;
  relation: string | null;
  provenance: string;
  tags: string;
  tailTag: string;
  headTag: string;
  createdAtEpoch: number;
}

interface SideRow {
  edgeRowId: number;
  side: string;
  tag: string;
}

describe("lane-model-v12 M-A — the tag set becomes one tag per side", () => {
  let db: Database;
  let citing: number;
  let cited: number;
  let other: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    db.exec(
      `INSERT INTO sessions (content_session_id, project, created_at_epoch)
       VALUES ('two-sided-tags', '/tmp/project', 100)`,
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

  /**
   * Put the database back where an UPGRADING one starts — one-sided table,
   * M-A pending — and seed it there. The receipt goes too: it is
   * insert-if-absent (the audit record of the ONE migration event), so a
   * fixture that left the bootstrap's own receipt in place would run the
   * phase and then silently keep the empty payload.
   */
  function pending(seed: (insert: typeof seedEdge) => void): void {
    downgradeToPreV12EdgeShape(db);
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT,
    );
    seed(seedEdge);
  }

  function seedEdge(
    id: number,
    citingId: number,
    citedId: number,
    relation: string | null,
    tags: string,
    provenance = "asserted",
    createdAtEpoch = 100,
  ): number {
    return db
      .query<{ id: number }, [number, number, number, string | null, string, string, number]>(
        `INSERT INTO memory_edges
           (id, citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
         VALUES (?, 'turn', ?, 'turn', ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(id, citingId, citedId, relation, provenance, tags, createdAtEpoch)!.id;
  }

  const edges = (): EdgeRow[] =>
    db
      .query<EdgeRow, []>(
        `SELECT id, relation, provenance, tags, tail_tag AS tailTag, head_tag AS headTag,
                created_at_epoch AS createdAtEpoch
         FROM memory_edges ORDER BY id`,
      )
      .all();

  /**
   * The same read WITHOUT the merged column, for the tests that run the whole
   * slot rather than M-A alone: ticket 09's M-E is that slot's last phase, so
   * `tags` no longer exists by the time those tests look.
   */
  const contractedEdges = (): Array<Omit<EdgeRow, "tags">> =>
    db
      .query<Omit<EdgeRow, "tags">, []>(
        `SELECT id, relation, provenance, tail_tag AS tailTag, head_tag AS headTag,
                created_at_epoch AS createdAtEpoch
         FROM memory_edges ORDER BY id`,
      )
      .all();

  const sideRows = (): SideRow[] =>
    db
      .query<SideRow, []>(
        `SELECT edge_row_id AS edgeRowId, side, tag FROM memory_edge_side_tags
         ORDER BY edge_row_id, side`,
      )
      .all();

  const receipt = (): LaneModelV12TwoSidedTagsReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT)!.payload,
    ) as LaneModelV12TwoSidedTagsReceipt;

  const storedTableSql = (): string =>
    db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;

  test("both columns are NOT NULL with the empty-string sentinel, and both join the identity key", () => {
    pending((insert) => insert(1, citing, cited, "extends", '["lane-a"]'));
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200);

    expect(storedTableSql()).toContain("tail_tag TEXT NOT NULL DEFAULT ''");
    expect(storedTableSql()).toContain("head_tag TEXT NOT NULL DEFAULT ''");
    expect(storedTableSql()).toContain(
      "UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tags, tail_tag, head_tag)",
    );
    // The seven-word CHECK ticket 03 narrowed the table onto survives the
    // rebuild — a rebuild that widened it back would re-admit two words no
    // writer can produce.
    expect(storedTableSql()).not.toContain("'supersedes'");
    expect(storedTableSql()).not.toContain("'refutes'");
  });

  test("a single-tag row becomes the same lane on both sides, keeping its row id", () => {
    pending((insert) => insert(7, citing, cited, "extends", '["lane-a"]'));
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200);

    expect(edges()).toEqual([
      {
        id: 7,
        relation: "extends",
        provenance: "asserted",
        tags: '["lane-a"]',
        tailTag: "lane-a",
        headTag: "lane-a",
        createdAtEpoch: 100,
      },
    ]);
    expect(receipt().disposition).toBe("expanded");
    expect(receipt().split).toEqual([]);
  });

  test("an untagged row is UNSETTLED on both sides — the post-migration baseline is a queue, not one global lane", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", "[]");
      insert(2, citing, other, null, "[]");
    });
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200);

    expect(edges().map((row) => [row.id, row.tailTag, row.headTag])).toEqual([
      [1, "", ""],
      [2, "", ""],
    ]);
    // An unsettled side is the ABSENCE of a lane, so it has no index row at
    // all — never a row carrying the empty tag.
    expect(sideRows()).toEqual([]);
    expect(receipt().unsettled).toBe(2);
  });

  test("a multi-tag row splits into one edge per tag, both sides equal on each", () => {
    pending((insert) => insert(5, citing, cited, "grounds", '["lane-b","lane-a"]'));
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200);

    const rows = edges();
    expect(rows).toHaveLength(2);
    // Canonical (sorted) order: `lane-a` is the first product and inherits
    // the original row id; `lane-b` is minted.
    expect(rows.map((row) => [row.id, row.tags, row.tailTag, row.headTag])).toEqual([
      [5, '["lane-a"]', "lane-a", "lane-a"],
      [rows[1]!.id, '["lane-b"]', "lane-b", "lane-b"],
    ]);
    expect(rows[1]!.id).toBeGreaterThan(5);
    // Both products keep the ORIGINAL row's audit metadata: the split is one
    // fact re-expressed, not two new assertions.
    expect(rows.map((row) => [row.provenance, row.createdAtEpoch])).toEqual([
      ["asserted", 100],
      ["asserted", 100],
    ]);

    const split = receipt().split;
    expect(split).toHaveLength(1);
    expect(split[0]!.edgeId).toBe(5);
    expect(split[0]!.tags).toEqual(["lane-a", "lane-b"]);
    expect(split[0]!.edgeIds).toEqual([5, rows[1]!.id]);
    expect(receipt().rowsBefore).toBe(1);
    expect(receipt().rowsAfter).toBe(2);
  });

  /**
   * The case the ticket says the split test cannot see. The pre-v12 key
   * admits `{a}` and `{a,b}` side by side on ONE (pair, relation); split,
   * both produce `(lane-a, lane-a)` and one of them has to go. Production
   * holds zero rows of this shape (measured, and re-measured at
   * implementation time: 43 multi-tag rows, 0 collisions) — which is exactly
   * why the contract may not rest on it.
   */
  test("a split that COLLIDES is merged by ticket 03's rule, and the receipt names both rows", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a"]', "asserted", 100);
      insert(2, citing, cited, "extends", '["lane-a","lane-b"]', "judged", 200);
    });
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 300);

    const rows = edges();
    // Three tuples went in ((a) from row 1, (a) and (b) from row 2); two rows
    // come out. The `asserted` row is the survivor of the collision, with its
    // OWN id, provenance and timestamp intact.
    expect(rows.map((row) => [row.id, row.tailTag, row.provenance, row.createdAtEpoch])).toEqual([
      [1, "lane-a", "asserted", 100],
      [rows[1]!.id, "lane-b", "judged", 200],
    ]);

    const merged = receipt().merged;
    expect(receipt().mergedCount).toBe(1);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      relation: "extends",
      tailTag: "lane-a",
      headTag: "lane-a",
      keptEdgeId: 1,
      keptProvenance: "asserted",
      keptTags: ["lane-a"],
      droppedEdgeId: 2,
      droppedProvenance: "judged",
      droppedTags: ["lane-a", "lane-b"],
      rule: "provenance",
    });
    // Addressed the way a reader can act on, not by raw row id alone.
    expect(merged[0]!.citingAddress).toBe("S1/T1");
    expect(merged[0]!.citedAddress).toBe("S1/T2");
    expect(receipt().rowsBefore).toBe(2);
    expect(receipt().rowsAfter).toBe(2);
  });

  /**
   * The two clauses of the rule made to DISAGREE, which is the only fixture
   * that can tell them apart. Both this ticket's collision above and ticket
   * 03's own M-B fixture happen to put `asserted` on the EARLIER row, so
   * either clause alone reproduces their outcome — delete the provenance
   * comparison and both still pass. Here the `asserted` row is the LATER one,
   * and provenance still decides: the rule is "keep the asserted row", with
   * age as the tiebreak, not the other way round.
   */
  test("provenance outranks age on a collision — the asserted row survives even when it is the later one", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a"]', "judged", 100);
      insert(2, citing, cited, "extends", '["lane-a","lane-b"]', "asserted", 500);
    });
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 300);

    expect(edges().map((row) => [row.id, row.tailTag, row.provenance, row.createdAtEpoch])).toEqual([
      [2, "lane-a", "asserted", 500],
      [3, "lane-b", "asserted", 500],
    ]);
    expect(receipt().merged.map((entry) => [entry.keptEdgeId, entry.droppedEdgeId, entry.rule])).toEqual([
      [2, 1, "provenance"],
    ]);
  });

  test("equal provenance on a collision keeps the EARLIER row, and says which clause decided", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a","lane-b"]', "asserted", 500);
      insert(2, citing, cited, "extends", '["lane-a"]', "asserted", 100);
    });
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 300);

    expect(receipt().merged.map((entry) => [entry.keptEdgeId, entry.droppedEdgeId, entry.rule])).toEqual([
      [2, 1, "earlier"],
    ]);
    // Row 1 lost its `lane-a` product but keeps its `lane-b` one — under a
    // NEW id, since the id it would have inherited went to the survivor.
    expect(edges().map((row) => [row.tailTag, row.createdAtEpoch])).toEqual([
      ["lane-a", 100],
      ["lane-b", 500],
    ]);
  });

  test("the side index says WHICH SIDE: a tag on both ends of one edge is two rows, not one", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a"]');
      insert(2, citing, other, "grounds", "[]");
    });
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200);

    expect(sideRows()).toEqual([
      { edgeRowId: 1, side: "head", tag: "lane-a" },
      { edgeRowId: 1, side: "tail", tag: "lane-a" },
    ]);
    // The old index cannot answer this question at all: keyed on
    // (edge_row_id, tag), the same tag on both ends is ONE row there.
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edge_tags WHERE edge_row_id = 1")
        .get()!.n,
    ).toBe(1);
  });

  test("the side index is rebuildable from the two columns alone — dropping it loses no semantics", () => {
    pending((insert) => insert(1, citing, cited, "extends", '["lane-a","lane-b"]'));
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200);
    const expected = sideRows();
    expect(expected).toHaveLength(4);

    db.exec("DELETE FROM memory_edge_side_tags");
    expect(sideRows()).toEqual([]);
    rebuildMemoryEdgeSideTagsIndex(db);

    expect(sideRows()).toEqual(expected);
    expect(expected.map((row) => row.side).sort()).toEqual(["head", "head", "tail", "tail"]);
  });

  test("failpoint: the rebuild and its receipt commit together or not at all", () => {
    pending((insert) => {
      insert(1, citing, cited, "extends", '["lane-a","lane-b"]');
      insert(2, citing, other, "grounds", "[]");
    });
    const before = db.query<EdgeRow, []>("SELECT id, relation, provenance, tags, created_at_epoch AS createdAtEpoch FROM memory_edges ORDER BY id").all();

    db.exec(
      `CREATE TRIGGER two_sided_failpoint BEFORE INSERT ON migration_receipts
       WHEN NEW.name = '${LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT}'
       BEGIN SELECT RAISE(ABORT, 'injected crash'); END`,
    );
    expect(() => ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200)).toThrow(/injected crash/);

    // The whole transaction rolled back: the table is still ONE-sided (the
    // rebuild is DDL, and DDL is transactional in SQLite), every row is
    // exactly as it was, and nothing claims the phase ran.
    expect(
      db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
        .all()
        .map((row) => row.name),
    ).not.toContain("tail_tag");
    expect(
      db.query<EdgeRow, []>("SELECT id, relation, provenance, tags, created_at_epoch AS createdAtEpoch FROM memory_edges ORDER BY id").all(),
    ).toEqual(before);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT)!.n,
    ).toBe(0);

    db.exec("DROP TRIGGER two_sided_failpoint");
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 300);
    expect(edges().map((row) => [row.id, row.tailTag])).toEqual([
      [1, "lane-a"],
      [2, ""],
      [3, "lane-b"],
    ]);
    expect(receipt().rowsAfter).toBe(3);
  });

  test("a second run changes nothing — and the receipt still describes the run that happened", () => {
    pending((insert) => insert(1, citing, cited, "extends", '["lane-a","lane-b"]'));
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200);
    const after = edges();
    const stamp = db
      .query<{ appliedAtEpoch: number }, [string]>(
        "SELECT applied_at_epoch AS appliedAtEpoch FROM migration_receipts WHERE name = ?",
      )
      .get(LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT)!.appliedAtEpoch;

    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 400);

    expect(edges()).toEqual(after);
    expect(
      db
        .query<{ appliedAtEpoch: number }, [string]>(
          "SELECT applied_at_epoch AS appliedAtEpoch FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT)!.appliedAtEpoch,
    ).toBe(stamp);
  });

  test("an already two-sided table records the disposition instead of rebuilding", () => {
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_MODEL_V12_TWO_SIDED_TAGS_RECEIPT,
    );
    ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200);
    expect(receipt().disposition).toBe("born-two-sided");
  });

  test("a retired relation word still stored refuses the rebuild BY NAME — M-B has to have run first", () => {
    pending(() => {
      db.exec("PRAGMA ignore_check_constraints = ON");
      try {
        db.exec(
          `INSERT INTO memory_edges
             (id, citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
           VALUES (1, 'turn', ${citing}, 'turn', ${cited}, 'supersedes', 'judged', '[]', 100)`,
        );
      } finally {
        db.exec("PRAGMA ignore_check_constraints = OFF");
      }
    });

    expect(() => ensureMemoryEdgesLaneModelV12TwoSidedTags(db, 200)).toThrow(
      /retired relation word.*runLaneModelV12VocabularyMerge/s,
    );
  });

  test("through the real phase slot: the whole v12 chain lands the two-sided shape", () => {
    pending((insert) => insert(1, citing, cited, "extends", '["lane-a"]'));
    runLaneModelV12EdgeMigration(db);

    expect(contractedEdges().map((row) => [row.tailTag, row.headTag])).toEqual([
      ["lane-a", "lane-a"],
    ]);
    expect(sideRows()).toHaveLength(2);
  });

  /**
   * The whole v12 chain against a table that has reached NONE of its phases:
   * the CHECK still names both retired words and a `supersedes` row is
   * stored. Both outcomes have to land in one open — the words leave, the
   * columns arrive — and the row has to come out consistent across the two.
   *
   * It pins ONE of the two orderings, not both. M-A ahead of M-B throws
   * (M-A's rebuild targets the seven-word CHECK), so that inversion cannot
   * pass here. M-A ahead of M-D is INVISIBLE to this test and to every other
   * one — measured — because M-A's rebuild target already carries M-D's
   * narrow CHECK and would simply do M-D's work early; see the note in
   * `runLaneModelV12EdgeMigration` for why the call still sits last.
   */
  test("the whole chain lands both outcomes in one open: the retired words leave AND the columns arrive", () => {
    downgradeToPreV12EdgeShape(db);
    db.exec("DELETE FROM migration_receipts WHERE name LIKE 'lane-model-v12-%'");
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(`
      CREATE TABLE memory_edges_wide (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        citing_kind TEXT NOT NULL,
        citing_id INTEGER NOT NULL,
        cited_kind TEXT NOT NULL,
        cited_id INTEGER NOT NULL,
        relation TEXT CHECK (
          relation IS NULL OR
          relation IN ('override', 'narrows', 'extends', 'indexes', 'consume',
                       'grounds', 'verifies', 'refutes', 'supersedes')
        ),
        provenance TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at_epoch INTEGER NOT NULL,
        UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tags)
      );
      INSERT INTO memory_edges_wide
        (id, citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
      VALUES (1, 'turn', ${citing}, 'turn', ${cited}, 'supersedes', 'judged', '["lane-a"]', 100);
      DROP TABLE memory_edges;
      ALTER TABLE memory_edges_wide RENAME TO memory_edges;
    `);
    db.exec("PRAGMA foreign_keys = ON;");

    runLaneModelV12EdgeMigration(db);

    // M-B rewrote the word and (this row being `supersedes`) took its tags;
    // M-D took the two words out of the CHECK; M-A gave the table its
    // columns; M-E (ticket 09) took the merged set away again. The row is
    // unsettled because M-B had just emptied it.
    expect(contractedEdges()).toEqual([
      {
        id: 1,
        relation: "override",
        provenance: "judged",
        tailTag: "",
        headTag: "",
        createdAtEpoch: 100,
      },
    ]);
    expect(storedTableSql()).not.toContain("'supersedes'");
    expect(storedTableSql()).toContain("tail_tag TEXT NOT NULL DEFAULT ''");
    expect(storedTableSql()).not.toContain("tags TEXT NOT NULL");
    expect(sideRows()).toEqual([]);
  });
});

describe("lane-model-v12 ticket 09 — the write path maintains the two sides alone", () => {
  let db: Database;
  let citing: number;
  let cited: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    db.exec(
      `INSERT INTO sessions (content_session_id, project, created_at_epoch)
       VALUES ('two-sided-write', '/tmp/project', 100)`,
    );
    [citing, cited] = [1, 2].map(
      (promptNumber) =>
        db
          .query<{ id: number }, [number]>(
            `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back)
             VALUES (1, ?, 'active', 100, 0) RETURNING id`,
          )
          .get(promptNumber)!.id,
    ) as [number, number];
  });

  afterEach(() => {
    db.close();
  });

  /**
   * lane-model-v12 ticket 08 changed the INPUT: a caller states the two SIDES.
   * `tags: undefined` here became "omit both sides", which is the same
   * unsettled row it always was; ticket 09 then deleted the merged column the
   * sides used to be projected onto, so these two values are now the whole of
   * what a write says about lanes.
   */
  function write(
    sides: readonly [string, string] | undefined,
    relationClass: "use" | null = "use",
  ) {
    return writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relationClass: relationClass as never,
          provenance: "asserted",
          ...(sides === undefined ? {} : { tailTag: sides[0], headTag: sides[1] }),
        },
      ],
      300,
    );
  }

  const columns = (): Array<{ id: number; tailTag: string; headTag: string }> =>
    db
      .query<{ id: number; tailTag: string; headTag: string }, []>(
        `SELECT id, tail_tag AS tailTag, head_tag AS headTag FROM memory_edges ORDER BY id`,
      )
      .all();

  const sideRows = (): SideRow[] =>
    db
      .query<SideRow, []>(
        `SELECT edge_row_id AS edgeRowId, side, tag FROM memory_edge_side_tags
         ORDER BY edge_row_id, side`,
      )
      .all();

  /**
   * THE reason both columns are NOT NULL with an empty-string sentinel.
   * SQLite's UNIQUE treats every NULL as distinct, so a nullable pair in the
   * identity key would let the SAME unsettled edge — the shape the main agent
   * writes every single time — be inserted again on every restatement.
   */
  test("the same fully-unsettled edge written twice leaves ONE row", () => {
    write(["", ""]);
    write(["", ""]);
    write(undefined);

    expect(columns()).toEqual([{ id: 1, tailTag: "", headTag: "" }]);
    expect(sideRows()).toEqual([]);
  });

  test("a same-lane write fills both sides and the side index", () => {
    const { written } = write(["lane-a", "lane-a"]);
    const edgeId = written[0]!.id;

    expect(columns()).toEqual([{ id: edgeId, tailTag: "lane-a", headTag: "lane-a" }]);
    expect(sideRows()).toEqual([
      { edgeRowId: edgeId, side: "head", tag: "lane-a" },
      { edgeRowId: edgeId, side: "tail", tag: "lane-a" },
    ]);
    // A restatement is still a no-op — including for the side index.
    write(["lane-a", "lane-a"]);
    expect(sideRows()).toHaveLength(2);
  });

  // Ticket 05's own MULTI-TAG write case retires here: ticket 08 removed the
  // input that could express one (a side holds ONE value), so a stored
  // multi-tag row can now only be pre-M-A stock, which the migration above
  // splits. What replaces it is the shape that became writable in the same
  // breath — a CROSSING, which the merged column could not carry at all, and
  // which ticket 09's contract makes the ONLY stored reading of the row.
  test("a CROSS-LANE write keeps its two sides apart, and the retired merged index is not there to lose it", () => {
    const { written } = write(["lane-a", "lane-b"]);
    const edgeId = written[0]!.id;

    expect(columns()).toEqual([{ id: edgeId, tailTag: "lane-a", headTag: "lane-b" }]);
    expect(sideRows()).toEqual([
      { edgeRowId: edgeId, side: "head", tag: "lane-b" },
      { edgeRowId: edgeId, side: "tail", tag: "lane-a" },
    ]);
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_edge_tags'`,
        )
        .all(),
    ).toEqual([]);
  });

  /**
   * MAIN-AGENT-EDGES D1 retires the case that stood here ("a bare row is not a
   * lane fact: both sides unsettled, no side-index row"). A wordless write is
   * refused by name, so there is no bare row for a side argument to be
   * ignored on. Its surviving half — an UNSETTLED side indexes nothing — is
   * pinned by "the same fully-unsettled edge written twice leaves ONE row"
   * above, which asserts the same empty index over a row that can still be
   * written.
   */
  test("the wordless write this file used to place sides on is refused by name (D1)", () => {
    const result = write(["ignored", "ignored"], null);

    expect(result.written).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "invalid-relation",
    ]);
    expect(columns()).toEqual([]);
    expect(sideRows()).toEqual([]);
  });

  /**
   * THE behavioural pin for ticket 09's narrowed identity key, now read off
   * RAW SQL. While `tags` was still in that key the two side columns were a
   * FUNCTION of it, so taking them out reddened DDL text and nothing else —
   * this property only became independently true once the merged component
   * left.
   *
   * main-agent-edges TICKET 01 FINISHED THE JOB. The write path lost the
   * multi-row shape at D5 (identity is the pair), and the cutover then took it
   * from the TABLE too: `(citing_kind, citing_id, cited_kind, cited_id)` is
   * the UNIQUE key, so the side columns are no longer part of any identity and
   * three rows on one pair cannot be stored at all. What this case pins now is
   * that inversion — the FIRST side placement lands, the second is refused,
   * whatever its sides.
   *
   * Mutation: drop the pair UNIQUE from `memoryEdgesPostCutoverTableDdl` and
   * the second insert lands instead of throwing.
   */
  test("the stored UNIQUE key is the PAIR — a second row with different sides is refused", () => {
    const insert = db.query<unknown, [number, number, string, string]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, provenance,
          tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
       VALUES ('turn', ?, 'turn', ?, 'asserted', ?, ?, 'use', '', 300)`,
    );
    insert.run(citing, cited, "lane-a", "lane-a");
    expect(() => insert.run(citing, cited, "lane-b", "lane-b")).toThrow();
    expect(() => insert.run(citing, cited, "lane-a", "lane-b")).toThrow();

    expect(columns().map((row) => [row.tailTag, row.headTag])).toEqual([
      ["lane-a", "lane-a"],
    ]);
  });

  /**
   * The CASCADE, re-addressed by main-agent-edges D4/D5: `retractMemoryEdges`
   * takes `{citing, cited}` and removes every row of the pair, so the sibling
   * this case used to leave standing — a second side placement of the SAME
   * pair — cannot exist to be left. What the cascade still owes is that a
   * deleted row takes its own side-index rows with it, which is what the
   * foreign key's ON DELETE CASCADE is for.
   */
  test("retraction takes the side-index rows with it", () => {
    write(["lane-a", "lane-a"]);
    expect(sideRows()).toHaveLength(2);

    retractMemoryEdges(db, [
      {
        citing: { kind: "turn", id: citing },
        cited: { kind: "turn", id: cited },
      },
    ]);

    expect(columns()).toEqual([]);
    expect(sideRows()).toEqual([]);
  });
});
