import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { attachTurnRelations } from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import { getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  displayEdgeRelation,
  edgeRelationClass,
  formatRelationClass,
  RELATION_CLASSES,
  RELATION_COVERAGES,
  relationClassBearingSql,
} from "../../src/shared/relation-class";

/**
 * `shared/relation-class.ts` after the main-agent-edges cutover (ticket 01).
 *
 * WHAT LEFT, AND WHY THIS FILE SHRANK. Three whole blocks went with the
 * `relation` column:
 *
 *   - "the mapping tables are total and mutually consistent" — it walked
 *     `EDGE_RELATIONS` against `LEGACY_RELATION_CLASS` /
 *     `LEGACY_RELATIONS_BY_CLASS`. All three constants are deleted; the seven
 *     words survive only as a frozen migration literal in `db/schema.ts`, and
 *     the sweep that consumes it is pinned by
 *     `tests/db/schema.relation-class-backfill.test.ts`.
 *   - the LEGACY arms of `edgeRelationClass` / `displayEdgeRelation` — a row
 *     with no class no longer resolves from a word, it resolves to `null`.
 *   - "a row written under the RETIRED vocabulary is unchanged for every
 *     reader" — every reader now takes the class columns, and no stored row
 *     carries a word to be unchanged about.
 *
 * WHAT REMAINS is the module as it now is: three classes, the coverage bit one
 * of them carries, the ONE accessor and its single surviving `null` arm (the
 * deferral window, where D9's fence has postponed the migration and a
 * pre-cutover wordless row still stands), and the storage guarantee the table
 * itself makes.
 */

describe("the class vocabulary is three closed values with one coverage bit", () => {
  test("the classes and coverages are exactly the spec's", () => {
    expect([...RELATION_CLASSES]).toEqual(["correct", "verify", "use"]);
    expect([...RELATION_COVERAGES]).toEqual(["full", "partial"]);
  });

  test("the token spelling is one function, used by every surface", () => {
    expect(formatRelationClass("correct", "full")).toBe("correct(full)");
    expect(formatRelationClass("correct", "partial")).toBe("correct(partial)");
    expect(formatRelationClass("verify", "")).toBe("verify");
    expect(formatRelationClass("use", "")).toBe("use");
  });

  test("the SQL form names the same three values and nothing else", () => {
    const sql = relationClassBearingSql("me");
    for (const relationClass of RELATION_CLASSES) {
      expect(sql, relationClass).toContain(`'${relationClass}'`);
    }
    expect(sql).toContain("me.relation_class IN");
  });
});

describe("edgeRelationClass is the ONE accessor, and its only `null` is the deferral window", () => {
  test("a classified row answers from its own columns", () => {
    expect(edgeRelationClass({ relationClass: "correct", relationCoverage: "full" })).toEqual({
      relationClass: "correct",
      relationCoverage: "full",
    });
    expect(edgeRelationClass({ relationClass: "use", relationCoverage: "" })).toEqual({
      relationClass: "use",
      relationCoverage: "",
    });
  });

  test("a row carrying NO class has none — the pre-cutover wordless row, in the deferral window", () => {
    expect(edgeRelationClass({ relationClass: "", relationCoverage: "" })).toBeNull();
    expect(displayEdgeRelation({ relationClass: "", relationCoverage: "" })).toBe("");
  });

  test("a classified row renders its class token", () => {
    expect(displayEdgeRelation({ relationClass: "correct", relationCoverage: "full" })).toBe(
      "correct(full)",
    );
    expect(displayEdgeRelation({ relationClass: "correct", relationCoverage: "partial" })).toBe(
      "correct(partial)",
    );
    expect(displayEdgeRelation({ relationClass: "verify", relationCoverage: "" })).toBe("verify");
    expect(displayEdgeRelation({ relationClass: "use", relationCoverage: "" })).toBe("use");
  });
});

describe("the two class columns are a STORED guarantee, not a write-path convention", () => {
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

  test("the class columns are there and the seven-word column is NOT", () => {
    const columns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("relation");
    expect(columns).toContain("relation_class");
    expect(columns).toContain("relation_coverage");

    const ddl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;
    for (const word of ["override", "narrows", "extends", "indexes", "consume", "grounds", "verifies"]) {
      expect(ddl, word).not.toContain(`'${word}'`);
    }
    expect(ddl).toContain("relation_class TEXT NOT NULL CHECK (relation_class IN ('correct', 'verify', 'use'))");
  });

  test("the identity key is the PAIR, and the bare-pair index is gone with the bare rows", () => {
    const indexes = db
      .query<{ name: string; sql: string | null }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_edges'",
      )
      .all();
    expect(indexes.map((row) => row.name)).not.toContain("idx_memory_edges_bare_pair");
    const ddl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()!.sql;
    // Neither class column joins the key: one pair is one row, and its class
    // is what a promotion REWRITES in place rather than a second row's name.
    expect(ddl).toContain("UNIQUE (citing_kind, citing_id, cited_kind, cited_id)");
    expect(ddl).not.toContain("relation_class, tail_tag");
  });

  test("the table itself refuses a `correct` with no coverage, a `use` with one, and a nonsense class", () => {
    const raw = db.query<unknown, [string, string]>(
      `INSERT INTO memory_edges
         (citing_kind, citing_id, cited_kind, cited_id, provenance,
          tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
       VALUES ('turn', ${citing}, 'turn', ${cited}, 'judged', '', '', ?, ?, 100)`,
    );
    expect(() => raw.run("correct", "")).toThrow();
    expect(() => raw.run("use", "full")).toThrow();
    expect(() => raw.run("nonsense", "")).toThrow();
    expect(() => raw.run("", "")).toThrow();
    // …and a legal shape goes through. ONE of them: the pair is UNIQUE now, so
    // the second legal insert this case used to make is itself a refusal.
    raw.run("correct", "full");
    expect(() => raw.run("use", "")).toThrow();
  });

  test("a write states its class, and the stored row answers from it", () => {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relationClass: "use",
          provenance: "judged",
        },
      ],
      200,
    );
    const [edge] = getOutgoingEdges(db, { kind: "turn", id: citing });
    expect(edge?.relationClass).toBe("use");
    expect(edge?.relationCoverage).toBe("");
    expect(edgeRelationClass(edge!)).toEqual({ relationClass: "use", relationCoverage: "" });
  });

  test("attachTurnRelations fills both columns", () => {
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
      relationClass: "correct",
      relationCoverage: "full",
    });
  });
});
