import { describe, expect, test } from "bun:test";

import type { LaneCheckerResult } from "../../src/shared/lane-checker";
import {
  buildLaneAnchorAddresses,
  LANE_CHECK_DEFAULT_PAGE_BUDGET,
  projectLaneCheckerResultByScope,
  renderLaneCheckerReports,
  renderLaneCheckerReportsPaged,
  renderLaneDigraph,
} from "../../src/shared/lane-checker-render";
import { DEFAULT_SEGMENT } from "../../src/shared/lane-interpretation";
import { WORKER_TOOL_RESULT_MAX_CHARS } from "../../src/mcp/handlers";
import { buildLargeLaneCheckerFixture, buildScopeFixture } from "../support/lane-checker-render-fixture";

/**
 * The lane checker's two renderers (rubric-v10 ticket 06), tested as PURE
 * functions of `LaneCheckerResult` -- no DB, no `checkLanes` call anywhere
 * in this file. That absence is itself the point (requirement 4/5): if
 * these functions needed the core to run to produce sensible output, this
 * file could not exist in this shape. Several fixtures below hand-build a
 * result that is semantically NONSENSE (a terminus that is not a member, a
 * severed component the stats report never mentions) specifically to prove
 * the renderer prints exactly what it is given and derives nothing of its
 * own -- a renderer that "fixed up" or cross-checked the input before
 * printing it would fail these.
 */

const LANE_KEY = { segment: "42", tag: "ownership" };

// semantic-conformance ticket 02 — every hand-built `LaneCheckerResult`
// fixture in this file needs this field now that the renderer reads it
// unconditionally; the clean (no-violation) shape is reused everywhere a
// fixture has nothing to say about vocabulary conformance.
const EMPTY_VOCABULARY_CONFORMANCE: LaneCheckerResult["vocabularyConformance"] = {
  typeViolations: { count: 0, entries: [] },
  outOfVocabularyEdges: { count: 0, entries: [] },
};

// lane-declaration ticket 09 (D9) — the "nothing to report" shape of the two
// attribution warnings, spread into every hand-built fixture that has nothing
// to say about attribution (the same role EMPTY_VOCABULARY_CONFORMANCE plays
// above).
const NO_ATTRIBUTION_WARNINGS = {
  unattributedClusters: { count: 0, entries: [] },
  laneProliferation: [],
  // lane-state-retirement ticket 01 adds a third attribution warning, read
  // unconditionally by both renders — same role as the two above.
} satisfies Pick<
  LaneCheckerResult,
  "unattributedClusters" | "laneProliferation"
>;


function emptyResult(): LaneCheckerResult {
  return {
    lanes: [],
    components: [],
    coupling: [],
    bypassCandidates: [],
    timeOrderViolations: [],
    warnings: [],
    vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
    ...NO_ATTRIBUTION_WARNINGS,
    errors: [],
  };
}

