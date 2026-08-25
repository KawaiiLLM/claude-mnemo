import { describe, expect, test } from "bun:test";

import type { LaneCheckerResult } from "../../src/shared/lane-checker";
import {
  buildLaneAnchorAddresses,
  renderLaneCheckerReports,
  renderLaneDigraph,
} from "../../src/shared/lane-checker-render";
import { DEFAULT_SEGMENT } from "../../src/shared/lane-interpretation";

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
} satisfies Pick<LaneCheckerResult, "unattributedClusters" | "laneProliferation">;

function emptyResult(): LaneCheckerResult {
  return {
    lanes: [],
    components: [],
    multiLaneComponents: [],
    interfaces: [],
    bypass: [],
    paths: [],
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
            { id: 1, dead: false },
            { id: 2, dead: true },
          ],
          edgeCountsByRelation: { extends: 1, indexes: 1 },
          declaration: { state: "declared", terminus: 2, latestEventTurn: 2 },
          state: { key: LANE_KEY, closure: "closed", validity: "valid", terminus: 2, lastDeclarer: 2 },
          citedness: {
            groundsFromNonMembers: [{ citingId: 9, citedId: 1 }],
            usedFromNonMembers: [{ citingId: 6, citedId: 1 }],
            testimonyFromNonMembers: [{ citingId: 8, citedId: 1, relation: "verifies" }],
          },
          coverage: { status: "partial", missingTurnIds: [7] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      paths: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const text = renderLaneCheckerReports(result);

    expect(text).toContain("E42:{ownership}");
    expect(text).toContain("1, 2(dead)");
    expect(text).toContain("extends=1");
    expect(text).toContain("indexes=1");
    // The raw declaration.state word ("declared") no longer renders here —
    // ticket 04 replaces it with the corrected closed-valid/closed-invalid/
    // open reading (`LaneStatsReport.state`), read from `deriveLaneStates`.
    expect(text).toContain("closed-valid");
    expect(text).not.toMatch(/declaration: declared/);
    expect(text).toContain("terminus T2");
    expect(text).toContain("[last event T2]");
    expect(text).toContain("T9->T1");
    expect(text).toContain("used[T6->T1]");
    expect(text).toContain("T8 verifies T1");
    expect(text).toContain("partial");
    // floor-and-render-fidelity ticket 03: EVERY turn id this file prints
    // routes through the same formatter, coverage's missing-id list included
    // — no addresses supplied here, so it keeps the bare `T<dbid>` form.
    expect(text).toContain("missing: T7");
  });

  test("report 1's state line renders all three forms — closed-valid, closed-invalid, and open with/without a last declarer", () => {
    const closedValid: LaneCheckerResult["lanes"][number] = {
      key: { segment: "1", tag: "cv" },
      phases: [],
      members: [],
      edgeCountsByRelation: {},
      declaration: { state: "declared", terminus: 31, latestEventTurn: 31 },
      state: { key: { segment: "1", tag: "cv" }, closure: "closed", validity: "valid", terminus: 31, lastDeclarer: 31 },
      citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
      coverage: { status: "whole", missingTurnIds: [] },
    };
    const closedInvalid: LaneCheckerResult["lanes"][number] = {
      ...closedValid,
      key: { segment: "1", tag: "ci" },
      state: { key: { segment: "1", tag: "ci" }, closure: "closed", validity: "invalid", terminus: 13, lastDeclarer: 13 },
    };
    const openWithDeclarer: LaneCheckerResult["lanes"][number] = {
      ...closedValid,
      key: { segment: "1", tag: "ow" },
      declaration: { state: "reopened", terminus: null, latestEventTurn: 103 },
      state: { key: { segment: "1", tag: "ow" }, closure: "open", validity: null, terminus: null, lastDeclarer: 102 },
    };
    const openNoDeclarer: LaneCheckerResult["lanes"][number] = {
      ...closedValid,
      key: { segment: "1", tag: "on" },
      declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
      state: { key: { segment: "1", tag: "on" }, closure: "open", validity: null, terminus: null, lastDeclarer: null },
    };

    const result: LaneCheckerResult = {
      ...emptyResult(),
      lanes: [closedValid, closedInvalid, openWithDeclarer, openNoDeclarer],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("declaration: closed-valid");
    expect(text).toContain("declaration: closed-invalid");
    expect(text).toContain("declaration: open (last declarer T102)");
    // The never-declared lane prints bare "open" — no invented declarer.
    const lines = text.split("\n");
    const onIndex = lines.findIndex((line) => line.includes("{on}"));
    const onDeclarationLine = lines.slice(onIndex).find((line) => line.includes("declaration:"))!;
    expect(onDeclarationLine.trim()).toBe("declaration: open");
  });

  test("the default-segment sentinel renders as 'default', never the raw sentinel bytes", () => {
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: { segment: DEFAULT_SEGMENT, tag: "homeless-lane" },
          phases: [],
          members: [],
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          state: {
            key: { segment: DEFAULT_SEGMENT, tag: "homeless-lane" },
            closure: "open",
            validity: null,
            terminus: null,
            lastDeclarer: null,
          },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      paths: [],
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

  test("report 2 flags a multi-component lane SEVERED, and report 3 lists a shared component's own lanes", () => {
    const result: LaneCheckerResult = {
      lanes: [],
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
      multiLaneComponents: [
        {
          representative: 5,
          lanes: [LANE_KEY, { segment: "9", tag: "other" }],
          sharedNodes: [
            { id: 5, citingLanesByStance: [LANE_KEY, { segment: "9", tag: "other" }], designedShape: true },
          ],
        },
      ],
      interfaces: [],
      bypass: [],
      paths: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("components: 2 (SEVERED)");
    // floor-and-render-fidelity ticket 03: an island's representative and
    // member ids are turn references too, not exempt from the address
    // formatter just because the old render left them bare.
    expect(text).toContain("island@T1: T1");
    expect(text).toContain("island@T3: T3");
    expect(text).toContain("component@T5:");
    expect(text).toContain("E9:{other}");
    expect(text).toContain("shared T5 (designed fork/merge)");
  });

  test("report 4b prints a skipped lane's reason and an ok lane's folded count", () => {
    const result: LaneCheckerResult = {
      lanes: [],
      components: [],
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      timeOrderViolations: [],
      paths: [
        {
          key: LANE_KEY,
          status: "skipped",
          skipReason: "undeclared",
          starts: [1, 2],
          terminus: null,
          pathCount: null,
          forkNodes: [],
          joinNodes: [],
          folded: null,
        },
        {
          key: { segment: "9", tag: "b" },
          status: "ok",
          starts: [1],
          terminus: 3,
          pathCount: 2,
          forkNodes: [1],
          joinNodes: [3],
          folded: { citingTurnsFolded: [8], pathCount: 2 },
        },
      ],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("skipped (undeclared)");
    // floor-and-render-fidelity ticket 03: starts/fork/join/folded-citing
    // lists are turn-id lists too, formatted the same as every other
    // reference in this file (bare `T<dbid>` here — no addresses supplied).
    expect(text).toContain("starts: T1,T2");
    expect(text).toContain("paths: 2 (terminus T3");
    expect(text).toContain("folded pathCount=2");
    expect(text).toContain("citing turns folded: T8");
    expect(text).toContain("fork: T1 join: T3");
  });

  test("report 4a prints an inter-lane interface pair's count and a declared lane's bypass edges", () => {
    const otherKey = { segment: "9", tag: "b" };
    const result: LaneCheckerResult = {
      ...emptyResult(),
      interfaces: [{ laneA: LANE_KEY, laneB: otherKey, count: 3 }],
      bypass: [
        {
          key: LANE_KEY,
          count: 1,
          edges: [{ citingId: 7, citedId: 2, relation: "consume", tags: [] }],
        },
      ],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("Report 4a");
    expect(text).toContain("E42:{ownership} <-> E9:{b}: 3");
    expect(text).toContain("bypass: 1");
    expect(text).toContain("T7 -> T2 (consume)");
  });

  test("report 4a prints an explicit empty marker for both interfaces and bypass when neither has anything to show", () => {
    const text = renderLaneCheckerReports(emptyResult());
    expect(text).toContain("(no inter-lane interfaces)");
    expect(text).toContain("(no declared lanes)");
  });

  test("report 4c lists a time-order violation verbatim (citing, cited, relation, tags)", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      timeOrderViolations: [{ citingId: 3, citedId: 9, relation: "extends", tags: ["ownership"] }],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("Report 4c");
    expect(text).toContain("T3 -> T9 (extends {ownership})");
  });

  test("report 4c prints an explicit empty marker when there are no violations", () => {
    const text = renderLaneCheckerReports(emptyResult());
    expect(text).toContain("## Report 4c -- time-order violations (the DAG guarantee)");
    const lines = text.split("\n");
    const headingIndex = lines.findIndex((line) => line.includes("Report 4c"));
    expect(lines[headingIndex + 1]).toBe("(none)");
  });

  test("cross-segment warnings render under a ⚠ line with a leading count, and an empty set says so explicitly", () => {
    const withWarnings: LaneCheckerResult = {
      ...emptyResult(),
      warnings: [{ citingId: 2, citedId: 1, tagSet: ["x"], citingSegment: "B", citedSegment: "A" }],
    };
    const text = renderLaneCheckerReports(withWarnings);
    expect(text).toContain("## Cross-segment warnings");
    expect(text).toContain("1 cross-segment tagged edge(s):");
    expect(text).toContain("⚠ T2(B) -> T1(A) {x}");

    const withoutWarnings = renderLaneCheckerReports(emptyResult());
    expect(withoutWarnings).toContain("## Cross-segment warnings");
    expect(withoutWarnings).toContain("(none)");
  });

  // tag-mandate ticket 03 — printed exactly what the typed result carries,
  // same "no derivation" discipline every other block in this file proves: a
  // nonsense-but-legal `LaneCheckerResult` still renders faithfully.
  test("the ERRORS block prints one line per instance, each leading with its class and its ANCHOR turn", () => {
    const withErrors: LaneCheckerResult = {
      ...emptyResult(),
      errors: [
        { class: "E2", anchorId: 5, citingId: 5, citedId: 4, relation: "depends-on" },
        { class: "E2", anchorId: 20, citingId: 20, citedId: 19, relation: "supersedes" },
        { class: "E3", anchorId: 10, id: 10, types: [], outsideVocabulary: [] },
        { class: "E3", anchorId: 11, id: 11, types: ["bugfix"], outsideVocabulary: ["bugfix"] },
        {
          class: "E4",
          anchorId: 31,
          citingId: 31,
          citedId: 30,
          relation: "narrows",
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
      "## ERRORS -- states the grammar forbids; commit refuses while one anchored in your writable scope remains",
    );
    expect(text).toContain("5 error(s)");
    expect(text).toContain("[E2] anchor T5 -- T5 --depends-on--> T4: relation is outside the eight-word vocabulary");
    expect(text).toContain("[E2] anchor T20 -- T20 --supersedes--> T19: relation is outside the eight-word vocabulary");
    expect(text).toContain("[E3] anchor T10 -- T10 type: [] (empty)");
    expect(text).toContain("[E3] anchor T11 -- T11 type: [bugfix] (outside vocabulary: bugfix)");
    expect(text).toContain(
      '[E4] anchor T31 -- T31 --narrows--> T30 {a,b}: "b" missing from the cited turn\'s tags; ' +
        '"b" missing from the citing turn\'s tags',
    );
    // The errors block LEADS: a reader (and the commit-gate-facing agent)
    // must not have to scroll past the aspirational reports to find must-fix.
    expect(text.indexOf("## ERRORS")).toBe(0);
    expect(text.indexOf("## ERRORS")).toBeLessThan(text.indexOf("## WARNINGS"));
    expect(text.indexOf("## WARNINGS")).toBeLessThan(text.indexOf("## Report 1"));
  });

  // tag-mandate ticket 04 — E5 is the one class whose instance is about a
  // LANE rather than a row, so its line has to name three things the other
  // four never need: which lane, which end, and the canonical node the
  // anchored one is extra to (without that last one the reader cannot tell
  // "retag this chain" from "bridge it to the lane's real start").
  test("the ERRORS block renders E5 with its lane, its dangling end, and the canonical node", () => {
    const withShapeErrors: LaneCheckerResult = {
      ...emptyResult(),
      errors: [
        {
          class: "E5",
          anchorId: 502,
          key: { segment: DEFAULT_SEGMENT, tag: "L" },
          role: "sink",
          nodeId: 502,
          canonicalId: 504,
        },
        {
          class: "E5",
          anchorId: 503,
          key: { segment: "42", tag: "ab" },
          role: "source",
          nodeId: 503,
          canonicalId: 501,
        },
      ],
    };
    const text = renderLaneCheckerReports(withShapeErrors);
    expect(text).toContain("2 error(s)");
    expect(text).toContain(
      "[E5] anchor T502 -- lane default:{L} has a second sink: T502 dangles beside T504;" +
        " a lane has exactly one start and one end (retag one chain, or bridge them)",
    );
    expect(text).toContain(
      "[E5] anchor T503 -- lane E42:{ab} has a second source: T503 dangles beside T501;",
    );
  });

  /**
   * T1466 (finding P1-3): an E5 anchor is the EDGE-OWNING CITER, so for a
   * dangling SOURCE it is a DIFFERENT turn from the one the sentence names.
   * The line has to say why, or the reader sees an anchor that appears
   * nowhere in the sentence and cannot tell which of the two is the typo.
   */
  test("an E5 source whose anchor is not the dangling node says which edge the anchor owns", () => {
    const text = renderLaneCheckerReports({
      ...emptyResult(),
      errors: [
        {
          class: "E5",
          anchorId: 512, // the citer that owns the in-lane edge into T511
          key: { segment: DEFAULT_SEGMENT, tag: "L" },
          role: "source",
          nodeId: 511,
          canonicalId: 509,
        },
      ],
    });
    expect(text).toContain(
      "[E5] anchor T512 -- lane default:{L} has a second source: T511 dangles beside T509;" +
        " a lane has exactly one start and one end (retag one chain, or bridge them;" +
        " the anchor owns the in-lane edge into T511)",
    );
  });

  test("an error-free result says so explicitly, and the retired vocabulary-conformance section prints nowhere", () => {
    const clean = renderLaneCheckerReports(emptyResult());
    const lines = clean.split("\n");
    expect(lines[0]).toBe(
      "## ERRORS -- states the grammar forbids; commit refuses while one anchored in your writable scope remains",
    );
    expect(lines[1]).toBe("(none)");
    // The facts are error classes E2/E3 now — the old "reported, never
    // enforced" section would contradict the commit gate that refuses on them.
    expect(clean).not.toContain("Vocabulary conformance");
  });

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
      class: "E2" as const,
      anchorId: index + 1,
      citingId: index + 1,
      citedId: 0,
      relation: "supersedes",
    }));
    const text = renderLaneCheckerReports({ ...emptyResult(), errors: many });
    expect(text).toContain("60 error(s)");
    expect(text).not.toContain("showing first");
    expect(text).toContain("[E2] anchor T50 --");
    expect(text).toContain("[E2] anchor T51 --");
    expect(text).toContain("[E2] anchor T60 --");
    // Every instance, counted rather than sampled: one line per error.
    expect(text.split("\n").filter((line) => line.startsWith("  [E2] anchor")).length).toBe(60);
  });

  /**
   * FLOOR-AND-RENDER-FIDELITY TICKET 03 (user ruling S15069/T1482) — EVERY
   * turn id this file prints is spelled for whoever is reading, not just the
   * error ANCHOR (tag-mandate ticket 06's own narrower scope): the edge
   * endpoint on an E2 line, the E5 node/canonical pair, every count list —
   * all route through the same `formatTurnRef`. The settlement tool, the
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
    const errors: LaneCheckerResult["errors"] = [
      { class: "E2", anchorId: 5, citingId: 5, citedId: 4, relation: "supersedes" },
      {
        class: "E5",
        anchorId: 7,
        key: { segment: DEFAULT_SEGMENT, tag: "L" },
        role: "sink",
        nodeId: 7,
        canonicalId: 9,
      },
    ];

    test("addresses replace every resolvable id on the line, in the anchor position and the endpoints alike", () => {
      const addresses = buildLaneAnchorAddresses([
        { id: 5, type: ["design"], order: [15069, 332] },
        { id: 7, type: ["design"], order: [15069, 401] },
      ]);
      const text = renderLaneCheckerReports({ ...emptyResult(), errors }, addresses);

      // E2's CITING side (id 5, in the map) resolves; its CITED side (id 4,
      // never in the map) keeps the bare fallback — proving this is a
      // per-id lookup, not a blanket string substitution.
      expect(text).toContain(
        "[E2] anchor S15069/T332 -- S15069/T332 --supersedes--> T4: relation is outside the eight-word vocabulary",
      );
      // The E5 line's dangling NODE (id 7, same as the anchor) resolves too;
      // its CANONICAL counterpart (id 9, not in the map) stays bare.
      expect(text).toContain(
        "[E5] anchor S15069/T401 -- lane default:{L} has a second sink: S15069/T401 dangles beside T9",
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
      expect(text).toContain("[E2] anchor S15069/T332 --");
      expect(text).toContain("[E5] anchor T7 --");
      expect(text).toContain("dangles beside T9");

      // A turn with no `order` contributes no entry at all.
      expect(buildLaneAnchorAddresses([{ id: 5, type: ["design"] }]).size).toBe(0);

      // And a caller that supplies NO map at all (the fallback path itself,
      // unreachable on any real settlement/CLI/console scope — those always
      // build one from the projection they loaded) is byte-identical to an
      // explicitly empty one.
      const bare = renderLaneCheckerReports({ ...emptyResult(), errors });
      expect(bare).toContain("[E2] anchor T5 --");
      expect(bare).toContain("[E5] anchor T7 --");
      expect(bare).toBe(renderLaneCheckerReports({ ...emptyResult(), errors }, new Map()));
    });
  });
});

describe("renderLaneDigraph -- CLI-only, glyphs the ticket names", () => {
  test("member/terminus/dead glyphs match the ticket's own vocabulary", () => {
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: LANE_KEY,
          phases: ["decision"],
          members: [
            { id: 1, dead: false },
            { id: 2, dead: true },
            { id: 3, dead: false },
          ],
          edgeCountsByRelation: {},
          declaration: { state: "declared", terminus: 3, latestEventTurn: 3 },
          state: { key: LANE_KEY, closure: "closed", validity: "valid", terminus: 3, lastDeclarer: 3 },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      timeOrderViolations: [],
      paths: [
        {
          key: LANE_KEY,
          status: "ok",
          starts: [1],
          terminus: 3,
          pathCount: 1,
          forkNodes: [],
          joinNodes: [],
          folded: { citingTurnsFolded: [], pathCount: 1 },
        },
      ],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const digraph = renderLaneDigraph(result);
    const lines = digraph.split("\n");
    expect(lines.find((line) => line.includes("T1"))).toContain("●");
    expect(lines.find((line) => line.includes("T2"))).toContain("✕");
    expect(lines.find((line) => line.includes("T3"))).toContain("◎");
  });

  test("a report-4 fork/join finding (pathCount > 1) marks its terminus with the finding glyph", () => {
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: LANE_KEY,
          phases: ["decision"],
          members: [{ id: 1, dead: false }],
          edgeCountsByRelation: {},
          declaration: { state: "declared", terminus: 1, latestEventTurn: 1 },
          state: { key: LANE_KEY, closure: "closed", validity: "valid", terminus: 1, lastDeclarer: 1 },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      timeOrderViolations: [],
      paths: [
        {
          key: LANE_KEY,
          status: "ok",
          starts: [2, 3],
          terminus: 1,
          pathCount: 2,
          forkNodes: [],
          joinNodes: [1],
          folded: { citingTurnsFolded: [], pathCount: 2 },
        },
      ],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    const digraph = renderLaneDigraph(result);
    expect(digraph).toContain("⚠");
  });

  test("a member shared with another lane renders as a reference line, not a second branch column", () => {
    const otherKey = { segment: "9", tag: "b" };
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: LANE_KEY,
          phases: [],
          members: [{ id: 5, dead: false }],
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          state: { key: LANE_KEY, closure: "open", validity: null, terminus: null, lastDeclarer: null },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
        {
          key: otherKey,
          phases: [],
          members: [{ id: 5, dead: false }],
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          state: { key: otherKey, closure: "open", validity: null, terminus: null, lastDeclarer: null },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      timeOrderViolations: [],
      paths: [],
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
    const manyMembers = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, dead: false }));
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: { segment: "1234567890", tag: "a-very-long-tag-name-that-pushes-width-another-tag" },
          phases: ["decision"],
          members: manyMembers,
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          state: {
            key: { segment: "1234567890", tag: "a-very-long-tag-name-that-pushes-width-another-tag" },
            closure: "open",
            validity: null,
            terminus: null,
            lastDeclarer: null,
          },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      timeOrderViolations: [],
      paths: [],
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

  test("derives nothing: a terminus id that is not even a member still prints, unvalidated", () => {
    // Semantically impossible for the REAL core to produce (a declared
    // terminus is always a member) -- constructed by hand specifically to
    // prove the renderer does not cross-check `declaration.terminus`
    // against `members` before printing.
    const result: LaneCheckerResult = {
      lanes: [
        {
          key: LANE_KEY,
          phases: [],
          members: [{ id: 1, dead: false }],
          edgeCountsByRelation: {},
          declaration: { state: "declared", terminus: 999, latestEventTurn: 999 },
          state: { key: LANE_KEY, closure: "closed", validity: "valid", terminus: 999, lastDeclarer: 999 },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      interfaces: [],
      bypass: [],
      timeOrderViolations: [],
      paths: [
        {
          key: LANE_KEY,
          status: "ok",
          starts: [1],
          terminus: 999,
          pathCount: 0,
          forkNodes: [],
          joinNodes: [],
          folded: { citingTurnsFolded: [], pathCount: 0 },
        },
      ],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      ...NO_ATTRIBUTION_WARNINGS,
      errors: [],
    };

    expect(() => renderLaneCheckerReports(result)).not.toThrow();
    expect(() => renderLaneDigraph(result)).not.toThrow();
    expect(renderLaneCheckerReports(result)).toContain("terminus T999");
    // Member 1 is not the (nonexistent, unmatched) terminus, so it renders
    // as a plain member glyph -- the renderer never "fixes" the mismatch.
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
            { id: 1, dead: false },
            { id: 2, dead: false },
          ],
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          state: { key: LANE_KEY, closure: "open", validity: null, terminus: null, lastDeclarer: null },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
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
          relation: "extends",
          tags: ["a"],
          missing: [{ tag: "a", endpoint: "cited" }],
        },
        // Anchored at a turn that is NO lane's member — exactly the case the
        // inline marks alone would hide, and the reason the block exists.
        { class: "E2", anchorId: 77, citingId: 77, citedId: 70, relation: "supersedes" },
      ],
    };

    const digraph = renderLaneDigraph(result);
    const lines = digraph.split("\n");
    expect(lines[0]).toBe("ERRORS (3)");
    expect(digraph).toContain("[E2] anchor T77 -- T77 --supersedes--> T70");
    // T1 anchors two distinct classes; both appear on its member line, and
    // the bracket keeps ✗ unmistakable for the dead-node ✕.
    expect(lines.find((line) => line.includes("● T1"))).toContain("✗[E3,E4]");
    expect(lines.find((line) => line.includes("● T2"))).not.toContain("✗");
    // T77 is not a member, so it appears ONLY in the block.
    expect(lines.filter((line) => line.includes("T77"))).toHaveLength(1);
  });

  // tag-mandate ticket 04 — an E5 instance ALWAYS anchors at a lane member
  // (its node is one of the lane's own edge endpoints by construction), so
  // unlike E2/E3 it is guaranteed to earn an inline mark as well as a block
  // line. Both must appear: the mark is where a reader scanning the lane
  // sees it, the block line is where the canonical counterpart is named.
  test("the digraph marks an E5-anchored member inline and keeps the block line inside the column bound", () => {
    const result: LaneCheckerResult = {
      ...emptyResult(),
      lanes: [
        {
          key: LANE_KEY,
          phases: [],
          members: [
            { id: 2, dead: false },
            { id: 9, dead: false },
          ],
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          state: { key: LANE_KEY, closure: "open", validity: null, terminus: null, lastDeclarer: null },
          citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      errors: [
        { class: "E5", anchorId: 2, key: LANE_KEY, role: "sink", nodeId: 2, canonicalId: 9 },
      ],
    };

    const digraph = renderLaneDigraph(result);
    const lines = digraph.split("\n");
    expect(lines[0]).toBe("ERRORS (1)");
    // Truncation is allowed to eat the teaching tail, never the three facts
    // that identify the defect: which end, which node, which canonical one.
    expect(digraph).toContain("[E5] anchor T2 -- lane E42:{ownership} has a second sink: T2 dangles beside T9;");
    expect(lines.find((line) => line.includes("● T2"))).toContain("✗[E5]");
    expect(lines.find((line) => line.includes("● T9"))).not.toContain("✗");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

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
          relation: "extends",
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
      class: "E2" as const,
      anchorId: index + 1,
      citingId: index + 1,
      citedId: 0,
      relation: "extends",
    }));
    const digraph = renderLaneDigraph({ ...emptyResult(), errors: many });
    expect(digraph.split("\n")[0]).toBe("ERRORS (60) (showing first 50)");
    expect(digraph).toContain("[E2] anchor T50 --");
    expect(digraph).not.toContain("[E2] anchor T51 --");
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
    expect(text).toContain("(no segment over its lane budget)");
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
    expect(text).toContain("  4 turns, none in any lane: S7/T1,S7/T2,S7/T3,S7/T4");
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
    expect(text).toContain("137 turns, none in any lane: T1,T2,T3,T4 (showing first 4)");
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
    expect(text).toContain("2 segment(s) over the lane budget:");
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
    expect(text).toContain("    2 of them have no live member (undeclare removes them): #ghost-a, #ghost-b");
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
