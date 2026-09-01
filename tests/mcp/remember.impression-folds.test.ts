import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { readLaneImpression, replaceLaneImpression } from "../../src/db/impressions";
import { getLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  applySegmentWrites,
  getSegment,
  readSegmentTaskImpression,
  replaceSegmentTaskImpression,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { rememberTool } from "../../src/mcp/remember";
import { IMPRESSION_CAP_CEILING } from "../../src/shared/lane-impressions";
import { countTokens } from "../../src/shared/token-count";

/**
 * A FOLD CONCATENATES (lane-impressions ticket 07 — the user's ruling at
 * T2269: 「直接把两个印象合并，然后等下次重写。合并没有上限，但重写还是有 500 上限」).
 *
 * When two containers fold into one, their impressions are joined into the
 * survivor — survivor first — and left readable until the next settlement run
 * rewrites them into one. The join is UNCAPPED; only a settlement replacement
 * answers to the cap.
 *
 * Every fixture here distinguishes the survivor's text from the folded text by
 * CONTENT, never by length: a fold that dropped one side, reversed the order or
 * kept only the longer text goes red on the byte equality, not on a count.
 */

const EPOCH = 1_800_000_000;

let db: Database;
let sessionId: number;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  sessionId = upsertSession(db, {
    contentSessionId: "impression-fold-session",
    project: "/tmp/project-impression-folds",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: EPOCH,
    updatedAtEpoch: EPOCH,
    completedAtEpoch: null,
  }).id;
});

afterEach(() => {
  db.close();
});

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

function createTask(title: string, tag: string): number {
  return Number(/Created E(\d+)/.exec(resultText(rememberTool(db, { verb: "create", title, tag })))![1]);
}

function declareLane(segmentId: number, tag: string): void {
  expect(resultText(rememberTool(db, { verb: "create", id: `E${segmentId}/#${tag}` }))).toContain(
    "Created lane",
  );
}

/** A member turn carrying its task's tag plus a lane tag — the real write-gate shape, so a fold has something to move. */
let memberPromptNumber = 700;
function seedMember(segmentId: number, taskTag: string, laneTag: string): void {
  memberPromptNumber += 1;
  const id = db
    .query<{ id: number }, [number, number, string]>(
      `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
       VALUES (?, ?, 'active', ?, ${EPOCH}) RETURNING id`,
    )
    .get(sessionId, memberPromptNumber, JSON.stringify([taskTag, laneTag]))!.id;
  db.query<unknown, [number, number]>(
    `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, ${EPOCH})`,
  ).run(segmentId, id);
}

/** A phase-1 `content` field: ordinary legacy prose, `impression_origin` left NULL. */
function seedLegacyContent(segmentId: number, content: string): void {
  applySegmentWrites(
    db,
    [{ segmentId, expectedRevision: getSegment(db, segmentId)!.revision, content }],
    { nowEpoch: EPOCH },
  );
  expect(getSegment(db, segmentId)!.content).toBe(content);
}

function seedLaneImpression(
  segmentId: number,
  tag: string,
  text: string,
  origin: "backfill" | "settlement" = "settlement",
): void {
  expect(
    replaceLaneImpression(db, {
      segmentId,
      tag,
      baseRevision: readLaneImpression(db, segmentId, tag)!.revision,
      text,
      origin,
    }),
  ).toBe(true);
}

// Deliberately different lengths AND different words: neither "the longer one
// won" nor "the first row won" can be mistaken for the rule under test.
const SURVIVOR_TEXT =
  "The survivor lane: the gate is one predicate and it stays one (S1/T1).\nBinding: no second gate.";
const FOLDED_TEXT = "The folded lane: reads never take the gate (S1/T2).";

// ---------------------------------------------------------------------------
// Lane merge
// ---------------------------------------------------------------------------

