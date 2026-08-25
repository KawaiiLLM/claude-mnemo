import { describe, expect, test } from "bun:test";

import {
  EDGE_RELATIONS,
  isTurnEdgeRelation,
  phasesForTypes,
  RELATION_FIELD_NAME,
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

describe("EDGE_RELATIONS — the seven-word closed set (lane-model v12 ticket 02)", () => {
  test("is exactly the seven words; supersedes AND refutes excluded", () => {
    expect([...EDGE_RELATIONS].sort()).toEqual(
      [
        "indexes",
        "consume",
        "extends",
        "grounds",
        "narrows",
        "override",
        "verifies",
      ].sort(),
    );
    expect(isTurnEdgeRelation("supersedes")).toBe(false);
    // v12: `refutes` merged into `override`. It stays a STORAGE word
    // (db/citations.ts's CITATION_RELATIONS) so old rows load and a
    // `retractRefutes` mirror can delete them, but a NEW write may not carry
    // it — the same footing `supersedes` has held since flow-relations.
    expect(isTurnEdgeRelation("refutes")).toBe(false);
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
// Lane-model v12 ticket 02: the PHASE AXIS LEAVES THE VOCABULARY. What used
// to sit here was the "六行律" table — all nine (source phase, target phase)
// cells against all eight words, transcribed by hand from the flow-relations
// spec — plus the exists-rule for multi-type turns, the
// `explainRelationPhaseRejection` wording tests and the
// `RELATION_PHASE_REQUIREMENT` shape tests. All four blocks pinned a rule
// that no longer exists, so they are REPLACED IN PLACE by the permission that
// took its place: a reader arriving at this spot learns the current rule.
//
// The measurement that decided it (spec's 问题 section): with the "any legal
// pairing on a multi-phase turn wins" escape hatch open, exactly ONE live
// hand-written edge in the whole database failed the gate; closing the hatch
// failed 309/609 (51%). The hatch was what made the graph legal, not the
// axis. The evidence-type condition on verifies/refutes went with it — 19/20
// asserted rows already complied, and the one genuine violation it caught is
// legal under the merged override semantics.
//
// The cell table stays, INVERTED: every cell now expects ACCEPT, so the test
// still enumerates all nine pairs rather than asserting the absence of a
// function.
// ---------------------------------------------------------------------------

describe("no phase gate — all nine (source, target) phase pairs x all seven words are accepted", () => {
  for (const source of TURN_PHASES) {
    for (const target of TURN_PHASES) {
      test(`${source} -> ${target}: every word is admitted, including the pairs the six-row law refused`, () => {
        for (const relation of EDGE_RELATIONS) {
          const result = validateRelationTarget({
            relation,
            citingPhases: new Set([source]),
            targetKind: "turn",
          });
          expect(result.ok, `${relation} at ${source}->${target}`).toBe(true);
        }
      });
    }
  }

  // Three named cells the OLD law refused, kept as their own test so the
  // change is legible without reading the loop above: an evidence->evidence
  // verifies (T1215's "evidence never renders a verdict on evidence"), a
  // same-phase grounds (T1209's cross-phase-only retightening), and a
  // cross-phase extends (the same-phase group's own domain).
  test("the formerly phase-illegal edges are accepted, one per retired rule", () => {
    const formerlyIllegal = [
      { relation: "verifies", source: "evidence", target: "evidence" },
      { relation: "grounds", source: "decision", target: "decision" },
      { relation: "extends", source: "delivery", target: "decision" },
    ] as const;
    for (const cell of formerlyIllegal) {
      const result = validateRelationTarget({
        relation: cell.relation,
        citingPhases: new Set([cell.source]),
        targetKind: "turn",
      });
      expect(result.ok, `${cell.relation} at ${cell.source}->${cell.target}`).toBe(true);
    }
  });

  // `verifies` used to require an evidence-phase SOURCE
  // (`EVIDENCE_SOURCE_RELATIONS`). A design-only turn writing one was the
  // single real violation the condition ever caught in production
  // (S15069/T839), and under the merged semantics that edge is legal.
  test("verifies no longer requires an evidence type on either end", () => {
    for (const citing of [new Set(["design" as const]), new Set(["implement" as const]), new Set([])]) {
      const result = validateRelationTarget({
        relation: "verifies",
        citingPhases: phasesForTypes([...citing]),
        targetKind: "turn",
      });
      expect(result.ok).toBe(true);
    }
  });

  // An UNTYPED turn (empty phase set) used to be refused outright for every
  // word — `grounds` most visibly, since T1209 gave it a rejection channel by
  // making it read the same table. Type is not a relation licence any more.
  test("an untyped turn on either end writes any word", () => {
    for (const relation of EDGE_RELATIONS) {
      const result = validateRelationTarget({
        relation,
        citingPhases: new Set<TurnPhase>(),
        targetKind: "turn",
      });
      expect(result.ok, `${relation} from an untyped turn`).toBe(true);
    }
  });

  // The rejection REASON is gone, not merely unreachable: nothing in the
  // union can name a phase any more, so no caller can branch on one.
  test("no rejection this module can produce names a phase requirement", () => {
    const rejections = [
      validateRelationTarget({
        relation: "override",
        citingPhases: new Set(["decision"]),
        targetKind: "segment",
      }),
    ];
    for (const rejection of rejections) {
      expect(rejection.ok).toBe(false);
      if (!rejection.ok) {
        expect(rejection.reason).not.toBe("phase-illegal");
        expect(rejection.detail).not.toMatch(/-phase type/);
      }
    }
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
  // Lane-model v12 ticket 02 replaces the retired "a phase-illegal turn target
  // is rejected, naming the missing half" pin, in place: the very pairing that
  // test used (a delivery-phase `narrows` at a decision-phase target) is the
  // ADMISSION case now.
  test("the turn target the old six-row law refused is admitted, with no verdict about either end's type", () => {
    const result = validateRelationTarget({
      relation: "narrows",
      citingPhases: new Set(["delivery"]),
      targetKind: "turn",
    });
    expect(result.ok).toBe(true);
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

  // lane-model-v12 D2 (ticket 04): the whole conditional self-citation
  // apparatus is DELETED — the `grounds`-only carve-out, its implementer
  // half, its post-transaction terminus gate (`checkSelfGroundsTerminus`,
  // which no longer exists) and the separate tag-on-a-self-edge refusal. What
  // is left is one flat rule: an edge's two ends must be DIFFERENT nodes.
  describe("self edges: refused outright, for every word and every phase (v12 D2)", () => {
    test("EVERY relation refuses a self target, whatever the phase — grounds included", () => {
      const dual = new Set<TurnPhase>(["decision", "delivery"]);
      for (const relation of EDGE_RELATIONS) {
        const result = validateRelationTarget({
          relation,
          citingPhases: dual,
          targetKind: "turn",
          isSelfReference: true,
        });
        expect(result.ok, `${relation} must not self-cite`).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("self-edge");
          expect(result.detail).toContain("DIFFERENT turns");
        }
      }
    });

    // The two conditions that used to make ONE word's self edge legal. Both
    // are now irrelevant: a delivery-carrying turn is refused exactly like a
    // decision-only one, and no post-write fact can rescue either.
    test("a delivery-carrying turn's self-grounds — the one shape that used to pass here — is refused too", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision", "delivery"]),
        targetKind: "turn",
        isSelfReference: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-edge");
      }
    });

    // The refusal is about the edge's SHAPE, so it short-circuits every later
    // gate — a self edge carrying a tag reports the self problem, not a tag
    // problem, and never reaches the registry at all.
    test("a TAGGED self edge reports the self refusal, not a tag refusal", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision", "delivery"]),
        targetKind: "turn",
        isSelfReference: true,
        tags: ["lane-a"],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-edge");
      }
    });
  });

  // rubric-v10 ticket 02 (Gate B): tag legality — every tag must already exist
  // on BOTH endpoint turns' own tags (the subset invariant). Since lane-model
  // v12 this is the ONLY thing left that can refuse a non-self turn target.
  describe("Gate B — tag legality (the subset invariant and the registry)", () => {
    // lane-declaration [S15069/T1562]: this used to be the five SAME-PHASE
    // words, on the reasoning that a lane is phase-local. It is all seven now
    // — a tagged edge is how one lane spans design and delivery.
    test("TAGGABLE_RELATIONS is ALL SEVEN words, the boundary-spanning ones included", () => {
      expect([...TAGGABLE_RELATIONS].sort()).toEqual([...EDGE_RELATIONS].sort());
      expect(TAGGABLE_RELATIONS.size).toBe(7);
      // The two words that used to be refused a tag because a lane was held to
      // be phase-local. `refutes` was the third and is no longer a word.
      for (const relation of ["grounds", "verifies"] as const) {
        expect(TAGGABLE_RELATIONS.has(relation)).toBe(true);
      }
    });

    // tag-mandate ("Write gate") narrowed this from "whatever the relation"
    // for one release; the mandate is withdrawn, so every one of the seven
    // words has an untagged form with nothing for Gate B to check.
    test("an untagged entry is legal for a word the mandate does not reach — nothing to check", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision"]),
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

    // The retired ordering pin ("a phase-illegal edge is rejected on phase
    // alone — tag legality never runs first") is replaced in place by what the
    // same call does now: with no phase gate in front of it, TAG legality is
    // the first thing that can refuse this edge, so the same inputs that used
    // to report a phase problem now report the tag problem — or nothing.
    test("a formerly phase-illegal edge with a legal tag is accepted; with an illegal tag it reports the TAG", () => {
      const legal = validateRelationTarget({
        relation: "override",
        citingPhases: new Set(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set(["lane-a"]),
      });
      expect(legal.ok).toBe(true);

      const tagIllegal = validateRelationTarget({
        relation: "override",
        citingPhases: new Set(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set<string>(),
      });
      expect(tagIllegal.ok).toBe(false);
      if (!tagIllegal.ok) {
        expect(tagIllegal.reason).toBe("tag-missing");
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
    // The per-word LEGAL_PAIR table this replaces existed only to give each
    // word a phase pairing its own domain admitted, so that a bare-form check
    // tested TAGS rather than phases. With no phase domain left, one call
    // shape serves every word.
    const bare = (relation: TurnEdgeRelation) =>
      validateRelationTarget({
        relation,
        citingPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
      });

    test("EVERY one of the seven words accepts a bare address — extends/narrows included", () => {
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
        targetKind: "segment",
      });
      expect(segment.ok).toBe(false);
      if (!segment.ok) {
        expect(segment.reason).toBe("segment-target");
      }

      const self = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        isSelfReference: true,
      });
      expect(self.ok).toBe(false);
      if (!self.ok) {
        expect(self.reason).toBe("self-edge");
      }

      // The third case used to be a phase-illegal edge outranking an
      // undeclared lane ("the phase problem is the more direct lever"). With
      // the phase gate gone the registry check is what this call reports —
      // there is no earlier gate left above it for a non-self turn target.
      const undeclared = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set(["lane-a"]),
        laneRegistry: registry({ citingDeclared: [], citedDeclared: [] }),
      });
      expect(undeclared.ok).toBe(false);
      if (!undeclared.ok) {
        expect(undeclared.reason).toBe("lane-not-declared");
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
        targetKind: "turn",
        tags: ["lane-a"],
        citingTurnTags: new Set(),
        citedTurnTags: new Set(["lane-a"]),
        laneRegistry: registry({ citingDeclared: ["lane-a"], citedDeclared: ["lane-a"] }),
      });
      expect(third.ok).toBe(false);
      if (!third.ok) expect(third.reason).toBe("tag-missing");
    });

    test("a SELF edge carrying a tag refuses before any registry check runs — as a SELF refusal (v12 ticket 04)", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set<TurnPhase>(["decision", "delivery"]),
        targetKind: "turn",
        isSelfReference: true,
        tags: ["lane-a"],
        citingTurnTags: new Set(["lane-a"]),
        citedTurnTags: new Set(["lane-a"]),
        laneRegistry: registry({ citingDeclared: ["lane-a"], citedDeclared: ["lane-a"] }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-edge");
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
