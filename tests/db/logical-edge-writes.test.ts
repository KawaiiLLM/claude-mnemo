import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  attachTurnRelations,
  declareEdgeSides,
  formatRelationRejections,
  formatRetractionReceipt,
  retractTurnRelations,
} from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import {
  getOutgoingEdges,
  selectLogicalEdgeRow,
  writeMemoryEdges,
  RELATION_CLASS_SPECIFICITY,
} from "../../src/db/memory-edges";
import { createSegment } from "../../src/db/segments";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  checkRelationsGate,
  getFieldStamp,
  stampTurnRelationsRevision,
} from "../../src/db/write-gate";
import { edgeRelationClass } from "../../src/shared/relation-class";
import { downgradeToPreCutoverShape, seedPreCutoverEdge } from "../support/pre-cutover-edge-shape";

/**
 * MAIN-AGENT-EDGES ticket 03 — D4 + D5 + the read-once 00 addendum.
 *
 * ONE PAIR, ONE ROW is the invariant every case below turns on. Before it, a
 * logical edge could be several physical rows (109 such pairs in production)
 * because identity was (pair, relation, tail, head): a second class minted a
 * row, and so did a second lane placement. Every consequence this file pins
 * follows from narrowing that identity to the pair alone —
 *
 *   - PRECEDENCE (D5): within one call the most specific class wins;
 *     `correct(full)` and `correct(partial)` on one pair refuse the whole
 *     call; across calls a stronger class or a coverage change PROMOTES the
 *     stored row in place, a weaker one is a no-op;
 *   - DECLARATION (D4): a lane side is patched onto the SAME row, addressed by
 *     the pair with the class as an optional compare-and-swap precondition
 *     (T2432 P1), three-state per side, cardinality < 2 refused by name, one
 *     stamp, both lanes of a moved side reported as touches;
 *   - RETRACTION: addressed by the pair, class as the same CAS precondition —
 *     an edge somebody else promoted is refused by name rather than deleted on
 *     a stale read;
 *   - CAPS: 20/20 count LOGICAL edges, so a legacy multi-row pair is one;
 *   - THE FRESH-TURN GATE EXCEPTION (D3): a citing turn with zero outgoing
 *     relation atoms needs no relations read, writer-agnostic, wordless rows
 *     not counted.
 */