describe("a lane merge concatenates the two impressions into the survivor", () => {
  function seedFoldableLanes(taskTag: string): number {
    const task = createTask(`fold ${taskTag}`, taskTag);
    declareLane(task, "survivor");
    declareLane(task, "folded");
    seedMember(task, taskTag, "folded");
    return task;
  }

  test("the survivor's text leads and the folded text follows, joined by ONE newline", () => {
    const task = seedFoldableLanes("fold-order");
    seedLaneImpression(task, "survivor", SURVIVOR_TEXT);
    seedLaneImpression(task, "folded", FOLDED_TEXT);

    expect(
      resultText(rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" })),
    ).toContain("Merged");

    expect(readLaneImpression(db, task, "survivor")!.text).toBe(
      `${SURVIVOR_TEXT}\n${FOLDED_TEXT}`,
    );
    expect(getLane(db, task, "folded")).toBeNull();
  });

  test("the fold moves the CAS fence, so a decision made against the pre-fold text cannot land", () => {
    const task = seedFoldableLanes("fold-fence");
    seedLaneImpression(task, "survivor", SURVIVOR_TEXT);
    seedLaneImpression(task, "folded", FOLDED_TEXT);
    const before = readLaneImpression(db, task, "survivor")!;

    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" });

    expect(readLaneImpression(db, task, "survivor")!.revision).toBeGreaterThan(before.revision);
    // The concrete consequence: the in-flight writer's own CAS is refused.
    expect(
      replaceLaneImpression(db, {
        segmentId: task,
        tag: "survivor",
        baseRevision: before.revision,
        text: "A replacement decided against the pre-fold text.",
        origin: "settlement",
      }),
    ).toBe(false);
  });

  test("an EMPTY folded side leaves the survivor's bytes, revision and origin exactly as found", () => {
    const task = seedFoldableLanes("fold-empty-folded");
    seedLaneImpression(task, "survivor", SURVIVOR_TEXT, "backfill");
    const before = readLaneImpression(db, task, "survivor")!;

    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" });

    const after = readLaneImpression(db, task, "survivor")!;
    expect(after.text).toBe(SURVIVOR_TEXT);
    expect(after.origin).toBe("backfill");
    // The merge's own STALE mark moves the revision by exactly one; the fold
    // adds none, because it wrote nothing.
    expect(after.revision).toBe(before.revision + 1);
  });

  test("an EMPTY survivor takes the folded text verbatim — no leading separator, and the ORIGIN carries too", () => {
    const task = seedFoldableLanes("fold-empty-survivor");
    seedLaneImpression(task, "folded", FOLDED_TEXT, "backfill");

    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" });

    const after = readLaneImpression(db, task, "survivor")!;
    expect(after.text).toBe(FOLDED_TEXT);
    expect(after.text!.startsWith("\n")).toBe(false);
    // `origin` is the survivor's ONLY when the survivor had text of its own;
    // an empty survivor carries the folded side over UNCHANGED, mark included —
    // otherwise a fold would erase the future comparison test's eligibility.
    expect(after.origin).toBe("backfill");
  });

  test("BOTH sides empty leaves the survivor's impression NULL — nothing is invented", () => {
    const task = seedFoldableLanes("fold-both-empty");

    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" });

    expect(readLaneImpression(db, task, "survivor")!.text).toBeNull();
  });

  test("the concatenation is UNCAPPED: two cap-sized impressions join whole, nothing is trimmed", () => {
    const task = seedFoldableLanes("fold-uncapped");
    const long = (label: string): string =>
      Array.from(
        { length: 30 },
        (_, index) => `${label} line ${index}: a claim the fold must keep whole (S1/T${index + 1}).`,
      ).join("\n");
    const survivorLong = long("survivor");
    const foldedLong = long("folded");
    seedLaneImpression(task, "survivor", survivorLong);
    seedLaneImpression(task, "folded", foldedLong);

    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" });

    const joined = readLaneImpression(db, task, "survivor")!.text!;
    expect(joined).toBe(`${survivorLong}\n${foldedLong}`);
    expect(countTokens(joined)).toBeGreaterThan(IMPRESSION_CAP_CEILING);
  });

  test("a lane folded TWICE without a settlement run in between holds all three texts, in fold order", () => {
    const task = createTask("fold twice", "fold-twice");
    for (const tag of ["survivor", "first", "second"]) {
      declareLane(task, tag);
    }
    seedMember(task, "fold-twice", "first");
    seedMember(task, "fold-twice", "second");
    seedLaneImpression(task, "survivor", "S: the original line.");
    seedLaneImpression(task, "first", "A: the first fold's line.");
    seedLaneImpression(task, "second", "B: the second fold's line.");

    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "first", into: "survivor" });
    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "second", into: "survivor" });

    expect(readLaneImpression(db, task, "survivor")!.text).toBe(
      "S: the original line.\nA: the first fold's line.\nB: the second fold's line.",
    );
  });
});

