import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import {
  MAX_INJECTED_BLOCK_CHARS,
  renderRubricBlock,
} from "../../src/hooks/session-composition";
import {
  MNEMO_TOOL_DESCRIPTIONS,
  noteInputShape,
  rememberInputShape,
} from "../../src/mcp/definitions";
import {
  EDGE_RELATIONS,
  isRelationLegalForPhases,
  type TurnPhase,
} from "../../src/shared/turn-phase";
import {
  MEMORY_RUBRIC_HASH,
  MEMORY_RUBRIC_TEXT,
  MEMORY_RUBRIC_VERSION,
  renderMemoryRubricBlock,
} from "../../src/shared/memory-rubric";

/**
 * Ticket 11 (edge-ownership-impl, "统一 Memory Rubric") — the rubric's own
 * guard tests. Full byte-identity between the SessionStart injection and the
 * settlement prompt is pinned in tests/worker/note-settlement-prompt.test.ts
 * (which already carries the settlement fixture); this file covers what
 * needs no database fixture at all: the hash itself, the shared block's
 * budget/incomplete-marker discipline, and the single-home grep guard over
 * every describe() this ticket migrated judgment prose OUT of.
 */

describe("MEMORY_RUBRIC_HASH — self-consistency", () => {
  test("is a deterministic hash of MEMORY_RUBRIC_TEXT, independently recomputed", () => {
    const recomputed = createHash("sha256")
      .update(MEMORY_RUBRIC_TEXT, "utf8")
      .digest("hex")
      .slice(0, 12);
    expect(MEMORY_RUBRIC_HASH).toBe(recomputed);
  });

  test("renderMemoryRubricBlock wraps the verbatim text with a version/hash header line", () => {
    const block = renderMemoryRubricBlock();
    expect(block).toContain(`version="${MEMORY_RUBRIC_VERSION}"`);
    expect(block).toContain(`hash="${MEMORY_RUBRIC_HASH}"`);
    expect(block).toContain(MEMORY_RUBRIC_TEXT);
    // The wrapper does not mutate the source text — it appears whole, once.
    expect(block.indexOf(MEMORY_RUBRIC_TEXT)).toBe(block.lastIndexOf(MEMORY_RUBRIC_TEXT));
  });

  test("the rubric's own sections are present verbatim (ticket's own normative text)", () => {
    expect(MEMORY_RUBRIC_TEXT).toContain("# Memory Rubric v9");
    expect(MEMORY_RUBRIC_TEXT).toContain("## Fields");
    // Ticket 03's four-section regroup survives translation: type/tags stay
    // unheaded sub-blocks of `## Fields`, and the four H2s carry the v6
    // English titles (relation-matrix spec, full-English ruling). v7 replaces
    // §Relations' BODY wholesale; all four headings, this one included, are
    // untouched.
    expect(MEMORY_RUBRIC_TEXT).toContain("type — a closed vocabulary, one meaning per word:");
    expect(MEMORY_RUBRIC_TEXT).toContain("tags — nouns, naming things");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "## Relations (turn→turn; recorded from the citing turn toward the cited)",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("## Segments (membership and creation)");
    expect(MEMORY_RUBRIC_TEXT).toContain("## Policy (when to read)");
  });

  // v9 (indexes-rescope follow-up, ruled S15069/T1253–T1256) restructures
  // §Relations into three layers: CONCEPTS (the three phase-local flows, then
  // the eight words), REACH RULES (same-flow / same-phase / cross-phase in one
  // place), then PROCEDURE. Two changes carry the behavioral intent, and both
  // are pinned below because either could be "tidied" away by someone who
  // reads them as formatting.
  //
  // First: `indexes` leaves the JUDGING group. Under v8 the rubric announced
  // three stances and then listed FOUR jobs — override/narrows/extends answer
  // "must the cited still be read?" with no/yes/yes, while indexes answered a
  // different question entirely ("through me"). A word filed under a heading
  // whose question it does not answer is a word the reader skips, and the
  // measured result was zero indexes edges written by the main agent across a
  // whole window that contained settlements needing them.
  //
  // Second: the checklist gains an AGGREGATION pass. The precursor pass asks
  // "what caused this turn", which can never generate an aggregation candidate
  // — aggregation is about what this turn stands for, not what stands behind
  // it. Naming the flows without adding this pass would have been a rename of
  // the table of contents.
  test("v9 carries the three flows, the four jobs and the reach rules, verbatim", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v9");

    // Concepts: three flows, with the one clause that keeps a reader from
    // believing the machine derives all three.
    // "MAY run a flow per phase", not "runs": a workflow can lack evidence
    // entirely, or not have shipped yet. Each flow is described by what JOINS
    // it, never by a lifecycle it must complete — an earlier draft said the
    // evidence flow ends where a decision takes it up (contradicting this
    // section's own rule that verifies/refutes may target delivery) and that a
    // delivery flow ends at a release (releases index across flows; not every
    // chain has one). Only the decision flow keeps a terminus, because only its
    // settlement is graph-defined.
    // ONE definition of a flow, instantiated per phase (user ruling
    // S15069/T1265): a phase-local separable line of work, where a single
    // subtask and even a single node are equally flows. The earlier draft gave
    // three different definitions, which read as three kinds of thing.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "A FLOW is one separable line of work inside a phase — a chain of subtasks,\n" +
        "sometimes one subtask, sometimes one node; each is equally a flow.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("EVIDENCE flows establish facts");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "DECISION flows join rulings with\nnarrows/extends and SETTLE where nothing further narrows or extends",
    );
    // Delivery names consume as its joining word — this is where v8's
    // "Dispatch → acceptance → commit chains are consume" mapping lives.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "DELIVERY\nflows join steps with consume (dispatch → acceptance → commit).",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "Only the\ndecision flow has graph-derived identity; the other two are reading aids, not\nmachine-derived.",
    );

    // Four jobs, indexes standing on its own question.
    expect(MEMORY_RUBRIC_TEXT).toContain("Eight words, four jobs:");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "  JUDGING the cited conclusion — after reading me, must it still be read?",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "  · override — no: it is wrong, and this node replaces it.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "  · narrows  — yes, but this node cuts a piece out of its scope.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("  · extends  — yes, and this node adds a piece.");
    expect(MEMORY_RUBRIC_TEXT).toContain("  AGGREGATING — which nodes do I stand for?");
    // The word now carries its PURPOSE, not just its shape (S15069/T1265):
    // it declares a flow converged and makes this node the flow's proxy, which
    // is what licenses everything outside to cite one node instead of members.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "  · indexes  — these: the flow converges here and I stand for it. Cite me and\n" +
        "    you have cited the flow, so everything outside reaches it through this one\n" +
        "    node, never through its members.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "  DEPENDING on it — if it turned out false, what happens to me?",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "  · grounds  — I fall with it: a delivery on the decision it implements, a",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "  · consume  — nothing: I used its product and do not answer for it.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("  TESTING it — did I put the claim to a check?");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "  · verifies / refutes — a result produced this turn, for it or against it.",
    );

    // Reach rules, gathered in one place instead of scattered per bullet.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "Where each may reach:\n" +
        "- ONE decision flow: narrows, extends.\n" +
        "- Same phase, regardless of flow: override, indexes, consume.\n" +
        "- Cross-phase only: grounds; verifies/refutes from an evidence source toward a\n" +
        "  decision or delivery target.",
    );
  });

  // The reach rules are TEACHING text about a machine rule, so they are the
  // classic drift pair: nothing linked the sentence a writer reads to the table
  // the validator enforces, and this batch has already been bitten twice by
  // exactly that shape (a DB reader holding a second stale copy of the relation
  // vocabulary; a prompt pointing at rubric sections renamed three versions
  // earlier). This test parses the rules out of the rubric itself and checks
  // every word against `isRelationLegalForPhases`, so a change on either side
  // that is not made on the other dies here.
  test("the reach rules state exactly what the validator enforces", () => {
    const wordsAfter = (marker: string): string[] => {
      const line = MEMORY_RUBRIC_TEXT.slice(MEMORY_RUBRIC_TEXT.indexOf(marker));
      return line
        .slice(marker.length, line.indexOf("\n"))
        .replace(/\.$/, "")
        .split(/,\s*/)
        .map((word) => word.trim())
        .filter(Boolean);
    };
    const legalPairs = (relation: string): string[] => {
      const phases: TurnPhase[] = ["evidence", "decision", "delivery"];
      const pairs: string[] = [];
      for (const source of phases) {
        for (const target of phases) {
          if (isRelationLegalForPhases(relation, new Set([source]), new Set([target]))) {
            pairs.push(`${source}→${target}`);
          }
        }
      }
      return pairs;
    };

    // "ONE decision flow" — both ends decision-phase, which is what makes these
    // two the only words that BUILD a flow.
    const flowWords = wordsAfter("- ONE decision flow: ");
    expect(flowWords).toEqual(["narrows", "extends"]);
    for (const word of flowWords) {
      expect(legalPairs(word)).toEqual(["decision→decision"]);
    }

    // "Same phase, regardless of flow" — all three same-phase cells, and no
    // flow condition of any kind (the retired terminus gate is why this reads
    // "regardless of" rather than "any flow").
    const samePhaseWords = wordsAfter("- Same phase, regardless of flow: ");
    expect(samePhaseWords).toEqual(["override", "indexes", "consume"]);
    for (const word of samePhaseWords) {
      expect(legalPairs(word)).toEqual([
        "evidence→evidence",
        "decision→decision",
        "delivery→delivery",
      ]);
    }

    // "Cross-phase only: grounds" — every pairing where the phases differ, in
    // either direction, and no same-phase cell at all.
    expect(MEMORY_RUBRIC_TEXT).toContain("- Cross-phase only: grounds;");
    expect(legalPairs("grounds")).toEqual([
      "evidence→decision",
      "evidence→delivery",
      "decision→evidence",
      "decision→delivery",
      "delivery→evidence",
      "delivery→decision",
    ]);

    // EXHAUSTIVENESS. Everything above checks the words the rules NAME; this
    // checks that they name every word there is. Without it, a ninth relation
    // added to the validator and forgotten in the rubric leaves this test
    // green — and this vocabulary has already turned over three times
    // (seven words → eight → the collects/indexes rename), so that is a
    // measured pattern, not a hypothetical.
    expect(
      [...flowWords, ...samePhaseWords, "grounds", "verifies", "refutes"].sort(),
    ).toEqual([...EDGE_RELATIONS].sort());

    // The verdict pair is the one word set with an asymmetric rule: an evidence
    // SOURCE only, and never an evidence target (a verdict's object is a claim
    // of another kind, [S15069/T1215]).
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "verifies/refutes from an evidence source toward a\n  decision or delivery target.",
    );
    for (const word of ["verifies", "refutes"]) {
      expect(legalPairs(word)).toEqual(["evidence→decision", "evidence→delivery"]);
    }
  });

  // The two passes, and the sentence that makes the aggregation pass writable
  // at all: a turn cannot know it is a final settlement, but it CAN know it is
  // gathering a conclusion now — and since law 2 retired the terminus gate, a
  // later extends does not falsify the edge, it just moves the flow past it.
  test("v9's procedure runs a precursor pass and a separate aggregation pass", () => {
    expect(MEMORY_RUBRIC_TEXT).toContain("Every finished turn makes two passes.");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "1. PRECURSORS — for each node that directly caused this turn, pick its word by",
    );
    // "legal ONLY as" — dropping the ONLY turned an exhaustive condition into
    // two examples, which would license any precursor-less turn to stay orphan.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "an orphan is legal ONLY as an unforeseen subtask start\n   or decision-free chatter, and edges are never invented to remove one.",
    );
    // The exists-rule mental model, restored verbatim from v8: a multi-phase
    // turn is judged per phase, which is NOT the same as acting once per phase —
    // the validator accepts an edge when ANY phase pairing is legal, and the
    // interim wording ("acts once per phase") read as a storage cardinality.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "A multi-phase turn is several steps merged into one: judge each phase's edge\nindependently.",
    );
    // The trigger is CONVERGENCE of a flow, not the looser "does it stand for
    // a set of nodes" (S15069/T1262): every turn can answer the loose question,
    // and for most the honest answer is "no, I am one link".
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "2. AGGREGATION — then ask of this turn itself: does a flow CONVERGE here — a\n" +
        "   decision closing on its settlement, a delivery on the release that ships\n" +
        "   it? Then index the nodes carrying its result. Later work may extend the\n" +
        "   flow past this turn; the edge stays true as the aggregation it was.",
    );
    // The dedup and the refusal/warning handling survive the compression.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "derive — extends and indexes both subsume consume, so never write both.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain("refusal names the missing half");
    // "stores the edge anyway", not "stores anyway": the subject of the storing
    // is the edge, not the warning.
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "A warning names a better target and stores the edge anyway → take it next",
    );
  });

  // The canonical route (spec law 7) moved out of the grounds bullet into the
  // citation paragraph beside the settlement rule, where both cross-phase
  // targeting rules now sit together. "SEPARATE delivery turn" states the
  // precondition in the two words that matter: a decision-only turn that
  // happens to write a spec is not the route's subject (an artifact consuming
  // it would be phase-illegal), and a merged design+spec turn is excluded by
  // the clause that follows.
  test("v9 keeps the settlement-citation rule and the canonical route together", () => {
    expect(MEMORY_RUBRIC_TEXT).toContain(
      // The pronoun is spelled out: with "names it instead", the nearest noun
      // is "a mid-flow grounds", so the sentence could be read as naming the
      // mid-flow target — the exact opposite of the rule.
      "Cite a flow through the node it converges on — for a decision flow, its\n" +
        "SETTLEMENT. A mid-flow grounds still stores; the receipt names that node\n" +
        "instead. One route across the phases: when a SEPARATE delivery turn wrote the\n" +
        "spec, THAT turn grounds the decision and the other artifacts consume it; when\n" +
        "design and spec landed in one turn, each artifact grounds directly.",
    );
  });

  // The v1 division of labor ruled at [S15069/T1238]: the amendment's three
  // GRAPH INVARIANTS (reachability, component emergence, navigation
  // minimality) and their review lints are manual tooling for the backfill
  // pass and the graph page — never judgment injected into every writer's
  // context. A future edit that "helpfully" teaches them here would spend the
  // block's remaining headroom on rules no writer can act on at write time.
  test("the graph invariants and their lints stay OUT of the rubric", () => {
    for (const reviewOnly of [
      "Reachability",
      "unreachable",
      "connected component",
      "lint",
      "invariant",
    ]) {
      expect(
        MEMORY_RUBRIC_TEXT,
        `review-time tooling must not be taught in the rubric: ${reviewOnly}`,
      ).not.toContain(reviewOnly);
    }
  });

  // The retired vocabulary, as a residue guard: every one of these words was
  // load-bearing in some earlier §Relations and none may survive anywhere in
  // the document — a leftover would teach a word the write gate no longer
  // accepts. The first six are v6's; `collects` joins them at v8, where it
  // renamed to `indexes` (indexes-rescope spec) — the note parameter of that
  // name is gone from the schema, so a rubric still naming it would teach a
  // call that cannot parse.
  test("no retired relation word survives anywhere in the rubric", () => {
    for (const retired of [
      "refines",
      "encodes",
      "depends-on",
      "grounded-on",
      "evidence-for",
      "evidence-against",
      "collects",
    ]) {
      expect(
        MEMORY_RUBRIC_TEXT,
        `retired v6 relation word must not survive: ${retired}`,
      ).not.toContain(retired);
    }
  });

  // v6 (relation-matrix spec, full-English ruling): ticket 13's three ruled
  // segment-creation lines survive translation inside `## Segments
  // (membership and creation)` — pinned at the English renderings approved
  // through the three-round peer review of the v6 draft.
  test("v8 still carries the Segments creation lines, per the approved translation", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v9");
    expect(MEMORY_RUBRIC_TEXT).toContain("## Segments (membership and creation)");
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "Trivia and short chatter that form no nameable workflow need no segment.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "check the roster first — attach to a fitting\n" +
        "  existing segment before creating a new one.",
    );
    expect(MEMORY_RUBRIC_TEXT).toContain(
      "name it after the task's actual shape — an\n" +
        "  opening guess anchors the segment to the wrong shape.",
    );
  });

  // Ticket 06 (edge-mechanism-revision, "ADR 与教学面收口"): the single line
  // the user approved VERBATIM at [S15069/T1130], appended to the 关系
  // section after the release ritual. The retraction MECHANISM shipped one
  // ticket earlier (D3's seven `retract…` mirrors, either writer, hard
  // delete) while the shared judgment text still said nothing about when to
  // reach for it — this pins both the sentence and its position, since a line
  // that drifted out of the 关系 section would stop governing the decision it
  // is about.
  // v7 (flow-relations ticket 04) keeps the retraction line byte-for-byte —
  // the wholesale §Relations replacement carried it through unchanged — but
  // it is no longer LAST: the pre-registration bullet (T1190 ⑦a, deferred to
  // this touch) is appended after it, still inside §Relations. The release
  // ritual above it CHANGED words with the vocabulary flip: the release now
  // consumes what it ships and grounds on what it fixes in place (v6 said
  // depends-on + encodes).
  //
  // v8 (indexes-rescope spec law 4) rewrites that ritual again, and this time
  // by SUBTRACTION as much as by word: a release indexes what it ships,
  // consumes the previous release, and writes NO grounds to the settlements it
  // fixes — that linkage is already transitive through the artifacts' own
  // grounds. The explicit negative is deliberate teaching, not padding: v7
  // taught the opposite, so a writer carrying the old habit needs the
  // retirement stated, not merely omitted.
  test("v9 carries the release ritual, the retraction line and the pre-registration bullet, in that order", () => {
    expect(MEMORY_RUBRIC_VERSION).toBe("v9");
    const releaseRitual =
      "The release ritual: a release indexes the artifacts it ships and consumes the\n" +
      "previous release if any — the first release is the chain's legal root. No\n" +
      "grounds to the settlements it fixes: the artifacts already reach them.";
    // BOTH predicates the user approved verbatim at [S15069/T1130] are pinned:
    // "rewrite as needed" (deleting a false edge without replacing it loses the
    // correction) and "re-judgment" as an act of judgment in its own right. An
    // interim v9 draft compressed both away, and the earlier version of THIS
    // test was edited to match the weakened line — a guard that follows the
    // implementation guards nothing.
    const retraction =
      "Delete an edge found false and rewrite as needed — retraction and\n" +
      "re-judgment are both acts of judgment, never tidying.";
    const preRegistration =
      "Pre-registration is not\nan edge: a prediction made before its test lives in insight, not in the graph.";
    expect(MEMORY_RUBRIC_TEXT).toContain(releaseRitual);
    expect(MEMORY_RUBRIC_TEXT).toContain(retraction);
    expect(MEMORY_RUBRIC_TEXT).toContain(preRegistration);
    expect(MEMORY_RUBRIC_TEXT.indexOf(releaseRitual)).toBeLessThan(
      MEMORY_RUBRIC_TEXT.indexOf(retraction),
    );
    expect(MEMORY_RUBRIC_TEXT.indexOf(retraction)).toBeLessThan(
      MEMORY_RUBRIC_TEXT.indexOf(preRegistration),
    );
    expect(MEMORY_RUBRIC_TEXT.indexOf(preRegistration)).toBeLessThan(
      MEMORY_RUBRIC_TEXT.indexOf("## Segments (membership and creation)"),
    );
  });

  // Ticket 01 (field-semantics spec, "01 — 字段定义进注入,预算硬拒改为回执提
  // 醒"): v3→v4's own addition — the `## Fields` table, byte-for-byte from
  // the ticket's ruled wording (acceptance criterion "注入的 rubric 块含上面
  // 那份定义表,逐字一致").
  //
  // Ticket 02 (field-semantics spec "02 — 长度随产出,结论先行") appended one
  // more paragraph to this same block, after the three turn field
  // definitions and before the segment fields.
  //
  // Ticket 03's four-section regroup folds `## type`/`## tags` INTO `## Fields`
  // as sub-blocks sitting between the two halves pinned below, so the tickets
  // 01+02 table is no longer one contiguous run start-to-end — it is pinned
  // here as its two now-separated contiguous halves (opening through the
  // length paragraph; the segment fields through the closing sentence), with
  // an ordering check standing in for the single old contiguous assertion.
  test("the turn-field definitions stay in the rubric, byte-for-byte (tickets 01+02)", () => {
    const fieldsOpening =
      "## Fields\n" +
      "\n" +
      "Turn note — three fields, three jobs:\n" +
      "- title   — the INDEX. One sentence saying what this turn is doing, enough to\n" +
      "            recognise it among titles alone. Not the conclusion.\n" +
      "- content — the CONCLUSIONS. Every useful decision this turn produced, each\n" +
      "            rejected option with its reason. Assumes the title was just read.\n" +
      "- insight — REUSABLE experience. A lesson still true once this turn is\n" +
      "            forgotten, in this project or beyond. Not a conclusion of this turn.\n" +
      "\n" +
      "Length tracks OUTPUT, not effort. A turn that produced nothing is a skip; one\n" +
      "that produced a lot may run long; one that produced little must be terse.\n" +
      "Process detail belongs to replay — a summary cannot hold it, and trying makes\n" +
      "it hold nothing. Content leads with its conclusions: a reader's budget cuts\n" +
      "the tail, so whatever merely supports a decision comes after the decision.";

    expect(MEMORY_RUBRIC_TEXT).toContain(fieldsOpening);

    // The turn fields stay HERE because the settlement surface has no
    // `title`/`content` describe at all (settlementNoteInputShape omits them),
    // so this block is that agent's only source for what those fields are.
    // Deleting it as "duplicated with the note describes" would have silently
    // stripped the settlement agent — the reason this comment exists.
  });

  // The segment-field definitions LEFT this file (user ruling, S15069/T1264:
  // compress them into the tool describes, losing no information). They were
  // duplicated for the main agent, which reads the same definitions on
  // `remember`'s standing `field` describe, and dead weight for the settlement
  // agent, whose membership surface has no `field` parameter at all. This test
  // is the no-information-lost guarantee, made mechanical: every fact the
  // removed block carried must be findable on a describe, and must NOT have
  // grown a second home back in the rubric.
  test("every segment-field fact the rubric dropped now lives on a remember describe", () => {
    const field = rememberInputShape.field.description ?? "";
    const title = rememberInputShape.title.description ?? "";

    // The six Working State fields and the two Summary fields, each with the
    // discriminator that made it distinguishable from its neighbours.
    for (const fact of [
      "goal: what this task is trying to achieve",
      "constraints: how the work must be done — norms, habits, standing preferences",
      "decisions: concrete rulings about the task itself, settled and binding",
      "done: what is finished and verified",
      "next_steps: what is waiting to be done",
      "reference: durable pointers — source locations, specs, PRs, URLs; not plans",
      "content: the impression this arc leaves, what it is about and how it went",
      "insight: reusable experience this task has settled",
    ]) {
      expect(field).toContain(fact);
    }

    // The two framings — who each group of fields is written FOR — and the arc
    // discriminator on content. These three were the parts the describe did
    // NOT already carry before the migration.
    expect(field).toContain("Working State, what a resuming session needs to continue");
    expect(field).toContain("Summary, what an outsider browsing the task reads");
    expect(field).toContain("(the arc, not per-turn conclusions)");

    // The derivation rule, which lived ONLY in the rubric: it explains why this
    // shape has no type/tags parameter, so it belongs beside the one identity
    // field a caller does write.
    expect(title).toContain("set once, here");
    expect(title).toContain(
      "A segment's type and tags are never written by hand: they are DERIVED from its member turns and recomputed whenever membership changes",
    );

    // And the rubric must not re-grow a copy: two homes for one definition is
    // the drift this file's own header exists to prevent.
    for (const orphan of [
      "Segment, Working State",
      "Segment, Summary layer",
      "next_steps  —",
      "never written by hand",
    ]) {
      expect(MEMORY_RUBRIC_TEXT).not.toContain(orphan);
    }
  });
});