describe("renderLaneCheckerReports -- compact numeric prose, no digraph", () => {
  test("an empty result renders all four report headings with an explicit empty marker", () => {
    const text = renderLaneCheckerReports(emptyResult());

    expect(text).toContain("Report 1");
    expect(text).toContain("Report 2");
    expect(text).toContain("Report 3");
    expect(text).toContain("Report 4");
    expect(text).not.toContain("●");
    expect(text).not.toContain("◎");
    expect(text).not.toContain("✕");
    // No digraph glyph vocabulary at all -- this function never renders one.
    expect(text.toLowerCase()).not.toContain("digraph");
  });

  test("report 1 prints exactly the fields the typed result carries, nothing derived", () => {
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: LANE_KEY,
          phases: ["decision"],
          members: [
            { id: 1 },
            { id: 2 },
          ],
          edgeCountsByRelation: { extends: 1, indexes: 1 },
          coverage: { status: "partial", missingTurnIds: [7] },
        },
      ],
      components: [],
      coupling: [],
      bypassCandidates: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const text = renderLaneCheckerReports(result);

    expect(text).toContain("E42:{ownership}");
    expect(text).toContain("1, 2");
    expect(text).toContain("extends=1");
    expect(text).toContain("indexes=1");
    // THE DECLARATION LINE IS GONE (lane-state-retirement ticket 01). It
    // printed a closure verdict plus the single terminus that verdict read;
    // both concepts left the model, so the line went whole rather than losing
    // one of its two halves.
    expect(text).not.toContain("declaration:");
    expect(text).not.toContain("terminus");
    expect(text).not.toContain("last event");
    // THE `cited from outside:` LINE IS GONE with the three buckets it read
    // (main-agent-edges spec D2) — `depends[]` / `used[]` / `testimony[]` were
    // one bucket per retired relation word.
    expect(text).not.toContain("cited from outside");
    expect(text).toContain("partial");
    // floor-and-render-fidelity ticket 03: EVERY turn id this file prints
    // routes through the same formatter, coverage's missing-id list included
    // — no addresses supplied here, so it keeps the bare `T<dbid>` form.
    expect(text).toContain("missing: T7");
  });

  // lane-state-retirement ticket 01: report 1 used to end on a state line —
  // "declaration: closed (terminus T31)" / "declaration: open". Both halves of
  // it are deleted, so the assertion inverts: whatever lanes are handed in,
  // NO line about closure, openness or a terminus is printed for any of them.
  // The four lanes below are the four INPUT shapes the old line distinguished,
  // kept so a re-derivation of any one of them has something to fail on.
  test("report 1 prints NO state line for any lane — closure and terminus both gone", () => {
    const base: LaneCheckerResult["lanes"][number] = {
      key: { segment: "1", tag: "cv" },
      phases: [],
      members: [{ id: 31 }],
      edgeCountsByRelation: { indexes: 1 },
      coverage: { status: "whole", missingTurnIds: [] },
    };
    const result: LaneCheckerResult = {
      ...emptyResult(),
      lanes: [
        base,
        { ...base, key: { segment: "1", tag: "ci" } },
        { ...base, key: { segment: "1", tag: "ow" } },
        { ...base, key: { segment: "1", tag: "on" } },
      ],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("E1:{cv}");
    expect(text).not.toContain("declaration:");
    expect(text).not.toContain("closed");
    expect(text).not.toContain("closed-");
    expect(text).not.toContain("last declarer");
    expect(text).not.toContain("terminus");
    expect(text).not.toContain("last event");
  });

  test("the default-segment sentinel renders as 'default', never the raw sentinel bytes", () => {
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: { segment: DEFAULT_SEGMENT, tag: "homeless-lane" },
          phases: [],
          members: [],
          edgeCountsByRelation: {},
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      coupling: [],
      bypassCandidates: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("default:{homeless-lane}");
    expect(text).not.toContain(DEFAULT_SEGMENT);
  });

  test("report 2 flags a multi-component lane SEVERED — islands and nothing else", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      components: [
        {
          key: LANE_KEY,
          componentCount: 2,
          islands: [
            { representative: 1, memberIds: [1] },
            { representative: 3, memberIds: [3] },
          ],
        },
      ],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("components: 2 (SEVERED)");
    // floor-and-render-fidelity ticket 03: an island's representative and
    // member ids are turn references too, not exempt from the address
    // formatter just because the old render left them bare.
    expect(text).toContain("island@T1: T1");
    expect(text).toContain("island@T3: T3");
    // lane-state-retirement ticket 01: report 2 used to end on a
    // closed-terminus citedness line ("terminus T3 cited from outside: T8,T9",
    // or "is NOT cited from outside the lane"). It asked about a lane's single
    // terminus and only for a CLOSED lane; neither concept exists, so the line
    // is gone in BOTH its directions rather than narrowed to one.
    expect(text).not.toContain("terminus");
    expect(text).not.toContain("cited from outside the lane");
  });

  test("report 3 prints one line per lane, naming each group's own relation words beside its count", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      coupling: [
        {
          key: LANE_KEY,
          groups: [
            { relations: ["verify", "correct(full)", "correct(partial)", "use"], count: 2 },
            { relations: ["use"], count: 0 },
            { relations: ["use"], count: 5 },
          ],
        },
      ],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("## Report 3 -- cross-lane coupling (counts only; no threshold and no verdict)");
    expect(text).toContain(
      "Lane E42:{ownership} - cross-lane edges: verify/correct(full)/correct(partial)/use=2  use=0  use=5",
    );
    // NO verdict word anywhere on the line — the ticket forbids inventing a
    // threshold, and a rendered adjective would be one.
    for (const verdict of ["high", "low", "too many", "few", "ok", "healthy"]) {
      expect(text.slice(text.indexOf("## Report 3"), text.indexOf("## Report 4b")).toLowerCase())
        .not.toContain(verdict);
    }
  });

  test("report 4b prints the direct edge AND the alternative route, and marks neither", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      bypassCandidates: [
        {
          segment: "42",
          citingId: 7,
          citedId: 2,
          relations: ["use"],
          alternativePath: [7, 5, 2],
        },
      ],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("Report 4b");
    expect(text).toContain("1 candidate(s)");
    expect(text).toContain("  T7 -> T2 (use) -- also joined by T7 -> T5 -> T2");
  });

  test("report 4b caps its list for display and states the TRUE total", () => {
    const many: LaneCheckerResult["bypassCandidates"] = Array.from({ length: 25 }, (_, index) => ({
      segment: "42",
      citingId: 100 + index,
      citedId: 1,
      relations: ["use"],
      alternativePath: [100 + index, 50, 1],
    }));
    const text = renderLaneCheckerReports({ ...emptyResult(), bypassCandidates: many });
    expect(text).toContain("25 candidate(s) (showing first 20)");
    expect(text).toContain("T119 -> T1");
    expect(text).not.toContain("T120 -> T1");
  });

  test("reports 3 and 4b print explicit empty markers when there is nothing to show", () => {
    const text = renderLaneCheckerReports(emptyResult());
    const report3 = text.slice(text.indexOf("## Report 3"), text.indexOf("## Report 4b"));
    expect(report3).toContain("(no lanes in scope)");
    const report4b = text.slice(text.indexOf("## Report 4b"), text.indexOf("## Report 4c"));
    expect(report4b).toContain("(none)");
  });

  test("report 4c lists a time-order violation verbatim (citing, cited, relation, tags)", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      timeOrderViolations: [{ citingId: 3, citedId: 9, relation: "use", tags: ["ownership"] }],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("Report 4c");
    expect(text).toContain("T3 -> T9 (use {ownership})");
  });

  test("report 4c prints an explicit empty marker when there are no violations", () => {
    const text = renderLaneCheckerReports(emptyResult());
    expect(text).toContain("## Report 4c -- time-order violations (the DAG guarantee)");
    const lines = text.split("\n");
    const headingIndex = lines.findIndex((line) => line.includes("Report 4c"));
    expect(lines[headingIndex + 1]).toBe("(none)");
  });

  test("cross-task warnings render under a ⚠ line with a leading count, and an empty set says so explicitly", () => {
    const withWarnings: LaneCheckerResult = {
      ...emptyResult(),
      warnings: [{ citingId: 2, citedId: 1, tagSet: ["x"], citingSegment: "B", citedSegment: "A" }],
    };
    const text = renderLaneCheckerReports(withWarnings);
    expect(text).toContain("## Stock warnings -- rows that take part in no report");
    expect(text).toContain("1 cross-task tagged edge(s):");
    expect(text).toContain("⚠ T2(B) -> T1(A) {x}");

    const withoutWarnings = renderLaneCheckerReports(emptyResult());
    expect(withoutWarnings).toContain("## Stock warnings -- rows that take part in no report");
    expect(withoutWarnings).toContain("(no cross-task tagged edges)");
  });

  /**
   * V12 TICKET 11: the EDGE half of `vocabularyConformance` prints HERE, on the
   * warning side, rather than as error class E2. No write path can create such
   * a row, so the only database holding one is a pre-migration file a
   * hard-`readonly` reader opened — and since `partitionEdgesByVocabulary`
   * keeps those rows out of every graph, saying nothing would leave that reader
   * with a silently under-reported scope.
   */
  test("an out-of-vocabulary relation prints as a stock WARNING, never in the ERRORS block", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      vocabularyConformance: {
        typeViolations: { count: 0, entries: [] },
        outOfVocabularyEdges: {
          count: 2,
          entries: [
            { citingId: 20, citedId: 19, relation: "supersedes" },
            { citingId: 22, citedId: 21, relation: "refutes" },
          ],
        },
      },
    };
    const text = renderLaneCheckerReports(result);
    expect(text).toContain(
      "2 edge(s) whose relation is outside the seven-word vocabulary -- pre-migration stock, admitted to no graph:",
    );
    expect(text).toContain("  T20 --supersedes--> T19");
    expect(text).toContain("  T22 --refutes--> T21");
    // It is BELOW the split, and no error class names it.
    expect(text.indexOf("## WARNINGS")).toBeLessThan(text.indexOf("supersedes"));
    expect(text).not.toContain("[E2]");
    expect(renderLaneCheckerReports(emptyResult())).toContain("(no out-of-vocabulary relations)");
  });

  // tag-mandate ticket 03 — printed exactly what the typed result carries,
  // same "no derivation" discipline every other block in this file proves: a
  // nonsense-but-legal `LaneCheckerResult` still renders faithfully.
  test("the ERRORS block prints one line per instance, each leading with its class and its ANCHOR turn", () => {
    const withErrors: LaneCheckerResult = {
      ...emptyResult(),
      errors: [
        { class: "E3", anchorId: 10, id: 10, types: [], outsideVocabulary: [] },
        { class: "E3", anchorId: 11, id: 11, types: ["bugfix"], outsideVocabulary: ["bugfix"] },
        {
          class: "E4",
          anchorId: 31,
          citingId: 31,
          citedId: 30,
          relation: "correct(partial)",
          tags: ["a", "b"],
          missing: [
            { tag: "b", endpoint: "cited" },
            { tag: "b", endpoint: "citing" },
          ],
        },
      ],
    };
    const text = renderLaneCheckerReports(withErrors);
    expect(text).toContain(
      "## ERRORS -- states the grammar forbids that THIS run can repair; commit refuses while one remains",
    );
    expect(text).toContain("3 error(s)");
    expect(text).toContain("[E3] anchor T10 -- T10 type: [] (empty)");
    expect(text).toContain("[E3] anchor T11 -- T11 type: [bugfix] (outside vocabulary: bugfix)");
    expect(text).toContain(
      '[E4] anchor T31 -- T31 --correct(partial)--> T30 {a,b}: "b" is not among the cited turn\'s own lanes; ' +
        '"b" is not among the citing turn\'s own lanes',
    );
    // The errors block LEADS: a reader (and the commit-gate-facing agent)
    // must not have to scroll past the aspirational reports to find must-fix.
    expect(text.indexOf("## ERRORS")).toBe(0);
    expect(text.indexOf("## ERRORS")).toBeLessThan(text.indexOf("## WARNINGS"));
    expect(text.indexOf("## WARNINGS")).toBeLessThan(text.indexOf("## Report 1"));
  });

  // MAIN-AGENT-EDGES TICKET 14b (E6 warning closure, user ruling
  // S15069/T2465-T2466): E6, an AMBIGUOUS side, is a WARNING class and
  // renders under the WARNINGS header, never inside the ERRORS block E3/E4
  // occupy — it reuses that existing block rather than a third one.
  test("an E6 draft edge renders under WARNINGS, naming the missing side, and the ERRORS block stays empty", () => {
    const withDrafts: LaneCheckerResult = {
      ...emptyResult(),
      errors: [
        {
          class: "E6",
          anchorId: 41,
          citingId: 41,
          citedId: 40,
          relation: "use",
          tags: [],
          unsettledSides: ["tail", "head"],
        },
        {
          class: "E6",
          anchorId: 43,
          citingId: 43,
          citedId: 42,
          relation: "use",
          tags: ["ownership"],
          unsettledSides: ["head"],
        },
        {
          class: "E6",
          anchorId: 45,
          citingId: 45,
          citedId: 44,
          relation: "use",
          tags: ["ownership"],
          unsettledSides: ["tail"],
        },
      ],
    };
    const text = renderLaneCheckerReports(withDrafts);
    // The ERRORS block is empty — no E6 counted as an error, and no third
    // block was added.
    const errorsBlock = text.slice(text.indexOf("## ERRORS"), text.indexOf("## WARNINGS"));
    expect(errorsBlock).toContain("(none)");
    expect(errorsBlock).not.toContain("[E6]");
    expect(text).toContain("3 ambiguous side(s) (E6)");
    expect(text).toContain(
      "  [E6] anchor T41 -- T41 --use--> T40: AMBIGUOUS side -- neither endpoint answers which lane",
    );
    // The HALF-settled shapes name the open side AND the lane the other side
    // already holds, which is usually the repair value.
    expect(text).toContain(
      "  [E6] anchor T43 -- T43 --use--> T42: AMBIGUOUS side -- the head endpoint sits in several lanes (the tail side is {ownership})",
    );
    expect(text).toContain(
      "  [E6] anchor T45 -- T45 --use--> T44: AMBIGUOUS side -- the tail endpoint sits in several lanes (the head side is {ownership})",
    );
    // Rank: every E6 line sits AT OR BELOW the WARNINGS split, never above it.
    expect(text.indexOf("[E6]")).toBeGreaterThan(text.indexOf("## WARNINGS"));
  });

  // Requirement 6's render half: a both-sides-empty edge is reported by BOTH
  // the ERRORS block (per row) and the attribution warning (as a cluster), so
  // the section heading must say why rather than leave a reader counting the
  // same edge twice and suspecting a bug.
  test("the attribution heading says the cluster's edges are ALSO listed as E6", () => {
    const text = renderLaneCheckerReports(emptyResult());
    const heading = text.split("\n").find((line) => line.startsWith("## Attribution"))!;
    expect(heading).toContain("ALSO listed one by one as E6");
    expect(heading).toContain("blocks commit");
  });

  // lane-model-v12 ticket 04 deleted E5 (the lane-shape class) outright, and
  // with it the two render tests that lived here — the one pinning its
  // three-part line (which lane, which end, which canonical node) and the one
  // pinning the T1466 clause naming the edge a non-node anchor owns.

  /**
   * PEER ROUND T1466, FINDING P2-8 — the settlement surface is UNCAPPED.
   * `lane_check` and the commit gate read the same `result.errors`; a 50-entry
   * display cap here meant a window with 51+ instances was told about 50,
   * repaired those, and was refused again over a remainder it had never been
   * shown. The CLI digraph keeps its cap (its reader can re-run the check,
   * and its output is a picture, not a work list).
   */
  test("the settlement prose prints EVERY error instance — no cap, and no 'showing first' suffix", () => {
    const many: LaneCheckerResult["errors"] = Array.from({ length: 60 }, (_, index) => ({
      class: "E3" as const,
      anchorId: index + 1,
      id: index + 1,
      types: [],
      outsideVocabulary: [],
    }));
    const text = renderLaneCheckerReports({ ...emptyResult(), errors: many });
    expect(text).toContain("60 error(s)");
    expect(text).not.toContain("showing first");
    expect(text).toContain("[E3] anchor T50 --");
    expect(text).toContain("[E3] anchor T51 --");
    expect(text).toContain("[E3] anchor T60 --");
    // Every instance, counted rather than sampled: one line per error.
    expect(text.split("\n").filter((line) => line.startsWith("  [E3] anchor")).length).toBe(60);
  });

  /**
   * FLOOR-AND-RENDER-FIDELITY TICKET 03 (user ruling S15069/T1482) — EVERY
   * turn id this file prints is spelled for whoever is reading, not just the
   * error ANCHOR (tag-mandate ticket 06's own narrower scope): the edge
   * endpoint on an E2 line, an E4 line's own two endpoints, every count list
   * — all route through the same `formatTurnRef`. The settlement tool, the
   * CLI, and the console all now build and pass this map from the SAME
   * projection they just loaded (`buildLaneAnchorAddresses`); a caller that
   * omits it (a hand fixture, or a turn genuinely outside the projection)
   * keeps the bare `T<dbid>` form as a marked last resort, never silently.
   *
   * The addresses come off `LaneTurnInput.order` — the `[session_id,
   * prompt_number]` tuple `db/lane-checker-load.ts` already fills — so this
   * module still derives nothing and queries nothing (the file header's own
   * requirement 4).
   */
  describe("error anchors AND endpoints print as addresses when the caller supplies the projection's turns", () => {
    // The second instance was an E5 (deleted by lane-model-v12 ticket 04);
    // an E4 replaces it and exercises the same property — a line with TWO
    // ids, one resolvable and one not.
    const errors: LaneCheckerResult["errors"] = [
      {
        class: "E4",
        anchorId: 5,
        citingId: 5,
        citedId: 4,
        relation: "use",
        tags: ["z"],
        missing: [{ tag: "z", endpoint: "cited" }],
      },
      {
        class: "E4",
        anchorId: 7,
        citingId: 7,
        citedId: 9,
        relation: "correct(partial)",
        tags: ["a"],
        missing: [{ tag: "a", endpoint: "cited" }],
      },
    ];

    test("addresses replace every resolvable id on the line, in the anchor position and the endpoints alike", () => {
      const addresses = buildLaneAnchorAddresses([
        { id: 5, type: ["design"], order: [15069, 332] },
        { id: 7, type: ["design"], order: [15069, 401] },
      ]);
      const text = renderLaneCheckerReports({ ...emptyResult(), errors }, addresses);

      // The first error's CITING side (id 5, in the map) resolves; its CITED
      // side (id 4, never in the map) keeps the bare fallback — proving this
      // is a per-id lookup, not a blanket string substitution.
      expect(text).toContain(
        "[E4] anchor S15069/T332 -- S15069/T332 --use--> T4 {z}:",
      );
      // The E4 line's CITING side (id 7, same as the anchor) resolves too;
      // its CITED counterpart (id 9, not in the map) stays bare.
      expect(text).toContain(
        "[E4] anchor S15069/T401 -- S15069/T401 --correct(partial)--> T9 {a}:",
      );
      // Pin: no bare `T<dbid>`-shaped reference survives for an id the map
      // actually resolved — ids 5 and 7 never appear as `T5`/`T7` anywhere.
      expect(text).not.toMatch(/\bT5\b/);
      expect(text).not.toMatch(/\bT7\b/);
    });

    test("a turn missing from the projection, and the no-addresses caller, both keep the bare id (the marked last resort)", () => {
      // Only turn 5 is known: 7 was never in the projection (a hand-built
      // fixture, or a row that vanished between load and render).
      const partial = buildLaneAnchorAddresses([{ id: 5, type: ["design"], order: [15069, 332] }]);
      const text = renderLaneCheckerReports({ ...emptyResult(), errors }, partial);
      expect(text).toContain("[E4] anchor S15069/T332 --");
      expect(text).toContain("[E4] anchor T7 --");
      expect(text).toContain("--correct(partial)--> T9");

      // A turn with no `order` contributes no entry at all.
      expect(buildLaneAnchorAddresses([{ id: 5, type: ["design"] }]).size).toBe(0);

      // And a caller that supplies NO map at all (the fallback path itself,
      // unreachable on any real settlement/CLI/console scope — those always
      // build one from the projection they loaded) is byte-identical to an
      // explicitly empty one.
      const bare = renderLaneCheckerReports({ ...emptyResult(), errors });
      expect(bare).toContain("[E4] anchor T5 --");
      expect(bare).toContain("[E4] anchor T7 --");
      expect(bare).toBe(renderLaneCheckerReports({ ...emptyResult(), errors }, new Map()));
    });
  });
});

