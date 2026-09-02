import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import {
  initializeSchema,
  MEMORY_EDGES_RELATION_CLASS_BACKFILL_RECEIPT,
  type MemoryEdgesRelationClassBackfillReceipt,
} from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  edgeRelationClass,
  LEGACY_RELATION_CLASS,
} from "../../src/shared/relation-class";
import { EDGE_RELATIONS, type TurnEdgeRelation } from "../../src/shared/turn-phase";

/**
 * Relation-vocabulary-v13 ticket 03 — the seven-to-three migration.
 *
 * The property under test is not "the columns got filled". It is that filling
 * them CHANGES NO READER'S ANSWER: `edgeRelationClass` already falls back to
 * `LEGACY_RELATION_CLASS[relation]`, so this sweep writes down what every
 * class-reader was already computing. Every test here is a statement about that
 * equivalence, about what the sweep refuses to touch (`relation`, an
 * already-classified row, a bare row), or about the receipt that makes "has this
 * database been swept" answerable rather than inferred.
 *
 * The fixtures are LEGACY-SHAPED by construction: `writeMemoryEdges` with no
 * class on the input stores the word and leaves both class columns `''`, which
 * is byte-for-byte the shape every row written before the v13 release carries.
 * Clearing the receipt afterwards is what makes the database "not yet swept" —
 * `initializeSchema` writes that receipt on the very first open, empty table
 * included, so a test that only inserted rows would be testing a database the
 * migration had already declared done.
 */
