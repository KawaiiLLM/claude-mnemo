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
  type EdgeSideRegistryFacts,
  type TurnEdgeRelation,
  type TurnPhase,
} from "../../src/shared/turn-phase";
import { containsToolCallSyntax } from "../../src/shared/tool-call-syntax";
import { MEMORY_TYPES } from "../../src/shared/type-vocabulary";

/**
 * lane-model-v12 D2 (ticket 08): the PER-SIDE evidence
 * `validateRelationTarget` judges, built by hand here. The DB adapter that
 * produces it in production is `db/lane-edge-gate.ts`'s
 * `collectEdgeSideFacts`; this module is DB-free, so its tests state the facts
 * directly rather than through a database.
 *
 * Defaults are the ORDINARY legal case (each side in a segment that declared
 * `lane-a`, the tag on that side's own turn, canonical) so each test names only
 * the one fact it is about.
 */
function sides(overrides: {
  tailAddress?: string;
  tailSegment?: string | null;
  tailDeclared?: readonly string[];
  tailTurnTags?: readonly string[];
  tailNonCanonical?: string | null;
  headAddress?: string;
  headSegment?: string | null;
  headDeclared?: readonly string[];
  headTurnTags?: readonly string[];
  headNonCanonical?: string | null;
}): EdgeSideRegistryFacts {
  const tailSegment = overrides.tailSegment === undefined ? "E60" : overrides.tailSegment;
  const headSegment = overrides.headSegment === undefined ? "E60" : overrides.headSegment;
  return {
    tail: {
      address: overrides.tailAddress ?? "S9/T5",
      segment: tailSegment,
      declaredTags: new Set(overrides.tailDeclared ?? ["lane-a"]),
      turnTags: new Set(overrides.tailTurnTags ?? ["lane-a"]),
      nonCanonicalMessage: overrides.tailNonCanonical ?? null,
    },
    head: {
      address: overrides.headAddress ?? "S9/T3",
      segment: headSegment,
      declaredTags: new Set(overrides.headDeclared ?? ["lane-a"]),
      turnTags: new Set(overrides.headTurnTags ?? ["lane-a"]),
      nonCanonicalMessage: overrides.headNonCanonical ?? null,
    },
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
    // gate — a self edge that also places two lanes reports the self problem,
    // not a lane problem, and never reaches the registry at all.
    test("a LANE-PLACED self edge reports the self refusal, not a lane refusal", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set(["decision", "delivery"]),
        targetKind: "turn",
        isSelfReference: true,
        tailTag: "lane-a",
        headTag: "lane-a",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-edge");
      }
    });
  });

  // lane-model-v12 D2 (ticket 08): the two-sided lane gate. `laneSides` is
  // caller-computed evidence (the DB adapter is `db/lane-edge-gate.ts`); this
  // block judges the ORDER and the WORDING, which is what the settlement write
  // path inherits.
  describe("D2 — the two-sided lane gate", () => {
    const placed = (
      facts: EdgeSideRegistryFacts | undefined,
      tailTag = "lane-a",
      headTag = "lane-a",
    ) =>
      validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        tailTag,
        headTag,
        laneSides: facts,
      });

    // lane-declaration [S15069/T1562]: this used to be the five SAME-PHASE
    // words, on the reasoning that a lane is phase-local. It is all seven now
    // — a lane-placed edge is how one lane spans design and delivery.
    test("TAGGABLE_RELATIONS is ALL SEVEN words, the boundary-spanning ones included", () => {
      expect([...TAGGABLE_RELATIONS].sort()).toEqual([...EDGE_RELATIONS].sort());
      expect(TAGGABLE_RELATIONS.size).toBe(7);
      for (const relation of ["grounds", "verifies"] as const) {
        expect(TAGGABLE_RELATIONS.has(relation)).toBe(true);
      }
    });

    // TICKET 20 REVERSES TICKET 08 HERE. The half-settled shape used to be
    // refused at this gate (`lane-half-settled`); the user's ruling makes it a
    // legal DRAFT — "边上只要任意一侧没有 tag 就是草稿形态,计算时视为无边,但
    // 结算的 commit 和检查工具应该出 error 提示". The refusal did not vanish, it
    // MOVED: `shared/lane-checker.ts`'s error class E6 and the settlement commit
    // gate are where a draft is now answered, and `tests/shared/
    // lane-checker.test.ts` plus `tests/worker/note-settlement-sdk-query.test.ts`
    // are where that half is pinned.
    describe("a draft edge is ACCEPTED here — either side may be left empty (ticket 20)", () => {
      test("BOTH sides unsettled is the legal draft — every word, nothing to check", () => {
        for (const relation of EDGE_RELATIONS) {
          expect(
            validateRelationTarget({
              relation,
              citingPhases: new Set<TurnPhase>(["decision"]),
              targetKind: "turn",
              tailTag: "",
              headTag: "",
              laneSides: sides({}),
            }),
            relation,
          ).toEqual({ ok: true });
        }
      });

      test("omitting both side fields entirely is the same draft", () => {
        expect(
          validateRelationTarget({
            relation: "extends",
            citingPhases: new Set<TurnPhase>(["decision"]),
            targetKind: "turn",
          }),
        ).toEqual({ ok: true });
      });

      // THE MUTATION for the acceptance itself: re-add a `tailTag === '' ||
      // headTag === ''` refusal arm to `checkSideTagLegality` and these two
      // tests go red, in both directions.
      test("only the TAIL placed is ACCEPTED — a half-settled edge is a legal draft", () => {
        expect(placed(sides({}), "lane-a", "")).toEqual({ ok: true });
      });

      test("only the HEAD placed is ACCEPTED the same way", () => {
        expect(placed(sides({}), "", "lane-a")).toEqual({ ok: true });
      });

      test("every one of the seven words accepts a half-settled edge, either side", () => {
        for (const relation of EDGE_RELATIONS) {
          for (const [tailTag, headTag] of [
            ["lane-a", ""],
            ["", "lane-a"],
          ] as const) {
            expect(
              validateRelationTarget({
                relation,
                citingPhases: new Set<TurnPhase>(["decision"]),
                targetKind: "turn",
                tailTag,
                headTag,
                laneSides: sides({}),
              }),
              `${relation} ${tailTag}/${headTag}`,
            ).toEqual({ ok: true });
          }
        }
      });

      // The acceptance is of the SHAPE, not of the content: the side that IS
      // placed answers to its own segment exactly as before, all three checks.
      // Without this, "accept a draft" would silently open a hole through which
      // an undeclared lane reaches storage on a half-settled row.
      test("the PLACED side of a half-settled edge is still judged — all three per-side checks", () => {
        const undeclaredTail = placed(sides({ tailDeclared: [] }), "lane-a", "");
        expect(undeclaredTail.ok).toBe(false);
        if (!undeclaredTail.ok) expect(undeclaredTail.reason).toBe("lane-not-declared");

        const notOnTurn = placed(sides({ tailTurnTags: [] }), "lane-a", "");
        expect(notOnTurn.ok).toBe(false);
        if (!notOnTurn.ok) expect(notOnTurn.reason).toBe("tag-missing");

        const nonCanonical = placed(
          sides({ headNonCanonical: 'tag "Lane-A" is not lowercase — canonical form is "lane-a".' }),
          "",
          "Lane-A",
        );
        expect(nonCanonical.ok).toBe(false);
        if (!nonCanonical.ok) expect(nonCanonical.reason).toBe("lane-tag-not-canonical");
      });

      // The `''` side names nothing, so it must attract no verdict of its own —
      // otherwise checks 2 and 3 would report the empty string as an undeclared
      // lane missing from the turn, two refusals for a shape no longer refused.
      // A head whose OWN registry facts are hostile proves it: the tail is
      // clean, the head is unplaced, and nothing fires.
      test("the UNSETTLED side attracts no per-side verdict, however hostile its own facts", () => {
        expect(
          placed(sides({ headDeclared: [], headTurnTags: [], headSegment: null }), "lane-a", ""),
        ).toEqual({ ok: true });
      });

      test("a half-settled edge with NO side evidence supplied is accepted too", () => {
        expect(placed(undefined, "lane-a", "")).toEqual({ ok: true });
      });

      // The retired reason must not come back under its own name or its own
      // words, on any surviving refusal path.
      test("no rejection this module can produce spells the retired half-settled reason", () => {
        const rejections = [
          placed(sides({ tailDeclared: [] }), "lane-a", ""),
          placed(sides({ tailTurnTags: [] }), "lane-a", ""),
          placed(sides({ headDeclared: [] }), "", "lane-a"),
        ];
        for (const rejection of rejections) {
          expect(rejection.ok).toBe(false);
          if (!rejection.ok) {
            expect(rejection.reason).not.toBe("lane-half-settled");
            expect(rejection.detail).not.toContain("BOTH sides or on NEITHER");
          }
        }
      });
    });

    describe("check 1 — canonical form, per side", () => {
      test("a non-canonical TAIL tag refuses first, quoting the registry's own message and naming the side", () => {
        const result = placed(
          sides({
            tailNonCanonical: 'tag "Lane-A" is not lowercase — canonical form is "lane-a".',
            tailDeclared: [],
            tailTurnTags: [],
          }),
          "Lane-A",
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("lane-tag-not-canonical");
          expect(result.detail).toContain("tail side");
          expect(result.detail).toContain("not lowercase");
          expect(result.detail).toContain('canonical form is "lane-a"');
        }
      });

      test("a non-canonical HEAD tag refuses too, naming the head side", () => {
        const result = placed(
          sides({
            headNonCanonical: 'tag "lane a" has interior whitespace — a canonical tag has none.',
            headDeclared: [],
            headTurnTags: [],
          }),
          "lane-a",
          "lane a",
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("lane-tag-not-canonical");
          expect(result.detail).toContain("head side");
          expect(result.detail).toContain("interior whitespace");
        }
      });
    });

    describe("check 2 — declared in THAT side's own segment", () => {
      test("a HOMELESS endpoint refuses, naming WHICH turn has no segment", () => {
        const result = placed(sides({ tailSegment: null, tailAddress: "S9/T4" }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("lane-not-declared");
          expect(result.detail).toContain("S9/T4");
          expect(result.detail).toContain("NO segment");
        }
      });

      test("a side whose own segment never declared the lane refuses, naming that segment", () => {
        const result = placed(
          sides({ headSegment: "E67", headAddress: "S9/T2", headDeclared: [] }),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("lane-not-declared");
          expect(result.detail).toContain("E67");
          expect(result.detail).toContain("S9/T2");
          expect(result.detail).toContain('lane "lane-a"');
        }
      });

      // THE CROSSING THAT IS EASIEST TO GET BACKWARDS. A lane's identity is
      // (segment, tag), so the same literal word in two segments is TWO lanes —
      // a legal cross-lane edge, not a declaration gap.
      test("the SAME WORD on both sides in DIFFERENT segments is ACCEPTED — identity is (segment, tag)", () => {
        const facts = sides({
          tailSegment: "E60",
          tailDeclared: ["lane-a"],
          tailTurnTags: ["lane-a"],
          headSegment: "E67",
          headDeclared: ["lane-a"],
          headTurnTags: ["lane-a"],
        });
        expect(placed(facts)).toEqual({ ok: true });
      });

      test("TWO DIFFERENT lanes, each declared where its own endpoint lives, is an accepted crossing", () => {
        const facts = sides({
          tailSegment: "E60",
          tailDeclared: ["lane-a"],
          tailTurnTags: ["lane-a"],
          headSegment: "E67",
          headDeclared: ["lane-b"],
          headTurnTags: ["lane-b"],
        });
        expect(placed(facts, "lane-a", "lane-b")).toEqual({ ok: true });
      });

      // The mirror of the acceptance above: a side is judged against its OWN
      // segment, so a lane declared only in the OTHER side's segment is a gap.
      test("a lane declared only in the OTHER side's segment does not satisfy this side", () => {
        const facts = sides({
          tailSegment: "E60",
          tailDeclared: ["lane-a", "lane-b"],
          tailTurnTags: ["lane-a"],
          headSegment: "E67",
          headDeclared: [],
          headTurnTags: ["lane-b"],
        });
        const result = placed(facts, "lane-a", "lane-b");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("lane-not-declared");
          expect(result.detail).toContain("E67");
          expect(result.detail).toContain('lane "lane-b"');
        }
      });
    });

    describe("check 3 — the subset invariant, per side", () => {
      test("a tag missing from the TAIL's own turn tags rejects, naming that side", () => {
        const result = placed(sides({ tailTurnTags: [] }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("tag-missing");
          expect(result.detail).toContain("lane-a");
          expect(result.detail).toContain("tail side");
          expect(result.detail).toContain("S9/T5");
        }
      });

      test("a tag missing from the HEAD's own turn tags rejects, naming that side", () => {
        const result = placed(sides({ headTurnTags: [] }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("tag-missing");
          expect(result.detail).toContain("head side");
          expect(result.detail).toContain("S9/T3");
        }
      });

      test("missing from BOTH names both in one rejection", () => {
        const result = placed(sides({ tailTurnTags: [], headTurnTags: [] }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("tag-missing");
          expect(result.detail).toContain("tail side");
          expect(result.detail).toContain("head side");
        }
      });

      // Each side is checked against its OWN turn: the tail's tag being on the
      // CITED turn buys it nothing. This is the mutation target for "the two
      // sides read the same endpoint".
      test("the tag being on the OTHER side's turn does not satisfy this side", () => {
        const result = placed(
          sides({ tailTurnTags: ["lane-b"], headTurnTags: ["lane-a", "lane-b"] }),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("tag-missing");
          expect(result.detail).toContain("tail side");
        }
      });
    });

    test("the three checks run in order: canonical before declaration before subset", () => {
      // All three would fail at once; only the FIRST is reported, and a caller
      // fixing it gets the next one on retry.
      const first = placed(
        sides({
          tailNonCanonical: 'tag "Lane-A" is not lowercase — canonical form is "lane-a".',
          tailDeclared: [],
          tailTurnTags: [],
        }),
        "Lane-A",
      );
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.reason).toBe("lane-tag-not-canonical");

      // Canonical now, still undeclared, still failing the subset invariant:
      // DECLARATION is reported, not the subset.
      const second = placed(sides({ tailDeclared: [], tailTurnTags: [] }));
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("lane-not-declared");

      // Declared now; the subset invariant is what is left.
      const third = placed(sides({ tailTurnTags: [] }));
      expect(third.ok).toBe(false);
      if (!third.ok) expect(third.reason).toBe("tag-missing");
    });

    test("a SELF edge placed in a lane refuses before any side check runs — as a SELF refusal (v12 ticket 04)", () => {
      const result = validateRelationTarget({
        relation: "grounds",
        citingPhases: new Set<TurnPhase>(["decision", "delivery"]),
        targetKind: "turn",
        isSelfReference: true,
        tailTag: "lane-a",
        headTag: "lane-a",
        laneSides: sides({ tailDeclared: [], tailTurnTags: [] }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("self-edge");
      }
    });

    test("no side evidence means no side verdict — a fully placed edge is not judged against facts nobody supplied", () => {
      // The "never fabricate a verdict" posture.
      expect(placed(undefined)).toEqual({ ok: true });
    });

    // Gate order: an earlier gate still wins — a segment target and a self
    // reference report their own reasons, never a lane one.
    test("an earlier gate still wins: a segment target and a self-reference report their own reasons", () => {
      const segment = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "segment",
        tailTag: "lane-a",
        headTag: "lane-a",
      });
      expect(segment.ok).toBe(false);
      if (!segment.ok) expect(segment.reason).toBe("segment-target");

      const self = validateRelationTarget({
        relation: "extends",
        citingPhases: new Set<TurnPhase>(["decision"]),
        targetKind: "turn",
        isSelfReference: true,
      });
      expect(self.ok).toBe(false);
      if (!self.ok) expect(self.reason).toBe("self-edge");
    });

    test("EVERY one of the seven words accepts a placed edge and a draft alike", () => {
      for (const relation of EDGE_RELATIONS) {
        expect(
          validateRelationTarget({
            relation,
            citingPhases: new Set<TurnPhase>(["decision"]),
            targetKind: "turn",
            tailTag: "lane-a",
            headTag: "lane-a",
            laneSides: sides({}),
          }),
          relation,
        ).toEqual({ ok: true });
        expect(
          validateRelationTarget({
            relation,
            citingPhases: new Set<TurnPhase>(["decision"]),
            targetKind: "turn",
          }),
          relation,
        ).toEqual({ ok: true });
      }
    });

    // The retired `lane-tags-intersect` refusal: it had no premise left once a
    // side held ONE value, so nothing may re-import it. Two rows on one
    // (pair, relation) differ in at least one side's lane, and neither lane
    // reads both as its own internal edge.
    test("no rejection this module can produce is the retired intersect reason", () => {
      const rejections = [
        placed(sides({ tailDeclared: [] })),
        placed(sides({ tailTurnTags: [] })),
        // Ticket 20: the half-settled sample this list used to carry is no
        // longer a rejection at all, so the third case is a placed edge whose
        // HEAD side fails instead.
        placed(sides({ headTurnTags: [] })),
      ];
      for (const rejection of rejections) {
        expect(rejection.ok).toBe(false);
        if (!rejection.ok) {
          expect(rejection.reason).not.toBe("lane-tags-intersect");
          expect(rejection.detail).not.toContain("UNION");
        }
      }
    });

    // RED LINE (write-gate-hardening ticket 01, tests/shared/tool-call-
    // syntax.test.ts's own closing test): a rejection returns straight into
    // the caller's context, so a message quoting call markup would plant the
    // exemplar the guard exists to break. Asserted with the guard itself
    // rather than by reading the string.
    test("no lane rejection reproduces tool-call markup", () => {
      const details: string[] = [];
      for (const build of [
        () => placed(sides({ tailDeclared: [] })),
        () => placed(sides({ tailSegment: null })),
        () => placed(sides({ tailTurnTags: [] })),
        // Ticket 20 retired the half-settled refusal this slot used to build;
        // a HALF-settled edge whose placed side is undeclared covers the same
        // path and is still a rejection.
        () => placed(sides({ headDeclared: [] }), "", "lane-a"),
        () =>
          placed(
            sides({
              tailNonCanonical: 'tag "lane a" has interior whitespace — a canonical tag has none.',
              tailDeclared: [],
              tailTurnTags: [],
            }),
            "lane a",
          ),
        () =>
          validateRelationTarget({
            relation: "grounds",
            citingPhases: new Set<TurnPhase>(["delivery"]),
            targetKind: "turn",
            isSelfReference: true,
          }),
      ]) {
        const result = build();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          details.push(result.detail);
        }
      }
      expect(details).toHaveLength(6);
      for (const detail of details) {
        expect(containsToolCallSyntax(detail)).toBe(false);
      }
    });
  });
});
