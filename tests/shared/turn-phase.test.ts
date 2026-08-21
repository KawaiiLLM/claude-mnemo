import { describe, expect, test } from "bun:test";

import {
  EDGE_RELATIONS,
  explainRelationPhaseRejection,
  isRelationLegalForPhases,
  isTurnEdgeRelation,
  phasesForTypes,
  RELATION_FIELD_NAME,
  RELATION_PHASE_REQUIREMENT,
  TURN_PHASES,
  TYPE_PHASE,
  UNSCORED_RELATIONS,
  validateRelationTarget,
  type TurnEdgeRelation,
  type TurnPhase,
} from "../../src/shared/turn-phase";
import { MEMORY_TYPES } from "../../src/shared/type-vocabulary";

/**
 * Ticket 01 (turn-edge-mechanism spec) — the ONE shared phase-derivation
 * module: note's write-time validation and ticket 07's future scoring both
 * read this table, so it is tested here in isolation from either consumer.
 */
describe("TYPE_PHASE (spec's three-row table)", () => {
  test("every current MEMORY_TYPES word maps to exactly one phase", () => {
    for (const word of MEMORY_TYPES) {
      expect(TYPE_PHASE[word]).toBeDefined();
    }
  });

  test("evidence/decision/delivery partition the eleven words as the spec table states", () => {
    expect(
      MEMORY_TYPES.filter((word) => TYPE_PHASE[word] === "evidence"),
    ).toEqual(["research", "measure"]);
    expect(
      MEMORY_TYPES.filter((word) => TYPE_PHASE[word] === "decision"),
    ).toEqual(["discuss", "design", "correction"]);
    expect(
      MEMORY_TYPES.filter((word) => TYPE_PHASE[word] === "delivery"),
    ).toEqual(["implement", "refactor", "fix", "review", "ops", "delegate"]);
  });
});

describe("phasesForTypes (exists-rule input)", () => {
  test("a single-type turn maps to a one-element phase set", () => {
    expect([...phasesForTypes(["design"])]).toEqual(["decision"]);
  });

  test("a multi-type turn's phase set is the UNION of its words' phases", () => {
    expect([...phasesForTypes(["review", "design"])].sort()).toEqual(
      ["decision", "delivery"].sort(),
    );
  });

  test("an unrecognised or legacy word contributes no phase", () => {
    expect([...phasesForTypes(["bugfix", "compact"])]).toEqual([]);
  });

  test("an empty type list has an empty phase set", () => {
    expect([...phasesForTypes([])]).toEqual([]);
  });
});

