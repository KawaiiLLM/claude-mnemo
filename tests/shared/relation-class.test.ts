import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { attachTurnRelations } from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { checkLanes } from "../../src/shared/lane-checker";
import { electMilestones } from "../../src/shared/milestone-election";
import {
  displayEdgeRelation,
  edgeRelationClass,
  INTERIM_LEGACY_RELATION,
  interimLegacyRelation,
  LEGACY_RELATION_CLASS,
  LEGACY_RELATIONS_BY_CLASS,
  RELATION_CLASSES,
  RELATION_COVERAGES,
} from "../../src/shared/relation-class";
import { EDGE_RELATIONS } from "../../src/shared/turn-phase";

/**
 * relation-vocabulary-v13 ticket 02 — the storage half.
 *
 * The vocabulary change is additive by construction, and this file is where
 * that construction is pinned:
 *
 *   - `memory_edges.relation` keeps its seven-word CHECK, so ticket 03 can
 *     migrate the existing corpus WITHOUT rewriting it and rollback stays a
 *     read-side switch;
 *   - `relation_class` / `relation_coverage` are the two added columns, and the
 *     coverage bit is a STORED guarantee (a table CHECK), not a convention the
 *     write path happens to honour;
 *   - the INTERIM equivalence is what keeps a three-class edge visible to every
 *     reader still keyed on the old words, and ticket 05a replaces exactly that
 *     table.
 */

describe("the mapping tables are total and mutually consistent", () => {
  test("every storage word maps to a class, and every class back to at least one word", () => {
    for (const relation of EDGE_RELATIONS) {
      const mapped = LEGACY_RELATION_CLASS[relation];
      expect(RELATION_CLASSES, relation).toContain(mapped.relationClass);
      expect(LEGACY_RELATIONS_BY_CLASS[mapped.relationClass], relation).toContain(relation);
    }
    for (const relationClass of RELATION_CLASSES) {
      expect(LEGACY_RELATIONS_BY_CLASS[relationClass].length).toBeGreaterThan(0);
    }
    // The v13 spec's own absorption table, stated once here so a silent
    // re-pointing of any word fails loudly.
    expect([...LEGACY_RELATIONS_BY_CLASS.correct].sort()).toEqual(["narrows", "override"]);
    expect([...LEGACY_RELATIONS_BY_CLASS.verify]).toEqual(["verifies"]);
    expect([...LEGACY_RELATIONS_BY_CLASS.use].sort()).toEqual([
      "consume",
      "extends",
      "grounds",
      "indexes",
    ]);
  });

  test("the coverage bit exists exactly where the class is `correct`", () => {
    for (const relation of EDGE_RELATIONS) {
      const { relationClass, relationCoverage } = LEGACY_RELATION_CLASS[relation];
      expect(relationCoverage !== "", relation).toBe(relationClass === "correct");
      if (relationCoverage !== "") {
        expect(RELATION_COVERAGES, relation).toContain(relationCoverage);
      }
    }
  });

  // THE INTERIM TABLE (relation-vocabulary-v13 ticket 05a replaces it, and
  // nothing else). It is the equivalence that lets the frozen election weights,
  // `db/edge-signals.ts` and the lane checker's coupling groups keep reading a
  // three-class edge with no change at their own seams.
  test("the INTERIM equivalence is (correct/full≈override, correct/partial≈narrows, verify≈verifies, use≈extends)", () => {
    expect(
      INTERIM_LEGACY_RELATION.map((row) => [
        row.relationClass,
        row.relationCoverage,
        row.legacy,
      ]),
    ).toEqual([
      ["correct", "full", "override"],
      ["correct", "partial", "narrows"],
      ["verify", "", "verifies"],
      ["use", "", "extends"],
    ]);
    // Every legal (class, coverage) write has exactly one interim destination,
    // and each destination is a real storage word.
    for (const relationClass of RELATION_CLASSES) {
      const coverages = relationClass === "correct" ? RELATION_COVERAGES : ([""] as const);
      for (const coverage of coverages) {
        const legacy = interimLegacyRelation(relationClass, coverage);
        expect(EDGE_RELATIONS, `${relationClass}/${coverage}`).toContain(legacy);
      }
    }
    // The interim word ROUND-TRIPS back to the class it came from — without
    // that, a row written today would read as a different class tomorrow.
    for (const row of INTERIM_LEGACY_RELATION) {
      expect(LEGACY_RELATION_CLASS[row.legacy]).toEqual({
        relationClass: row.relationClass,
        relationCoverage: row.relationCoverage,
      });
    }
  });

  test("interimLegacyRelation throws rather than guessing at an illegal pairing", () => {
    expect(() => interimLegacyRelation("use", "full")).toThrow();
    expect(() => interimLegacyRelation("correct", "")).toThrow();
  });
});