describe("relation-vocabulary-v13 ticket 03 — legacy relation classification", () => {
  let db: Database;
  let sessionId: number;
  let nextPrompt = 1;
  const EPOCH = 1_900_000_000;

  function addTurn(): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', 100)
         RETURNING id`,
      )
      .get(sessionId, nextPrompt++)!.id;
  }

  /** A row in the pre-v13 shape: a stored word, both class columns `''`. */
  function seedLegacyEdge(relation: TurnEdgeRelation): number {
    const citing = addTurn();
    const cited = addTurn();
    const { written } = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation,
          provenance: "judged",
        },
      ],
      EPOCH,
    );
    expect(written).toHaveLength(1);
    return written[0]!.id;
  }

  /**
   * A WORDLESS row of the same era, seeded PAST the write path.
   *
   * main-agent-edges D1 retired the wordless write — `writeMemoryEdges`
   * refuses a `relation: null` input by name — but the stored population is
   * untouched by that: 696 `judged` bare rows and 1,187 `text-ref` ones stand
   * until ticket 01's cutover deletes them, and this sweep runs over exactly
   * that stock and has to keep leaving it alone. So the fixture states the row
   * in SQL rather than pretending a writer will still produce one.
   */
  function seedWordlessEdge(provenance: "judged" | "text-ref" = "judged"): number {
    const citing = addTurn();
    const cited = addTurn();
    return db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, relation, provenance,
            tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, NULL, ?, '', '', '', '', ?)
         RETURNING id`,
      )
      .get(citing, cited, provenance, EPOCH)!.id;
  }

  /** The "never swept" state: rows present, no receipt. */
  function clearReceipt(): void {
    db.run("DELETE FROM migration_receipts WHERE name = ?", [
      MEMORY_EDGES_RELATION_CLASS_BACKFILL_RECEIPT,
    ]);
  }

  function receiptRows(): number {
    return db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM migration_receipts WHERE name = ?",
      )
      .get(MEMORY_EDGES_RELATION_CLASS_BACKFILL_RECEIPT)!.c;
  }

  function receipt(): MemoryEdgesRelationClassBackfillReceipt {
    const row = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM migration_receipts WHERE name = ?",
      )
      .get(MEMORY_EDGES_RELATION_CLASS_BACKFILL_RECEIPT);
    expect(row).not.toBeNull();
    return JSON.parse(row!.payload) as MemoryEdgesRelationClassBackfillReceipt;
  }

  interface StoredEdge {
    id: number;
    relation: string | null;
    relation_class: string;
    relation_coverage: string;
  }

  function readEdge(id: number): StoredEdge {
    return db
      .query<StoredEdge, [number]>(
        `SELECT id, relation, relation_class, relation_coverage
           FROM memory_edges WHERE id = ?`,
      )
      .get(id)!;
  }

  function allEdges(): StoredEdge[] {
    return db
      .query<StoredEdge, []>(
        `SELECT id, relation, relation_class, relation_coverage
           FROM memory_edges ORDER BY id`,
      )
      .all();
  }

  /** What `edgeRelationClass` answers for a stored row, as one comparable token. */
  function readerAnswer(row: StoredEdge): string {
    const answer = edgeRelationClass({
      relation: row.relation,
      relationClass: row.relation_class as never,
      relationCoverage: row.relation_coverage as never,
    });
    return answer
      ? `${answer.relationClass}/${answer.relationCoverage || "-"}`
      : "null";
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    nextPrompt = 1;
    sessionId = upsertSession(db, {
      contentSessionId: "session-relation-class-backfill",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------
  // One fixture per old word: its destination AND its bit
  // ---------------------------------------------------------------------

  const DESTINATIONS: ReadonlyArray<
    readonly [TurnEdgeRelation, class_: string, coverage: string]
  > = [
    ["override", "correct", "full"],
    ["narrows", "correct", "partial"],
    ["verifies", "verify", ""],
    ["extends", "use", ""],
    ["consume", "use", ""],
    ["grounds", "use", ""],
    ["indexes", "use", ""],
  ];

  test("the destination table covers every word the storage vocabulary admits", () => {
    // Not decoration: a word added to `EDGE_RELATIONS` without a case here
    // would migrate silently under whatever `LEGACY_RELATION_CLASS` said, with
    // no fixture asserting the bit.
    expect([...DESTINATIONS.map(([word]) => word)].sort()).toEqual(
      [...EDGE_RELATIONS].sort(),
    );
  });

  for (const [word, expectedClass, expectedCoverage] of DESTINATIONS) {
    test(`\`${word}\` migrates to ${expectedClass}${expectedCoverage ? `(${expectedCoverage})` : ""}`, () => {
      const id = seedLegacyEdge(word);
      expect(readEdge(id).relation_class).toBe("");
      clearReceipt();

      initializeSchema(db);

      const row = readEdge(id);
      expect(row.relation_class).toBe(expectedClass);
      expect(row.relation_coverage).toBe(expectedCoverage);
      // The whole point of "no re-judgement": the word is still the word.
      expect(row.relation).toBe(word);
    });
  }

  // ---------------------------------------------------------------------
  // A legacy-shaped database: additive, idempotent, receipted once
  // ---------------------------------------------------------------------

  describe("a legacy-shaped database", () => {
    let seeded: Map<number, TurnEdgeRelation | null>;

    beforeEach(() => {
      seeded = new Map();
      for (const word of EDGE_RELATIONS) {
        seeded.set(seedLegacyEdge(word), word);
        seeded.set(seedLegacyEdge(word), word);
      }
      // Both wordless populations: settlement's own output and the prose index.
      seeded.set(seedWordlessEdge(), null);
      seeded.set(seedWordlessEdge(), null);
      clearReceipt();
    });

    test("classifies every worded row, destroys none, and rewrites no word", () => {
      const before = allEdges();
      const beforeWords = new Map(before.map((row) => [row.id, row.relation]));
      expect(before.every((row) => row.relation_class === "")).toBe(true);

      initializeSchema(db);

      const after = allEdges();
      expect(after).toHaveLength(before.length);
      for (const row of after) {
        expect(row.relation).toBe(beforeWords.get(row.id)!);
        if (row.relation === null) {
          continue;
        }
        const mapped = LEGACY_RELATION_CLASS[row.relation as TurnEdgeRelation];
        expect(row.relation_class).toBe(mapped.relationClass);
        expect(row.relation_coverage).toBe(mapped.relationCoverage);
      }
    });

    test("no reader's answer moves — the sweep is a materialization", () => {
      const before = new Map(allEdges().map((row) => [row.id, readerAnswer(row)]));

      initializeSchema(db);

      for (const row of allEdges()) {
        expect(readerAnswer(row)).toBe(before.get(row.id)!);
      }
    });

    test("the receipt is written once and accounts for what ran", () => {
      expect(receiptRows()).toBe(0);

      initializeSchema(db);

      expect(receiptRows()).toBe(1);
      const written = receipt();
      expect(written.classified).toBe(EDGE_RELATIONS.length * 2);
      for (const word of EDGE_RELATIONS) {
        expect(written.classifiedByRelation[word]).toBe(2);
      }
      expect(written.bareRowsLeftUnclassified).toBe(2);
      expect(written.unknownWordRowsLeftUnclassified).toBe(0);
    });

    test("idempotent: a second open changes no row and writes no second receipt", () => {
      initializeSchema(db);
      const first = allEdges();
      const firstApplied = db
        .query<{ applied_at_epoch: number }, [string]>(
          "SELECT applied_at_epoch FROM migration_receipts WHERE name = ?",
        )
        .get(MEMORY_EDGES_RELATION_CLASS_BACKFILL_RECEIPT)!.applied_at_epoch;

      initializeSchema(db);
      initializeSchema(db);

      expect(allEdges()).toEqual(first);
      expect(receiptRows()).toBe(1);
      expect(
        db
          .query<{ applied_at_epoch: number }, [string]>(
            "SELECT applied_at_epoch FROM migration_receipts WHERE name = ?",
          )
          .get(MEMORY_EDGES_RELATION_CLASS_BACKFILL_RECEIPT)!.applied_at_epoch,
      ).toBe(firstApplied);
    });

    test("rollback is a read-side switch: clearing the two columns restores the pre-sweep row", () => {
      const before = allEdges();
      initializeSchema(db);

      db.exec("UPDATE memory_edges SET relation_class = '', relation_coverage = ''");

      expect(allEdges()).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------
  // The wordless population — DECIDED, not defaulted
  // ---------------------------------------------------------------------

  describe("wordless rows (`relation IS NULL`) stay unclassified", () => {
    /**
     * The 696 `judged` bare rows the ticket singles out, and the 1,187
     * `text-ref` ones beside them, are the PAIR'S EXISTENCE RECORD, not an
     * unclassified relation. `use` is a claim settlement never made; minting it
     * in a migration would be re-judgement, would break the materialization
     * equivalence above (`edgeRelationClass` answers `null` today), and would
     * make the bare row answer to the `relation: null` retraction address AND
     * to a class. So they stay `''` — and the receipt records how many, which is
     * what makes `''` readable rather than ambiguous.
     */
    test("both bare populations survive the sweep with `''` in both columns", () => {
      const judged = seedWordlessEdge("judged");
      const textRef = seedWordlessEdge("text-ref");
      clearReceipt();

      initializeSchema(db);

      for (const id of [judged, textRef]) {
        const row = readEdge(id);
        expect(row.relation).toBeNull();
        expect(row.relation_class).toBe("");
        expect(row.relation_coverage).toBe("");
        expect(readerAnswer(row)).toBe("null");
      }
      expect(receipt().bareRowsLeftUnclassified).toBe(2);
    });

    test("the receipt is what tells `never swept` from `classified as nothing`", () => {
      seedWordlessEdge();
      seedLegacyEdge("override");
      clearReceipt();

      // State 1 — no receipt: every `''` means "not yet swept".
      expect(receiptRows()).toBe(0);
      expect(
        db
          .query<{ c: number }, []>(
            "SELECT COUNT(*) AS c FROM memory_edges WHERE relation_class = ''",
          )
          .get()!.c,
      ).toBe(2);

      initializeSchema(db);

      // State 2 — receipt present: the only `''` left is the bare row, which is
      // "classified as nothing" by construction, and the receipt counts it.
      expect(receiptRows()).toBe(1);
      const unclassified = db
        .query<{ relation: string | null }, []>(
          "SELECT relation FROM memory_edges WHERE relation_class = ''",
        )
        .all();
      expect(unclassified).toEqual([{ relation: null }]);
      expect(receipt().bareRowsLeftUnclassified).toBe(1);
      expect(receipt().unknownWordRowsLeftUnclassified).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // A MIXED database — rows a ticket-02 write already classified
  // ---------------------------------------------------------------------

  describe("a mixed database", () => {
    /**
     * A row whose stored class DISAGREES with what its stored word maps to.
     * The migration must leave it alone: a stored class is a writer's
     * statement, and the sweep only materializes the fallback for rows that
     * have no statement of their own. Chosen deliberately over an agreeing
     * pair, which would pass whether or not the `relation_class = ''` guard
     * exists.
     */
    function seedDisagreeingClassifiedEdge(): number {
      const citing = addTurn();
      const cited = addTurn();
      const { written } = writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "extends",
            provenance: "asserted",
            relationClass: "correct",
            relationCoverage: "full",
          },
        ],
        EPOCH,
      );
      return written[0]!.id;
    }

    test("an already-classified row is not re-derived from its legacy word", () => {
      const classified = seedDisagreeingClassifiedEdge();
      const legacy = seedLegacyEdge("extends");
      clearReceipt();

      initializeSchema(db);

      const kept = readEdge(classified);
      expect(kept.relation).toBe("extends");
      expect(kept.relation_class).toBe("correct");
      expect(kept.relation_coverage).toBe("full");

      const swept = readEdge(legacy);
      expect(swept.relation_class).toBe("use");
      expect(swept.relation_coverage).toBe("");
    });

    test("the receipt counts only the rows the sweep actually classified", () => {
      seedDisagreeingClassifiedEdge();
      seedLegacyEdge("extends");
      seedLegacyEdge("verifies");
      clearReceipt();

      initializeSchema(db);

      const written = receipt();
      expect(written.classified).toBe(2);
      expect(written.classifiedByRelation.extends).toBe(1);
      expect(written.classifiedByRelation.verifies).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // The ON CONFLICT gap ticket 02 left open
  // ---------------------------------------------------------------------

  describe("re-asserting over a pre-existing legacy row (ticket 02's owed gap)", () => {
    function reassert(
      citing: number,
      cited: number,
      relation: TurnEdgeRelation,
      relationClass?: "correct" | "verify" | "use",
      relationCoverage?: "full" | "partial",
    ): void {
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation,
            provenance: "judged",
            ...(relationClass ? { relationClass } : {}),
            ...(relationCoverage ? { relationCoverage } : {}),
          },
        ],
        EPOCH,
      );
    }

    test("a class-carrying restatement classifies the unclassified row it conflicts with", () => {
      const citing = addTurn();
      const cited = addTurn();
      reassert(citing, cited, "override");
      const id = db
        .query<{ id: number }, []>("SELECT id FROM memory_edges ORDER BY id DESC LIMIT 1")
        .get()!.id;
      expect(readEdge(id).relation_class).toBe("");

      reassert(citing, cited, "override", "correct", "full");

      const row = readEdge(id);
      expect(row.relation_class).toBe("correct");
      expect(row.relation_coverage).toBe("full");
      // One row, not two: the conflict path is still a restatement.
      expect(
        db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_edges").get()!.c,
      ).toBe(1);
    });

    test("a CLASSLESS restatement still classifies, from the stored word", () => {
      const citing = addTurn();
      const cited = addTurn();
      reassert(citing, cited, "narrows");
      const id = db
        .query<{ id: number }, []>("SELECT id FROM memory_edges ORDER BY id DESC LIMIT 1")
        .get()!.id;

      reassert(citing, cited, "narrows");

      const row = readEdge(id);
      expect(row.relation_class).toBe("correct");
      expect(row.relation_coverage).toBe("partial");
    });

    test("a restatement never overwrites a class the row already carries", () => {
      const citing = addTurn();
      const cited = addTurn();
      reassert(citing, cited, "extends", "correct", "full");
      const id = db
        .query<{ id: number }, []>("SELECT id FROM memory_edges ORDER BY id DESC LIMIT 1")
        .get()!.id;

      reassert(citing, cited, "extends", "verify");
      reassert(citing, cited, "extends");

      const row = readEdge(id);
      expect(row.relation_class).toBe("correct");
      expect(row.relation_coverage).toBe("full");
    });

    test("the conflict path returns the row it satisfied, as the write contract requires", () => {
      const citing = addTurn();
      const cited = addTurn();
      reassert(citing, cited, "verifies");
      const { written } = writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citing },
            cited: { kind: "turn", id: cited },
            relation: "verifies",
            provenance: "judged",
            relationClass: "verify",
          },
        ],
        EPOCH,
      );
      expect(written).toHaveLength(1);
      expect(written[0]!.relationClass).toBe("verify");
      expect(written[0]!.relation).toBe("verifies");
    });
  });
});
