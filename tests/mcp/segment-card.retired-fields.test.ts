import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  appendSegmentWorkingStateRows,
  createSegment,
  getSegment,
  markSegmentTaskImpressionStale,
  replaceSegmentTaskImpression,
} from "../../src/db/segments";
import { renderSegmentCard } from "../../src/mcp/segment-card";
import { createTruncationSignal } from "../../src/mcp/format";
import {
  SEGMENT_EDITABLE_FIELDS,
  SEGMENT_WORKING_STATE_FIELDS,
} from "../../src/shared/segment-fields";

/**
 * THE DELETION (lane-impressions ticket 05, user ruling S15069/T2320:
 * 别迁移了，直接删，初始印象不需要任何特殊机制). `decisions`, `done`,
 * `next_steps` and the legacy `content` text left the product. There is no
 * backfill, no per-task cutover and no seeded initial impression: a task's
 * impression starts EMPTY and settlement writes it the first time it touches
 * one of that task's lanes.
 *
 * A deletion is the easiest kind of test to fake — "the card shows no `- done:`
 * row" is worth nothing if nothing ever put one there. So every fixture below
 * SEEDS the retired columns by direct SQL (no writer accepts them any more) and
 * then asserts they still do not reach the reader. Delete the render change and
 * these go red; delete the seeding and they would pass over an empty database,
 * which is exactly why the seed is asserted back out of storage too.
 */

const NOW = 1_800_000_000;

let db: Database;
let segmentId: number;

const TASK_IMPRESSION =
  "The card-slimming task: an impression is grown, never seeded.\nFrontier: the retired columns keep their bytes.";

const RETIRED_SEED = {
  decisions: "- a ruling nothing reads any more",
  done: "- a completion nothing reads any more",
  next_steps: "- an owed item nothing reads any more",
  content: "the pre-impression content blob",
} as const;

function pointerLine(id: number): string {
  return `- lane impressions: recall(id="E${id}/#<tag>")`;
}

/** The retired columns, written the only way left: straight at the table. */
function seedRetiredColumns(): void {
  db.query<unknown, [string, string, string, string, number]>(
    `UPDATE segments
        SET decisions = ?, done = ?, next_steps = ?, content = ?
      WHERE id = ?`,
  ).run(
    RETIRED_SEED.decisions,
    RETIRED_SEED.done,
    RETIRED_SEED.next_steps,
    RETIRED_SEED.content,
    segmentId,
  );
}

function readRetiredColumns(): Record<string, string | null> {
  return db
    .query<Record<string, string | null>, [number]>(
      `SELECT decisions, done, next_steps AS nextSteps, content, impression_origin AS origin
         FROM segments WHERE id = ?`,
    )
    .get(segmentId)!;
}

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  segmentId = createSegment(db, {
    title: "card slimming fixture",
    insight: null,
    type: [],
    tags: ["card-slimming"],
    nowEpoch: NOW,
  }).id;
  insertLane(db, segmentId, "alpha", NOW);
  appendSegmentWorkingStateRows(db, segmentId, "goal", ["keep the goal"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "constraints", ["keep the constraint"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "reference", ["keep the reference"], NOW);
  seedRetiredColumns();
});

afterEach(() => {
  db.close();
});

describe("the field sets themselves", () => {
  // PINNED LITERALLY, not derived from the constants the product also reads: a
  // test that iterates the same list the render iterates cannot tell "this
  // field retired" from "this field is no longer in the list".
  test("Working State is exactly the three kept fields", () => {
    expect([...SEGMENT_WORKING_STATE_FIELDS]).toEqual(["goal", "constraints", "reference"]);
  });

  test("the write face is exactly those three plus insight — content is settlement's", () => {
    expect([...SEGMENT_EDITABLE_FIELDS]).toEqual([
      "goal",
      "constraints",
      "reference",
      "insight",
    ]);
  });
});

