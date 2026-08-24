import { describe, expect, test } from "bun:test";

import {
  checkSelfGroundsTerminus,
  EDGE_RELATIONS,
  explainRelationPhaseRejection,
  hasTaggedTerminusDeclaration,
  isRelationLegalForPhases,
  isTurnEdgeRelation,
  phasesForTypes,
  RELATION_FIELD_NAME,
  RELATION_PHASE_REQUIREMENT,
  TAGGABLE_RELATIONS,
  TURN_PHASES,
  TYPE_PHASE,
  validateRelationTarget,
  type LaneRegistryFacts,
  type TurnEdgeRelation,
  type TurnPhase,
} from "../../src/shared/turn-phase";
import { containsToolCallSyntax } from "../../src/shared/tool-call-syntax";
import { MEMORY_TYPES } from "../../src/shared/type-vocabulary";

/**
 * lane-declaration D2: the registry evidence `validateRelationTarget` judges,
 * built by hand here. The DB adapter that produces it in production is
 * `db/lane-edge-gate.ts`'s `collectLaneRegistryFacts`; this module is DB-free,
 * so its tests state the facts directly rather than through a database.
 * Defaults are the ORDINARY legal case (one segment, tag declared, canonical,
 * no stored row) so each test names only the one fact it is about.
 */
