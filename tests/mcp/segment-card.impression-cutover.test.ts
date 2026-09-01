import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  appendSegmentWorkingStateRows,
  createSegment,
  markSegmentTaskImpressionStale,
  replaceSegmentTaskImpression,
  retireSegmentImpressionSourceFields,
} from "../../src/db/segments";
import { renderSegmentCard } from "../../src/mcp/segment-card";
import { createTruncationSignal } from "../../src/mcp/format";
import {
  SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER,
  SEGMENT_WORKING_STATE_FIELDS,
  SEGMENT_WORKING_STATE_FIELDS_AFTER_CUTOVER,
} from "../../src/shared/segment-fields";

/**
 * THE SEGMENT CARD SLIMMING (lane-impressions spec Rev 8, "Segment card
 * slimming"; ticket 05). The card is the surface the cutover is VISIBLE on, so
 * every assertion here is about rendered text.
 *
 * The two halves are deliberately asserted TOGETHER in the same render: the
 * spec's order — pointer, then retirement — is only meaningful if a reader can
 * never see one without the other, and both hang off the one
 * `impression_origin` discriminator that this ticket's commit flips.
 */

const NOW = 1_800_000_000;

let db: Database;
let segmentId: number;

const TASK_IMPRESSION =
  "The card-slimming task: one discriminator decides three things at once, and it holds.\nFrontier: the enums leave the tool in a later release.";

function pointerLine(id: number): string {
  return `- lane impressions: recall(id="E${id}/#<tag>")`;
}

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  segmentId = createSegment(db, {
    title: "card slimming fixture",
    content: "the legacy content blob",
    insight: null,
    type: [],
    tags: ["card-slimming"],
    nowEpoch: NOW,
  }).id;
  insertLane(db, segmentId, "alpha", NOW);
  appendSegmentWorkingStateRows(db, segmentId, "goal", ["keep the goal"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "constraints", ["keep the constraint"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "reference", ["keep the reference"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "decisions", ["a legacy ruling"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "done", ["a legacy completion"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "next_steps", ["a legacy owed item"], NOW);
});

afterEach(() => {
  db.close();
});

/** The cutover, exactly as `commitImpressionBackfill` performs it: seed, then retire. */
function cutOver(): void {
  replaceSegmentTaskImpression(db, {
    segmentId,
    baseRevision: 0,
    text: TASK_IMPRESSION,
    origin: "backfill",
    nowEpoch: NOW,
  });
  retireSegmentImpressionSourceFields(db, segmentId, NOW);
}

describe("the field sets themselves", () => {
  test("exactly these three retire, and exactly these three keep", () => {
    // PINNED LITERALLY, not read off the constant the card also reads: a test
    // that iterates the same list the render iterates cannot tell "this field
    // retired" from "this field is no longer in the list".
    expect([...SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER]).toEqual([
      "decisions",
      "done",
      "next_steps",
    ]);
    expect([...SEGMENT_WORKING_STATE_FIELDS_AFTER_CUTOVER]).toEqual([
      "goal",
      "constraints",
      "reference",
    ]);
  });
});

describe("before the cutover the card is unchanged", () => {
  test("all six Working State fields render, and there is no pointer line", () => {
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    for (const field of SEGMENT_WORKING_STATE_FIELDS) {
      expect(card).toContain(`- ${field}:`);
    }
    expect(card).toContain("- content: the legacy content blob");
    expect(card).not.toContain("lane impressions: recall(");
  });

  test("retiring the fields WITHOUT seeding the impression does not slim the card", () => {
    // The un-orderable state the spec forbids, forced by hand: the fields are
    // gone but no successor exists. The card must still show the legacy shape,
    // because `impression_origin` — not the fields' emptiness — is what decides.
    retireSegmentImpressionSourceFields(db, segmentId, NOW);
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    for (const field of SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER) {
      expect(card).toContain(`- ${field}: 0 rows`);
    }
    expect(card).not.toContain("lane impressions: recall(");
  });
});

describe("after the cutover the card is slimmed and carries the pointer", () => {
  test("the three retired fields are GONE and the three kept ones remain", () => {
    cutOver();
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });

    expect(card).not.toContain("- decisions:");
    expect(card).not.toContain("- done:");
    expect(card).not.toContain("- next_steps:");
    expect(card).toContain("- goal:");
    expect(card).toContain("- constraints:");
    expect(card).toContain("- reference:");
    expect(card).toContain("keep the goal");
    expect(card).toContain("keep the constraint");
    expect(card).toContain("keep the reference");
  });

  test("the pointer line renders verbatim, with the placeholder tag the spec pins", () => {
    cutOver();
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    expect(card).toContain(pointerLine(segmentId));
    // NO VOCABULARY EXPANSION: this task declares `#alpha`, and the pointer
    // must not name it — the card carries no lane vocabulary.
    expect(card).not.toContain('recall(id="E1/#alpha")');
  });

  test("content becomes the task-tier impression, rendered as its own multi-row field", () => {
    cutOver();
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    expect(card).toContain("- impression:");
    expect(card).not.toContain("- content: the legacy content blob");
    for (const line of TASK_IMPRESSION.split("\n")) {
      expect(card).toContain(line);
    }
  });

  test("a STALE task tier changes nothing about the slimming (ticket 07: the flag hides nothing)", () => {
    cutOver();
    markSegmentTaskImpressionStale(db, segmentId);
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    expect(card).toContain(pointerLine(segmentId));
    expect(card).not.toContain("- done:");
    expect(card).toContain(TASK_IMPRESSION.split("\n")[0]!);
  });
});

describe("the slimming holds on every page and under every budget", () => {
  test("page 2 (un-elided) is slimmed too, and still carries the pointer", () => {
    cutOver();
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000, page: 2 });
    expect(card).toContain(pointerLine(segmentId));
    expect(card).not.toContain("- decisions:");
    expect(card).not.toContain("- done:");
    expect(card).not.toContain("- next_steps:");
    expect(card).toContain("- goal:");
  });

  test("the pointer survives a budget so tight every field row is elided", () => {
    cutOver();
    const signal = createTruncationSignal();
    const card = renderSegmentCard(db, segmentId, { pageBudget: 1, signal });
    expect(signal.truncated).toBe(true);
    expect(card).toContain(pointerLine(segmentId));
  });

  test("a retired field reports no completeness signal, because it renders no row", () => {
    cutOver();
    const signal = createTruncationSignal();
    renderSegmentCard(db, segmentId, { pageBudget: 4000, signal });
    const reported = new Set((signal.fieldCompleteness ?? []).map((entry) => entry.field));
    expect(reported.has("decisions")).toBe(false);
    expect(reported.has("done")).toBe(false);
    expect(reported.has("next_steps")).toBe(false);
    expect(reported.has("goal")).toBe(true);
  });
});
