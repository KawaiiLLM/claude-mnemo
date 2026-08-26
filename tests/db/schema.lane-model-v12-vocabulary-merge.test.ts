import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT,
  LaneMigrationOrderError,
  runLaneModelV12VocabularyMerge,
  type LaneModelV12VocabularyMergeReceipt,
} from "../../src/db/lanes";
import {
  ensureMemoryEdgesLaneModelV12RelationContract,
  initializeSchema,
  runLaneModelV12EdgeMigration,
} from "../../src/db/schema";
import { downgradeToPreV12EdgeShape } from "../support/pre-v12-edge-shape";

/**
 * lane-model-v12 M-B and M-D (spec D4, ticket 03): the two words v12's
 * seven-word vocabulary does not contain leave the data (`refutes` and
 * `supersedes` become `override`) and then leave the table's CHECK.
 *
 * THE FIXTURE IS THE LIVE COLLISION, not a synthetic one. Measured read-only
 * on the production database: `S15069/T1072 -> T1068` carries edge 2643
 * (`refutes`, `asserted`, untagged, created 1787212083) AND edge 3010
 * (`override`, `judged`, untagged, created 1787337397). The rename makes their
 * identity keys equal. An earlier revision of the spec called the whole
 * migration collision-free because it had only checked `supersedes` — so the
 * pair that actually exists is what the merge rule is proved against, and the
 * receipt is asserted to name BOTH rows rather than a count.
 *
 * The rest of the live shape, same measurement: 150 `supersedes` rows (2
 * asserted, 148 judged), all turn->turn, all untagged, no same-pair collision
 * of their own; 8 `refutes` rows (6 asserted), all untagged.
 */