describe("the retired fields are seeded in storage and reach no reader", () => {
  test("the seed is really there — this test's own premise, asserted", () => {
    const row = readRetiredColumns();
    expect(row.decisions).toBe(RETIRED_SEED.decisions);
    expect(row.done).toBe(RETIRED_SEED.done);
    expect(row.nextSteps).toBe(RETIRED_SEED.next_steps);
    expect(row.content).toBe(RETIRED_SEED.content);
  });

  test("no row for any retired field renders, and none of its text does either", () => {
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });

    for (const field of ["decisions", "done", "next_steps"]) {
      expect(card).not.toContain(`- ${field}:`);
    }
    for (const text of Object.values(RETIRED_SEED)) {
      expect(card).not.toContain(text);
    }
    expect(card).toContain("- goal:");
    expect(card).toContain("- constraints:");
    expect(card).toContain("- reference:");
  });

  test("nothing on the read path erases them either — the bytes survive the render", () => {
    renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    const row = readRetiredColumns();
    expect(row.decisions).toBe(RETIRED_SEED.decisions);
    expect(row.done).toBe(RETIRED_SEED.done);
    expect(row.nextSteps).toBe(RETIRED_SEED.next_steps);
  });

  test("a retired field reports no completeness signal, because it renders no row", () => {
    const signal = createTruncationSignal();
    renderSegmentCard(db, segmentId, { pageBudget: 4000, signal });
    const reported = new Set((signal.fieldCompleteness ?? []).map((entry) => entry.field));
    expect(reported.has("decisions")).toBe(false);
    expect(reported.has("done")).toBe(false);
    expect(reported.has("next_steps")).toBe(false);
    expect(reported.has("goal")).toBe(true);
  });
});

describe("a task settlement has not touched shows NO impression", () => {
  test("no impression heading, no content row, no placeholder — and the seeded bytes stay put", () => {
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });

    expect(card).not.toContain("- impression:");
    expect(card).not.toContain("- content:");
    expect(card).not.toContain(RETIRED_SEED.content);
    // Not an empty shell either: no line in the card so much as mentions the
    // word, and the column still holds its bytes.
    expect(card.toLowerCase()).not.toContain("impression pending");
    expect(getSegment(db, segmentId)!.content).toBe(RETIRED_SEED.content);
  });

  test("the pointer line renders ANYWAY — a slimmed card without it orphans the narrative", () => {
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    expect(card).toContain(pointerLine(segmentId));
    // NO VOCABULARY EXPANSION: this task declares `#alpha`, and the pointer
    // must not name it — the card carries no lane vocabulary.
    expect(card).not.toContain(`recall(id="E${segmentId}/#alpha")`);
  });

  test("the STALE flag over an empty slot still shows nothing", () => {
    expect(markSegmentTaskImpressionStale(db, segmentId)).toBe(true);
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    expect(card).not.toContain("- impression:");
    expect(card).not.toContain(RETIRED_SEED.content);
  });
});

describe("settlement's first write is what makes an impression appear", () => {
  function settle(): void {
    expect(
      replaceSegmentTaskImpression(db, {
        segmentId,
        baseRevision: 0,
        text: TASK_IMPRESSION,
        nowEpoch: NOW,
      }),
    ).toBe(true);
  }

  test("the slot fills from empty, with no seeding step in between", () => {
    expect(renderSegmentCard(db, segmentId, { pageBudget: 4000 })).not.toContain("- impression:");

    settle();

    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    expect(card).toContain("- impression:");
    for (const line of TASK_IMPRESSION.split("\n")) {
      expect(card).toContain(line);
    }
    // Still never through the legacy row, and the bytes it replaced are gone
    // from the column because the impression now owns it.
    expect(card).not.toContain("- content:");
    expect(getSegment(db, segmentId)!.content).toBe(TASK_IMPRESSION);
  });

  test("the retired fields stay gone once an impression exists", () => {
    settle();
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000 });
    for (const field of ["decisions", "done", "next_steps"]) {
      expect(card).not.toContain(`- ${field}:`);
    }
    expect(readRetiredColumns().decisions).toBe(RETIRED_SEED.decisions);
  });
});

describe("the slimming holds on every page and under every budget", () => {
  test("page 2 (un-elided) is slimmed too, and still carries the pointer", () => {
    const card = renderSegmentCard(db, segmentId, { pageBudget: 4000, page: 2 });
    expect(card).toContain(pointerLine(segmentId));
    for (const field of ["decisions", "done", "next_steps"]) {
      expect(card).not.toContain(`- ${field}:`);
    }
    expect(card).not.toContain(RETIRED_SEED.content);
    expect(card).toContain("- goal:");
  });

  test("the pointer survives a budget so tight every field row is elided", () => {
    const signal = createTruncationSignal();
    const card = renderSegmentCard(db, segmentId, { pageBudget: 1, signal });
    expect(signal.truncated).toBe(true);
    expect(card).toContain(pointerLine(segmentId));
  });
});