describe("renderLaneDigraph -- CLI-only, glyphs the ticket names", () => {
  // ONE glyph, not two and not three. Ticket 04 deleted the overridden-node
  // cross (✕) with node death; lane-state-retirement ticket 01 deleted the
  // terminus target (◎) with the single per-lane terminus it marked. Every
  // member renders as the same dot.
  test("every lane member renders the ONE member glyph — no terminus target, no third glyph", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      lanes: [
        {
          key: LANE_KEY,
          phases: ["decision"],
          members: [{ id: 1 }, { id: 2 }, { id: 3 }],
          edgeCountsByRelation: {},
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
    };

    const digraph = renderLaneDigraph(result);
    const lines = digraph.split("\n");
    expect(lines.find((line) => line.includes("T1"))).toContain("●");
    expect(lines.find((line) => line.includes("T2"))).toContain("●");
    expect(lines.find((line) => line.includes("T3"))).toContain("●");
    // Both retired glyphs appear nowhere in the whole render.
    expect(digraph).not.toContain("✕");
    expect(digraph).not.toContain("◎");
  });

  // v12 ticket 11 moved the finding glyph's own source: report 4b is a
  // per-segment EDGE report now, with no lane column to mark a member from.
  // Ticket 01 removed the second of the two things a member line could carry
  // (an uncited closed terminus), so a SEVERED lane's members are the one
  // remaining report-2 finding a member glyph can state.
  test("a report-2 finding marks the member with the finding glyph — SEVERED islands, the one surviving source", () => {
    const lane: LaneCheckerResult["lanes"][number] = {
      key: LANE_KEY,
      phases: ["decision"],
      members: [{ id: 1 }, { id: 2 }],
      edgeCountsByRelation: {},
      coverage: { status: "whole", missingTurnIds: [] },
    };

    const severed = renderLaneDigraph({
      ...emptyResult(),
      lanes: [lane],
      components: [
        {
          key: LANE_KEY,
          componentCount: 2,
          islands: [
            { representative: 1, memberIds: [1] },
            { representative: 2, memberIds: [2] },
          ],
        },
      ],
    });
    expect(severed.split("\n").find((line) => line.includes("T1"))).toContain("⚠");

    // A WHOLE lane marks nobody — the uncited-terminus arm that used to flag a
    // member here is deleted, so this shape now yields no finding at all.
    const whole = renderLaneDigraph({
      ...emptyResult(),
      lanes: [lane],
      components: [
        {
          key: LANE_KEY,
          componentCount: 1,
          islands: [{ representative: 1, memberIds: [1, 2] }],
        },
      ],
    });
    expect(whole).not.toContain("⚠");
  });

  test("a member shared with another lane renders as a reference line, not a second branch column", () => {
    const otherKey = { segment: "9", tag: "b" };
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: LANE_KEY,
          phases: [],
          members: [{ id: 5 }],
          edgeCountsByRelation: {},
          coverage: { status: "whole", missingTurnIds: [] },
        },
        {
          key: otherKey,
          phases: [],
          members: [{ id: 5 }],
          edgeCountsByRelation: {},
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      coupling: [],
      bypassCandidates: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const digraph = renderLaneDigraph(result);
    expect(digraph).toContain("⇐ see T5 in another lane");
    // Still one line per member -- no second column was introduced.
    const t5Lines = digraph.split("\n").filter((line) => line.includes("T5"));
    expect(t5Lines).toHaveLength(2); // once per lane's own listing
  });

  test("no line exceeds 100 columns", () => {
    const manyMembers = Array.from({ length: 40 }, (_, index) => ({ id: index + 1 }));
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: { segment: "1234567890", tag: "a-very-long-tag-name-that-pushes-width-another-tag" },
          phases: ["decision"],
          members: manyMembers,
          edgeCountsByRelation: {},
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      coupling: [],
      bypassCandidates: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const digraph = renderLaneDigraph(result);
    for (const line of digraph.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  test("derives nothing: a lane with members and no reports renders without cross-checking anything", () => {
    // Constructed by hand to prove the renderer validates nothing about a
    // lane it is handed — no components entry, no coupling entry, no
    // attribution warning, and it still renders the members it was given.
    // (This test used to hand in an unmatched `declaration.terminus`; that
    // field is deleted with lane state, lane-state-retirement ticket 01.)
    const result: LaneCheckerResult = {
      ...emptyResult(),
      lanes: [
        {
          key: LANE_KEY,
          phases: [],
          members: [{ id: 1 }],
          edgeCountsByRelation: {},
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
    };

    expect(() => renderLaneCheckerReports(result)).not.toThrow();
    expect(() => renderLaneDigraph(result)).not.toThrow();
    const digraph = renderLaneDigraph(result);
    expect(digraph.split("\n").find((line) => line.includes("T1"))).toContain("●");
  });

  // tag-mandate ticket 03 — the digraph is the CLI's own surface, so it
  // carries the same split: an ERRORS block first, then the lane listing.
  test("the digraph leads with an ERRORS block and marks each anchored MEMBER inline", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      lanes: [
        {
          key: LANE_KEY,
          phases: [],
          members: [
            { id: 1 },
            { id: 2 },
          ],
          edgeCountsByRelation: {},
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      errors: [
        { class: "E3", anchorId: 1, id: 1, types: [], outsideVocabulary: [] },
        {
          class: "E4",
          anchorId: 1,
          citingId: 1,
          citedId: 2,
          relation: "use",
          tags: ["a"],
          missing: [{ tag: "a", endpoint: "cited" }],
        },
        // Anchored at a turn that is NO lane's member — exactly the case the
        // inline marks alone would hide, and the reason the block exists.
        { class: "E3", anchorId: 77, id: 77, types: ["legacy"], outsideVocabulary: ["legacy"] },
      ],
    };

    const digraph = renderLaneDigraph(result);
    const lines = digraph.split("\n");
    expect(lines[0]).toBe("ERRORS (3)");
    expect(digraph).toContain("[E3] anchor T77 -- T77 type: [legacy] (outside vocabulary: legacy)");
    // T1 anchors two distinct classes; both appear on its member line, and
    // the bracket keeps ✗ unmistakable for the dead-node ✕.
    expect(lines.find((line) => line.includes("● T1"))).toContain("✗[E3,E4]");
    expect(lines.find((line) => line.includes("● T2"))).not.toContain("✗");
    // T77 is not a member, so it appears ONLY in the block.
    expect(lines.filter((line) => line.includes("T77"))).toHaveLength(1);
  });

  // lane-model-v12 ticket 04 deleted E5, and ticket 11 deleted E2. The
  // inline-mark MECHANISM is unaffected and still covered by the E3/E4 cases
  // above — only the classes those tests used are gone.

  test("an error-free digraph still states the count, so an empty block is never ambiguous with a missing one", () => {
    const digraph = renderLaneDigraph(emptyResult());
    expect(digraph.split("\n")[0]).toBe("ERRORS (0)");
    expect(digraph).toContain("(no lanes in scope)");
  });

  test("error lines obey the same 100-column bound as every other digraph line", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      errors: [
        {
          class: "E4",
          anchorId: 1,
          citingId: 1,
          citedId: 2,
          relation: "use",
          tags: Array.from({ length: 20 }, (_, index) => "a-very-long-lane-tag-" + index),
          missing: Array.from({ length: 20 }, (_, index) => ({
            tag: "a-very-long-lane-tag-" + index,
            endpoint: "cited" as const,
          })),
        },
      ],
    };
    for (const line of renderLaneDigraph(result).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  /**
   * The OTHER half of finding P2-8: only the settlement prose was uncapped.
   * The digraph is CLI-only, human-read and column-truncated already, and its
   * reader can re-run the check — so it keeps the 50-entry bound and states
   * the true total beside it.
   */
  test("the digraph still caps its error list at 50 while its heading states the TRUE total", () => {
    const many: LaneCheckerResult["errors"] = Array.from({ length: 60 }, (_, index) => ({
      class: "E3" as const,
      anchorId: index + 1,
      id: index + 1,
      types: ["legacy"],
      outsideVocabulary: ["legacy"],
    }));
    const digraph = renderLaneDigraph({ ...emptyResult(), errors: many });
    expect(digraph.split("\n")[0]).toBe("ERRORS (60) (showing first 50)");
    expect(digraph).toContain("[E3] anchor T50 --");
    expect(digraph).not.toContain("[E3] anchor T51 --");
  });
});

/**
 * D9's two attribution warnings on the settlement surface (lane-declaration
 * ticket 09). `lane_check` returns exactly `renderLaneCheckerReports`, so
 * "the tool prints both" is a property of THIS function and nothing else.
 * Same posture as every other block here: the renderer derives nothing — it
 * prints the counts it is handed, including a `turnCount` deliberately larger
 * than the capped id list.
 */
describe("renderLaneCheckerReports -- D9 attribution warnings", () => {
  test("an empty result still prints the section, with an explicit empty marker for BOTH warnings", () => {
    const text = renderLaneCheckerReports(emptyResult());
    expect(text).toContain("## Attribution");
    expect(text).toContain("(no unattributed clusters)");
    expect(text).toContain("(no task over its lane budget)");
  });

  test("a cluster prints its true size and every named turn, in the reader's own address vocabulary", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      unattributedClusters: {
        count: 1,
        entries: [{ turnIds: [11, 12, 13, 14], turnCount: 4 }],
      },
    };
    const addresses = buildLaneAnchorAddresses([
      { id: 11, type: [], order: [7, 1] },
      { id: 12, type: [], order: [7, 2] },
      { id: 13, type: [], order: [7, 3] },
      { id: 14, type: [], order: [7, 4] },
    ]);
    const text = renderLaneCheckerReports(result, addresses);
    expect(text).toContain("1 unattributed cluster(s) of 4+ turns:");
    expect(text).toContain("  4 turns joined by edges with no lane on either side: S7/T1,S7/T2,S7/T3,S7/T4");
    // The row ids never reach the reader: they cannot be typed into `note`.
    expect(text).not.toContain("T11,");
  });

  test("a capped cluster says so, and the count line keeps the TRUE size", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      unattributedClusters: {
        count: 1,
        entries: [{ turnIds: [1, 2, 3, 4], turnCount: 137 }],
      },
    };
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("137 turns joined by edges with no lane on either side: T1,T2,T3,T4 (showing first 4)");
  });

  test("proliferation names BOTH numbers and the line they were judged against", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      laneProliferation: [
        { segment: "60", declaredLaneCount: 63, memberTurnCount: 400, allowance: 20 },
        { segment: "61", declaredLaneCount: 4, memberTurnCount: 25, allowance: 1.25 },
      ],
    };
    const text = renderLaneCheckerReports(result);
    expect(text).toContain("2 task(s) over the lane budget:");
    expect(text).toContain("  E60: 63 declared lanes over 400 member turns -- above max(1, 0.05 x 400) = 20");
    // A fractional allowance prints to two places rather than 1.2500000000000002.
    expect(text).toContain("  E61: 4 declared lanes over 25 member turns -- above max(1, 0.05 x 25) = 1.25");
  });

  test("ticket 14: lanes with no live member are NAMED under the count they inflated, as the removable remainder", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      laneProliferation: [
        {
          segment: "60",
          declaredLaneCount: 6,
          memberTurnCount: 100,
          allowance: 5,
          emptyLaneTags: ["ghost-a", "ghost-b"],
        },
      ],
    };
    const text = renderLaneCheckerReports(result);
    // The count itself is unchanged — every declared lane still counts — and
    // the part a reader can act on prints beneath it.
    expect(text).toContain("  E60: 6 declared lanes over 100 member turns -- above max(1, 0.05 x 100) = 5");
    expect(text).toContain("    2 of them have no live member (delete removes them): #ghost-a, #ghost-b");
  });

  test("ticket 14: a warning with no empty lanes prints exactly the one line it always did", () => {
    const withField: LaneCheckerResult = {
      ...emptyResult(),
      laneProliferation: [
        { segment: "60", declaredLaneCount: 6, memberTurnCount: 100, allowance: 5, emptyLaneTags: [] },
      ],
    };
    const withoutField: LaneCheckerResult = {
      ...emptyResult(),
      laneProliferation: [{ segment: "60", declaredLaneCount: 6, memberTurnCount: 100, allowance: 5 }],
    };
    expect(renderLaneCheckerReports(withField)).toBe(renderLaneCheckerReports(withoutField));
    expect(renderLaneCheckerReports(withField)).not.toContain("no live member");
  });

  test("both warnings sit on the WARNING side of the split, below the ERRORS block", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      unattributedClusters: { count: 1, entries: [{ turnIds: [1, 2, 3, 4], turnCount: 4 }] },
      laneProliferation: [{ segment: "60", declaredLaneCount: 6, memberTurnCount: 100, allowance: 5 }],
    };
    const text = renderLaneCheckerReports(result);
    expect(text.indexOf("## WARNINGS")).toBeLessThan(text.indexOf("## Attribution"));
    expect(text.indexOf("## ERRORS")).toBeLessThan(text.indexOf("## Attribution"));
    // And nothing about them reads as an error class.
    expect(text).toContain("## ERRORS -- states the grammar forbids");
    expect(text.slice(text.indexOf("## ERRORS"), text.indexOf("## WARNINGS"))).toContain("(none)");
  });
});