describe("EDGE_RELATIONS — the seven-word closed set", () => {
  test("is exactly the seven words, supersedes excluded", () => {
    expect([...EDGE_RELATIONS].sort()).toEqual(
      [
        "depends-on",
        "encodes",
        "evidence-against",
        "evidence-for",
        "grounded-on",
        "override",
        "refines",
      ].sort(),
    );
    expect(isTurnEdgeRelation("supersedes")).toBe(false);
  });

  test("isTurnEdgeRelation accepts every listed word and rejects junk", () => {
    for (const relation of EDGE_RELATIONS) {
      expect(isTurnEdgeRelation(relation)).toBe(true);
    }
    expect(isTurnEdgeRelation("supports")).toBe(false);
    expect(isTurnEdgeRelation(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Relation-matrix spec (S15069/T1163–T1171), ticket 01, acceptance criterion
// 1: the nine-cell matrix, exhaustively — all nine (source phase, target
// phase) pairs against all seven relation words.
//
// `NINE_CELL_LEGAL_WORDS` is transcribed BY HAND from spec.md's own table,
// independent of `RELATION_PHASE_REQUIREMENT`'s construction (the two-rule
// generator in `shared/turn-phase.ts`) — this test re-derives its
// expectation from the spec text, not from the code under test, so a mistake
// in the generator (a swapped source/target, a missing widened pair, a
// diagonal relation left off one phase) shows up as a mismatch here instead
// of being invisible to a test that trusts the same construction it checks.
// ---------------------------------------------------------------------------
const NINE_CELL_LEGAL_WORDS: Record<TurnPhase, Record<TurnPhase, readonly TurnEdgeRelation[]>> = {
  evidence: {
    evidence: ["refines", "override", "depends-on"],
    decision: ["evidence-for", "evidence-against"],
    delivery: ["evidence-for", "evidence-against"],
  },
  decision: {
    evidence: ["grounded-on"],
    decision: ["refines", "override", "depends-on"],
    delivery: ["grounded-on"],
  },
  delivery: {
    evidence: ["encodes"],
    decision: ["encodes"],
    delivery: ["refines", "override", "depends-on"],
  },
};

describe("the nine-cell matrix — all nine (source, target) phase pairs x all seven relation words (ticket 01 acceptance criterion 1)", () => {
  for (const source of TURN_PHASES) {
    for (const target of TURN_PHASES) {
      const legalWords = new Set(NINE_CELL_LEGAL_WORDS[source][target]);

      test(`${source} -> ${target}: exactly {${[...legalWords].join(", ")}} accepted, every other word rejected naming the missing half`, () => {
        for (const relation of EDGE_RELATIONS) {
          const legal = isRelationLegalForPhases(relation, new Set([source]), new Set([target]));
          expect(legal, `${relation} at ${source}->${target}`).toBe(legalWords.has(relation));

          if (legal) {
            continue;
          }
          const result = validateRelationTarget({
            relation,
            citingPhases: new Set([source]),
            targetKind: "turn",
            citedPhases: new Set([target]),
          });
          expect(result.ok, `${relation} at ${source}->${target} should be rejected`).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe("phase-illegal");
            // The rejection names the missing half: which side, and a
            // phase-word clause for it.
            expect(result.detail).toMatch(/citing turn|cited turn/);
            expect(result.detail).toMatch(/(evidence|decision|delivery)-phase/);
          }
        }
      });
    }
  }
});

// Ticket 01 acceptance criterion 2 — the REGRESSION block: every class that
// was legal (or illegal) BEFORE the nine-cell rewrite must still be legal
// (or illegal) after it. Every assertion below already held against the
// pre-matrix single-pair table and continues to hold against the widened
// one — the rewrite is a pure relaxation, so nothing here needed to change
// when the matrix landed — plus the exists-rule / grounded-on OR coverage
// this module owns directly.
describe("regression: pre-matrix legal/illegal classes (E->D evidence, D->D refines/override, D->E|L grounded-on, L->D encodes, L->L depends-on)", () => {
  test("evidence -> decision: evidence-for/against", () => {
    expect(
      isRelationLegalForPhases("evidence-for", new Set(["evidence"]), new Set(["decision"])),
    ).toBe(true);
    expect(
      isRelationLegalForPhases("evidence-against", new Set(["decision"]), new Set(["decision"])),
    ).toBe(false);
  });

  test("decision -> decision: refines/override", () => {
    expect(
      isRelationLegalForPhases("refines", new Set(["decision"]), new Set(["decision"])),
    ).toBe(true);
    expect(
      isRelationLegalForPhases("override", new Set(["delivery"]), new Set(["decision"])),
    ).toBe(false);
  });

  test("delivery -> decision: encodes", () => {
    expect(
      isRelationLegalForPhases("encodes", new Set(["delivery"]), new Set(["decision"])),
    ).toBe(true);
    expect(
      isRelationLegalForPhases("encodes", new Set(["decision"]), new Set(["decision"])),
    ).toBe(false);
  });

  test("delivery -> delivery: depends-on", () => {
    expect(
      isRelationLegalForPhases("depends-on", new Set(["delivery"]), new Set(["delivery"])),
    ).toBe(true);
    expect(
      isRelationLegalForPhases("depends-on", new Set(["delivery"]), new Set(["decision"])),
    ).toBe(false);
  });

  // [S15069/T935]: grounded-on's OR — decision source, evidence OR delivery
  // target, illegal against a plain decision-phase target.
  test("decision -> {evidence, delivery}: grounded-on (the one relation with two legal pairs)", () => {
    expect(
      isRelationLegalForPhases("grounded-on", new Set(["decision"]), new Set(["evidence"])),
    ).toBe(true);
    expect(
      isRelationLegalForPhases("grounded-on", new Set(["decision"]), new Set(["delivery"])),
    ).toBe(true);
    expect(
      isRelationLegalForPhases("grounded-on", new Set(["decision"]), new Set(["decision"])),
    ).toBe(false);
  });

  // Ticket 01's exists-rule: a dual-type turn is legal on EACH end
  // separately for two DIFFERENT relations — the spec's own worked example
  // ("design+ops 轮可被 refines 亦可发 encodes").
  test("a dual-type (decision+delivery) phase set satisfies refines' target AND encodes' source at once", () => {
    const dual = new Set(["decision", "delivery"] as const);
    // As refines' TARGET (needs decision) from a plain decision-phase citer:
    expect(isRelationLegalForPhases("refines", new Set(["decision"]), dual)).toBe(true);
    // As encodes' SOURCE (needs delivery) toward a plain decision-phase target:
    expect(isRelationLegalForPhases("encodes", dual, new Set(["decision"]))).toBe(true);
  });
});

describe("explainRelationPhaseRejection — names the missing half", () => {
  // `refines` is now diagonal-legal from EVERY recognised phase (the
  // relation-matrix widening), so a single-phase citing turn always
  // satisfies SOME diagonal pair and the rejection falls to the cited side
  // instead (covered by the dedicated diagonal-mismatch test below). The
  // "citing side missing entirely" branch now only fires for a turn with NO
  // recognised phase at all (empty or fully-legacy `type`) — an empty
  // citing-phase set exercises exactly that.
  test("citing side missing: a phase-less citing turn names every diagonal source phase, decision's included", () => {
    const message = explainRelationPhaseRejection("refines", new Set([]), new Set(["decision"]));
    expect(message).toContain("citing turn");
    expect(message).toContain("decision-phase");
    expect(message).toContain("design");
  });

  // The relaxation's own new failure shape: a delivery-phase citing turn is
  // now a LEGAL refines source (the diagonal), so pointing it at a
  // decision-phase target fails on the CITED side, not the citing side.
  test("cited side missing (diagonal mismatch): a delivery-phase citing turn pointed at a decision-phase target names the missing delivery-phase target", () => {
    const message = explainRelationPhaseRejection(
      "refines",
      new Set(["delivery"]),
      new Set(["decision"]),
    );
    expect(message).toContain("cited turn");
    expect(message).toContain("delivery-phase");
    expect(message).toContain("implement");
  });

  test("cited side missing (citing side fine): names the required target phase", () => {
    const message = explainRelationPhaseRejection(
      "encodes",
      new Set(["delivery"]),
      new Set(["delivery"]),
    );
    expect(message).toContain("cited turn");
    expect(message).toContain("decision-phase");
  });

  // grounded-on's OR surfaces as an "or" between two target phases when the
  // citing side is fine but neither of its two target options is present.
  test("grounded-on's cited-side message lists BOTH legal target phases", () => {
    const message = explainRelationPhaseRejection(
      "grounded-on",
      new Set(["decision"]),
      new Set(["decision"]),
    );
    expect(message).toContain("evidence-phase");
    expect(message).toContain("delivery-phase");
    expect(message).toContain(" or ");
  });
});

describe("RELATION_PHASE_REQUIREMENT — table shape (relation-matrix spec: two reading rules, not seven hand-carved rows)", () => {
  test("the diagonal relations (refines/override/depends-on) each carry all three same-phase pairs", () => {
    for (const relation of ["refines", "override", "depends-on"] as const) {
      const pairs = RELATION_PHASE_REQUIREMENT[relation];
      expect(pairs.length).toBe(3);
      expect(pairs.every((pair) => pair.source === pair.target)).toBe(true);
      expect(new Set(pairs.map((pair) => pair.source))).toEqual(new Set(TURN_PHASES));
    }
  });

  test("the cross-phase relations (evidence-for/against, grounded-on, encodes) each carry exactly two pairs, toward the other two phases", () => {
    for (const relation of ["evidence-for", "evidence-against", "grounded-on", "encodes"] as const) {
      const pairs = RELATION_PHASE_REQUIREMENT[relation];
      expect(pairs.length).toBe(2);
      expect(pairs.every((pair) => pair.source !== pair.target)).toBe(true);
      // Both pairs share the SAME source phase — this relation always speaks
      // from one fixed phase, toward both others.
      expect(new Set(pairs.map((pair) => pair.source)).size).toBe(1);
    }
  });
});

describe("UNSCORED_RELATIONS (ticket 07 hand-off)", () => {
  test("grounded-on is the one relation excluded from scoring; every other relation is scoreable", () => {
    expect(UNSCORED_RELATIONS.has("grounded-on")).toBe(true);
    for (const relation of EDGE_RELATIONS) {
      if (relation === "grounded-on") continue;
      expect(UNSCORED_RELATIONS.has(relation)).toBe(false);
    }
  });
});

// [S15069/T939] mid-flight amendment: the edge validator is ONE shared
// domain module, not logic inlined in note.ts/definitions.ts — this is the
// seed test invoking it DIRECTLY, entirely outside the note tool, so a
// future settlement correction surface (ticket 08) can call the identical
// function and get the identical rejection semantics `mcp/note.ts`'s
// end-to-end tests (`tests/mcp/note.test.ts`) observe through the tool.
describe("validateRelationTarget — the shared judgment, called directly (ticket 08 hand-off, [S15069/T939])", () => {
  test("a legal turn target is admitted", () => {
    const result = validateRelationTarget({
      relation: "refines",
      citingPhases: new Set(["decision"]),
      targetKind: "turn",
      citedPhases: new Set(["decision"]),
    });
    expect(result).toEqual({ ok: true });
  });

  // Identical semantics to `mcp/note.ts`'s "a relation target naming a
  // segment is rejected" end-to-end test: same reason, same detail text
  // (that test asserts the SAME substrings "segment address" / "turn-only").
  test("a segment target is rejected, whatever the relation or phase set — same detail note.ts's own message wraps", () => {
    const result = validateRelationTarget({
      relation: "override",
      citingPhases: new Set(["decision"]),
      targetKind: "segment",
      citedPhases: new Set(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("segment-target");
      expect(result.detail).toContain("segment address");
      expect(result.detail).toContain("turn-only");
    }
  });

  // Identical semantics to `mcp/note.ts`'s "pure-review turn attempting
  // refines" end-to-end test: same missing-half message shape. `delivery` is
  // now a legal `refines` source (the diagonal relaxation), so this fails on
  // the CITED side — it names the missing delivery-phase target, not a
  // missing decision-phase citing type.
  test("a phase-illegal turn target is rejected, naming the missing half — matches the note tool's own end-to-end wording", () => {
    const result = validateRelationTarget({
      relation: "refines",
      citingPhases: new Set(["delivery"]),
      citedPhases: new Set(["decision"]),
      targetKind: "turn",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("phase-illegal");
      expect(result.detail).toContain("delivery-phase");
      expect(result.detail).toContain("cited turn");
    }
  });

  // RELATION_FIELD_NAME is the same map `mcp/note.ts`'s `RELATION_FIELD_ENTRIES`
  // derives from — pinned here too so a future caller cannot read a stale copy.
  test("RELATION_FIELD_NAME covers every EDGE_RELATIONS word with a distinct camelCase name", () => {
    const names = EDGE_RELATIONS.map((relation) => RELATION_FIELD_NAME[relation]);
    expect(new Set(names).size).toBe(EDGE_RELATIONS.length);
    for (const relation of EDGE_RELATIONS) {
      expect(RELATION_FIELD_NAME[relation]).toBeTruthy();
    }
  });
});