describe("lane-model-v12 M-B — the vocabulary merge", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    // Back to the shape M-B is the ONLY shape M-B can meet (ticket 09):
    // `initializeSchema` now ends with M-E, so the table it returns has no
    // `tags` column at all — while this phase merges on an identity key that
    // ends in the tag payload and runs, by the ordering barrier's own
    // guarantee, strictly before that column moves.
    downgradeToPreV12EdgeShape(db);
    // `initializeSchema` already ran the phase on this empty database; every
    // test below starts from a pending one.
    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT,
    );
    sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('vocabulary-merge', '/tmp/project', 100) RETURNING id`,
      )
      .get()!.id;
  });

  afterEach(() => {
    db.close();
  });

  function seedTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, created_at_epoch, status)
         VALUES (?, ?, 100, 'extracted') RETURNING id`,
      )
      .get(sessionId, promptNumber)!.id;
  }

  /**
   * Writes straight to the table with the CHECK suspended: `refutes` and
   * `supersedes` are the words M-B exists to remove, so by the time this
   * migration has run once no writer — not `writeMemoryEdges`, not the raw
   * table — can produce one. The fixture has to say what it means: a row a
   * build older than this migration left behind.
   */
  function seedEdge(
    citing: number,
    cited: number,
    relation: string,
    provenance: string,
    tags = "[]",
    createdAtEpoch = 100,
  ): number {
    db.exec("PRAGMA ignore_check_constraints = ON");
    try {
      const id = db
        .query<{ id: number }, [number, number, string, string, string, number]>(
          `INSERT INTO memory_edges
             (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
           VALUES ('turn', ?, 'turn', ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(citing, cited, relation, provenance, tags, createdAtEpoch)!.id;
      for (const tag of JSON.parse(tags) as string[]) {
        db.query<unknown, [number, string]>(
          "INSERT INTO memory_edge_tags (edge_row_id, tag) VALUES (?, ?)",
        ).run(id, tag);
      }
      return id;
    } finally {
      db.exec("PRAGMA ignore_check_constraints = OFF");
    }
  }

  const receipt = (): LaneModelV12VocabularyMergeReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT)!.payload,
    ) as LaneModelV12VocabularyMergeReceipt;

  const edges = (): Array<{ id: number; relation: string | null; provenance: string; tags: string; createdAtEpoch: number }> =>
    db
      .query<
        { id: number; relation: string | null; provenance: string; tags: string; createdAtEpoch: number },
        []
      >(
        `SELECT id, relation, provenance, tags, created_at_epoch AS createdAtEpoch
         FROM memory_edges ORDER BY id`,
      )
      .all();

  // THE MEASURED COLLISION, reproduced row for row.
  test("the live colliding pair merges onto the asserted row, and the receipt names both sides", () => {
    const t1072 = seedTurn(1072);
    const t1068 = seedTurn(1068);
    const refutes = seedEdge(t1072, t1068, "refutes", "asserted", "[]", 1787212083);
    const override = seedEdge(t1072, t1068, "override", "judged", "[]", 1787337397);

    runLaneModelV12VocabularyMerge(db, 500);

    // ONE row survives, and it is the `asserted` one — its row id, its
    // `created_at`, its provenance, all its own.
    expect(edges()).toEqual([
      {
        id: refutes,
        relation: "override",
        provenance: "asserted",
        tags: "[]",
        createdAtEpoch: 1787212083,
      },
    ]);

    const payload = receipt();
    expect(payload.rewritten).toEqual([
      { edgeId: refutes, from: "refutes", to: "override", tagsCleared: false },
    ]);
    expect(payload.merged).toEqual([
      {
        citingAddress: `S${sessionId}/T1072`,
        citedAddress: `S${sessionId}/T1068`,
        tags: "[]",
        keptEdgeId: refutes,
        keptRelation: "refutes",
        keptProvenance: "asserted",
        keptCreatedAtEpoch: 1787212083,
        droppedEdgeId: override,
        droppedRelation: "override",
        droppedProvenance: "judged",
        droppedCreatedAtEpoch: 1787337397,
        rule: "provenance",
      },
    ]);
  });

  // The rule's second clause, which the live data happens not to exercise.
  test("two asserted rows on one key keep the EARLIER, and the receipt says which clause fired", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    const earlier = seedEdge(citing, cited, "override", "asserted", "[]", 100);
    const later = seedEdge(citing, cited, "refutes", "asserted", "[]", 900);

    runLaneModelV12VocabularyMerge(db, 500);

    expect(edges().map((edge) => edge.id)).toEqual([earlier]);
    expect(receipt().merged).toEqual([
      expect.objectContaining({
        keptEdgeId: earlier,
        keptProvenance: "asserted",
        droppedEdgeId: later,
        droppedProvenance: "asserted",
        rule: "earlier",
      }),
    ]);
    // The kept row was already `override`, so nothing was rewritten at all.
    expect(receipt().rewritten).toEqual([]);
  });

  // The two words differ in exactly one respect, and only here.
  test("refutes keeps its tags; supersedes becomes an UNTAGGED override, index rows included", () => {
    const a = seedTurn(1);
    const b = seedTurn(2);
    const c = seedTurn(3);
    const taggedRefutes = seedEdge(a, b, "refutes", "asserted", '["lane-a"]');
    const taggedSupersedes = seedEdge(c, b, "supersedes", "judged", '["lane-a"]');

    runLaneModelV12VocabularyMerge(db, 500);

    expect(edges()).toEqual([
      { id: taggedRefutes, relation: "override", provenance: "asserted", tags: '["lane-a"]', createdAtEpoch: 100 },
      { id: taggedSupersedes, relation: "override", provenance: "judged", tags: "[]", createdAtEpoch: 100 },
    ]);
    // The side index follows the column it mirrors, never left orphaned.
    expect(
      db
        .query<{ edgeRowId: number }, []>(
          "SELECT edge_row_id AS edgeRowId FROM memory_edge_tags ORDER BY edge_row_id",
        )
        .all(),
    ).toEqual([{ edgeRowId: taggedRefutes }]);
    expect(receipt().rewritten).toEqual([
      { edgeId: taggedRefutes, from: "refutes", to: "override", tagsCleared: false },
      { edgeId: taggedSupersedes, from: "supersedes", to: "override", tagsCleared: true },
    ]);
  });

  // The tag payload is the LAST component of the identity key, so clearing it
  // is itself a way to collide — a shape no rename alone produces.
  test("clearing a supersedes row's tags can itself collide, and merges under the same rule", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    const untagged = seedEdge(citing, cited, "override", "asserted", "[]", 100);
    const tagged = seedEdge(citing, cited, "supersedes", "judged", '["lane-a"]', 200);

    runLaneModelV12VocabularyMerge(db, 500);

    expect(edges().map((edge) => edge.id)).toEqual([untagged]);
    expect(receipt().merged).toEqual([
      expect.objectContaining({
        tags: "[]",
        keptEdgeId: untagged,
        droppedEdgeId: tagged,
        droppedRelation: "supersedes",
      }),
    ]);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edge_tags").get()!.n,
    ).toBe(0);
  });

  test("a database with nothing to merge still writes a receipt, so the phase is provably settled", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    seedEdge(citing, cited, "extends", "asserted");

    runLaneModelV12VocabularyMerge(db, 500);

    expect(receipt()).toEqual({ rewritten: [], merged: [] });
    expect(edges()).toHaveLength(1);
  });

  // "A receipt row exists and a second run changes nothing" does not by itself
  // prove crash safety: the receipt could have committed while the data did
  // not. The failpoint aborts the receipt insert, which is inside the SAME
  // transaction as every rewrite and delete.
  test("failpoint: the data and the receipt commit together or not at all", () => {
    const t1072 = seedTurn(1072);
    const t1068 = seedTurn(1068);
    const refutes = seedEdge(t1072, t1068, "refutes", "asserted", "[]", 1787212083);
    const override = seedEdge(t1072, t1068, "override", "judged", "[]", 1787337397);

    db.exec(
      `CREATE TRIGGER vocabulary_merge_failpoint BEFORE INSERT ON migration_receipts
       WHEN NEW.name = '${LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT}'
       BEGIN SELECT RAISE(ABORT, 'injected crash'); END`,
    );
    expect(() => runLaneModelV12VocabularyMerge(db, 500)).toThrow(/injected crash/);

    // Nothing landed: the deleted duplicate is back, and the survivor still
    // carries its pre-migration word.
    expect(edges().map((edge) => [edge.id, edge.relation])).toEqual([
      [refutes, "refutes"],
      [override, "override"],
    ]);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT)!.n,
    ).toBe(0);

    // The reopen finishes it exactly once.
    db.exec("DROP TRIGGER vocabulary_merge_failpoint");
    runLaneModelV12VocabularyMerge(db, 600);
    expect(edges().map((edge) => [edge.id, edge.relation])).toEqual([[refutes, "override"]]);
    expect(receipt().merged).toHaveLength(1);
  });

  test("a second run is a no-op, and stays one even with the receipt removed", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    const kept = seedEdge(citing, cited, "refutes", "asserted");

    runLaneModelV12VocabularyMerge(db, 500);
    runLaneModelV12VocabularyMerge(db, 600);

    expect(edges().map((edge) => [edge.id, edge.relation])).toEqual([[kept, "override"]]);
    // The receipt keeps the FIRST run's epoch — the second inserted nothing.
    expect(
      db
        .query<{ applied: number }, [string]>(
          "SELECT applied_at_epoch AS applied FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT)!.applied,
    ).toBe(500);

    db.query<unknown, [string]>("DELETE FROM migration_receipts WHERE name = ?").run(
      LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT,
    );
    runLaneModelV12VocabularyMerge(db, 700);
    expect(edges().map((edge) => [edge.id, edge.relation])).toEqual([[kept, "override"]]);
  });

  // The gate is the PREDICATE, not the receipt. "This ran once" and "no such
  // row can exist" are different statements, and the M-D CHECK narrow
  // immediately downstream refuses to rebuild around a row it cannot admit —
  // so a retired-word row that appears after the receipt (a restored backup,
  // a fixture hand-building a pre-migration table) has to be repaired, not
  // skipped.
  test("a retired-word row appearing AFTER the receipt is still repaired", () => {
    runLaneModelV12VocabularyMerge(db, 500);
    expect(receipt()).toEqual({ rewritten: [], merged: [] });

    const citing = seedTurn(1);
    const cited = seedTurn(2);
    const late = seedEdge(citing, cited, "supersedes", "judged");

    runLaneModelV12VocabularyMerge(db, 600);

    expect(edges().map((edge) => [edge.id, edge.relation])).toEqual([[late, "override"]]);
    // The receipt still records the FIRST run — a standing repair is a repair,
    // not a second migration, and overwriting the original findings to say so
    // would destroy the audit trail.
    expect(receipt()).toEqual({ rewritten: [], merged: [] });
  });

  // M-B merges on an identity key that ENDS in the tag payload, so unlike M-C
  // it has a side with respect to the `tags` -> `tail_tag`/`head_tag` change
  // (v12 tickets 05/09). Checked where the damage would be, not in a comment.
  test("a PENDING merge against an already-contracted table refuses with a named error", () => {
    const contracted = createDatabase(":memory:");
    try {
      contracted.exec(`
        CREATE TABLE migration_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          applied_at_epoch INTEGER NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, prompt_number INTEGER);
        CREATE TABLE memory_edge_tags (edge_row_id INTEGER NOT NULL, tag TEXT NOT NULL);
        CREATE TABLE memory_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          citing_kind TEXT NOT NULL, citing_id INTEGER NOT NULL,
          cited_kind TEXT NOT NULL, cited_id INTEGER NOT NULL,
          relation TEXT, provenance TEXT NOT NULL,
          tail_tag TEXT NOT NULL DEFAULT '', head_tag TEXT NOT NULL DEFAULT '',
          created_at_epoch INTEGER NOT NULL DEFAULT 0
        );
      `);

      let thrown: unknown;
      try {
        runLaneModelV12VocabularyMerge(contracted, 500);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LaneMigrationOrderError);
      expect((thrown as Error).message).toContain("two-sided v12 shape");
      expect((thrown as Error).message).toContain("lane-model-v12 spec D4");

      // SETTLED plus no `tags` column is the ordinary post-column-change
      // shape, and must sail past rather than trip.
      contracted
        .query<unknown, [string]>(
          "INSERT INTO migration_receipts (name, applied_at_epoch, payload) VALUES (?, 200, '{}')",
        )
        .run(LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT);
      expect(() => runLaneModelV12VocabularyMerge(contracted, 500)).not.toThrow();
    } finally {
      contracted.close();
    }
  });
});

/**
 * M-B ON AN EXPANDED TABLE — the restore case the phase claims to support, and
 * the one the tests above structurally cannot reach: every fixture there forces
 * the table back to the PRE-v12 one-sided shape first, so the two side columns
 * are not present to be got wrong.
 *
 * The shape below is ticket 05's EXPAND target: `tags` still there, `tail_tag`
 * and `head_tag` beside it, and all three in the identity UNIQUE. It is what an
 * operator produces by dropping an old `memory_edges` into a database whose
 * table has already moved — the exact scenario M-B's predicate gate (rather
 * than a receipt gate) exists for.
 *
 * WHAT THE PEER REVIEW CAUGHT. M-B grouped collisions by pair + the merged
 * `tags` alone. On this shape two rows of DIFFERENT lane identity —
 * `override tail=a/head=b` and `refutes tail=c/head=d` — both say `tags = '[]'`,
 * so they read as one identity key and one of them is deleted as a duplicate,
 * losing an arc nothing had asserted was the same. The side cleanup that would
 * have made the sides comparable happens later in the phase, after the grouping
 * is already done.
 */
describe("lane-model-v12 M-B — an EXPANDED restore (both sides in the identity key)", () => {
  let db: Database;

  const EXPANDED_DDL = `
    CREATE TABLE migration_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at_epoch INTEGER NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      prompt_number INTEGER
    );
    CREATE TABLE memory_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      citing_kind TEXT NOT NULL,
      citing_id INTEGER NOT NULL,
      cited_kind TEXT NOT NULL,
      cited_id INTEGER NOT NULL,
      relation TEXT,
      provenance TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      tail_tag TEXT NOT NULL DEFAULT '',
      head_tag TEXT NOT NULL DEFAULT '',
      created_at_epoch INTEGER NOT NULL,
      UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tags, tail_tag, head_tag)
    );
    CREATE TABLE memory_edge_tags (
      edge_row_id INTEGER NOT NULL REFERENCES memory_edges(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (edge_row_id, tag)
    );
    CREATE TABLE memory_edge_side_tags (
      edge_row_id INTEGER NOT NULL REFERENCES memory_edges(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK (side IN ('tail', 'head')),
      tag TEXT NOT NULL,
      PRIMARY KEY (edge_row_id, side)
    );
  `;

  beforeEach(() => {
    db = createDatabase(":memory:");
    db.exec(EXPANDED_DDL);
    for (const promptNumber of [1, 2, 3, 4]) {
      db.query("INSERT INTO turns (session_id, prompt_number) VALUES (1, ?)").run(promptNumber);
    }
  });

  afterEach(() => {
    db.close();
  });

  function seedEdge(
    citing: number,
    cited: number,
    relation: string,
    provenance: string,
    tags: string,
    tailTag: string,
    headTag: string,
    createdAtEpoch = 100,
  ): number {
    const id = db
      .query<{ id: number }, [number, number, string, string, string, string, string, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, relation, provenance,
            tags, tail_tag, head_tag, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(citing, cited, relation, provenance, tags, tailTag, headTag, createdAtEpoch)!.id;
    for (const [side, tag] of [
      ["tail", tailTag],
      ["head", headTag],
    ] as const) {
      if (tag !== "") {
        db.query("INSERT INTO memory_edge_side_tags (edge_row_id, side, tag) VALUES (?, ?, ?)").run(
          id,
          side,
          tag,
        );
      }
    }
    return id;
  }

  const rows = (): Array<{
    id: number;
    relation: string | null;
    provenance: string;
    tags: string;
    tailTag: string;
    headTag: string;
  }> =>
    db
      .query<
        {
          id: number;
          relation: string | null;
          provenance: string;
          tags: string;
          tailTag: string;
          headTag: string;
        },
        []
      >(
        `SELECT id, relation, provenance, tags, tail_tag AS tailTag, head_tag AS headTag
         FROM memory_edges ORDER BY id`,
      )
      .all();

  const receipt = (): LaneModelV12VocabularyMergeReceipt =>
    JSON.parse(
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM migration_receipts WHERE name = ?",
        )
        .get(LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT)!.payload,
    ) as LaneModelV12VocabularyMergeReceipt;

  // THE DEFECT, stated as a fixture. Same pair, same (empty) merged tag set,
  // DIFFERENT sides — two identities under the table's own UNIQUE, and the
  // rename does not make them one.
  test("two rows of different SIDE identity are not duplicates, however identical their merged tag sets", () => {
    const kept = seedEdge(1, 2, "override", "judged", "[]", "lane-a", "lane-b");
    const renamed = seedEdge(1, 2, "refutes", "asserted", "[]", "lane-c", "lane-d");

    runLaneModelV12VocabularyMerge(db, 500);

    expect(rows()).toEqual([
      {
        id: kept,
        relation: "override",
        provenance: "judged",
        tags: "[]",
        tailTag: "lane-a",
        headTag: "lane-b",
      },
      {
        id: renamed,
        relation: "override",
        provenance: "asserted",
        tags: "[]",
        tailTag: "lane-c",
        headTag: "lane-d",
      },
    ]);
    expect(receipt().merged).toEqual([]);
    expect(receipt().rewritten).toEqual([
      { edgeId: renamed, from: "refutes", to: "override", tagsCleared: false },
    ]);
  });

  // The other direction, so the key is not merely proved to be timid: rows
  // that DO tie on the full key still merge, under the same rule.
  test("two rows on the SAME sides still merge, and the dropped row leaves no index row behind", () => {
    const dropped = seedEdge(3, 4, "override", "judged", "[]", "lane-a", "lane-b");
    const kept = seedEdge(3, 4, "refutes", "asserted", "[]", "lane-a", "lane-b");

    runLaneModelV12VocabularyMerge(db, 500);

    expect(rows()).toEqual([
      {
        id: kept,
        relation: "override",
        provenance: "asserted",
        tags: "[]",
        tailTag: "lane-a",
        headTag: "lane-b",
      },
    ]);
    expect(receipt().merged.map((entry) => [entry.keptEdgeId, entry.droppedEdgeId, entry.rule])).toEqual(
      [[kept, dropped, "provenance"]],
    );
    expect(
      db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM memory_edge_side_tags WHERE edge_row_id = ?",
        )
        .get(dropped)!.n,
    ).toBe(0);
  });

  /**
   * THE SAME ASSERTION UNDER `PRAGMA foreign_keys = OFF`, and only this one
   * can tell. `memory_edge_side_tags.edge_row_id` cascades on
   * `memory_edges(id)`, so with foreign keys ON the lookup row disappears
   * whether or not this phase deletes it — the test above passes over a
   * version that leaves the cascade to do the work, which makes it no guard
   * at all for that property.
   *
   * The pragma is not hypothetical: EVERY `memory_edges` rebuild in
   * db/schema.ts (M-A, M-D, M-E) turns it off around the table swap, and this
   * phase shares a slot with them. A restore repaired in one of those windows
   * would strand a side-index row pointing at a deleted edge, and the side
   * index is a read source for the checker's three lane passes.
   */
  test("the dropped row's side-index rows go even with foreign keys OFF, not by cascade", () => {
    const dropped = seedEdge(3, 4, "override", "judged", "[]", "lane-a", "lane-b");
    const kept = seedEdge(3, 4, "refutes", "asserted", "[]", "lane-a", "lane-b");

    db.exec("PRAGMA foreign_keys = OFF");
    try {
      runLaneModelV12VocabularyMerge(db, 500);
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }

    expect(rows().map((row) => row.id)).toEqual([kept]);
    expect(
      db
        .query<{ edgeRowId: number; side: string; tag: string }, []>(
          "SELECT edge_row_id AS edgeRowId, side, tag FROM memory_edge_side_tags ORDER BY edge_row_id, side",
        )
        .all()
        .map((row) => row.edgeRowId),
    ).toEqual([kept, kept]);
    expect(dropped).not.toBe(kept);
  });

  // `supersedes` projects to an UNTAGGED override — `'[]'` AND `('', '')`. The
  // key has to be built from the projected values, or the row is grouped by an
  // identity it is about to stop having.
  test("supersedes is grouped by what it BECOMES: empty tags and both sides unset", () => {
    const kept = seedEdge(1, 3, "override", "asserted", "[]", "", "", 100);
    const dropped = seedEdge(1, 3, "supersedes", "judged", '["lane-x"]', "lane-x", "lane-x", 200);

    runLaneModelV12VocabularyMerge(db, 500);

    expect(rows()).toEqual([
      {
        id: kept,
        relation: "override",
        provenance: "asserted",
        tags: "[]",
        tailTag: "",
        headTag: "",
      },
    ]);
    expect(receipt().merged.map((entry) => entry.droppedEdgeId)).toEqual([dropped]);
  });

  // The same projection when there is NOTHING to collide with: the row must
  // still lose both representations of its lane, not just the merged one.
  test("a lone supersedes loses its sides as well as its tag set, and its side index rows", () => {
    const lone = seedEdge(2, 4, "supersedes", "judged", '["lane-x"]', "lane-x", "lane-x");

    runLaneModelV12VocabularyMerge(db, 500);

    expect(rows()).toEqual([
      {
        id: lone,
        relation: "override",
        provenance: "judged",
        tags: "[]",
        tailTag: "",
        headTag: "",
      },
    ]);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edge_side_tags").get()!.n,
    ).toBe(0);
    expect(receipt().rewritten).toEqual([
      { edgeId: lone, from: "supersedes", to: "override", tagsCleared: true },
    ]);
  });
});

describe("lane-model-v12 M-D — the relation CHECK narrows onto the seven words", () => {
  let open: Database | undefined;

  afterEach(() => {
    open?.close();
    open = undefined;
  });

  /**
   * An installation as it stands BEFORE this migration: the previous chain's
   * final CHECK (nine words), carrying rows under both retired words, a tag
   * index row, and the endpoint prune triggers the rebuild must not disturb.
   */
  function preMigrationDatabase(): {
    db: Database;
    refutes: number;
    supersedes: number;
    kept: number;
    turns: number[];
  } {
    const db = createDatabase(":memory:");
    open = db;
    initializeSchema(db);
    // Ticket 09: the shape M-B/M-D actually run against — see the beforeEach.
    downgradeToPreV12EdgeShape(db);
    const sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('check-narrow', '/tmp/project', 100) RETURNING id`,
      )
      .get()!.id;
    const turns = [1, 2, 3].map(
      (promptNumber) =>
        db
          .query<{ id: number }, [number, number]>(
            `INSERT INTO turns (session_id, prompt_number, created_at_epoch, status)
             VALUES (?, ?, 100, 'extracted') RETURNING id`,
          )
          .get(sessionId, promptNumber)!.id,
    );

    // Put the table back to the shape this migration inherits: the previous
    // chain's final CHECK, which still names both retired words. Written out
    // rather than derived, so a later edit to the live DDL cannot quietly
    // change what "before" meant here.
    db.exec("DROP TABLE memory_edges");
    db.exec(`
      CREATE TABLE memory_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        citing_kind TEXT NOT NULL CHECK (citing_kind IN ('turn', 'segment', 'session')),
        citing_id INTEGER NOT NULL,
        cited_kind TEXT NOT NULL CHECK (cited_kind IN ('turn', 'segment')),
        cited_id INTEGER NOT NULL,
        relation TEXT CHECK (
          relation IS NULL OR
          relation IN ('override', 'narrows', 'extends', 'indexes', 'consume',
                       'grounds', 'verifies', 'refutes', 'supersedes')
        ),
        provenance TEXT NOT NULL CHECK (
          provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
        ),
        tags TEXT NOT NULL DEFAULT '[]' CHECK (
          json_valid(tags) AND json_type(tags) = 'array'
        ),
        created_at_epoch INTEGER NOT NULL,
        CHECK (citing_kind <> cited_kind OR citing_id <> cited_id OR relation IS NOT NULL),
        UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tags)
      );
      CREATE INDEX idx_memory_edges_cited ON memory_edges(cited_kind, cited_id, relation);
      CREATE UNIQUE INDEX idx_memory_edges_bare_pair
        ON memory_edges(citing_kind, citing_id, cited_kind, cited_id)
        WHERE relation IS NULL;
    `);
    // EXPLICIT, NON-CONTIGUOUS row ids, and not for flavour: they are what a
    // rebuild that forgot to carry `id` across would silently renumber to
    // 1/2/3, re-keying `memory_edge_tags` against rows it never described.
    // With ids allocated in order that mutation is invisible.
    const insert = (
      id: number,
      citing: number,
      cited: number,
      relation: string,
      tags: string,
    ): number =>
      db
        .query<{ id: number }, [number, number, number, string, string]>(
          `INSERT INTO memory_edges
             (id, citing_kind, citing_id, cited_kind, cited_id, relation, provenance, tags, created_at_epoch)
           VALUES (?, 'turn', ?, 'turn', ?, ?, 'asserted', ?, 100) RETURNING id`,
        )
        .get(id, citing, cited, relation, tags)!.id;
    const refutes = insert(41, turns[1]!, turns[0]!, "refutes", '["lane-a"]');
    const supersedes = insert(58, turns[2]!, turns[0]!, "supersedes", "[]");
    const kept = insert(93, turns[2]!, turns[1]!, "extends", '["lane-a"]');
    for (const edgeId of [refutes, kept]) {
      db.query<unknown, [number]>(
        "INSERT INTO memory_edge_tags (edge_row_id, tag) VALUES (?, 'lane-a')",
      ).run(edgeId);
    }

    // Re-arm both v12 phases so the whole slot runs as it would on upgrade.
    db.exec("DELETE FROM migration_receipts WHERE name LIKE 'lane-model-v12-%'");
    return { db, refutes, supersedes, kept, turns };
  }

  const storedDdl = (db: Database): string =>
    db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;

  test("both retired words leave the CHECK, and surviving rows keep their ids, tags and audit columns", () => {
    const { db, refutes, supersedes, kept } = preMigrationDatabase();
    expect(storedDdl(db)).toContain("'supersedes'");

    runLaneModelV12EdgeMigration(db);

    // The CHECK is now exactly the seven-word write vocabulary.
    for (const word of ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"]) {
      expect(storedDdl(db)).toContain(`'${word}'`);
    }
    expect(storedDdl(db)).not.toContain("'supersedes'");
    expect(storedDdl(db)).not.toContain("'refutes'");

    // Row ids survive every rebuild in the slot — the side index's
    // `edge_row_id` references them, so a fresh AUTOINCREMENT sequence would
    // silently re-key it. The LANE columns are read here rather than the
    // merged set: this runs the whole slot, whose last phase (M-E, ticket 09)
    // retires that set, so what the words' departure must leave intact is the
    // two sides M-A derived from it.
    expect(
      db
        .query<
          { id: number; relation: string; tailTag: string; headTag: string; provenance: string },
          []
        >(
          `SELECT id, relation, tail_tag AS tailTag, head_tag AS headTag, provenance
           FROM memory_edges ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: refutes, relation: "override", tailTag: "lane-a", headTag: "lane-a", provenance: "asserted" },
      { id: supersedes, relation: "override", tailTag: "", headTag: "", provenance: "asserted" },
      { id: kept, relation: "extends", tailTag: "lane-a", headTag: "lane-a", provenance: "asserted" },
    ]);
    expect(
      db
        .query<{ edgeRowId: number; side: string }, []>(
          `SELECT edge_row_id AS edgeRowId, side FROM memory_edge_side_tags
           ORDER BY edge_row_id, side`,
        )
        .all()
        .map((row) => [row.edgeRowId, row.side]),
    ).toEqual([
      [refutes, "head"],
      [refutes, "tail"],
      [kept, "head"],
      [kept, "tail"],
    ]);
  });

  test("neither retired word can be inserted afterwards, and the live seven still can", () => {
    const { db, turns } = preMigrationDatabase();
    runLaneModelV12EdgeMigration(db);

    const insert = (relation: string): void => {
      db.query<unknown, [number, number, string]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, ?, 'asserted', 200)`,
      ).run(turns[0]!, turns[2]!, relation);
    };
    expect(() => insert("supersedes")).toThrow();
    expect(() => insert("refutes")).toThrow();
    expect(() => insert("grounds")).not.toThrow();
  });

  test("the rebuild keeps the endpoint prune triggers and the table's own indexes", () => {
    const { db, kept, turns } = preMigrationDatabase();
    runLaneModelV12EdgeMigration(db);

    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_edges' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toContain("idx_memory_edges_cited");

    // The trigger has to fire against the REBUILT table, not a dropped one.
    // Renaming the ORIGINAL away instead of the replacement in would have
    // rewritten these trigger bodies onto a table this phase then drops.
    db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(turns[0]!);
    expect(
      db
        .query<{ id: number }, []>("SELECT id FROM memory_edges ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual([kept]);
  });

  test("a second run rebuilds nothing: the DDL and the rows are byte-identical", () => {
    const { db } = preMigrationDatabase();
    runLaneModelV12EdgeMigration(db);
    const ddl = storedDdl(db);
    const rows = db.query<Record<string, unknown>, []>("SELECT * FROM memory_edges ORDER BY id").all();

    runLaneModelV12EdgeMigration(db);

    expect(storedDdl(db)).toBe(ddl);
    expect(db.query<Record<string, unknown>, []>("SELECT * FROM memory_edges ORDER BY id").all()).toEqual(rows);
  });

  // A fresh database is born narrow, so the probe skips it — the whole slot is
  // a no-op on it rather than an unnecessary table rebuild.
  test("a fresh database is born without either word and is never rebuilt", () => {
    const db = createDatabase(":memory:");
    open = db;
    initializeSchema(db);
    expect(storedDdl(db)).not.toContain("'supersedes'");
    expect(storedDdl(db)).not.toContain("'refutes'");
    expect(() => runLaneModelV12EdgeMigration(db)).not.toThrow();
  });

  /**
   * The precondition M-B guarantees, asserted on the narrow ITSELF rather than
   * through the slot — inside the slot M-B always repairs first, so this is
   * unreachable there by construction, and that is exactly why the guard needs
   * its own test: a future ticket reordering the phases would otherwise learn
   * about it through a raw SQLITE_CONSTRAINT from a table copy.
   */
  test("the narrow refuses a stranded retired-word row by name, instead of failing on the CHECK", () => {
    const { db } = preMigrationDatabase();

    let thrown: unknown;
    try {
      ensureMemoryEdgesLaneModelV12RelationContract(db);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain("retired relation");
    expect((thrown as Error).message).toContain("runLaneModelV12VocabularyMerge");
    // Nothing was half-rebuilt: the table is still the wide one.
    expect(storedDdl(db)).toContain("'supersedes'");
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edges").get()!.n,
    ).toBe(3);
  });
});