/**
 * SETTLEMENT-ERGONOMICS TICKET 05 (spec D3 items 1/2/4) —
 * `renderLaneCheckerReportsPaged`, the settlement `lane_check` tool's OWN
 * entry point. `renderLaneCheckerReports` above is untouched (still the
 * CLI's/console's uncapped, unaggregated render); everything below is about
 * the SEPARATE paged/aggregated function.
 *
 * `buildLargeLaneCheckerFixture` (`tests/support/`) is a deterministic,
 * loop-built `LaneCheckerResult` sized to reproduce the real-run failure this
 * ticket exists for: `renderLaneCheckerReports` over it is 101,220 characters
 * / 2,008 lines — already OVER `WORKER_TOOL_RESULT_MAX_CHARS` on its own,
 * same order of magnitude as the measured 128,100-character run. A
 * three-lane toy cannot exercise either property below; only volume can.
 *
 * TWO SEPARATE ASSERTIONS, never merged (ticket's own text, and the spec's
 * test-decision section): (a) pagination is alive — page 1's content, its
 * continuation metadata, and page 2's coverage of the remainder; (b) a hard
 * upper bound — the DEFAULT call's byte size is under the cap. Folded
 * together, a fixture that happens to fit its aggregated form in one page
 * would leave (b) green while pagination is entirely dead; kept apart, (a)
 * cannot pass that way because it explicitly demands a SECOND page exists and
 * covers real content.
 */
