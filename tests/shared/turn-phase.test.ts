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
  validateRelationTarget,
  type TurnEdgeRelation,
  type TurnPhase,
} from "../../src/shared/turn-phase";
import { MEMORY_TYPES } from "../../src/shared/type-vocabulary";

/**
 * Flow-relations spec (ticket 02) — the ONE shared phase-derivation module:
 * note's write-time validation and any future scoring reader both read this
 * table, so it is tested here in isolation from either consumer.
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

describe("EDGE_RELATIONS — the eight-word closed set (flow-relations spec)", () => {
  test("is exactly the eight words, supersedes excluded", () => {
    expect([...EDGE_RELATIONS].sort()).toEqual(
      [
        "collects",
        "consume",
        "extends",
        "grounds",
        "narrows",
        "override",
        "refutes",
        "verifies",
      ].sort(),
    );
    expect(isTurnEdgeRelation("supersedes")).toBe(false);
    // Old, retired words are not part of the write-time closed set either —
    // the CHECK still admits them at the storage layer (db/citations.ts's
    // CITATION_RELATIONS, the old∪new union) but a NEW write may not.
    for (const retired of ["refines", "encodes", "grounded-on", "depends-on", "evidence-for", "evidence-against"]) {
      expect(isTurnEdgeRelation(retired)).toBe(false);
    }
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
// Flow-relations spec (`.scratch/flow-relations/spec.md`, "六行律" — the
// six-row law), ticket 02's own acceptance criterion: exhaustively, all nine
// (source phase, target phase) pairs against all eight relation words.
//
// `SIX_ROW_LEGAL_WORDS` is transcribed BY HAND from spec.md's own table,
// independent of `RELATION_PHASE_REQUIREMENT`'s construction (the
// same-phase/decision-only/evidence-source generator in
// `shared/turn-phase.ts`) — this test re-derives its expectation from the
// spec text, not from the code under test, so a mistake in the generator
// shows up as a mismatch here rather than being invisible to a test that
// trusts the same construction it checks.
//
// `collects`' own graph-state hard check (P1's one graph fact — the citing
// turn must itself be a flow's terminus, every target an OWN member) is NOT
// part of this table: it lives one layer up, at the orchestration layer
// (`mcp/note.ts`, using a flow derivation `shared/turn-phase.ts` has no DB
// access to build) — `isRelationLegalForPhases`/`validateRelationTarget`
// only ever answer collects' PHASE half here (same phase, like override).
// The graph half is covered end-to-end in `tests/mcp/note.test.ts`'s "note
// tool collects" describe block.
// ---------------------------------------------------------------------------
const SIX_ROW_LEGAL_WORDS: Record<TurnPhase, Record<TurnPhase, readonly TurnEdgeRelation[]>> = {
  evidence: {
    evidence: ["override", "collects", "consume", "grounds", "verifies", "refutes"],
    decision: ["grounds", "verifies", "refutes"],
    delivery: ["grounds", "verifies", "refutes"],
  },
  decision: {
    evidence: ["grounds"],
    decision: ["override", "narrows", "extends", "collects", "consume", "grounds"],
    delivery: ["grounds"],
  },
  delivery: {
    evidence: ["grounds"],
    decision: ["grounds"],
    delivery: ["override", "collects", "consume", "grounds"],
  },
};

describe("the six-row law — all nine (source, target) phase pairs x all eight relation words (flow-relations spec)", () => {
  for (const source of TURN_PHASES) {
    for (const target of TURN_PHASES) {
      const legalWords = new Set(SIX_ROW_LEGAL_WORDS[source][target]);

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

  // `grounds` is the one row with NO illegal cell at all — pinned separately
  // since the loop above only ever exercises its (always-true) legal branch.
  test("grounds is legal in every one of the nine cells — even both phase sets empty (an untyped turn)", () => {
    for (const source of [...TURN_PHASES, undefined]) {
      for (const target of [...TURN_PHASES, undefined]) {
        const citingPhases = source ? new Set([source]) : new Set<TurnPhase>();
        const citedPhases = target ? new Set([target]) : new Set<TurnPhase>();
        expect(isRelationLegalForPhases("grounds", citingPhases, citedPhases)).toBe(true);
      }
    }
  });
});

// The exists-rule for a MULTI-type turn — legal on EACH end separately for
// two DIFFERENT relations, one exercising each half of a dual-type turn.
describe("the exists-rule for multi-type turns", () => {
  test("a dual-type (decision+delivery) phase set satisfies extends' target AND consume's own shared-phase requirement at once", () => {
    const dual = new Set(["decision", "delivery"] as const);
    // As extends' TARGET (needs decision) from a plain decision-phase citer:
    expect(isRelationLegalForPhases("extends", new Set(["decision"]), dual)).toBe(true);
    // As consume's SOURCE, sharing its delivery half with a plain
    // delivery-phase target:
    expect(isRelationLegalForPhases("consume", dual, new Set(["delivery"]))).toBe(true);
  });
});

describe("explainRelationPhaseRejection — names the missing half", () => {
  test("citing side missing: a phase-less citing turn names narrows'/extends' one source phase, decision", () => {
    const message = explainRelationPhaseRejection("extends", new Set([]), new Set(["decision"]));
    expect(message).toContain("citing turn");
    expect(message).toContain("decision-phase");
    expect(message).toContain("design");
  });

  // override/collects/consume: legal in EVERY same-phase pair, so a
  // delivery-phase citing turn already satisfies the delivery/delivery pair
  // — pointing it at a decision-phase target fails on the CITED side, not
  // the citing side.
  test("cited side missing (same-phase mismatch): a delivery-phase citing turn pointed at a decision-phase target names the missing delivery-phase target", () => {
    const message = explainRelationPhaseRejection(
      "override",
      new Set(["delivery"]),
      new Set(["decision"]),
    );
    expect(message).toContain("cited turn");
    expect(message).toContain("delivery-phase");
    expect(message).toContain("implement");
  });

  test("verifies/refutes cited side missing: an evidence-phase source against an untyped target names all three legal target phases", () => {
    const message = explainRelationPhaseRejection(
      "verifies",
      new Set(["evidence"]),
      new Set([]),
    );
    expect(message).toContain("cited turn");
    expect(message).toContain("evidence-phase");
    expect(message).toContain("decision-phase");
    expect(message).toContain("delivery-phase");
  });

  test("narrows/extends citing side missing (decision-only pair): names decision as the one required phase, no 'or' clause", () => {
    const message = explainRelationPhaseRejection("narrows", new Set(["delivery"]), new Set(["decision"]));
    expect(message).toContain("citing turn");
    expect(message).toContain("decision-phase");
    expect(message).not.toContain(" or ");
  });
});

describe("RELATION_PHASE_REQUIREMENT — table shape (flow-relations spec: three reading rules, not seven hand-carved rows)", () => {
  test("the same-phase relations (override/collects/consume) each carry all three same-phase pairs", () => {
    for (const relation of ["override", "collects", "consume"] as const) {
      const pairs = RELATION_PHASE_REQUIREMENT[relation];
      expect(pairs.length).toBe(3);
      expect(pairs.every((pair) => pair.source === pair.target)).toBe(true);
      expect(new Set(pairs.map((pair) => pair.source))).toEqual(new Set(TURN_PHASES));
    }
  });

  test("the decision-only relations (narrows/extends) each carry exactly one pair: decision -> decision", () => {
    for (const relation of ["narrows", "extends"] as const) {
      const pairs = RELATION_PHASE_REQUIREMENT[relation];
      expect(pairs).toEqual([{ source: "decision", target: "decision" }]);
    }
  });

  test("the evidence-source relations (verifies/refutes) each carry exactly three pairs, all sourced from evidence, toward every phase", () => {
    for (const relation of ["verifies", "refutes"] as const) {
      const pairs = RELATION_PHASE_REQUIREMENT[relation];
      expect(pairs.length).toBe(3);
      expect(pairs.every((pair) => pair.source === "evidence")).toBe(true);
      expect(new Set(pairs.map((pair) => pair.target))).toEqual(new Set(TURN_PHASES));
    }
  });

  test("grounds carries an empty pairs array — never consulted, since isRelationLegalForPhases short-circuits it to always-legal", () => {
    expect(RELATION_PHASE_REQUIREMENT.grounds).toEqual([]);
  });
});

// [S15069/T939]-precedent: the edge validator is ONE shared domain module,
// not logic inlined in note.ts/definitions.ts — this is the seed test
// invoking it DIRECTLY, entirely outside the note tool, so a future caller
// (a settlement correction surface, or any other write path) can call the
// identical function and get the identical rejection semantics
// `mcp/note.ts`'s end-to-end tests (`tests/mcp/note.test.ts`) observe
// through the tool.
describe("validateRelationTarget — the shared judgment, called directly", () => {
  test("a legal turn target is admitted", () => {
    const result = validateRelationTarget({
      relation: "extends",
      citingPhases: new Set(["decision"]),
      targetKind: "turn",
      citedPhases: new Set(["decision"]),
    });
    expect(result).toEqual({ ok: true });
  });

  // Identical semantics to `mcp/note.ts`'s "a relation target naming a
  // segment is rejected" end-to-end test: same reason, same detail text.
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

  test("a phase-illegal turn target is rejected, naming the missing half — matches the note tool's own end-to-end wording", () => {
    const result = validateRelationTarget({
      relation: "narrows",
      citingPhases: new Set(["delivery"]),
      citedPhases: new Set(["decision"]),
      targetKind: "turn",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("phase-illegal");
      expect(result.detail).toContain("decision-phase");
      expect(result.detail).toContain("citing turn");
    }
  });

  // RELATION_FIELD_NAME is the same map `mcp/note.ts`'s `RELATION_FIELD_ENTRIES`
  // derives from — pinned here too so a future caller cannot read a stale copy.
  test("RELATION_FIELD_NAME covers every EDGE_RELATIONS word with a distinct name", () => {
    const names = EDGE_RELATIONS.map((relation) => RELATION_FIELD_NAME[relation]);
    expect(new Set(names).size).toBe(EDGE_RELATIONS.length);
    for (const relation of EDGE_RELATIONS) {
      expect(RELATION_FIELD_NAME[relation]).toBeTruthy();
    }
  });

  // Flow-relations spec (ticket 02, "自引用"): the old phase-spanning self
  // rule retires with the vocabulary — ONLY `grounds` may ever self-cite,
  // and only when the citing turn is BOTH a flow's settlement (a graph fact
  // this module cannot derive; the caller supplies `isSettlement`) AND that
  // settlement's implementer (a local fact: its own phase set carries
  // decision AND delivery).
  describe("self-citation: grounds only, settlement+implementer", () => {
    test("every relation but grounds refuses a self target outright, whatever the phase or isSettlement", () => {
      const dual = new Set<TurnPhase>(["decision", "delivery"]);
      for (const relation of EDGE_RELATIONS) {
        if (relation === "grounds") continue;
        const result = validateRelationTarget({
          relation,
          citingPhases: dual,
          targetKind: "turn",
          citedPhases: dual,
          isSelfReference: true,
          isSettlement: true,
        });
        expect(result.ok, `${relation} must not self-cite`).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("self-not-grounds");
        }
      }
    });

    test("a self-grounds from a decision-only turn is refused — not its own implementer (no delivery half)", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision"]),
        targetKind: "turn",
        citedPhases: new Set(["decision"]),
        isSelfReference: true,
        isSettlement: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-not-implementer");
        expect(result.detail).toContain("delivery-phase");
      }
    });

    test("a self-grounds from a decision+delivery turn that is NOT a settlement is refused", () => {
      const dual = new Set<TurnPhase>(["decision", "delivery"]);
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: dual,
        targetKind: "turn",
        citedPhases: dual,
        isSelfReference: true,
        isSettlement: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-not-settlement");
        expect(result.detail).toContain("flow's settlement");
      }
    });

    test("a self-grounds from a decision+delivery turn that IS a settlement is accepted", () => {
      const dual = new Set<TurnPhase>(["decision", "delivery"]);
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: dual,
        targetKind: "turn",
        citedPhases: dual,
        isSelfReference: true,
        isSettlement: true,
      });
      expect(result).toEqual({ ok: true });
    });

    test("isSettlement defaults to false when the caller never computed a derivation", () => {
      const dual = new Set<TurnPhase>(["decision", "delivery"]);
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: dual,
        targetKind: "turn",
        citedPhases: dual,
        isSelfReference: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-not-settlement");
      }
    });
  });
});