describe("edgeRelationClass is the ONE accessor, for a legacy row and a classified one alike", () => {
  test("a classified row answers from its own columns", () => {
    expect(
      edgeRelationClass({ relation: "extends", relationClass: "correct", relationCoverage: "full" }),
    ).toEqual({ relationClass: "correct", relationCoverage: "full" });
  });

  test("an UNCLASSIFIED legacy row answers from its stored word — one fixture per word", () => {
    for (const relation of EDGE_RELATIONS) {
      expect(
        edgeRelationClass({ relation, relationClass: "", relationCoverage: "" }),
        relation,
      ).toEqual(LEGACY_RELATION_CLASS[relation]);
    }
  });

  test("a BARE row and an out-of-vocabulary word have no class at all", () => {
    expect(edgeRelationClass({ relation: null, relationClass: "", relationCoverage: "" })).toBeNull();
    expect(
      edgeRelationClass({ relation: "supersedes", relationClass: "", relationCoverage: "" }),
    ).toBeNull();
  });

  // The rendering asymmetry is deliberate, and it is what keeps ticket 03's
  // migration honest: a legacy row renders EXACTLY as it did before this
  // release until that ticket classifies it, so nothing about the existing
  // corpus's rendering moves here.
  test("a legacy row renders its own word, unchanged; a classified row renders its class", () => {
    for (const relation of EDGE_RELATIONS) {
      expect(
        displayEdgeRelation({ relation, relationClass: "", relationCoverage: "" }),
        relation,
      ).toBe(relation);
    }
    expect(
      displayEdgeRelation({
        relation: "override",
        relationClass: "correct",
        relationCoverage: "full",
      }),
    ).toBe("correct(full)");
    expect(
      displayEdgeRelation({
        relation: "narrows",
        relationClass: "correct",
        relationCoverage: "partial",
      }),
    ).toBe("correct(partial)");
    expect(
      displayEdgeRelation({ relation: "extends", relationClass: "use", relationCoverage: "" }),
    ).toBe("use");
  });
});

describe("the two added columns are a STORED guarantee, not a write-path convention", () => {
  let db: Database;
  let sessionId: number;
  let citing: number;
  let cited: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "relation-class-storage",
      project: "/tmp/relation-class",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    const insert = db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
       VALUES (?, ?, 'active', 'p', 100) RETURNING id`,
    );
    cited = insert.get(sessionId, 1)!.id;
    citing = insert.get(sessionId, 2)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("the columns exist beside `relation`, which keeps its own seven-word CHECK", () => {
    const columns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("relation");
    expect(columns).toContain("relation_class");
    expect(columns).toContain("relation_coverage");

    const ddl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;
    // UNCHANGED, and that is the point: ticket 03's migration writes only the
    // two new columns, so an existing row keeps its original word and rollback
    // is a read-side switch rather than a data restore.
    for (const relation of EDGE_RELATIONS) {
      expect(ddl, relation).toContain(`'${relation}'`);
    }
    for (const relationClass of RELATION_CLASSES) {
      expect(ddl, relationClass).not.toContain(`relation IN`.concat(` ('${relationClass}'`));
    }
  });

  test("the bare-pair uniqueness index and the identity key still hold", () => {
    const indexes = db
      .query<{ name: string; sql: string | null }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_edges'",
      )
      .all();
    const barePair = indexes.find((row) => row.name === "idx_memory_edges_bare_pair");
    expect(barePair?.sql).toContain("WHERE relation IS NULL");
    // Neither new column joins the identity key: the class is a FUNCTION of the
    // stored word for a legacy row and is filled FROM it for a new one, so
    // adding it to the key could only split one claim into two rows.
    const ddl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;
    expect(ddl).toContain(
      "UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation, tail_tag, head_tag)",
    );
    expect(ddl).not.toContain("relation_class, tail_tag");
  });

  test("the table itself refuses a `correct` with no coverage and a `use` with one", () => {
    const raw = db.query<unknown, [string, string, string]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, relation, provenance,
          tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
       VALUES ('turn', ${citing}, 'turn', ${cited}, ?, 'judged', '', '', ?, ?, 100)`,
    );
    expect(() => raw.run("override", "correct", "")).toThrow();
    expect(() => raw.run("extends", "use", "full")).toThrow();
    expect(() => raw.run("extends", "nonsense", "")).toThrow();
    // …and the legal shapes go through.
    raw.run("override", "correct", "full");
    raw.run("extends", "use", "");
  });

  test("a write that states no class stores `''` in both — the pre-v13 row shape", () => {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "grounds",
          provenance: "judged",
        },
      ],
      200,
    );
    const [edge] = getOutgoingEdges(db, { kind: "turn", id: citing });
    expect(edge?.relationClass).toBe("");
    expect(edge?.relationCoverage).toBe("");
    // …and it still answers the class question, through the one accessor.
    expect(edgeRelationClass(edge!)).toEqual({ relationClass: "use", relationCoverage: "" });
  });

  test("attachTurnRelations fills both columns and the interim word together", () => {
    const result = attachTurnRelations(
      db,
      citing,
      [
        {
          relationClass: "correct",
          targets: [{ turn: `S${sessionId}/T1`, tailTag: "", headTag: "", coverage: "full" }],
        },
      ],
      300,
      "judged",
    );
    expect(result.rejected).toEqual([]);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]).toMatchObject({
      relation: "override",
      relationClass: "correct",
      relationCoverage: "full",
    });
  });
});