function registry(overrides: {
  citingAddress?: string;
  citingSegment?: string | null;
  citingDeclared?: readonly string[];
  citedAddress?: string;
  citedSegment?: string | null;
  citedDeclared?: readonly string[];
  nonCanonical?: readonly (readonly [string, string])[];
  intersectingRows?: readonly { tags: readonly string[]; shared: readonly string[] }[];
}): LaneRegistryFacts {
  const citingSegment =
    overrides.citingSegment === undefined ? "E60" : overrides.citingSegment;
  const citedSegment = overrides.citedSegment === undefined ? "E60" : overrides.citedSegment;
  return {
    citing: {
      address: overrides.citingAddress ?? "S9/T5",
      segment: citingSegment,
      declaredTags: new Set(overrides.citingDeclared ?? ["lane-a"]),
    },
    cited: {
      address: overrides.citedAddress ?? "S9/T3",
      segment: citedSegment,
      declaredTags: new Set(overrides.citedDeclared ?? ["lane-a"]),
    },
    nonCanonical: new Map(overrides.nonCanonical ?? []),
    intersectingRows: overrides.intersectingRows ?? [],
  };
}

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
        "indexes",
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
    for (const retired of ["refines", "encodes", "grounded-on", "depends-on", "evidence-for", "evidence-against", "collects"]) {
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
// `indexes` (the retired `collects`) carries no graph-state check of its own
// any more — indexes-rescope spec law 2, [S15069/T1232] retires the old
// `collects` hard check (own-branch terminus/membership). This table and
// `isRelationLegalForPhases`/`validateRelationTarget` state its WHOLE test:
// same phase, like override. See `tests/mcp/note.test.ts`'s "note tool
// indexes" describe block for the end-to-end write path.
// ---------------------------------------------------------------------------
// rubric-v10 ticket 02 (spec "Vocabulary and validator"): narrows/extends
// WIDEN from the old decision-only cage to the full same-phase group — the
// cage was built for the retired flow model's branch derivation, which the
// lane model does not perform at write time. All five same-phase words now
// admit all three diagonal cells identically.
const SIX_ROW_LEGAL_WORDS: Record<TurnPhase, Record<TurnPhase, readonly TurnEdgeRelation[]>> = {
  evidence: {
    // T1215: no verdict pair on the diagonal — evidence's object is the
    // world, not another turn's claim. Scope purity: every same-phase word
    // strictly same-phase, every cross-phase word strictly cross-phase.
    evidence: ["override", "narrows", "extends", "indexes", "consume"],
    decision: ["grounds", "verifies", "refutes"],
    delivery: ["grounds", "verifies", "refutes"],
  },
  decision: {
    evidence: ["grounds"],
    decision: ["override", "narrows", "extends", "indexes", "consume"],
    delivery: ["grounds"],
  },
  delivery: {
    evidence: ["grounds"],
    decision: ["grounds"],
    delivery: ["override", "narrows", "extends", "indexes", "consume"],
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

  // User retightening [S15069/T1209]: grounds is CROSS-phase only — the six
  // off-diagonal cells legal, the diagonal rejected, and an EMPTY phase set
  // on either side rejected (grounds regained a rejection channel; its old
  // always-legal short-circuit meant a warning was the only feedback on the
  // whole path, the ledger note the peer flagged).
  test("grounds is cross-phase only: six cross cells legal, diagonal and empty phase sets reject", () => {
    for (const source of TURN_PHASES) {
      for (const target of TURN_PHASES) {
        expect(
          isRelationLegalForPhases("grounds", new Set([source]), new Set([target])),
          `grounds at ${source}->${target}`,
        ).toBe(source !== target);
      }
    }
    expect(isRelationLegalForPhases("grounds", new Set<TurnPhase>(), new Set(["decision"]))).toBe(false);
    expect(isRelationLegalForPhases("grounds", new Set(["delivery"]), new Set<TurnPhase>())).toBe(false);
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
  // rubric-v10 ticket 02: extends widened into the full same-phase group
  // (evidence/decision/delivery), so a phase-less citing turn now names all
  // three options, not decision alone.
  test("citing side missing: a phase-less citing turn names extends' three same-phase options", () => {
    const message = explainRelationPhaseRejection("extends", new Set([]), new Set(["decision"]));
    expect(message).toContain("citing turn");
    expect(message).toContain("evidence-phase");
    expect(message).toContain("decision-phase");
    expect(message).toContain("delivery-phase");
    expect(message).toContain("design");
  });

  // override/indexes/consume: legal in EVERY same-phase pair, so a
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

  test("verifies/refutes cited side missing: an evidence-phase source against an untyped target names the two legal target phases — never evidence (T1215)", () => {
    const message = explainRelationPhaseRejection(
      "verifies",
      new Set(["evidence"]),
      new Set([]),
    );
    expect(message).toContain("cited turn");
    expect(message).toContain("decision-phase");
    expect(message).toContain("delivery-phase");
    expect(message).not.toContain("evidence-phase");
  });

  // rubric-v10 ticket 02: narrows/extends widened into the same-phase group,
  // so a delivery-phase citing turn already SATISFIES narrows' delivery/
  // delivery pair — the mismatch is now on the CITED side, same shape
  // override's own same-phase-mismatch test above has.
  test("narrows/extends cited side missing (same-phase mismatch, post-widening): a delivery-phase citing turn pointed at a decision-phase target names the missing delivery-phase target", () => {
    const message = explainRelationPhaseRejection("narrows", new Set(["delivery"]), new Set(["decision"]));
    expect(message).toContain("cited turn");
    expect(message).toContain("delivery-phase");
  });

});

describe("RELATION_PHASE_REQUIREMENT — table shape (flow-relations spec: three reading rules, not seven hand-carved rows)", () => {
  // rubric-v10 ticket 02: narrows/extends widen INTO this group — the same
  // five same-phase words the lane model may tag (Gate B's TAGGABLE_RELATIONS
  // below is exactly this set).
  test("the same-phase relations (override/narrows/extends/indexes/consume) each carry all three same-phase pairs", () => {
    for (const relation of ["override", "narrows", "extends", "indexes", "consume"] as const) {
      const pairs = RELATION_PHASE_REQUIREMENT[relation];
      expect(pairs.length).toBe(3);
      expect(pairs.every((pair) => pair.source === pair.target)).toBe(true);
      expect(new Set(pairs.map((pair) => pair.source))).toEqual(new Set(TURN_PHASES));
    }
  });

  test("the evidence-source relations (verifies/refutes) each carry exactly two cross-phase pairs — never toward evidence (T1215)", () => {
    for (const relation of ["verifies", "refutes"] as const) {
      const pairs = RELATION_PHASE_REQUIREMENT[relation];
      expect(pairs.length).toBe(2);
      expect(pairs.every((pair) => pair.source === "evidence")).toBe(true);
      expect(new Set(pairs.map((pair) => pair.target))).toEqual(
        new Set(["decision", "delivery"]),
      );
    }
  });

  test("grounds carries exactly the six cross-phase pairs — the T1209 retightening reads the same table as every other word", () => {
    const pairs = RELATION_PHASE_REQUIREMENT.grounds.map((pair) => `${pair.source}->${pair.target}`).sort();
    expect(pairs).toEqual(
      [
        "decision->delivery",
        "decision->evidence",
        "delivery->decision",
        "delivery->evidence",
        "evidence->decision",
        "evidence->delivery",
      ].sort(),
    );
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
  // tag-mandate ("Write gate"): `override` rather than `extends` here — the
  // tag mandate took `extends`' untagged form away, so the plainest "legal
  // target" example is now a word that still has one.
  test("a legal turn target is admitted", () => {
    const result = validateRelationTarget({
      relation: "override",
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

  // rubric-v10 ticket 02: narrows is same-phase now (widened), so a
  // delivery-phase citer against a decision-phase target fails on the CITED
  // side (delivery is satisfied by the citing side already) — same shape
  // override's own end-to-end wording test in tests/mcp/note.test.ts has.
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
      expect(result.detail).toContain("delivery-phase");
      expect(result.detail).toContain("cited turn");
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

  // rubric-v10 ticket 02 ("自引用"): the old phase-spanning self rule retires
  // with the vocabulary — ONLY `grounds` may ever self-cite. Its actual
  // legality (Gate C, "carries a tagged indexes edge post-transaction") is no
  // longer decided HERE at all — it moved to a separate post-write check
  // (`checkSelfGroundsTerminus`, tested in its own describe block below) — so
  // `validateRelationTarget` now admits a self-`grounds` unconditionally,
  // whatever the phase.
  describe("self-citation: grounds only, phase-blind (Gate C moved post-transaction)", () => {
    test("every relation but grounds refuses a self target outright, whatever the phase", () => {
      const dual = new Set<TurnPhase>(["decision", "delivery"]);
      for (const relation of EDGE_RELATIONS) {
        if (relation === "grounds") continue;
        const result = validateRelationTarget({
          relation,
          citingPhases: dual,
          targetKind: "turn",
          citedPhases: dual,
          isSelfReference: true,
        });
        expect(result.ok, `${relation} must not self-cite`).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("self-not-grounds");
        }
      }
    });

    test("a self-grounds is admitted at this layer for a delivery-carrying turn, whatever the other phase", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision", "delivery"]),
        targetKind: "turn",
        citedPhases: new Set(["decision", "delivery"]),
        isSelfReference: true,
      });
      expect(result).toEqual({ ok: true });
    });

    // round-4 review #1: the implementer half is checked HERE, pre-write —
    // a decision-only turn (no `delivery` in its own phase set) can never
    // self-ground, whether or not it holds some lane's terminus. The OLD
    // version of this layer admitted a self-grounds unconditionally on
    // phase, deferring the whole legality question to post-transaction Gate
    // C — this is the fix, caught by round-4 review #1 as a "decision-only
    // self-grounds REJECTS" contract requirement.
    test("a decision-only turn's self-grounds is refused right here, before Gate C ever runs", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision"]),
        targetKind: "turn",
        citedPhases: new Set(["decision"]),
        isSelfReference: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-not-delivery");
        expect(result.detail).toContain("delivery");
      }
    });

    // lane-declaration ticket 02 (peer P1-3): `grounds` IS taggable now, so
    // the reason this rejects moved from the word to the SHAPE — a self edge
    // is one node, and a tag names a lane, which has at least two.
    test("a self-grounds carrying tags rejects because a one-node self-loop is not a lane", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision", "delivery"]),
        targetKind: "turn",
        citedPhases: new Set(["decision", "delivery"]),
        isSelfReference: true,
        tags: ["lane-a"],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tag-on-self-edge");
        expect(result.detail).toContain("self-loop is not a lane");
        expect(result.detail).toContain("bare address");
      }
    });
  });

  // rubric-v10 ticket 02 (Gate C): the self-`grounds` terminus check, a
  // SEPARATE post-transaction function — see this module's header for why it
  // cannot live inside `validateRelationTarget`.
  describe("checkSelfGroundsTerminus / hasTaggedTerminusDeclaration — Gate C, post-transaction", () => {
    test("a tagged indexes edge PROVEN to be the current terminus makes it legal", () => {
      const edges = [{ relation: "indexes", tags: ["lane-a"], isCurrentTerminus: true }];
      expect(hasTaggedTerminusDeclaration(edges)).toBe(true);
      expect(checkSelfGroundsTerminus(edges)).toEqual({ ok: true });
    });

    // round-4 review #1's own headline fix: the OLD version of this pure
    // function asked only "is there a tagged indexes fact" and treated that
    // as sufficient — exactly the stale-declaration bug. A fact that is
    // relation=indexes/tagged but carries NO positive proof of currency (the
    // caller's own narrower, pre-fix evidence shape) must now fail closed,
    // not pass by omission.
    test("a tagged indexes fact with NO current-terminus proof fails closed — the stale-declaration case", () => {
      const edges = [{ relation: "indexes", tags: ["lane-a"] }];
      expect(hasTaggedTerminusDeclaration(edges)).toBe(false);
      const result = checkSelfGroundsTerminus(edges);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-not-terminus");
      }
    });

    test("isCurrentTerminus explicitly false — a lane reopened or repudiated since the declaration — still rejects", () => {
      const edges = [{ relation: "indexes", tags: ["lane-a"], isCurrentTerminus: false }];
      expect(hasTaggedTerminusDeclaration(edges)).toBe(false);
      const result = checkSelfGroundsTerminus(edges);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-not-terminus");
      }
    });

    test("an UNTAGGED indexes edge does not count — untagged indexes is free aggregation, not a terminus declaration", () => {
      const edges = [{ relation: "indexes", tags: [], isCurrentTerminus: true }];
      expect(hasTaggedTerminusDeclaration(edges)).toBe(false);
      const result = checkSelfGroundsTerminus(edges);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-not-terminus");
      }
    });

    test("a tagged edge of a DIFFERENT relation does not count — only indexes declares a terminus", () => {
      const edges = [{ relation: "override", tags: ["lane-a"], isCurrentTerminus: true }];
      expect(hasTaggedTerminusDeclaration(edges)).toBe(false);
    });

    test("no outgoing edges at all is refused, naming self-not-terminus", () => {
      const result = checkSelfGroundsTerminus([]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-not-terminus");
        expect(result.detail).toContain("TAGGED");
        expect(result.detail).toContain("indexes");
      }
    });
  });

  // rubric-v10 ticket 02 (Gate B): tag legality — only the five same-phase
  // words are taggable, and every tag must already exist on BOTH endpoint
  // turns' own tags (the subset invariant).
  describe("Gate B — tag legality (taggability + the subset invariant)", () => {
    // lane-declaration [S15069/T1562]: this used to be the five SAME-PHASE
    // words, on the reasoning that a lane is phase-local. It is all eight now
    // — a tagged cross-phase word is how one lane spans design and delivery.
    test("TAGGABLE_RELATIONS is ALL EIGHT words, including the three cross-phase ones", () => {
      expect([...TAGGABLE_RELATIONS].sort()).toEqual([...EDGE_RELATIONS].sort());
      for (const relation of ["grounds", "verifies", "refutes"] as const) {
        expect(TAGGABLE_RELATIONS.has(relation)).toBe(true);
      }
    });

    // tag-mandate ("Write gate") narrowed this from "whatever the relation":
    // six of the eight words still have an untagged form with nothing for
    // Gate B to check; `extends`/`narrows` lost theirs (see the tag-mandate
    // describe below).
    test("an untagged entry is legal for a word the mandate does not reach — nothing to check", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision"]),
        citedPhases: new Set(["delivery"]),
        targetKind: "turn",
        tags: [],
      });
      expect(result).toEqual({ ok: true });
    });

    // Replaces the pin that used to live here ("a tag on a cross-phase word
    // rejects as not-taggable"): the refusal is DELETED, so the same shape is
    // asserted ACCEPTED in the same place, which is where a reader looks.
    test("a CROSS-PHASE word carrying a declared, subset-satisfying tag is ACCEPTED", () => {
      const result = validateRelationTarget({
        relation: "verifies",
        citingPhases: new Set(["evidence"]),
        citedPhases: new Set(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set(["lane-a"]),
        laneRegistry: registry({ citingDeclared: ["lane-a"], citedDeclared: ["lane-a"] }),
      });
      expect(result).toEqual({ ok: true });
    });

    test("a tag present on both endpoint turns' tags is legal on a same-phase word", () => {
      const result = validateRelationTarget({
        relation: "override",
        citingPhases: new Set(["decision"]),
        citedPhases: new Set(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a", "other"]),
        citedTurnTags: new Set(["lane-a"]),
      });
      expect(result).toEqual({ ok: true });
    });

    test("a tag missing from the CITING turn's tags rejects, naming that endpoint", () => {
      const result = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set(["decision"]),
        citedPhases: new Set(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(),
        citedTurnTags: new Set(["lane-a"]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tag-missing");
        expect(result.detail).toContain("lane-a");
        expect(result.detail).toContain("citing turn");
      }
    });

    test("a tag missing from the CITED turn's tags rejects, naming that endpoint", () => {
      const result = validateRelationTarget({
        relation: "narrows",
        citingPhases: new Set(["decision"]),
        citedPhases: new Set(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tag-missing");
        expect(result.detail).toContain("lane-a");
        expect(result.detail).toContain("cited turn");
      }
    });

    test("a tag missing from BOTH endpoints names both in one rejection", () => {
      const result = validateRelationTarget({
        relation: "consume",
        citingPhases: new Set(["delivery"]),
        citedPhases: new Set(["delivery"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(),
        citedTurnTags: new Set(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tag-missing");
        expect(result.detail).toContain("citing turn");
        expect(result.detail).toContain("cited turn");
      }
    });

    test("a phase-illegal edge is rejected on phase alone — tag legality never runs first", () => {
      const result = validateRelationTarget({
        relation: "override",
        citingPhases: new Set(["decision"]),
        citedPhases: new Set(["delivery"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set(["lane-a"]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("phase-illegal");
      }
    });
  });

  // lane-declaration ticket 02 ([S15069/T1548]/[T1562]): the tag mandate is
  // WITHDRAWN. This block used to pin it ("a bare extends is refused as
  // tag-required"); it pins the permission that replaced it, in the same
  // place, so a reader learns the current rule where they used to learn the
  // old one. The end-to-end halves live in tests/mcp/note.test.ts (main
  // agent) and tests/worker/note-settlement-turn-facade.test.ts (settlement).
  describe("no word requires a lane tag — the mandate is withdrawn", () => {
    /** One legal phase pair per word, so a bare-form check below tests TAGS and not phases. */
    const LEGAL_PAIR: Record<
      TurnEdgeRelation,
      { citing: TurnPhase; cited: TurnPhase }
    > = {
      override: { citing: "decision", cited: "decision" },
      narrows: { citing: "decision", cited: "decision" },
      extends: { citing: "decision", cited: "decision" },
      indexes: { citing: "decision", cited: "decision" },
      consume: { citing: "decision", cited: "decision" },
      grounds: { citing: "decision", cited: "delivery" },
      verifies: { citing: "evidence", cited: "decision" },
      refutes: { citing: "evidence", cited: "decision" },
    };

    const bare = (relation: TurnEdgeRelation) =>
      validateRelationTarget({
        relation,
        citingPhases: new Set([LEGAL_PAIR[relation].citing]),
        citedPhases: new Set([LEGAL_PAIR[relation].cited]),
        targetKind: "turn",
      });

    test("EVERY one of the eight words accepts a bare address — extends/narrows included", () => {
      for (const relation of EDGE_RELATIONS) {
        expect(bare(relation)).toEqual({ ok: true });
      }
    });

    test("no rejection reason names a required tag any more", () => {
      // The `tag-required` reason is gone from the union; a bare stance edge
      // simply passes. Asserted through behaviour rather than the type, since
      // a type-only pin would survive the branch being re-added.
      for (const relation of ["extends", "narrows"] as const) {
        const result = bare(relation);
        expect(result.ok).toBe(true);
      }
    });

    test("the tagged form still works for the two words the mandate used to force it on", () => {
      for (const relation of ["extends", "narrows"] as const) {
        const result = validateRelationTarget({
          relation,
          citingPhases: new Set<TurnPhase>(["decision"]),
          citedPhases: new Set<TurnPhase>(["decision"]),
          targetKind: "turn",
          tags: ["lane-a"],
          citingTurnTags: new Set(["lane-a"]),
          citedTurnTags: new Set(["lane-a"]),
          laneRegistry: registry({ citingDeclared: ["lane-a"], citedDeclared: ["lane-a"] }),
        });
        expect(result).toEqual({ ok: true });
      }
    });

    // Gate order: tag legality is the LAST thing checked, so a call that is
    // wrong in an earlier way is told about that instead — the writer's more
    // direct lever first.
    test("an earlier gate still wins: a segment target and a self-reference report their own reasons", () => {
      const segment = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        citedPhases: new Set<TurnPhase>(),
        targetKind: "segment",
      });
      expect(segment.ok).toBe(false);
      if (!segment.ok) {
        expect(segment.reason).toBe("segment-target");
      }

      const self = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        citedPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        isSelfReference: true,
      });
      expect(self.ok).toBe(false);
      if (!self.ok) {
        expect(self.reason).toBe("self-not-grounds");
      }

      const phaseIllegal = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        citedPhases: new Set<TurnPhase>(["delivery"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set(["lane-a"]),
        laneRegistry: registry({ citingDeclared: [], citedDeclared: [] }),
      });
      expect(phaseIllegal.ok).toBe(false);
      if (!phaseIllegal.ok) {
        // NOT `lane-not-declared`: the phase problem is the more direct lever.
        expect(phaseIllegal.reason).toBe("phase-illegal");
      }
    });
  });

  // lane-declaration spec D2: the three per-tag checks, IN ORDER, plus the two
  // structural refusals. `laneRegistry` is caller-computed evidence (the DB
  // adapter is `db/lane-edge-gate.ts`); this block judges the ordering and the
  // wording, which is what both write paths inherit.
  describe("D2 — the lane registry gate", () => {
    const tagged = (facts: LaneRegistryFacts | undefined, tags: readonly string[] = ["lane-a"]) =>
      validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        citedPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        tags,
        citingTurnTags: new Set(tags),
        citedTurnTags: new Set(tags),
        laneRegistry: facts,
      });

    test("check 1 — a NON-CANONICAL tag refuses first, quoting the registry's own message", () => {
      const facts = registry({
        citingDeclared: ["lane-a"],
        citedDeclared: ["lane-a"],
        nonCanonical: [["Lane-A", 'tag "Lane-A" is not lowercase — canonical form is "lane-a".']],
      });
      const result = tagged(facts, ["Lane-A"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("lane-tag-not-canonical");
        expect(result.detail).toContain("not lowercase");
        expect(result.detail).toContain('canonical form is "lane-a"');
      }
    });

    test("check 2 — a HOMELESS endpoint refuses, naming WHICH turn has no segment", () => {
      const facts = registry({
        citingSegment: null,
        citingAddress: "S9/T4",
        citedDeclared: ["lane-a"],
      });
      const result = tagged(facts);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("lane-not-declared");
        expect(result.detail).toContain("S9/T4");
        expect(result.detail).toContain("NO segment");
      }
    });

    test("check 2 — a CROSS-SEGMENT edge declared on only ONE side refuses, naming the segment missing it", () => {
      const facts = registry({
        citingSegment: "E60",
        citingDeclared: ["lane-a"],
        citedSegment: "E67",
        citedAddress: "S9/T2",
        citedDeclared: [],
      });
      const result = tagged(facts);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("lane-not-declared");
        expect(result.detail).toContain("E67");
        expect(result.detail).toContain("S9/T2");
        expect(result.detail).toContain('lane "lane-a"');
        // The legal shape is stated, so the writer knows cross-segment is not
        // itself the problem.
        expect(result.detail).toContain("both segments declared the tag");
      }
    });

    test("check 2 — a CROSS-SEGMENT edge declared on BOTH sides is accepted", () => {
      const facts = registry({
        citingSegment: "E60",
        citingDeclared: ["lane-a"],
        citedSegment: "E67",
        citedDeclared: ["lane-a"],
      });
      expect(tagged(facts)).toEqual({ ok: true });
    });

    test("the three checks run in order: canonical before declaration before subset", () => {
      // All three would fail at once; only the FIRST is reported, and a
      // caller fixing it gets the next one on retry.
      const facts = registry({
        citingDeclared: [],
        citedDeclared: [],
        nonCanonical: [["Lane-A", 'tag "Lane-A" is not lowercase — canonical form is "lane-a".']],
      });
      const first = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        citedPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        tags: ["Lane-A"],
        citingTurnTags: new Set(),
        citedTurnTags: new Set(),
        laneRegistry: facts,
      });
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.reason).toBe("lane-tag-not-canonical");

      // Canonical now, still undeclared, still failing the subset invariant:
      // DECLARATION is reported, not the subset.
      const second = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        citedPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(),
        citedTurnTags: new Set(),
        laneRegistry: registry({ citingDeclared: [], citedDeclared: [] }),
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("lane-not-declared");

      // Declared now; the subset invariant is what is left.
      const third = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        citedPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(),
        citedTurnTags: new Set(["lane-a"]),
        laneRegistry: registry({ citingDeclared: ["lane-a"], citedDeclared: ["lane-a"] }),
      });
      expect(third.ok).toBe(false);
      if (!third.ok) expect(third.reason).toBe("tag-missing");
    });

    test("a SELF edge carrying a tag refuses before any registry check runs", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set<TurnPhase>(["decision", "delivery"]),
        citedPhases: new Set<TurnPhase>(["decision", "delivery"]),
        targetKind: "turn",
        isSelfReference: true,
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set(["lane-a"]),
        laneRegistry: registry({ citingDeclared: ["lane-a"], citedDeclared: ["lane-a"] }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tag-on-self-edge");
      }
    });

    test("an INTERSECTING stored tag set on the same (pair, relation) refuses, naming the union repair", () => {
      const facts = registry({
        citingDeclared: ["lane-a", "lane-b"],
        citedDeclared: ["lane-a", "lane-b"],
        intersectingRows: [{ tags: ["lane-a"], shared: ["lane-a"] }],
      });
      const result = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        citedPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        tags: ["lane-a", "lane-b"],
        citingTurnTags: new Set(["lane-a", "lane-b"]),
        citedTurnTags: new Set(["lane-a", "lane-b"]),
        laneRegistry: facts,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("lane-tags-intersect");
        expect(result.detail).toContain("lane-a");
        expect(result.detail).toContain("UNION");
        expect(result.detail).toContain("RETRACTING");
      }
    });

    test("a DISJOINT stored tag set on the same (pair, relation) is fine — the collector reports none", () => {
      const facts = registry({
        citingDeclared: ["lane-a"],
        citedDeclared: ["lane-a"],
        intersectingRows: [],
      });
      expect(tagged(facts)).toEqual({ ok: true });
    });

    test("no registry evidence means no registry verdict — the subset invariant still runs", () => {
      // The "never fabricate a verdict" posture: a caller that supplied
      // nothing gets no declaration verdict, and the pre-existing Gate B
      // behaviour is untouched.
      expect(tagged(undefined)).toEqual({ ok: true });
    });

    // RED LINE (write-gate-hardening ticket 01, tests/shared/tool-call-
    // syntax.test.ts's own closing test): a rejection returns straight into
    // the caller's context, so a message quoting call markup would plant the
    // exemplar the guard exists to break. Asserted with the guard itself
    // rather than by reading the string.
    test("no tag rejection reproduces tool-call markup", () => {
      const details: string[] = [];
      for (const build of [
        () => tagged(registry({ citingDeclared: [], citedDeclared: [] })),
        () => tagged(registry({ citingSegment: null, citedDeclared: ["lane-a"] })),
        () =>
          tagged(
            registry({
              citingDeclared: ["lane-a"],
              citedDeclared: ["lane-a"],
              nonCanonical: [["lane a", 'tag "lane a" has interior whitespace — a canonical tag has none.']],
            }),
            ["lane a"],
          ),
        () =>
          validateRelationTarget({
            relation: "grounds",
            citingPhases: new Set<TurnPhase>(["delivery"]),
            citedPhases: new Set<TurnPhase>(["delivery"]),
            targetKind: "turn",
            isSelfReference: true,
            tags: ["lane-a"],
          }),
      ]) {
        const result = build();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          details.push(result.detail);
        }
      }
      expect(details).toHaveLength(4);
      for (const detail of details) {
        expect(containsToolCallSyntax(detail)).toBe(false);
      }
    });
  });
});
