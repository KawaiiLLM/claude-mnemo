import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import {
  listOpenImpressionDebts,
  readLaneImpression,
  replaceLaneImpression,
  type ImpressionDebtRecord,
} from "../../src/db/impressions";
import { getLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  getSegment,
  readSegmentTaskImpression,
  replaceSegmentTaskImpression,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { rememberTool } from "../../src/mcp/remember";
import { renderSegmentCard } from "../../src/mcp/segment-card";

/**
 * LIFECYCLE DEBTS, WRITE SIDE (lane-impressions spec Rev 8, "Lifecycle debts"
 * and "Merge staleness"; ticket 03).
 *
 * Every manual `remember` operation that can invalidate an impression leaves a
 * DURABLE, ROUTABLE obligation in the SAME transaction as the operation itself,
 * and the merge family — and only the merge family — additionally marks the
 * survivor STALE.
 *
 * One property per test, and every assertion is about a stored outcome or a
 * rendered surface, never a writer internal.
 */

const EPOCH = 1_800_000_000;

let db: Database;
let sessionId: number;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  sessionId = upsertSession(db, {
    contentSessionId: "impression-debt-session",
    project: "/tmp/project-impression-debts",
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

function createTask(title: string, tag?: string): number {
  const text = resultText(rememberTool(db, { verb: "create", title, ...(tag ? { tag } : {}) }));
  return Number(/Created E(\d+)/.exec(text)![1]);
}

function declareLane(segmentId: number, tag: string): string {
  return resultText(rememberTool(db, { verb: "create", id: `E${segmentId}/#${tag}` }));
}

/** Every open debt of one task as `<lane|task>:<kind>` pairs, oldest first — the shape the assertions read. */
function openDebts(segmentId: number): string[] {
  return listOpenImpressionDebts(db, segmentId).map(
    (debt: ImpressionDebtRecord) => `${debt.laneTag ?? "task"}:${debt.kind}`,
  );
}

/**
 * A member turn carrying its task's own tag plus any lane tags — the real
 * write-gate shape (a lane tag only counts on a turn that also carries its
 * task's tag), so a merge has a member to move.
 */
let memberPromptNumber = 500;
function seedMember(segmentId: number, taskTag: string, laneTag?: string): number {
  memberPromptNumber += 1;
  const tags = laneTag ? [taskTag, laneTag] : [taskTag];
  const id = db
    .query<{ id: number }, [number, number, string]>(
      `INSERT INTO turns (session_id, prompt_number, status, tags, created_at_epoch)
       VALUES (?, ?, 'active', ?, ${EPOCH}) RETURNING id`,
    )
    .get(sessionId, memberPromptNumber, JSON.stringify(tags))!.id;
  db.query<unknown, [number, number]>(
    `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, ${EPOCH})`,
  ).run(segmentId, id);
  return id;
}

/** Text on a lane's impression, so a STALE mark has real prose to be about. */
function seedLaneImpression(segmentId: number, tag: string, text: string): void {
  const before = readLaneImpression(db, segmentId, tag)!;
  expect(
    replaceLaneImpression(db, {
      segmentId,
      tag,
      baseRevision: before.revision,
      text,
      origin: "settlement",
    }),
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Atomicity: the debt and the operation are one write
// ---------------------------------------------------------------------------

describe("a lifecycle debt is atomic with the operation it is about", () => {
  test("a lane declaration lands the lane AND its `declare` debt", () => {
    const task = createTask("declare debt", "declare-debt");
    expect(declareLane(task, "write-gate")).toContain('Created lane "write-gate"');
    expect(openDebts(task)).toEqual(["write-gate:declare"]);
  });

  test("a declaration whose transaction ROLLS BACK leaves neither the lane nor the debt", () => {
    const task = createTask("rollback debt", "rollback-debt");
    expect(() =>
      rememberTool(
        db,
        { verb: "create", id: `E${task}/#doomed` },
        {
          // The operation's own write transaction, then a throw inside it: the
          // debt is written by the SAME transaction, so it must go back with
          // the lane. A debt inserted outside that boundary would survive here.
          runWriteTransaction: (database, fn) =>
            runWriteTransaction(database, () => {
              fn();
              throw new Error("rolled back on purpose");
            }),
        },
      ),
    ).toThrow("rolled back on purpose");
    expect(getLane(db, task, "doomed")).toBeNull();
    expect(openDebts(task)).toEqual([]);
  });

  test("a REFUSED declaration (the name is already declared) leaves no second debt", () => {
    const task = createTask("duplicate debt", "duplicate-debt");
    declareLane(task, "taken");
    expect(declareLane(task, "taken")).toContain("already declares");
    expect(openDebts(task)).toEqual(["taken:declare"]);
  });

  test("a task retag lands a TASK-TIER debt — `lane_tag` null is what makes it one", () => {
    const task = createTask("retag debt");
    expect(
      resultText(rememberTool(db, { verb: "retag", id: `E${task}`, tag: "named-now" })),
    ).toContain("is now");
    expect(openDebts(task)).toEqual(["task:task-retag"]);
    expect(listOpenImpressionDebts(db, task)[0]!.laneTag).toBeNull();
  });

  test("a REFUSED task retag (non-canonical tag) leaves no debt", () => {
    const task = createTask("bad retag debt");
    expect(
      resultText(rememberTool(db, { verb: "retag", id: `E${task}`, tag: "Not Canonical" })),
    ).toStartWith("Parameter error:");
    expect(openDebts(task)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rename: the debts follow the new name
// ---------------------------------------------------------------------------

describe("a rename re-keys its debts to the new tag", () => {
  test("the old key is emptied and the new key holds both the moved debt and the rename's own", () => {
    const task = createTask("rename debt", "rename-debt");
    declareLane(task, "old-name");

    expect(
      resultText(
        rememberTool(db, { verb: "retag", id: `E${task}/#old-name`, tag: "new-name" }),
      ),
    ).toContain('Retagged E');

    expect(openDebts(task)).toEqual(["new-name:declare", "new-name:rename"]);
    expect(
      listOpenImpressionDebts(db, task).every((debt) => debt.laneTag === "new-name"),
    ).toBe(true);
  });

  test("a rename sets NO stale flag — nothing about the line's prose became false", () => {
    const task = createTask("rename not stale", "rename-not-stale");
    declareLane(task, "before");
    seedLaneImpression(task, "before", "The line, named wrong.");

    rememberTool(db, { verb: "retag", id: `E${task}/#before`, tag: "after" });

    expect(readLaneImpression(db, task, "after")!.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lane merge: survivor key, STALE, and the collapse
// ---------------------------------------------------------------------------

describe("a lane merge leaves only the survivor's key, and marks it STALE", () => {
  function seedMergeableLanes(taskTag: string): { task: number } {
    const task = createTask(`merge ${taskTag}`, taskTag);
    declareLane(task, "folded");
    declareLane(task, "survivor");
    seedMember(task, taskTag, "folded");
    return { task };
  }

  test("every open debt ends up on the survivor's key, and the folded key holds none", () => {
    const { task } = seedMergeableLanes("lane-merge-keys");

    expect(
      resultText(
        rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" }),
      ),
    ).toContain("Merged");

    expect(
      listOpenImpressionDebts(db, task).some((debt) => debt.laneTag === "folded"),
    ).toBe(false);
    expect(openDebts(task)).toContain("survivor:merge");
  });

  test("the survivor's impression goes STALE and its fence moves, so an in-flight decision cannot land over the fusion", () => {
    const { task } = seedMergeableLanes("lane-merge-stale");
    seedLaneImpression(task, "survivor", "The surviving line, before the fusion.");
    const before = readLaneImpression(db, task, "survivor")!;
    expect(before.stale).toBe(false);

    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" });

    const after = readLaneImpression(db, task, "survivor")!;
    expect(after.stale).toBe(true);
    // The prose is NOT destroyed — the display suppresses it while stale, and
    // only a qualified CAS rewrite replaces it.
    expect(after.text).toBe("The surviving line, before the fusion.");
    // The revision moved: a run holding `before.revision` is now fenced out.
    expect(after.revision).toBe(before.revision + 1);
  });

  test("the collapse dedups per KIND: two open `declare` debts become one on the survivor", () => {
    const { task } = seedMergeableLanes("lane-merge-collapse");

    rememberTool(db, { verb: "merge", id: `E${task}`, tag: "folded", into: "survivor" });

    const declares = listOpenImpressionDebts(db, task).filter(
      (debt) => debt.kind === "declare" && debt.laneTag === "survivor",
    );
    expect(declares).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Task merge: the surviving task tier, and each folded lane
// ---------------------------------------------------------------------------

describe("a task merge marks the surviving task tier STALE and debts each folded lane", () => {
  function seedTasks(label: string): { from: number; into: number } {
    const from = createTask(`${label} from`, `${label}-from`);
    const into = createTask(`${label} into`, `${label}-into`);
    return { from, into };
  }

  test("the survivor's task tier goes STALE and takes a `task-merge` debt", () => {
    const { from, into } = seedTasks("task-merge");
    expect(
      replaceSegmentTaskImpression(db, {
        segmentId: into,
        baseRevision: 0,
        text: "The surviving task, before the fusion.",
        origin: "settlement",
        nowEpoch: EPOCH,
      }),
    ).toBe(true);
    const before = readSegmentTaskImpression(db, into)!;

    expect(
      resultText(rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` })),
    ).toContain("Merged");

    const after = readSegmentTaskImpression(db, into)!;
    expect(after.stale).toBe(true);
    expect(after.revision).toBe(before.revision + 1);
    expect(openDebts(into)).toContain("task:task-merge");
  });

  test("a force-merge STALEs EACH folded survivor lane and gives each its own `merge` debt", () => {
    const { from, into } = seedTasks("force-fold");
    for (const tag of ["contested-one", "contested-two"]) {
      declareLane(from, tag);
      declareLane(into, tag);
      seedMember(from, "force-fold-from", tag);
      seedLaneImpression(into, tag, `The surviving ${tag} line.`);
    }

    expect(
      resultText(
        rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}`, force: true }),
      ),
    ).toContain("Merged");

    for (const tag of ["contested-one", "contested-two"]) {
      expect(readLaneImpression(db, into, tag)!.stale).toBe(true);
      expect(openDebts(into)).toContain(`${tag}:merge`);
    }
  });

  test("a lane that merely RELOCATED is not stale and takes no merge debt — nothing about it was fused", () => {
    const { from, into } = seedTasks("relocate");
    declareLane(from, "moved-line");
    seedMember(from, "relocate-from", "moved-line");

    rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` });

    expect(getLane(db, into, "moved-line")).not.toBeNull();
    expect(readLaneImpression(db, into, "moved-line")!.stale).toBe(false);
    expect(openDebts(into)).not.toContain("moved-line:merge");
  });

  test("the source's own open lane debts move to the survivor instead of dying with its row", () => {
    const { from, into } = seedTasks("carry-debt");
    // `create` on the lane tier left a `declare` debt keyed to E<from>.
    declareLane(from, "moved-line");
    seedMember(from, "carry-debt-from", "moved-line");
    expect(openDebts(from)).toEqual(["moved-line:declare"]);

    rememberTool(db, { verb: "merge", id: `E${from}`, into: `E${into}` });

    expect(getSegment(db, from)).toBeNull();
    expect(openDebts(into)).toContain("moved-line:declare");
  });
});

// ---------------------------------------------------------------------------
// A deleted source row takes its impression and its debts with it
// ---------------------------------------------------------------------------

describe("a deleted source row's impression and debts die with it", () => {
  test("deleting a task cascades its lanes, their impressions and every one of its debts", () => {
    const task = createTask("cascade", "cascade");
    declareLane(task, "doomed-line");
    seedLaneImpression(task, "doomed-line", "A line about to stop existing.");
    rememberTool(db, { verb: "retag", id: `E${task}`, tag: "cascade-renamed" });
    expect(openDebts(task)).toHaveLength(2);

    // The lane must go first — `delete`'s task tier refuses while one stands.
    rememberTool(db, { verb: "delete", id: `E${task}/#doomed-line` });
    expect(resultText(rememberTool(db, { verb: "delete", id: `E${task}` }))).toContain(
      "Deleted",
    );

    expect(getSegment(db, task)).toBeNull();
    expect(
      db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM impression_debts WHERE segment_id = ?",
        )
        .get(task)!.n,
    ).toBe(0);
  });

  test("deleting a lane takes its impression text with the row", () => {
    const task = createTask("lane cascade", "lane-cascade");
    declareLane(task, "temporary");
    seedLaneImpression(task, "temporary", "Text that dies with the row.");

    rememberTool(db, { verb: "delete", id: `E${task}/#temporary` });
    declareLane(task, "temporary");

    expect(readLaneImpression(db, task, "temporary")!.text).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A waiting debt shows on no reader surface
// ---------------------------------------------------------------------------

describe("a non-merge debt waits durably with no reader-surface marker", () => {
  test("a task-retag debt changes the card by NOT ONE BYTE — the retag it rode in on is undone first", () => {
    const task = createTask("no marker", "no-marker");
    const before = renderSegmentCard(db, task, {});

    // A `task-retag` debt, then the retag itself REVERSED: the card's own
    // inputs are back exactly where they started while the two debts stand.
    rememberTool(db, { verb: "retag", id: `E${task}`, tag: "no-marker-renamed" });
    rememberTool(db, { verb: "retag", id: `E${task}`, tag: "no-marker" });
    expect(openDebts(task)).toEqual(["task:task-retag", "task:task-retag"]);

    expect(renderSegmentCard(db, task, {})).toBe(before);
  });

  test("neither tier carries the merge family's STALE flag for a declare or a retag", () => {
    const task = createTask("no stale", "no-stale");
    declareLane(task, "pending-line");
    rememberTool(db, { verb: "retag", id: `E${task}`, tag: "no-stale-renamed" });

    expect(openDebts(task)).toEqual(["pending-line:declare", "task:task-retag"]);
    // The STALE flag is the ONE thing a reader surface is ever told about
    // (spec "Merge staleness": only the merge family, which falsifies prose,
    // sets it). A waiting non-merge debt sets neither tier's.
    expect(readSegmentTaskImpression(db, task)!.stale).toBe(false);
    expect(readLaneImpression(db, task, "pending-line")!.stale).toBe(false);
  });
});