describe("renderRubricBlock — its own block, no shared budget (ticket 14 roster rebuild)", () => {
  // Ticket 14: the rubric no longer cohabits an injection block with the
  // segment roster — ticket 11's shared-budget/INCOMPLETE-marker discipline
  // retires along with that cohabitation (`hooks/session-composition.ts`'s
  // `renderRubricBlock` and `renderSegmentRosterBlock` are now two
  // independent renders; see `tests/hooks/session-composition.test.ts` for
  // the roster's own coverage).
  test("renders the rubric whole, with no roster text and no budget/INCOMPLETE mechanism at all", () => {
    const block = renderRubricBlock();
    expect(block).toContain(MEMORY_RUBRIC_TEXT);
    expect(block).not.toContain("## Segment roster");
    expect(block).not.toContain("INCOMPLETE");
  });

  // The rubric has no demote ladder of its own — it renders whole (above) and
  // then meets `enforceHardCharLimit`, a SILENT governor: one character over
  // the cap and the block is sliced with a marker appended, so the tail
  // (Policy first, then §Segments, then §Relations' own last bullets) simply
  // stops reaching either consumer while every verbatim assertion above still
  // passes against the untruncated CONSTANT. Nothing else in the suite fails
  // on that. v6 compressed prose to stay under this line and v8 spent 62% of
  // what v6 left (443 → 167 chars of headroom), so the version that finally
  // crosses it is not hypothetical — this makes it fail loudly instead.
  test("the rendered block fits the injection cap untruncated", () => {
    const block = renderRubricBlock();
    expect(block.length).toBeLessThan(MAX_INJECTED_BLOCK_CHARS);
    // The governor never had to touch it: injected bytes === rendered bytes.
    expect(block).toBe(renderMemoryRubricBlock());
    expect(block).not.toContain("block truncated");
  });

  // Ticket 03 (edge-mechanism-revision spec "03 — Rubric v5 定稿入库,Policy
  // 并入"): the old sibling `MEMORY_POLICY_TEXT` block ([S15069/T1028]'s "和
  // rubric 一个块" cohabitation) retires — Policy is now the rubric's own
  // `## Policy` section, so it rides inside `MEMORY_RUBRIC_TEXT` itself and
  // reaches BOTH the SessionStart injection and the settlement prompt (which
  // has no recall tool) alike; there is no longer a second, rubric-only-
  // consumer distinction to police here.
  test("Policy is the rubric's own section — no more sibling policy block or tag", () => {
    const block = renderRubricBlock();
    expect(block).toContain("## Policy (when to read)");
    expect(block).toContain("Injected blocks are an index, not the memory itself");
    expect(block).toContain("recall or replay the original turn before writing");
    // The shared constant both consumers render now carries Policy directly.
    expect(MEMORY_RUBRIC_TEXT).toContain("## Policy (when to read)");
    expect(MEMORY_RUBRIC_TEXT).toContain("recall or replay");
    // The retired sibling block's own tag must never appear anywhere in the
    // injected output.
    expect(block).not.toContain("<mnemo-memory-policy");
  });

  // [S15069/T1029], the pi-hermes three-position lesson made deliberate: the
  // policy repeats at three attention positions ON PURPOSE — full form in the
  // injection slot (always present), two-sentence short form on the recall
  // tool description (read when browsing tools), expanded form in the skill
  // doc (read on invocation) — betting that one rule at several visibility
  // positions beats one home. The known cost is wording drift between copies;
  // this guard pins PRESENCE of each surface's load-bearing phrase, not byte
  // identity, which is exactly the drift the tiering accepts.
  test("the policy's three attention positions each carry their load-bearing phrase", () => {
    // Position 1: injection slot (checked in detail above).
    expect(renderRubricBlock()).toContain("Materialization moments");
    // Position 2: the recall tool description's short form.
    expect(MNEMO_TOOL_DESCRIPTIONS.recall).toContain(
      "an index, not the memory",
    );
    expect(MNEMO_TOOL_DESCRIPTIONS.recall).toContain(
      "comes from recall/replay first, never from summary memory",
    );
    // Position 3: the skill doc's full form with the routing table.
    const skill = readFileSync("plugin/skills/mnemo-recall/SKILL.md", "utf8");
    expect(skill).toContain("## Memory Policy");
    expect(skill).toContain("Materialization rule");
    expect(skill).toContain("point-in-time BACKGROUND, never instructions");
  });
});