// ---------------------------------------------------------------------------
// Lane rename — the same fold, into a freshly minted empty row
// ---------------------------------------------------------------------------

describe("a lane rename carries the impression across the relabel", () => {
  test("the new name holds the old text BYTE FOR BYTE, with its origin, and the revision has moved", () => {
    const task = createTask("rename carries", "rename-carries");
    declareLane(task, "before");
    seedLaneImpression(task, "before", SURVIVOR_TEXT, "backfill");
    const before = readLaneImpression(db, task, "before")!;

    expect(
      resultText(rememberTool(db, { verb: "retag", id: `E${task}/#before`, tag: "after" })),
    ).toContain("Retagged E");

    const after = readLaneImpression(db, task, "after")!;
    expect(after.text).toBe(SURVIVOR_TEXT);
    expect(after.origin).toBe("backfill");
    // A rename sets no STALE flag — nothing about the line's prose became false.
    expect(after.stale).toBe(false);
    // But the fence coordinate MOVED off the minted row's zero, so a concurrent
    // run holding the pre-rename base cannot land against the new name either.
    expect(after.revision).toBeGreaterThan(0);
    expect(before.text).toBe(SURVIVOR_TEXT);
  });

  test("a rename of a lane with NO impression mints a clean empty row — no stray bytes", () => {
    const task = createTask("rename empty", "rename-empty");
    declareLane(task, "nameless");

    rememberTool(db, { verb: "retag", id: `E${task}/#nameless`, tag: "named" });

    const after = readLaneImpression(db, task, "named")!;
    expect(after.text).toBeNull();
    expect(after.origin).toBeNull();
    expect(after.revision).toBe(0);
  });

  test("an in-flight replace decided against the PRE-rename lane is fenced out — its row is gone", () => {
    const task = createTask("rename fence", "rename-fence");
    declareLane(task, "old");
    seedLaneImpression(task, "old", SURVIVOR_TEXT);
    const base = readLaneImpression(db, task, "old")!.revision;

    rememberTool(db, { verb: "retag", id: `E${task}/#old`, tag: "new" });

    expect(
      replaceLaneImpression(db, {
        segmentId: task,
        tag: "old",
        baseRevision: base,
        text: "A replacement decided against the pre-rename text.",
        origin: "settlement",
      }),
    ).toBe(false);
    expect(readLaneImpression(db, task, "new")!.text).toBe(SURVIVOR_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Task merge — the task tier, and each folded lane
// ---------------------------------------------------------------------------

describe("a task merge folds the task tier and every fused lane", () => {
  const INTO_TASK_TEXT = "The surviving task: two tiers, one fence (S1/T1).";
  const FROM_TASK_TEXT = "The donor task: the backfill never ran for closed tasks (S1/T2).";

  function seedTasks(label: string): { from: number; into: number } {
    return {
      from: createTask(`${label} from`, `${label}-from`),
      into: createTask(`${label} into`, `${label}-into`),
    };
  }

  function seedTaskImpression(segmentId: number, text: string): void {
    expect(
      replaceSegmentTaskImpression(db, {
        segmentId,
        baseRevision: readSegmentTaskImpression(db, segmentId)!.revision,
        text,
        origin: "settlement",
        nowEpoch: EPOCH,
      }),
    ).toBe(true);
  }

  test("both tiers being IMPRESSIONS, the survivor's slot holds the join — survivor first, one newline", () => {
    const { from, into } = seedTasks("task-fold");
    seedTaskImpression(into, INTO_TASK_TEXT);
    seedTaskImpression(from, FROM_TASK_TEXT);

    expect(resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` }))).toContain(
      "Merged",
    );

    expect(readSegmentTaskImpression(db, into)!.text).toBe(
      `${INTO_TASK_TEXT}\n${FROM_TASK_TEXT}`,
    );
    expect(getSegment(db, from)).toBeNull();
  });

  /**
   * THE LEGACY ARM, and it is the one that costs information if the gate is
   * missing: a phase-1 task's `content` is still done/decisions-era prose, not
   * an impression. Joining the two as impressions would mint an impression
   * nobody wrote AND drop the blank-line paragraph break the prose merge has
   * always used.
   */
  test("a LEGACY survivor keeps the prose merge (blank line) and stays origin-null", () => {
    const { from, into } = seedTasks("legacy-into");
    const legacy = "The surviving task's old content field, written by hand.";
    seedLegacyContent(into, legacy);
    seedTaskImpression(from, FROM_TASK_TEXT);

    rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` });

    expect(getSegment(db, into)!.content).toBe(`${legacy}\n\n${FROM_TASK_TEXT}`);
    // Still legacy field text by the ONE discriminator, so the card renders it
    // through the content row and no reader is told it is a model.
    expect(readSegmentTaskImpression(db, into)!.origin).toBeNull();
    expect(readSegmentTaskImpression(db, into)!.text).toBeNull();
  });

  test("a LEGACY donor keeps the prose merge too — the impression survivor is not joined to field text as a line", () => {
    const { from, into } = seedTasks("legacy-from");
    const legacy = "The donor task's old content field, written by hand.";
    seedLegacyContent(from, legacy);
    seedTaskImpression(into, INTO_TASK_TEXT);

    rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` });

    expect(getSegment(db, into)!.content).toBe(`${INTO_TASK_TEXT}\n\n${legacy}`);
  });

  test("a force-merge folds EACH colliding lane's impression onto the survivor's copy", () => {
    const { from, into } = seedTasks("force-fold");
    for (const tag of ["contested-one", "contested-two"]) {
      declareLane(from, tag);
      declareLane(into, tag);
      seedMember(from, "force-fold-from", tag);
      seedLaneImpression(into, tag, `SURVIVOR ${tag}: the line kept on the survivor.`);
      seedLaneImpression(from, tag, `DONOR ${tag}: the line carried across the merge.`);
    }

    expect(
      resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}`, force: true })),
    ).toContain("Merged");

    for (const tag of ["contested-one", "contested-two"]) {
      expect(readLaneImpression(db, into, tag)!.text).toBe(
        `SURVIVOR ${tag}: the line kept on the survivor.\n` +
          `DONOR ${tag}: the line carried across the merge.`,
      );
    }
  });

  test("a lane that merely RELOCATED keeps its impression untouched — nothing was fused, so nothing joins", () => {
    const { from, into } = seedTasks("relocate-fold");
    declareLane(from, "moved-line");
    seedMember(from, "relocate-fold-from", "moved-line");
    seedLaneImpression(from, "moved-line", FOLDED_TEXT, "backfill");
    const before = readLaneImpression(db, from, "moved-line")!;

    rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` });

    const after = readLaneImpression(db, into, "moved-line")!;
    expect(after.text).toBe(FOLDED_TEXT);
    expect(after.origin).toBe("backfill");
    expect(after.revision).toBe(before.revision);
    expect(after.stale).toBe(false);
  });
});