describe("a row written under the RETIRED vocabulary is unchanged for every reader", () => {
  /** One legacy row per old word, plus the two turns it joins, in one lane. */
  function legacyGraph(relation: string) {
    return {
      turns: [
        { id: 1, type: ["design"], laneTags: ["lane-a"] },
        { id: 2, type: ["implement"], laneTags: ["lane-a"] },
      ],
      edges: [
        {
          citingId: 2,
          citedId: 1,
          relation,
          tailTag: "lane-a",
          headTag: "lane-a",
        },
      ],
    };
  }

  test("the lane checker admits every old word to its graph, with no out-of-vocabulary finding", () => {
    for (const relation of EDGE_RELATIONS) {
      const { turns, edges } = legacyGraph(relation);
      const result = checkLanes(turns as never, edges as never);
      expect(result.vocabularyConformance.outOfVocabularyEdges.count, relation).toBe(0);
    }
  });

  // main-agent-edges ticket 02: the election has no IN-degree term any more —
  // its four terms are out-degree, the outgoing class sum, recency and type.
  // What a legacy word still has to do is RESOLVE to its class, which is what
  // the class sum prices; the assertion moves to that.
  test("election prices every old word through its CLASS — one fixture per word", () => {
    const expected: Record<string, number> = {
      override: 2, // correct(full)
      narrows: 1.5, // correct(partial)
      verifies: 1, // verify
      extends: 0.5,
      consume: 0.5,
      grounds: 0.5,
      indexes: 0.5,
    };
    for (const relation of EDGE_RELATIONS) {
      const { turns, edges } = legacyGraph(relation);
      const elected = electMilestones(turns as never, edges as never);
      const citer = elected.candidates.find((entry) => entry.id === 2);
      expect(citer, relation).toBeTruthy();
      expect(citer!.outDegree, relation).toBe(1);
      expect(citer!.classScore, relation).toBe(expected[relation]!);
    }
  });

  // THE INTERIM EQUIVALENCE, AT THE ELECTION SEAM. A NEW three-class edge
  // scores exactly as the old-vocabulary edge it replaces — which since
  // main-agent-edges ticket 02 is true by CONSTRUCTION rather than by a frozen
  // word table: both go through `edgeRelationClass`, so the only way they could
  // differ is if the legacy bridge mapped the word to the wrong class.
  test("INTERIM: a new-class edge scores identically to its old-word equivalent", () => {
    for (const row of INTERIM_LEGACY_RELATION) {
      const legacy = legacyGraph(row.legacy);
      // What a v13 write actually stores: the interim word in `relation`, plus
      // the class and bit in their own columns.
      const classified = {
        turns: legacy.turns,
        edges: [
          {
            ...legacy.edges[0]!,
            relationClass: row.relationClass,
            relationCoverage: row.relationCoverage,
          },
        ],
      };
      const before = electMilestones(legacy.turns as never, legacy.edges as never);
      const after = electMilestones(classified.turns as never, classified.edges as never);
      expect(
        after.candidates.map((entry) => [entry.id, entry.score, entry.classScore, entry.outDegree]),
        `${row.relationClass}/${row.relationCoverage}`,
      ).toEqual(
        before.candidates.map((entry) => [entry.id, entry.score, entry.classScore, entry.outDegree]),
      );
    }
  });
});