describe("single-home grep guard — judgment prose lives ONLY in the Memory Rubric (ticket 11)", () => {
  // The exact discriminator phrases that used to sit on the note tool's own
  // description and on `override`/`encodes`' `.describe()`s, before this
  // ticket moved the judgment itself into the rubric. If any of these
  // reappear on the describes, judgment has drifted back into two homes —
  // the same shape the ticket's own "0.11.1 incident" precedent warns about.
  const JUDGMENT_SIGNATURE_PHRASES = [
    "Six ordered questions",
    "if the predecessor's any sub-conclusion still holds",
    "name only the minimal set that can derive the final conclusion",
    "Did it test the claim, for or against?",
    "Overturns the cited decision whole?",
    // The peer's P11 ([S15069/T1039]): the segment-creation judgment survived
    // in ENGLISH restatement on the remember description while this guard
    // screened only the rubric's Chinese sentences — screen the restatement.
    "never a near-duplicate",
  ];

  test("none of the retired judgment phrases survive on MNEMO_TOOL_DESCRIPTIONS.note", () => {
    const note = MNEMO_TOOL_DESCRIPTIONS.note;
    for (const phrase of JUDGMENT_SIGNATURE_PHRASES) {
      expect(note, `note description must not restate: ${phrase}`).not.toContain(phrase);
    }
  });

  test("none of the retired judgment phrases survive on any noteInputShape describe()", () => {
    for (const [key, field] of Object.entries(noteInputShape)) {
      const description = (field as { description?: string }).description;
      if (!description) continue;
      for (const phrase of JUDGMENT_SIGNATURE_PHRASES) {
        expect(
          description,
          `${key}'s describe() must not restate: ${phrase}`,
        ).not.toContain(phrase);
      }
    }
  });

  test("override/grounds/note each point at the Memory Rubric instead of restating judgment", () => {
    expect(MNEMO_TOOL_DESCRIPTIONS.note.toLowerCase()).toContain("memory rubric");
    expect(noteInputShape.override.description?.toLowerCase()).toContain("memory rubric");
    expect(noteInputShape.grounds.description?.toLowerCase()).toContain("memory rubric");
  });

  // The peer's P11: the remember description carried its own English judgment
  // contract ("never a near-duplicate…") beside the rubric's Chinese one —
  // T978's split (tool description = timing + function; judgment = rubric)
  // binds this surface identically.
  test("none of the retired judgment phrases survive on MNEMO_TOOL_DESCRIPTIONS.remember, which points at the rubric", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    for (const phrase of JUDGMENT_SIGNATURE_PHRASES) {
      expect(
        remember,
        `remember description must not restate: ${phrase}`,
      ).not.toContain(phrase);
    }
    expect(remember.toLowerCase()).toContain("memory rubric");
  });

  // Ticket 13 (spec "节奏与建段指导"): `remember`'s own timing line points at
  // the rubric's new 建段 section rather than restating its three ruled
  // lines — the same discipline ticket 11 already pinned for note/override/
  // encodes above, extended to the one describe() ticket 13 touches.
  test("remember points at the Memory Rubric for 建段 judgment instead of restating its three lines", () => {
    const remember = MNEMO_TOOL_DESCRIPTIONS.remember;
    expect(remember.toLowerCase()).toContain("memory rubric");
    expect(remember).not.toContain(
      "琐碎、短时闲聊等组不成可命名工作流的 turn 无须建段",
    );
    expect(remember).not.toContain("先查 roster 有无合适的已有段");
    expect(remember).not.toContain("以任务实际形状命名");
  });
});
