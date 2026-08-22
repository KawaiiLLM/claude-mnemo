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

function emptyResult(): LaneCheckerResult {
  return { lanes: [], components: [], multiLaneComponents: [], paths: [], warnings: [] };
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
          citedness: {
            groundsFromNonMembers: [{ citingId: 9, citedId: 1 }],
            testimonyFromNonMembers: [{ citingId: 8, citedId: 1, relation: "verifies" }],
          },
          coverage: { status: "partial", missingTurnIds: [7] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      paths: [],
      warnings: [],
    };

    const text = renderLaneCheckerReports(result);

    expect(text).toContain("E42:{ownership}");
    expect(text).toContain("1, 2(dead)");
    expect(text).toContain("extends=1");
    expect(text).toContain("indexes=1");
    expect(text).toContain("declared");
    expect(text).toContain("terminus 2");
    expect(text).toContain("[last event T2]");
    expect(text).toContain("T9->T1");
    expect(text).toContain("T8 verifies T1");
    expect(text).toContain("partial");
    expect(text).toContain("missing: 7");
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
          citedness: { groundsFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      paths: [],
      warnings: [],
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
      paths: [],
      warnings: [],
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("components: 2 (SEVERED)");
    expect(text).toContain("island@1: 1");
    expect(text).toContain("island@3: 3");
    expect(text).toContain("component@5:");
    expect(text).toContain("E9:{other}");
    expect(text).toContain("shared T5 (designed fork/merge)");
  });

  test("report 4 prints a skipped lane's reason and an ok lane's folded count", () => {
    const result: LaneCheckerResult = {
      lanes: [],
      components: [],
      multiLaneComponents: [],
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
    };

    const text = renderLaneCheckerReports(result);
    expect(text).toContain("skipped (undeclared)");
    expect(text).toContain("starts: 1,2");
    expect(text).toContain("paths: 2 (terminus T3");
    expect(text).toContain("folded pathCount=2");
    expect(text).toContain("citing turns folded: 8");
    expect(text).toContain("fork: 1 join: 3");
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
          citedness: { groundsFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
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
          citedness: { groundsFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
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
          citedness: { groundsFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
        {
          key: otherKey,
          phases: [],
          members: [{ id: 5, dead: false }],
          edgeCountsByRelation: {},
          declaration: { state: "undeclared", terminus: null, latestEventTurn: null },
          citedness: { groundsFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      paths: [],
      warnings: [],
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
          citedness: { groundsFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
      paths: [],
      warnings: [],
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
          citedness: { groundsFromNonMembers: [], testimonyFromNonMembers: [] },
          coverage: { status: "whole", missingTurnIds: [] },
        },
      ],
      components: [],
      multiLaneComponents: [],
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
    };

    expect(() => renderLaneCheckerReports(result)).not.toThrow();
    expect(() => renderLaneDigraph(result)).not.toThrow();
    expect(renderLaneCheckerReports(result)).toContain("terminus 999");
    // Member 1 is not the (nonexistent, unmatched) terminus, so it renders
    // as a plain member glyph -- the renderer never "fixes" the mismatch.
    const digraph = renderLaneDigraph(result);
    expect(digraph.split("\n").find((line) => line.includes("T1"))).toContain("●");
  });
});
