import { describe, expect, test } from "bun:test";

import type { LaneCheckerResult } from "../../src/shared/lane-checker";
import { renderLaneCheckerReports, renderLaneDigraph } from "../../src/shared/lane-checker-render";
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

const LANE_KEY = { segment: "42", tagSet: ["ownership"] };

// semantic-conformance ticket 02 — every hand-built `LaneCheckerResult`
// fixture in this file needs this field now that the renderer reads it
// unconditionally; the clean (no-violation) shape is reused everywhere a
// fixture has nothing to say about vocabulary conformance.
const EMPTY_VOCABULARY_CONFORMANCE: LaneCheckerResult["vocabularyConformance"] = {
  typeViolations: { count: 0, entries: [] },
  outOfVocabularyEdges: { count: 0, entries: [] },
};

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
    expect(text).toContain("terminus 2");
    expect(text).toContain("[last event T2]");
    expect(text).toContain("T9->T1");
    expect(text).toContain("used[T6->T1]");
    expect(text).toContain("T8 verifies T1");
    expect(text).toContain("partial");
    expect(text).toContain("missing: 7");
  });

  test("report 1's state line renders all three forms — closed-valid, closed-invalid, and open with/without a last declarer", () => {
    const closedValid: LaneCheckerResult["lanes"][number] = {
      key: { segment: "1", tagSet: ["cv"] },
      phases: [],
      members: [],
      edgeCountsByRelation: {},
      declaration: { state: "declared", terminus: 31, latestEventTurn: 31 },
      state: { key: { segment: "1", tagSet: ["cv"] }, closure: "closed", validity: "valid", terminus: 31, lastDeclarer: 31 },
      citedness: { groundsFromNonMembers: [], usedFromNonMembers: [], testimonyFromNonMembers: [] },
      coverage: { status: "whole", missingTurnIds: [] },
    };
    const closedInvalid: LaneCheckerResult["lanes"][number] = {
      ...closedValid,
      key: { segment: "1", tagSet: ["ci"] },
      state: { key: { segment: "1", tagSet: ["ci"] }, closure: "closed", validity: "invalid", terminus: 13, lastDeclarer: 13 },
    };
    const openWithDeclarer: LaneCheckerResult["lanes"][number] = {
      ...closedValid,
      key: { segment: "1", tagSet: ["ow"] },
      declaration: { state: "reopened", terminus: null, latestEventTurn: 103 },
      state: { key: { segment: "1", tagSet: ["ow"] }, closure: "open", validity: null, terminus: null, lastDeclarer: 102 },
    };
    const openNoDeclarer: LaneCheckerResult["lanes"][number] = {
      ...closedValid,
      key: { segment: "1", tagSet: ["on"] },
      declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
      state: { key: { segment: "1", tagSet: ["on"] }, closure: "open", validity: null, terminus: null, lastDeclarer: null },
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
          key: { segment: DEFAULT_SEGMENT, tagSet: ["homeless-lane"] },
          phases: [],
          members: [],
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          state: {
            key: { segment: DEFAULT_SEGMENT, tagSet: ["homeless-lane"] },
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
          lanes: [LANE_KEY, { segment: "9", tagSet: ["other"] }],
          sharedNodes: [
            { id: 5, citingLanesByStance: [LANE_KEY, { segment: "9", tagSet: ["other"] }], designedShape: true },
          ],
        },
      ],
      interfaces: [],
      bypass: [],
      paths: [],
      timeOrderViolations: [],
      warnings: [],
      vocabularyConformance: EMPTY_VOCABULARY_CONFORMANCE,
      errors: [],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("components: 2 (SEVERED)");
    expect(text).toContain("island@1: 1");
    expect(text).toContain("island@3: 3");
    expect(text).toContain("component@5:");
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
          key: { segment: "9", tagSet: ["b"] },
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
      errors: [],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("skipped (undeclared)");
    expect(text).toContain("starts: 1,2");
    expect(text).toContain("paths: 2 (terminus T3");
    expect(text).toContain("folded pathCount=2");
    expect(text).toContain("citing turns folded: 8");
    expect(text).toContain("fork: 1 join: 3");
  });

  test("report 4a prints an inter-lane interface pair's count and a declared lane's bypass edges", () => {
    const otherKey = { segment: "9", tagSet: ["b"] };
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
        { class: "E1", anchorId: 5, citingId: 5, citedId: 4, relation: "extends" },
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
    expect(text).toContain("[E1] anchor T5 -- T5 --extends--> T4 carries no lane tags");
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

  test("the printed error list caps while the count line states the TRUE total (the data itself never caps)", () => {
    const many: LaneCheckerResult["errors"] = Array.from({ length: 60 }, (_, index) => ({
      class: "E1" as const,
      anchorId: index + 1,
      citingId: index + 1,
      citedId: 0,
      relation: "extends",
    }));
    const text = renderLaneCheckerReports({ ...emptyResult(), errors: many });
    expect(text).toContain("60 error(s) (showing first 50)");
    expect(text).toContain("[E1] anchor T50 --");
    expect(text).not.toContain("[E1] anchor T51 --");
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
      errors: [],
    };

    const digraph = renderLaneDigraph(result);
    expect(digraph).toContain("⚠");
  });

  test("a member shared with another lane renders as a reference line, not a second branch column", () => {
    const otherKey = { segment: "9", tagSet: ["b"] };
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
          key: { segment: "1234567890", tagSet: ["a-very-long-tag-name-that-pushes-width", "another-tag"] },
          phases: ["decision"],
          members: manyMembers,
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          state: {
            key: { segment: "1234567890", tagSet: ["a-very-long-tag-name-that-pushes-width", "another-tag"] },
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
      errors: [],
    };

    expect(() => renderLaneCheckerReports(result)).not.toThrow();
    expect(() => renderLaneDigraph(result)).not.toThrow();
    expect(renderLaneCheckerReports(result)).toContain("terminus 999");
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
        { class: "E1", anchorId: 77, citingId: 77, citedId: 70, relation: "narrows" },
      ],
    };

    const digraph = renderLaneDigraph(result);
    const lines = digraph.split("\n");
    expect(lines[0]).toBe("ERRORS (3)");
    expect(digraph).toContain("[E1] anchor T77 -- T77 --narrows--> T70");
    // T1 anchors two distinct classes; both appear on its member line, and
    // the bracket keeps ✗ unmistakable for the dead-node ✕.
    expect(lines.find((line) => line.includes("● T1"))).toContain("✗[E3,E4]");
    expect(lines.find((line) => line.includes("● T2"))).not.toContain("✗");
    // T77 is not a member, so it appears ONLY in the block.
    expect(lines.filter((line) => line.includes("T77"))).toHaveLength(1);
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
});