describe("logical edge writes (main-agent-edges D4/D5)", () => {
  const NOW = 1_800_000_000;

  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "logical-edges",
      project: "/tmp/logical-edges",
      title: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => db.close());

  function seedTurn(promptNumber: number, tags: string[] = []): number {
    return db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, title, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', 'fixture', ${NOW}, '[]', ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, JSON.stringify(tags))!.id;
  }

  function address(turnId: number): string {
    const row = db
      .query<{ promptNumber: number }, [number]>(
        "SELECT prompt_number AS promptNumber FROM turns WHERE id = ?",
      )
      .get(turnId)!;
    return `S${sessionId}/T${row.promptNumber}`;
  }

  function outgoing(turnId: number) {
    return getOutgoingEdges(db, { kind: "turn", id: turnId });
  }

  function attach(
    citing: number,
    fields: Array<{ relationClass: "correct" | "verify" | "use"; targets: unknown[] }>,
    epoch = NOW + 1,
  ) {
    return attachTurnRelations(db, citing, fields as never, epoch);
  }

  // -----------------------------------------------------------------------
  // D5 — precedence within one call
  // -----------------------------------------------------------------------

  test("several classes on one pair in ONE call collapse to the most specific, in one row", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);

    const result = attach(citing, [
      { relationClass: "use", targets: [address(cited)] },
      { relationClass: "verify", targets: [address(cited)] },
      { relationClass: "correct", targets: [{ turn: address(cited), coverage: "full" }] },
    ]);

    expect(result.rejected).toEqual([]);
    const rows = outgoing(citing);
    expect(rows).toHaveLength(1);
    expect(edgeRelationClass(rows[0]!)).toEqual({
      relationClass: "correct",
      relationCoverage: "full",
    });
  });

  test("`correct(full)` and `correct(partial)` on one pair in one call REFUSE the whole call, naming the pair", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    const other = seedTurn(3);

    const result = attach(citing, [
      {
        relationClass: "correct",
        targets: [
          { turn: address(cited), coverage: "full" },
          { turn: address(other), coverage: "partial" },
          { turn: address(cited), coverage: "partial" },
        ],
      },
    ]);

    expect(result.written).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBe("coverage-conflict");
    expect(result.rejected[0]!.raw).toBe(address(cited));
    // Nothing landed — not even the pair that was never in conflict.
    expect(outgoing(citing)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // D5 — promotion across calls
  // -----------------------------------------------------------------------

  test("a later STRONGER class promotes the stored row IN PLACE — same row id, provenance and creation time", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);

    attach(citing, [{ relationClass: "use", targets: [address(cited)] }], NOW + 1);
    const before = outgoing(citing)[0]!;

    const promotion = attach(
      citing,
      [{ relationClass: "correct", targets: [{ turn: address(cited), coverage: "partial" }] }],
      NOW + 500,
    );

    expect(promotion.rejected).toEqual([]);
    expect(promotion.written).toHaveLength(1);
    expect(promotion.restated).toEqual([]);

    const after = outgoing(citing);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.provenance).toBe(before.provenance);
    expect(after[0]!.createdAtEpoch).toBe(before.createdAtEpoch);
    expect(edgeRelationClass(after[0]!)).toEqual({
      relationClass: "correct",
      relationCoverage: "partial",
    });
  });

  test("a COVERAGE change on a stored `correct` promotes in place — it is a correction of the bit, not a demotion", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);

    attach(
      citing,
      [{ relationClass: "correct", targets: [{ turn: address(cited), coverage: "partial" }] }],
      NOW + 1,
    );
    const before = outgoing(citing)[0]!;

    const changed = attach(
      citing,
      [{ relationClass: "correct", targets: [{ turn: address(cited), coverage: "full" }] }],
      NOW + 2,
    );

    expect(changed.written).toHaveLength(1);
    const after = outgoing(citing);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.relationCoverage).toBe("full");
  });

  test("a later WEAKER class is a NO-OP — restated, not written, and never a second row", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);

    attach(
      citing,
      [{ relationClass: "correct", targets: [{ turn: address(cited), coverage: "full" }] }],
      NOW + 1,
    );
    const before = outgoing(citing)[0]!;

    const weaker = attach(citing, [{ relationClass: "use", targets: [address(cited)] }], NOW + 2);

    expect(weaker.written).toEqual([]);
    expect(weaker.restated).toHaveLength(1);
    const after = outgoing(citing);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(edgeRelationClass(after[0]!)).toEqual({
      relationClass: "correct",
      relationCoverage: "full",
    });
  });

  test("a second SIDE placement is never a second row — the stored sides stay as they are", () => {
    const citing = seedTurn(1, ["#alpha"]);
    const cited = seedTurn(2, ["#alpha"]);

    attach(citing, [{ relationClass: "use", targets: [address(cited)] }], NOW + 1);
    const first = outgoing(citing)[0]!;

    attach(
      citing,
      [
        {
          relationClass: "use",
          targets: [{ turn: address(cited), tailTag: "#alpha", headTag: "#alpha" }],
        },
      ],
      NOW + 2,
    );

    const after = outgoing(citing);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first.id);
    // Declaration is `declareEdgeSides`' job; an attach never re-places an edge.
    expect(after[0]!.tailTag).toBe("");
    expect(after[0]!.headTag).toBe("");
  });

  test("the precedence table ranks use < verify < correct, and coverage is not part of the rank", () => {
    expect(RELATION_CLASS_SPECIFICITY.use).toBeLessThan(RELATION_CLASS_SPECIFICITY.verify);
    expect(RELATION_CLASS_SPECIFICITY.verify).toBeLessThan(RELATION_CLASS_SPECIFICITY.correct);
  });

  // -----------------------------------------------------------------------
  // D1 — the wordless write path is retired
  // -----------------------------------------------------------------------

  test("a `relation: null` write is REFUSED by name, never silently dropped", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);

    const result = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relationClass: null as never,
          provenance: "text-ref",
        },
      ],
      NOW,
    );

    expect(result.written).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBe("invalid-relation");
    expect(outgoing(citing)).toHaveLength(0);
  });

  test("the retraction receipt carries ONE number — the restored-bare count is gone with the population", () => {
    expect(formatRetractionReceipt({ retracted: 2 })).toBe("Retracted 2 relation(s).");
    expect(formatRetractionReceipt({ retracted: 0 })).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Retraction — pair-addressed, class as a CAS precondition (T2432 P1)
  // -----------------------------------------------------------------------

  test("retracting a PROMOTED edge succeeds by its NEW class and is refused by name under the OLD one", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);

    attach(citing, [{ relationClass: "use", targets: [address(cited)] }], NOW + 1);
    attach(
      citing,
      [{ relationClass: "correct", targets: [{ turn: address(cited), coverage: "full" }] }],
      NOW + 2,
    );

    const stale = retractTurnRelations(
      db,
      citing,
      [{ relationClass: "use", targets: [address(cited)] }],
      NOW + 3,
    );
    expect(stale.deleted).toEqual([]);
    expect(stale.rejected).toHaveLength(1);
    expect(stale.rejected[0]!.reason).toBe("stale-class");
    expect(stale.rejected[0]!.currentClass).toBe("correct");
    expect(formatRelationRejections(stale.rejected, "retraction")).toContain(
      "is now `correct`, not `use`",
    );
    // Refused means NOTHING deleted.
    expect(outgoing(citing)).toHaveLength(1);

    const current = retractTurnRelations(
      db,
      citing,
      [{ relationClass: "correct", targets: [address(cited)] }],
      NOW + 4,
    );
    expect(current.rejected).toEqual([]);
    expect(current.deleted).toHaveLength(1);
    expect(outgoing(citing)).toHaveLength(0);
  });

  test("a retraction with NO class precondition removes the pair's edge whatever it says", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);

    attach(
      citing,
      [{ relationClass: "correct", targets: [{ turn: address(cited), coverage: "partial" }] }],
      NOW + 1,
    );

    const result = retractTurnRelations(
      db,
      citing,
      [{ relationClass: null, targets: [address(cited)] }],
      NOW + 2,
    );
    expect(result.rejected).toEqual([]);
    expect(result.deleted).toHaveLength(1);
    expect(outgoing(citing)).toHaveLength(0);
  });

  test("a retraction addresses the pair, so a DECLARED side does not have to be restated to remove the edge", () => {
    const segmentId = createSegment(db, { title: "task", tags: ["task-one"], nowEpoch: NOW }).id;
    insertLane(db, segmentId, "#alpha", NOW);
    insertLane(db, segmentId, "#beta", NOW);
    const citing = seedTurn(1, ["task-one", "#alpha", "#beta"]);
    const cited = seedTurn(2, ["task-one", "#alpha", "#beta"]);

    attach(citing, [{ relationClass: "use", targets: [address(cited)] }], NOW + 1);
    declareEdgeSides(
      db,
      { citingTurnId: citing, citedTurnId: cited, tailTag: "#alpha", headTag: "#beta" },
      "settlement",
      NOW + 2,
    );

    const result = retractTurnRelations(
      db,
      citing,
      [{ relationClass: "use", targets: [address(cited)] }],
      NOW + 3,
    );
    expect(result.rejected).toEqual([]);
    expect(result.deleted).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // D4 — declareEdgeSides
  // -----------------------------------------------------------------------

  describe("declareEdgeSides", () => {
    let segmentId: number;
    let citing: number;
    let cited: number;

    beforeEach(() => {
      segmentId = createSegment(db, { title: "task", tags: ["task-one"], nowEpoch: NOW }).id;
      insertLane(db, segmentId, "#alpha", NOW);
      insertLane(db, segmentId, "#beta", NOW);
      citing = seedTurn(1, ["task-one", "#alpha", "#beta"]);
      cited = seedTurn(2, ["task-one", "#alpha", "#beta"]);
      attach(citing, [{ relationClass: "use", targets: [address(cited)] }], NOW + 1);
    });

    test("declares IN PLACE — row id, class, coverage, provenance and creation time all survive", () => {
      const before = outgoing(citing)[0]!;

      const result = declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#alpha", headTag: "#beta" },
        "settlement",
        NOW + 2,
      );

      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      const after = outgoing(citing);
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(before.id);
      expect(after[0]!.relationClass).toBe(before.relationClass);
      expect(after[0]!.relationCoverage).toBe(before.relationCoverage);
      expect(after[0]!.provenance).toBe(before.provenance);
      expect(after[0]!.createdAtEpoch).toBe(before.createdAtEpoch);
      expect(after[0]!.tailTag).toBe("#alpha");
      expect(after[0]!.headTag).toBe("#beta");
    });

    test("an OMITTED side is left alone; an explicit `null` clears it", () => {
      declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#alpha", headTag: "#beta" },
        "settlement",
        NOW + 2,
      );

      // head omitted -> untouched; tail patched.
      declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#beta" },
        "settlement",
        NOW + 3,
      );
      let row = outgoing(citing)[0]!;
      expect(row.tailTag).toBe("#beta");
      expect(row.headTag).toBe("#beta");

      // explicit null -> cleared.
      declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, headTag: null },
        "settlement",
        NOW + 4,
      );
      row = outgoing(citing)[0]!;
      expect(row.tailTag).toBe("#beta");
      expect(row.headTag).toBe("");
    });

    test("a tag that is not the endpoint's own lane tag is refused as `invalid-declaration`", () => {
      insertLane(db, segmentId, "#gamma", NOW);
      const result = declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#gamma" },
        "settlement",
        NOW + 2,
      );
      expect(result.ok).toBe(false);
      expect(result.refusal?.reason).toBe("invalid-declaration");
      expect(outgoing(citing)[0]!.tailTag).toBe("");
    });

    test("an endpoint in FEWER THAN TWO lanes is refused BY NAME as derivable", () => {
      const unique = seedTurn(3, ["task-one", "#alpha"]);
      attach(citing, [{ relationClass: "use", targets: [address(unique)] }], NOW + 2);

      const result = declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: unique, headTag: "#alpha" },
        "settlement",
        NOW + 3,
      );
      expect(result.ok).toBe(false);
      expect(result.refusal?.reason).toBe("derivable");
      expect(result.message).toContain("derivable; no declaration needed");
    });

    test("the class is an optional CAS precondition: matching declares, stale refuses naming the current class", () => {
      attach(
        citing,
        [{ relationClass: "correct", targets: [{ turn: address(cited), coverage: "full" }] }],
        NOW + 2,
      );

      const stale = declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, relationClass: "use", tailTag: "#alpha" },
        "settlement",
        NOW + 3,
      );
      expect(stale.ok).toBe(false);
      expect(stale.refusal).toEqual({ reason: "stale-class", currentClass: "correct" });
      expect(stale.message).toContain("stale: the pair is now `correct`");
      expect(outgoing(citing)[0]!.tailTag).toBe("");

      const fresh = declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, relationClass: "correct", tailTag: "#alpha" },
        "settlement",
        NOW + 4,
      );
      expect(fresh.ok).toBe(true);
      expect(outgoing(citing)[0]!.tailTag).toBe("#alpha");
    });

    test("a pair with no edge is refused — a declaration never creates one", () => {
      const stranger = seedTurn(3, ["task-one", "#alpha", "#beta"]);
      const result = declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: stranger, tailTag: "#alpha" },
        "settlement",
        NOW + 2,
      );
      expect(result.ok).toBe(false);
      expect(result.refusal?.reason).toBe("no-such-edge");
      expect(outgoing(citing)).toHaveLength(1);
    });

    test("ONE stamp per changing call, and a no-op patch stamps nothing", () => {
      const sequenceOf = (): number =>
        getFieldStamp(db, "turn", citing, "relations")?.writeSequence ?? 0;

      const before = sequenceOf();
      declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#alpha", headTag: "#beta" },
        "settlement",
        NOW + 2,
      );
      const afterChange = sequenceOf();
      expect(afterChange).toBeGreaterThan(before);

      // Both sides already stored at these values -> nothing to change.
      const noop = declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#alpha", headTag: "#beta" },
        "settlement",
        NOW + 3,
      );
      expect(noop.ok).toBe(true);
      expect(noop.changed).toBe(false);
      expect(sequenceOf()).toBe(afterChange);
    });

    test("both the OLD and the NEW qualified lane of a moved side come back as touches", () => {
      declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#alpha" },
        "settlement",
        NOW + 2,
      );
      const moved = declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#beta" },
        "settlement",
        NOW + 3,
      );
      expect(moved.touches).toEqual([
        { turnId: citing, tag: "#alpha" },
        { turnId: citing, tag: "#beta" },
      ]);
    });

    test("the side index follows the declaration", () => {
      declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, tailTag: "#alpha", headTag: "#beta" },
        "settlement",
        NOW + 2,
      );
      const edgeId = outgoing(citing)[0]!.id;
      const rows = db
        .query<{ side: string; tag: string }, [number]>(
          "SELECT side, tag FROM memory_edge_side_tags WHERE edge_row_id = ? ORDER BY side",
        )
        .all(edgeId);
      expect(rows).toEqual([
        { side: "head", tag: "#beta" },
        { side: "tail", tag: "#alpha" },
      ]);

      declareEdgeSides(
        db,
        { citingTurnId: citing, citedTurnId: cited, headTag: null },
        "settlement",
        NOW + 3,
      );
      expect(
        db
          .query<{ side: string; tag: string }, [number]>(
            "SELECT side, tag FROM memory_edge_side_tags WHERE edge_row_id = ?",
          )
          .all(edgeId),
      ).toEqual([{ side: "tail", tag: "#alpha" }]);
    });

    // -----------------------------------------------------------------------
    // 03b F5 (peer implementation review escape): `endpointLaneTags` resolves
    // an endpoint's OWN segment before intersecting with its declared lanes
    // — the same two-step `lane-edge-gate.ts`'s `collectEdgeSideFacts` does
    // for the attach path (see that module's own doc comment for why the
    // split is one reader per side rather than a re-derivation). Every case
    // above uses ONE segment, so none of them can tell "correctly scoped to
    // the endpoint's own task" apart from "answers by literal word alone,
    // whichever segment declared it first" — the two only diverge once the
    // SAME lane word is declared in two different segments, which is what
    // this fixture adds.
    // -----------------------------------------------------------------------

    describe("a lane word declared in two different tasks (03b F5)", () => {
      test("an endpoint declares the shared word under its OWN task, not the other one's", () => {
        const otherSegmentId = createSegment(db, {
          title: "the other task",
          tags: ["task-two"],
          nowEpoch: NOW,
        }).id;
        // The SAME word, "#alpha", declared again — under a different segment.
        insertLane(db, otherSegmentId, "#alpha", NOW);
        insertLane(db, otherSegmentId, "#epsilon", NOW);
        const otherCited = seedTurn(4, ["task-two", "#alpha", "#epsilon"]);
        attach(citing, [{ relationClass: "use", targets: [address(otherCited)] }], NOW + 2);

        // `citing` is a task-one member; `otherCited` a task-two one. The
        // shared word resolves against OTHER-CITED's own task (task-two),
        // where it is genuinely one of its two lanes — so this declares.
        const result = declareEdgeSides(
          db,
          { citingTurnId: citing, citedTurnId: otherCited, headTag: "#alpha" },
          "settlement",
          NOW + 3,
        );
        expect(result.ok).toBe(true);
        expect(result.changed).toBe(true);
        expect(outgoing(citing).find((edge) => edge.cited.id === otherCited)!.headTag).toBe(
          "#alpha",
        );
      });

      test("a declaration naming the OTHER task's lane refuses as `invalid-declaration`, not the endpoint's own", () => {
        const otherSegmentId = createSegment(db, {
          title: "the other task",
          tags: ["task-two"],
          nowEpoch: NOW,
        }).id;
        // "#alpha" is declared here too, but this endpoint never carries it —
        // its own two lanes are "#delta"/"#epsilon".
        insertLane(db, otherSegmentId, "#alpha", NOW);
        insertLane(db, otherSegmentId, "#delta", NOW);
        insertLane(db, otherSegmentId, "#epsilon", NOW);
        const otherCited = seedTurn(5, ["task-two", "#delta", "#epsilon"]);
        attach(citing, [{ relationClass: "use", targets: [address(otherCited)] }], NOW + 2);

        // Naming task-one's "#alpha" for a task-two endpoint: it is a real,
        // declared lane word SOMEWHERE, but not one this endpoint is in.
        const result = declareEdgeSides(
          db,
          { citingTurnId: citing, citedTurnId: otherCited, headTag: "#alpha" },
          "settlement",
          NOW + 3,
        );
        expect(result.ok).toBe(false);
        expect(result.refusal).toEqual({
          reason: "invalid-declaration",
          side: "head",
          tag: "#alpha",
          endpoint: address(otherCited),
        });
        expect(outgoing(citing).find((edge) => edge.cited.id === otherCited)!.headTag).toBe("");

        // And the SAME endpoint declares its own, real lane without incident
        // — the refusal above was about the WORD's task, not the endpoint.
        const own = declareEdgeSides(
          db,
          { citingTurnId: citing, citedTurnId: otherCited, headTag: "#delta" },
          "settlement",
          NOW + 4,
        );
        expect(own.ok).toBe(true);
        expect(own.changed).toBe(true);
      });
    });
  });

  // -----------------------------------------------------------------------
  // D5 — the caps count LOGICAL edges
  // -----------------------------------------------------------------------

  test("a legacy pair stored as SEVERAL physical rows counts ONCE toward the outgoing cap", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);

    // Two physical rows for one pair, written past the write path exactly as a
    // pre-cutover database holds them.
    // PRE-CUTOVER shape (idempotent): the rebuilt table is UNIQUE on the pair,
    // so a multi-row pair exists only while D9's fence defers the migration.
    downgradeToPreCutoverShape(db);
    seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "consume", relationClass: "use", provenance: "judged", createdAtEpoch: NOW });
    seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "verifies", relationClass: "verify", provenance: "judged", createdAtEpoch: NOW });
    expect(outgoing(citing)).toHaveLength(2);

    // 19 further distinct pairs -> 20 logical edges. One more must refuse.
    for (let n = 0; n < 19; n += 1) {
      const target = seedTurn(10 + n);
      const result = attach(citing, [{ relationClass: "use", targets: [address(target)] }], NOW + n);
      expect(result.rejected).toEqual([]);
    }

    const overflow = seedTurn(100);
    const refused = attach(
      citing,
      [{ relationClass: "use", targets: [address(overflow)] }],
      NOW + 100,
    );
    expect(refused.rejected).toHaveLength(1);
    expect(refused.rejected[0]!.reason).toBe("outgoing-degree-cap");
  });

  test("among equal-class rows of one legacy pair the LOWEST row id is the edge (integration probe S15069/T2437)", () => {
    // Pinned after an adjudication probe flipped the tie-break to the highest
    // id and nothing went red: the worker's report leans on this tie-break
    // matching D9's fold, so it has to be a test, not a comment.
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    downgradeToPreCutoverShape(db);
    seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "consume", relationClass: "use", provenance: "judged", createdAtEpoch: NOW });
    seedPreCutoverEdge(db, { citingId: citing, citedId: cited, relation: "extends", relationClass: "use", provenance: "judged", createdAtEpoch: NOW });
    const rows = outgoing(citing);
    expect(rows).toHaveLength(2);
    const lowest = Math.min(...rows.map((row) => row.id));
    expect(selectLogicalEdgeRow(rows)?.id).toBe(lowest);
  });

  test("PROMOTING a stored edge at the cap succeeds — a promotion adds no degree", () => {
    const citing = seedTurn(1);
    const targets: number[] = [];
    for (let n = 0; n < 20; n += 1) {
      const target = seedTurn(10 + n);
      targets.push(target);
      attach(citing, [{ relationClass: "use", targets: [address(target)] }], NOW + n);
    }
    expect(outgoing(citing)).toHaveLength(20);

    const promotion = attach(
      citing,
      [{ relationClass: "correct", targets: [{ turn: address(targets[0]!), coverage: "full" }] }],
      NOW + 200,
    );
    expect(promotion.rejected).toEqual([]);
    expect(outgoing(citing)).toHaveLength(20);
  });

  // -----------------------------------------------------------------------
  // D3 / read-once 00 addendum — the fresh-turn gate exception
  // -----------------------------------------------------------------------

  describe("the fresh-turn relations-gate exception", () => {
    test("a citing turn with ZERO outgoing relation atoms needs no relations read", () => {
      const citing = seedTurn(1);
      expect(checkRelationsGate(db, "session:7", citing, address(citing))).toEqual({ ok: true });
    });

    test("it is WRITER-AGNOSTIC — settlement and the main agent are admitted alike", () => {
      const citing = seedTurn(1);
      expect(checkRelationsGate(db, "settlement:job-9", citing, address(citing)).ok).toBe(true);
      expect(checkRelationsGate(db, "session:7", citing, address(citing)).ok).toBe(true);
    });

    test("a WORDLESS row does not count — a turn holding only those is still fresh", () => {
      const citing = seedTurn(1);
      const cited = seedTurn(2);
      downgradeToPreCutoverShape(db);
      seedPreCutoverEdge(db, {
        citingId: citing,
        citedId: cited,
        relation: null,
        provenance: "text-ref",
        createdAtEpoch: NOW,
      });

      expect(checkRelationsGate(db, "session:7", citing, address(citing))).toEqual({ ok: true });
    });

    test("ONE relation atom closes the exception — the gate demands the read again", () => {
      const citing = seedTurn(1);
      const cited = seedTurn(2);
      attach(citing, [{ relationClass: "use", targets: [address(cited)] }], NOW + 1);

      const verdict = checkRelationsGate(db, "session:7", citing, address(citing));
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe("incomplete-read");
    });

    test("the exception does not swallow STALENESS on a turn that has edges", () => {
      const citing = seedTurn(1);
      const cited = seedTurn(2);
      attach(citing, [{ relationClass: "use", targets: [address(cited)] }], NOW + 1);
      stampTurnRelationsRevision(db, citing, "someone-else", NOW + 2);

      const verdict = checkRelationsGate(db, "session:7", citing, address(citing));
      expect(verdict.ok).toBe(false);
    });
  });
});