describe("renderLaneCheckerReportsPaged -- settlement paging (ticket 05)", () => {
  test("(a) pagination is alive: page 1 carries every error plus a continuation hint, and page 2 covers the remainder untruncated", () => {
    const fixture = buildLargeLaneCheckerFixture();

    const page1 = renderLaneCheckerReportsPaged(fixture, undefined);
    expect(page1.page).toBe(1);
    // Two pages at the DEFAULT budget for THIS fixture — pinned so a future
    // change to either the fixture or the default budget has to update this
    // number deliberately rather than silently going stale.
    expect(page1.pageCount).toBe(2);

    // Page 1 carries EVERY error instance -- all 250, uncapped, exactly like
    // `renderLaneCheckerReports`'s own settlement-parity guarantee -- proving
    // pagination never drops an instance the commit gate would judge.
    expect(page1.text).toContain("250 error(s)");
    expect(page1.text).toContain("[E3] anchor T80000 -- T80000 type: [] (empty)");
    // The LAST error (an E6, anchor 82049) is still on page 1 -- the whole
    // uncapped list fit in one page's budget even though later sections did
    // not.
    expect(page1.text).toContain("anchor T82049");

    // The continuation hint: how many pages remain, and the exact call for
    // the next one.
    expect(page1.text).toContain("-- page 1/2: 1 more page(s) -- call lane_check(page=2) for the next --");

    // Content that lands on page 2 is ABSENT from page 1 -- the boundary is
    // real, not just a cosmetic footer.
    expect(page1.text).not.toContain("## Stock warnings");
    expect(page1.text).not.toContain("time-order violation(s), folded");
    expect(page1.text).not.toContain("cross-task tagged edge(s), folded");

    const page2 = renderLaneCheckerReportsPaged(fixture, undefined, { page: 2 });
    expect(page2.page).toBe(2);
    expect(page2.pageCount).toBe(2);
    // The remainder: report 4b, the two FOLDED families, attribution, and the
    // out-of-vocabulary stock list all show up here, complete.
    expect(page2.text).toContain("25 candidate(s)");
    expect(page2.text).toContain("80 time-order violation(s), folded:");
    expect(page2.text).toContain("80 cross-task tagged edge(s), folded:");
    expect(page2.text).toContain("## Attribution");
    expect(page2.text).toContain(
      "30 edge(s) whose relation is outside the seven-word vocabulary -- pre-migration stock, admitted to no graph (showing first 20):",
    );
    // No error re-print on page 2 -- the uncapped list appeared exactly once.
    expect(page2.text).not.toContain("anchor T82049");
    // Last page: no "N more" hint, since there is nothing left to ask for.
    // Peer round three finding 01 (user ruling [S15069/T1778]): paging RE-RUNS
    // the check, so any page after the first says so — the denominator can
    // move between calls and a silent one is how a row never gets seen.
    expect(page2.text).toContain(
      "-- page 2/2: this was the last page (re-run; counts are as of this call) --",
    );
  });

  test("(b) hard upper bound: the DEFAULT call (no page, no pageBudget) stays under the worker tool-result cap", () => {
    const fixture = buildLargeLaneCheckerFixture();

    // Sanity check on the fixture itself: the OLD unbounded render already
    // exceeds the cap on this fixture, same order of magnitude as the
    // measured 128,100-character failure -- otherwise this test would prove
    // nothing about paging.
    expect(renderLaneCheckerReports(fixture).length).toBeGreaterThan(WORKER_TOOL_RESULT_MAX_CHARS);

    const defaultCall = renderLaneCheckerReportsPaged(fixture);
    expect(defaultCall.text.length).toBeLessThan(WORKER_TOOL_RESULT_MAX_CHARS);
    expect(defaultCall.page).toBe(1);
  });

  test("time-order violations and stock cross-task warnings fold into ONE line each -- a count plus a handful of addresses, never one line per instance", () => {
    const fixture = buildLargeLaneCheckerFixture();
    const page2 = renderLaneCheckerReportsPaged(fixture, undefined, { page: 2 });

    expect(page2.text).toContain(
      "80 time-order violation(s), folded:\n  T30000->T30001, T30001->T30002, T30002->T30003, T30003->T30004, T30004->T30005 (+75 more)",
    );
    expect(page2.text).toContain(
      "80 cross-task tagged edge(s), folded:\n  T40000(2000)->T39999(2100), T40001(2001)->T40000(2101), T40002(2002)->T40001(2102), T40003(2003)->T40002(2103), T40004(2004)->T40003(2104) (+75 more)",
    );
    // ONE line per family, not 80: the per-instance arrow format
    // `renderLaneCheckerReports` prints for these two families never appears.
    expect(page2.text).not.toContain("T30005->T30006");
    expect(page2.text.split("\n").filter((line) => /^T\d+->T\d+$/.test(line.trim()))).toHaveLength(0);
  });

  test("a small result needs no pagination: one page, no continuation footer, and the SAME content the plain renderer prints (aside from the two folded families)", () => {
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: LANE_KEY,
          phases: ["decision"],
          members: [{ id: 1 }, { id: 2 }],
          edgeCountsByRelation: { extends: 1 },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      coupling: [],
      bypassCandidates: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const paged = renderLaneCheckerReportsPaged(result);
    expect(paged.pageCount).toBe(1);
    expect(paged.text).not.toContain("-- page");
    expect(paged.text).not.toContain("more page");
    expect(paged.text).toBe(renderLaneCheckerReports(result));
  });

  test("an out-of-range page returns an empty body while still reporting the true page count -- the same no-clamping convention recall's own pageBudget pagination uses", () => {
    const fixture = buildLargeLaneCheckerFixture();
    const farPage = renderLaneCheckerReportsPaged(fixture, undefined, { page: 99 });
    expect(farPage.pageCount).toBe(2);
    expect(farPage.text).toBe("");
  });

  test("LANE_CHECK_DEFAULT_PAGE_BUDGET is exported and is what an omitted pageBudget resolves to", () => {
    const fixture = buildLargeLaneCheckerFixture();
    const implicit = renderLaneCheckerReportsPaged(fixture);
    const explicit = renderLaneCheckerReportsPaged(fixture, undefined, {
      pageBudget: LANE_CHECK_DEFAULT_PAGE_BUDGET,
    });
    expect(implicit).toEqual(explicit);
  });
});

/**
 * THE ACTIONABLE PROJECTION, at its new home (settlement-gate-taxonomy ticket
 * 03). It was `renderLaneCheckerReportsPaged`'s own first mechanism and a
 * model-facing `scope` parameter (`"actionable"` | `"all"`,
 * settlement-ergonomics ticket 06); it is now a standalone pure function the
 * EVALUATOR calls once, because the render is only ONE of the two consumers of
 * a `lane_check` result and the other one — the LANE DISPOSITION block — was
 * reading the unprojected value.
 *
 * The per-family predicate table is unchanged and is still pinned here.
 * `buildScopeFixture` (`tests/support/`) gives each DECIDABLE report family
 * exactly one in-window and one out-of-window entry, so "the projection
 * filters" is provable PER FAMILY rather than merely "something was dropped
 * somewhere" -- a fixture whose findings were all in-window would let a dead
 * filter pass unnoticed. The UNPROJECTED render is the control arm: it proves
 * each out-of-window entry really is in the fixture and really does render.
 *
 * A large `pageBudget` keeps every assertion below on a single page, so
 * "family X is absent" can only mean "the projection dropped it", never "it
 * paged away".
 */
describe("the actionable projection, per report family (settlement-gate-taxonomy ticket 03)", () => {
  /** Project, then render -- the exact order and the exact pair of calls the evaluator seam makes. */
  function renderProjected(
    result: LaneCheckerResult,
    actionableTurnIds: ReadonlySet<number>,
  ): string {
    return renderLaneCheckerReportsPaged(
      projectLaneCheckerResultByScope(result, actionableTurnIds),
      undefined,
      { pageBudget: 1_000_000 },
    ).text;
  }

  // Peer round three finding 05: the projection filtered ENTRIES and kept the
  // unfiltered COUNT, so a family with two instances and one in scope printed
  // "2 edge(s) ... showing first 1" -- which reads as an actionable item the
  // page budget withheld, not as an edge outside the scope entirely.
  test("a rescoped family's count follows its entries, so no 'showing first' suffix is invented", () => {
    const { result, actionableTurnIds } = buildScopeFixture();
    const actionable = renderProjected(result, actionableTurnIds);

    // FAMILY headers only. A cluster's own "50 turns ... (showing first 2)"
    // is a different, honest cap -- that cluster really does have 50 turns and
    // the sample inside it is bounded on purpose. What must not survive is a
    // header counting INSTANCES of a family above the number of instances the
    // scope actually kept, on a page big enough to show them all.
    const familyHeaders = actionable
      .split("\n")
      .filter((line) => /^\d+ (unattributed cluster|edge)\(s\)/.test(line));
    expect(familyHeaders.filter((line) => /\(showing first \d+\)/.test(line))).toEqual([]);
    // And the guard is not vacuous -- the fixture does render such headers.
    expect(familyHeaders.length).toBeGreaterThan(0);
  });

  test("per-family table: the projection keeps only the in-window entry; the unprojected result keeps both -- one assertion pair per DECIDABLE family", () => {
    const { result, actionableTurnIds } = buildScopeFixture();
    const actionable = renderProjected(result, actionableTurnIds);
    // The CONTROL: the same fixture rendered with no projection at all, which
    // is what the CLI/console still do and what every out-of-window assertion
    // below is measured against.
    const unprojected = renderLaneCheckerReportsPaged(result, undefined, {
      pageBudget: 1_000_000,
    }).text;

    // ANCHORED -- errors, tested by anchor.
    expect(actionable).toContain("anchor T101");
    expect(actionable).not.toContain("anchor T201");
    expect(unprojected).toContain("anchor T101");
    expect(unprojected).toContain("anchor T201");

    // AGGREGATE -- reports 1/2/3, tested by the lane's own members.
    expect(actionable).toContain("in-lane");
    expect(actionable).not.toContain("out-lane");
    expect(unprojected).toContain("in-lane");
    expect(unprojected).toContain("out-lane");

    // AGGREGATE -- report 4b, bypass candidates.
    expect(actionable).toContain("T120 -> T121");
    expect(actionable).not.toContain("T220 -> T221");
    expect(unprojected).toContain("T220 -> T221");

    // AGGREGATE, folded -- report 4c, time-order violations.
    expect(actionable).toContain("1 time-order violation(s), folded:");
    expect(actionable).not.toContain("T230->T231");
    expect(unprojected).toContain("2 time-order violation(s), folded:");
    expect(unprojected).toContain("T230->T231");

    // AGGREGATE, folded -- stock cross-task warnings.
    expect(actionable).toContain("1 cross-task tagged edge(s), folded:");
    expect(actionable).not.toContain("T240(2)");
    expect(unprojected).toContain("2 cross-task tagged edge(s), folded:");
    expect(unprojected).toContain("T240(2)");

    // AGGREGATE -- out-of-vocabulary edges (each entry is a complete fact).
    expect(actionable).toContain("T150 --supersedes--> T151");
    expect(actionable).not.toContain("T250 --supersedes--> T251");
    expect(unprojected).toContain("T250 --supersedes--> T251");

    // AGGREGATE -- unattributed clusters, the FULLY-SHOWN pair (the truncated
    // undecidable one is covered separately below).
    expect(actionable).toContain("T160,T161,T162,T163");
    expect(actionable).not.toContain("T260,T261,T262,T263");
    expect(unprojected).toContain("T260,T261,T262,T263");

    // BORROWED ANCHOR -- lane proliferation, via the reported lane's own
    // members in that segment.
    expect(actionable).toContain("E1: 5 declared lanes");
    expect(actionable).not.toContain("E2: 5 declared lanes");
    expect(unprojected).toContain("E2: 5 declared lanes");
  });

  test("the UNDECIDABLE entries (no matching reported lane at all) survive the projection -- 'cannot decide honestly' keeps rather than drops", () => {
    const { result, actionableTurnIds } = buildScopeFixture();
    const actionable = renderProjected(result, actionableTurnIds);

    // coupling: {segment:"3", tag:"orphan-coupling"} names no reported lane.
    expect(actionable).toContain("orphan-coupling");
    // laneProliferation: segment "9" has no reported lane either.
    expect(actionable).toContain("E9: 5 declared lanes");
  });

  test("a truncated unattributed cluster survives even with no window hit among the SHOWN turns -- a negative result from an incomplete sample is undecidable, not a clean miss", () => {
    const { result, actionableTurnIds } = buildScopeFixture();
    // turnIds=[300,301] is 2 of the cluster's true 50 members, none shown
    // land in the window -- the sample is too short to say "no", so it stays.
    expect(renderProjected(result, actionableTurnIds)).toContain("T300,T301");
  });

  /**
   * THE FAIL-OPEN IS GONE (ticket 03). `actionableTurnIds` used to be
   * optional, and omitting it returned the WHOLE result -- the spec's "missing
   * production provenance … falling open to whole history". The parameter is
   * required now, so the nearest thing a caller can still express is an EMPTY
   * set, and that must drop everything decidable rather than keep it. A
   * re-added `if (actionableTurnIds.size === 0) return result` short-circuit --
   * the shape a fail-open would take today -- turns this red.
   */
  test("an EMPTY actionable set projects everything decidable away, rather than falling open to the whole result", () => {
    const { result } = buildScopeFixture();
    const empty = projectLaneCheckerResultByScope(result, new Set());

    expect(empty.errors).toEqual([]);
    expect(empty.lanes).toEqual([]);
    expect(empty.components).toEqual([]);
    expect(empty.bypassCandidates).toEqual([]);
    expect(empty.timeOrderViolations).toEqual([]);
    expect(empty.warnings).toEqual([]);
    // The fixture is not empty to begin with -- so the assertions above are
    // about the projection and not about a vacuous input.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.components.length).toBeGreaterThan(0);
  });

  test("order: the projection runs BEFORE aggregation -- a dropped out-of-window instance never inflates a folded family's own count", () => {
    const { result, actionableTurnIds } = buildScopeFixture();
    const actionable = renderProjected(result, actionableTurnIds);
    // Exactly ONE instance survives the projection in each folded family.
    // Had aggregation run FIRST (the forbidden order), the fold would already
    // have merged both raw instances before the projection got a chance to
    // drop one, and a count of "1" could never appear here.
    expect(actionable).toContain("1 time-order violation(s), folded:");
    expect(actionable).toContain("1 cross-task tagged edge(s), folded:");
  });
});
