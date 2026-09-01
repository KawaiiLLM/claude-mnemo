import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import {
  readLaneImpression,
  replaceLaneImpression,
} from "../../src/db/impressions";
import { insertLane, mergeLaneTag } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  createSegment,
  getSegment,
  readSegmentTaskImpression,
  replaceSegmentTaskImpression,
  toggleSegmentStatus,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { updateTurnById } from "../../src/db/turns";
import {
  admissibleAnchorAddresses,
  assembleBackfillInput,
  captureBackfillSourceSnapshot,
  commitImpressionBackfill,
  compareBackfillSourceSnapshots,
  ImpressionBackfillRefused,
  listTasksCarryingLegacyFields,
  loadBackfillAnchorIndex,
  parseBackfillBatch,
  type BackfillSourceSnapshot,
} from "../../src/worker/impression-backfill";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * THE LEGACY BACKFILL'S COMMIT PATH (lane-impressions spec Rev 8, "Legacy
 * backfill"; ticket 05). Every assertion below is about a TRANSACTION OUTCOME
 * or a STORED ROW — never a writer internal.
 *
 * THE FENCE FIXTURES MOVE ONE COORDINATE AT A TIME, deliberately: a lane merge
 * moves BOTH the roster and the member index, so a suite that only tested a
 * merge could not tell which coordinate was doing the work. Each of the five
 * coordinates therefore gets its own minimal mutation, and each asserts the
 * message that names IT.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  sessionDbId: number;
  segmentId: number;
  turnIds: number[];
}

function seedSession(contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-backfill",
    title: "backfill fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 1, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      SETTLEMENT_ERA_CUTOFF_EPOCH + promptNumber,
    )!.id;
}

/**
 * One task carrying all four legacy fields, two declared lanes, three member
 * turns — turn 1 and 2 in `#alpha`, turn 3 in `#beta`.
 */
function seedFixture(options: { lanes?: string[]; title?: string } = {}): Fixture {
  const lanes = options.lanes ?? ["alpha", "beta"];
  const sessionDbId = seedSession("backfill-fixture-session");
  const segmentId = createSegment(db, {
    title: options.title ?? "backfill fixture task",
    content: "The task's legacy content blob.",
    insight: null,
    type: [],
    tags: ["backfill-fixture"],
    nowEpoch: NOW - 5_000,
  }).id;
  const turnIds = [1, 2, 3].map((promptNumber) => seedTurn(sessionDbId, promptNumber));
  addSegmentMembers(db, segmentId, turnIds, NOW);
  for (const tag of lanes) {
    insertLane(db, segmentId, tag, NOW - 4_000);
  }
  updateTurnById(db, turnIds[0]!, {
    type: ["design"],
    tags: ["backfill-fixture", "alpha"],
    updatedAtEpoch: NOW,
  });
  updateTurnById(db, turnIds[1]!, {
    type: ["design"],
    tags: ["backfill-fixture", "alpha"],
    updatedAtEpoch: NOW,
  });
  updateTurnById(db, turnIds[2]!, {
    type: ["design"],
    tags: ["backfill-fixture", "beta"],
    updatedAtEpoch: NOW,
  });
  appendSegmentWorkingStateRows(db, segmentId, "done", ["the alpha decision is settled"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "decisions", ["alpha binds beta"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "next_steps", ["beta is still open"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "goal", ["ship the fixture"], NOW);
  return { sessionDbId, segmentId, turnIds };
}

/** A legal lane impression: one global line, anchors that resolve AND sit in the index. */
function laneText(fixture: Fixture, tag: string): string {
  return `The #${tag} lane: one decision governs it and still holds (S${fixture.sessionDbId}/T1, T2).`;
}

function taskText(fixture: Fixture): string {
  return `E${fixture.segmentId}: two lanes, one arc, and the second is still open (S${fixture.sessionDbId}/T3).`;
}

function legalBatch(fixture: Fixture): Record<string, unknown> {
  return {
    lanes: [
      { tag: "alpha", text: laneText(fixture, "alpha") },
      { tag: "beta", text: laneText(fixture, "beta") },
    ],
    task: taskText(fixture),
    unresolved: [],
  };
}

interface CommitAttempt {
  snapshot: BackfillSourceSnapshot;
  refusal: ImpressionBackfillRefused | null;
}

/**
 * The whole job shape in one helper: assemble the input (which captures the
 * source snapshot), let `midCall` stand in for whatever landed while the model
 * was generating, then commit inside a real write transaction.
 */
function attemptCutover(
  fixture: Fixture,
  batch: unknown,
  midCall?: () => void,
): CommitAttempt {
  const input = assembleBackfillInput(db, fixture.segmentId);
  if (input === null) {
    throw new Error("fixture segment vanished");
  }
  midCall?.();
  try {
    runWriteTransaction(db, () =>
      commitImpressionBackfill(db, {
        segmentId: fixture.segmentId,
        snapshot: input.snapshot,
        rawBatch: batch,
        nowEpoch: NOW,
      }),
    );
    return { snapshot: input.snapshot, refusal: null };
  } catch (error) {
    if (error instanceof ImpressionBackfillRefused) {
      return { snapshot: input.snapshot, refusal: error };
    }
    throw error;
  }
}

function refusalOf(attempt: CommitAttempt): ImpressionBackfillRefused {
  if (attempt.refusal === null) {
    throw new Error("expected a refusal, but the cutover committed");
  }
  return attempt.refusal;
}

/** The three fields the cutover retires, exactly as stored. */
function retiringFields(segmentId: number): {
  done: string | null;
  decisions: string | null;
  nextSteps: string | null;
} {
  const segment = getSegment(db, segmentId)!;
  return { done: segment.done, decisions: segment.decisions, nextSteps: segment.nextSteps };
}

// ---------------------------------------------------------------------------
// Coverage — by query
// ---------------------------------------------------------------------------

describe("coverage is a query over every task carrying legacy fields", () => {
  test("open, closed and retired-vocabulary tasks all appear; a task with no legacy field does not", () => {
    const open = seedFixture({ title: "open task" });

    const closedId = createSegment(db, {
      title: "closed task",
      content: null,
      insight: null,
      type: [],
      tags: ["closed-task"],
      nowEpoch: NOW,
    }).id;
    appendSegmentWorkingStateRows(db, closedId, "next_steps", ["still owed"], NOW);
    toggleSegmentStatus(db, closedId, NOW);
    expect(getSegment(db, closedId)!.status).toBe("closed");

    // Production still holds the retired arc-era words on most legacy rows; the
    // coverage query must not name a status at all.
    const deliveredId = createSegment(db, {
      title: "delivered task",
      content: "a delivered arc's content",
      insight: null,
      type: [],
      tags: ["delivered-task"],
      nowEpoch: NOW,
    }).id;
    db.query("UPDATE segments SET status = 'delivered' WHERE id = ?").run(deliveredId);

    const emptyId = createSegment(db, {
      title: "nothing to migrate",
      content: null,
      insight: null,
      type: [],
      tags: ["empty-task"],
      nowEpoch: NOW,
    }).id;

    const covered = listTasksCarryingLegacyFields(db).map((task) => task.segmentId);
    expect(covered).toContain(open.segmentId);
    expect(covered).toContain(closedId);
    expect(covered).toContain(deliveredId);
    expect(covered).not.toContain(emptyId);
  });

  test("a task whose content is already an impression and whose narrative fields are empty is NOT covered", () => {
    const fixture = seedFixture();
    expect(
      listTasksCarryingLegacyFields(db).map((task) => task.segmentId),
    ).toContain(fixture.segmentId);

    expect(attemptCutover(fixture, legalBatch(fixture)).refusal).toBeNull();

    expect(
      listTasksCarryingLegacyFields(db).map((task) => task.segmentId),
    ).not.toContain(fixture.segmentId);
  });

  test("the list is ordered largest-source-first — the scale gate reads its subject off the top", () => {
    const small = createSegment(db, {
      title: "small",
      content: "x",
      insight: null,
      type: [],
      tags: ["small-task"],
      nowEpoch: NOW,
    }).id;
    const big = createSegment(db, {
      title: "big",
      content: "y".repeat(5_000),
      insight: null,
      type: [],
      tags: ["big-task"],
      nowEpoch: NOW,
    }).id;

    const covered = listTasksCarryingLegacyFields(db);
    expect(covered[0]!.segmentId).toBe(big);
    expect(covered[0]!.sourceChars).toBeGreaterThan(covered[1]!.sourceChars);
    expect(covered.map((task) => task.segmentId)).toContain(small);
  });
});

// ---------------------------------------------------------------------------
// The happy path — the cutover itself
// ---------------------------------------------------------------------------

describe("the atomic batch cuts one task over", () => {
  test("seeds both tiers with origin=backfill, replaces content, and retires the three fields", () => {
    const fixture = seedFixture();
    expect(attemptCutover(fixture, legalBatch(fixture)).refusal).toBeNull();

    const alpha = readLaneImpression(db, fixture.segmentId, "alpha")!;
    expect(alpha.text).toBe(laneText(fixture, "alpha"));
    expect(alpha.origin).toBe("backfill");

    const beta = readLaneImpression(db, fixture.segmentId, "beta")!;
    expect(beta.origin).toBe("backfill");

    const task = readSegmentTaskImpression(db, fixture.segmentId)!;
    expect(task.origin).toBe("backfill");
    expect(task.text).toBe(taskText(fixture));

    expect(retiringFields(fixture.segmentId)).toEqual({
      done: null,
      decisions: null,
      nextSteps: null,
    });
  });

  test("goal, constraints, reference and insight are NOT touched", () => {
    const fixture = seedFixture();
    appendSegmentWorkingStateRows(db, fixture.segmentId, "reference", ["spec.md"], NOW);
    appendSegmentWorkingStateRows(db, fixture.segmentId, "insight", ["reusable"], NOW);
    const before = getSegment(db, fixture.segmentId)!;

    expect(attemptCutover(fixture, legalBatch(fixture)).refusal).toBeNull();

    const after = getSegment(db, fixture.segmentId)!;
    expect(after.goal).toBe(before.goal);
    expect(after.reference).toBe(before.reference);
    expect(after.insight).toBe(before.insight);
  });

  test("a declared lane the fields say nothing about simply gets no impression — nothing is invented for it", () => {
    const fixture = seedFixture();
    const batch = {
      lanes: [{ tag: "alpha", text: laneText(fixture, "alpha") }],
      task: taskText(fixture),
      unresolved: [],
    };
    expect(attemptCutover(fixture, batch).refusal).toBeNull();

    expect(readLaneImpression(db, fixture.segmentId, "beta")!.text).toBeNull();
    // …and the cutover still happened: the task tier is what flips it.
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.origin).toBe("backfill");
  });

  test("a batch without a task-tier impression is refused — that text IS the cutover", () => {
    const fixture = seedFixture();
    const refusal = refusalOf(
      attemptCutover(fixture, { lanes: [{ tag: "alpha", text: laneText(fixture, "alpha") }] }),
    );
    expect(refusal.kind).toBe("malformed");
    expect(refusal.message).toContain('"task" is required');
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.origin).toBeNull();
  });

  test("a lane the task has not declared is refused by the roster check", () => {
    const fixture = seedFixture();
    const batch = legalBatch(fixture);
    (batch.lanes as Array<Record<string, unknown>>).push({
      tag: "gamma",
      text: laneText(fixture, "gamma"),
    });
    const refusal = refusalOf(attemptCutover(fixture, batch));
    expect(refusal.kind).toBe("roster");
    expect(refusal.message).toContain("#gamma");
    expect(retiringFields(fixture.segmentId).done).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The source-snapshot fence — one coordinate per fixture
// ---------------------------------------------------------------------------

describe("the source-snapshot fence rejects every input that moved mid-generation", () => {
  test("a field APPENDED mid-model-call rejects, naming the retiring fields, and nothing is cleared", () => {
    const fixture = seedFixture();
    const refusal = refusalOf(
      attemptCutover(fixture, legalBatch(fixture), () => {
        appendSegmentWorkingStateRows(
          db,
          fixture.segmentId,
          "decisions",
          ["a ruling that landed while the model was writing"],
          NOW + 1,
        );
      }),
    );

    expect(refusal.kind).toBe("snapshot-fence");
    expect(refusal.message).toContain("the retiring fields");
    expect(refusal.regenerable).toBe(true);
    // The whole point: the appended ruling is still there, unswallowed.
    expect(retiringFields(fixture.segmentId).decisions).toContain(
      "a ruling that landed while the model was writing",
    );
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.origin).toBeNull();
  });

  test("a LANE MERGE mid-model-call rejects", () => {
    const fixture = seedFixture();
    const refusal = refusalOf(
      attemptCutover(fixture, legalBatch(fixture), () => {
        runWriteTransaction(db, () =>
          mergeLaneTag(db, fixture.segmentId, "beta", "alpha", NOW + 1),
        );
      }),
    );

    expect(refusal.kind).toBe("snapshot-fence");
    expect(refusal.regenerable).toBe(true);
    expect(retiringFields(fixture.segmentId).done).not.toBeNull();
  });

  test("a lane DECLARE moves the ROSTER alone, and the refusal names the roster", () => {
    const fixture = seedFixture();
    const refusal = refusalOf(
      attemptCutover(fixture, legalBatch(fixture), () => {
        insertLane(db, fixture.segmentId, "gamma", NOW + 1);
      }),
    );

    expect(refusal.kind).toBe("snapshot-fence");
    expect(refusal.message).toContain("declared-lane roster moved");
    // A declare touches no turn's tags and no field.
    expect(refusal.message).not.toContain("member/anchor index moved");
    expect(refusal.message).not.toContain("the retiring fields");
  });

  test("a member's LANE WORDS moving rewrites the member index alone, and the refusal names the index", () => {
    const fixture = seedFixture();
    const refusal = refusalOf(
      attemptCutover(fixture, legalBatch(fixture), () => {
        updateTurnById(db, fixture.turnIds[2]!, {
          type: ["design"],
          tags: ["backfill-fixture", "alpha"],
          updatedAtEpoch: NOW + 1,
        });
      }),
    );

    expect(refusal.kind).toBe("snapshot-fence");
    expect(refusal.message).toContain("member/anchor index moved");
    expect(refusal.message).not.toContain("declared-lane roster moved");
  });

  test("a settlement replacement on ONE lane moves that lane's fence alone", () => {
    const fixture = seedFixture();
    const refusal = refusalOf(
      attemptCutover(fixture, legalBatch(fixture), () => {
        expect(
          replaceLaneImpression(db, {
            segmentId: fixture.segmentId,
            tag: "beta",
            baseRevision: 0,
            text: `Settlement got here first (S${fixture.sessionDbId}/T3).`,
            origin: "settlement",
          }),
        ).toBe(true);
      }),
    );

    expect(refusal.kind).toBe("snapshot-fence");
    expect(refusal.message).toContain("lane #beta's impression moved");
    expect(refusal.message).not.toContain("task-tier impression moved");
    // The settlement text survives: a backfill may not clobber it.
    expect(readLaneImpression(db, fixture.segmentId, "beta")!.origin).toBe("settlement");
  });

  test("a task-tier write moves the task tier's fence alone", () => {
    const fixture = seedFixture();
    const refusal = refusalOf(
      attemptCutover(fixture, legalBatch(fixture), () => {
        expect(
          replaceSegmentTaskImpression(db, {
            segmentId: fixture.segmentId,
            baseRevision: 0,
            text: `Settlement got to the task tier first (S${fixture.sessionDbId}/T1).`,
            origin: "settlement",
            nowEpoch: NOW + 1,
          }),
        ).toBe(true);
      }),
    );

    expect(refusal.kind).toBe("snapshot-fence");
    expect(refusal.message).toContain("task-tier impression moved");
    expect(refusal.message).not.toContain("lane #");
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.origin).toBe("settlement");
  });

  test("an unmoved snapshot compares clean", () => {
    const fixture = seedFixture();
    const first = captureBackfillSourceSnapshot(db, fixture.segmentId)!;
    const second = captureBackfillSourceSnapshot(db, fixture.segmentId)!;
    expect(compareBackfillSourceSnapshots(first, second)).toEqual([]);
  });

  test("a NULL field and an emptied one are different digests — clearing is a move, not a no-op", () => {
    const fixture = seedFixture();
    const before = captureBackfillSourceSnapshot(db, fixture.segmentId)!;
    db.query("UPDATE segments SET done = '' WHERE id = ?").run(fixture.segmentId);
    const emptied = captureBackfillSourceSnapshot(db, fixture.segmentId)!;
    db.query("UPDATE segments SET done = NULL WHERE id = ?").run(fixture.segmentId);
    const nulled = captureBackfillSourceSnapshot(db, fixture.segmentId)!;

    expect(before.sourceFields).not.toBe(emptied.sourceFields);
    expect(emptied.sourceFields).not.toBe(nulled.sourceFields);
  });
});

// ---------------------------------------------------------------------------
// Anchor re-sourcing
// ---------------------------------------------------------------------------

describe("anchors are re-sourced through the member/anchor index", () => {
  test("the index carries every live member with its address and its lane words", () => {
    const fixture = seedFixture();
    const index = loadBackfillAnchorIndex(db, fixture.segmentId, ["alpha", "beta"]);

    expect(index.map((row) => row.address)).toEqual([
      `S${fixture.sessionDbId}/T1`,
      `S${fixture.sessionDbId}/T2`,
      `S${fixture.sessionDbId}/T3`,
    ]);
    expect(index[0]!.laneTags).toEqual(["alpha"]);
    expect(index[2]!.laneTags).toEqual(["beta"]);
    // The task's own word is not a lane and does not enter the index's lane set.
    expect(index[0]!.laneTags).not.toContain("backfill-fixture");
    expect([...admissibleAnchorAddresses(index)]).toHaveLength(3);
  });

  test("an anchor that resolves to a REAL turn outside this task's index is refused", () => {
    const fixture = seedFixture();
    // A real, resolvable turn — in a different session, owned by nothing this
    // task's index shows.
    const strangerSession = seedSession("stranger-session");
    seedTurn(strangerSession, 1);

    const batch = legalBatch(fixture);
    (batch.lanes as Array<Record<string, unknown>>)[0] = {
      tag: "alpha",
      text: `The #alpha lane rests on somebody else's turn (S${strangerSession}/T1).`,
    };

    const refusal = refusalOf(attemptCutover(fixture, batch));
    expect(refusal.kind).toBe("anchor-index");
    expect(refusal.message).toContain(`S${strangerSession}/T1`);
    expect(refusal.message).toContain("member/anchor index");
    expect(refusal.regenerable).toBe(true);
    expect(retiringFields(fixture.segmentId).done).not.toBeNull();
  });

  test("a rolled-back member leaves the index, and citing it is refused", () => {
    const fixture = seedFixture();
    db.query("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(fixture.turnIds[2]!);

    const index = loadBackfillAnchorIndex(db, fixture.segmentId, ["alpha", "beta"]);
    expect(index.map((row) => row.address)).not.toContain(`S${fixture.sessionDbId}/T3`);

    const refusal = refusalOf(attemptCutover(fixture, legalBatch(fixture)));
    expect(refusal.kind).toBe("anchor-index");
    expect(refusal.message).toContain(`S${fixture.sessionDbId}/T3`);
  });

  test("an anchor naming no turn at all is refused by the shared validator, not by the index check", () => {
    const fixture = seedFixture();
    const batch = legalBatch(fixture);
    (batch.lanes as Array<Record<string, unknown>>)[0] = {
      tag: "alpha",
      text: `The #alpha lane rests on nothing (S${fixture.sessionDbId}/T99).`,
    };

    const refusal = refusalOf(attemptCutover(fixture, batch));
    // The index check runs first and catches it too, which is correct: an
    // address the index never showed is inadmissible whether or not it resolves.
    expect(refusal.kind).toBe("anchor-index");
  });

  test("the deterministic validator still binds: a delivery word with no anchor rejects", () => {
    const fixture = seedFixture();
    const batch = legalBatch(fixture);
    (batch.lanes as Array<Record<string, unknown>>)[0] = {
      tag: "alpha",
      text: "The #alpha lane shipped.",
    };

    const refusal = refusalOf(attemptCutover(fixture, batch));
    expect(refusal.kind).toBe("validator");
    expect(refusal.message).toContain("delivery-anchor");
    expect(retiringFields(fixture.segmentId).done).not.toBeNull();
  });

  test("a lane text over its cap rejects and nothing lands", () => {
    const fixture = seedFixture();
    const batch = legalBatch(fixture);
    (batch.lanes as Array<Record<string, unknown>>)[0] = {
      tag: "alpha",
      // A lane with no settled member caps at 100 tokens.
      text: `The #alpha lane ${"and more words ".repeat(80)}(S${fixture.sessionDbId}/T1).`,
    };

    const refusal = refusalOf(attemptCutover(fixture, batch));
    expect(refusal.kind).toBe("validator");
    expect(refusal.message).toContain("line-1-cap");
    expect(readLaneImpression(db, fixture.segmentId, "alpha")!.text).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unresolved refuses cutover
// ---------------------------------------------------------------------------

describe("unresolved content refuses the cutover", () => {
  test("the fields stay POPULATED, byte for byte, and the card is left un-slimmed", () => {
    const fixture = seedFixture();
    const before = retiringFields(fixture.segmentId);
    expect(before.done).not.toBeNull();

    const batch = legalBatch(fixture);
    batch.unresolved = [
      { claim: "the 2019 rewrite was abandoned", reason: "belongs to no declared lane" },
    ];

    const refusal = refusalOf(attemptCutover(fixture, batch));

    expect(refusal.kind).toBe("unresolved");
    // THE ASSERTION THAT MATTERS: not "the job failed", but "the source is
    // still there". A refusal that lost the fields would pass a weaker test.
    expect(retiringFields(fixture.segmentId)).toEqual(before);
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.origin).toBeNull();
    expect(readLaneImpression(db, fixture.segmentId, "alpha")!.text).toBeNull();
    expect(readLaneImpression(db, fixture.segmentId, "beta")!.text).toBeNull();
  });

  test("the job REPORTS what could not be placed, claim and reason both", () => {
    const fixture = seedFixture();
    const batch = legalBatch(fixture);
    batch.unresolved = [
      { claim: "the 2019 rewrite was abandoned", reason: "belongs to no declared lane" },
    ];

    const refusal = refusalOf(attemptCutover(fixture, batch));
    expect(refusal.message).toContain("the 2019 rewrite was abandoned");
    expect(refusal.message).toContain("belongs to no declared lane");
    expect(refusal.unresolved).toEqual([
      { claim: "the 2019 rewrite was abandoned", reason: "belongs to no declared lane" },
    ]);
  });

  test("an unresolved report is NOT regenerable — asking again cannot place it", () => {
    const fixture = seedFixture();
    const batch = legalBatch(fixture);
    batch.unresolved = [{ claim: "orphan", reason: "no lane" }];
    expect(refusalOf(attemptCutover(fixture, batch)).regenerable).toBe(false);
  });

  test("unresolved outranks a source-snapshot drift — the operator sees the mapping problem, not the fence", () => {
    const fixture = seedFixture();
    const batch = legalBatch(fixture);
    batch.unresolved = [{ claim: "orphan", reason: "no lane" }];

    const refusal = refusalOf(
      attemptCutover(fixture, batch, () => {
        insertLane(db, fixture.segmentId, "gamma", NOW + 1);
      }),
    );
    expect(refusal.kind).toBe("unresolved");
  });

  test("no residual container is created for what could not be placed", () => {
    const fixture = seedFixture();
    const lanesBefore = db
      .query<{ n: number }, [number]>("SELECT count(*) AS n FROM lanes WHERE segment_id = ?")
      .get(fixture.segmentId)!.n;

    const batch = legalBatch(fixture);
    batch.unresolved = [{ claim: "orphan", reason: "no lane" }];
    refusalOf(attemptCutover(fixture, batch));

    expect(
      db
        .query<{ n: number }, [number]>("SELECT count(*) AS n FROM lanes WHERE segment_id = ?")
        .get(fixture.segmentId)!.n,
    ).toBe(lanesBefore);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM segments").get()!.n,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Atomicity and order
// ---------------------------------------------------------------------------

describe("the batch is atomic, and its order is the spec's", () => {
  test("a validator rejection on the SECOND lane leaves the FIRST lane unwritten too", () => {
    const fixture = seedFixture();
    const batch = legalBatch(fixture);
    (batch.lanes as Array<Record<string, unknown>>)[1] = {
      tag: "beta",
      text: "The #beta lane landed.",
    };

    expect(refusalOf(attemptCutover(fixture, batch)).kind).toBe("validator");
    expect(readLaneImpression(db, fixture.segmentId, "alpha")!.text).toBeNull();
    expect(readLaneImpression(db, fixture.segmentId, "beta")!.text).toBeNull();
    expect(retiringFields(fixture.segmentId).done).not.toBeNull();
  });

  test("no reachable state has a retired field and no successor: origin flips iff the fields cleared", () => {
    const fixture = seedFixture();

    const orphanedRetirements = (): number =>
      db
        .query<{ n: number }, []>(
          `SELECT count(*) AS n FROM segments
            WHERE impression_origin IS NULL
              AND done IS NULL AND decisions IS NULL AND next_steps IS NULL
              AND id = (SELECT MIN(id) FROM segments)`,
        )
        .get()!.n;

    expect(orphanedRetirements()).toBe(0);
    refusalOf(
      attemptCutover(fixture, { ...legalBatch(fixture), unresolved: [{ claim: "x", reason: "y" }] }),
    );
    expect(orphanedRetirements()).toBe(0);

    expect(attemptCutover(fixture, legalBatch(fixture)).refusal).toBeNull();
    expect(orphanedRetirements()).toBe(0);
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.origin).toBe("backfill");
  });
});

// ---------------------------------------------------------------------------
// The batch parser
// ---------------------------------------------------------------------------

describe("the output batch is parsed and MEASURED", () => {
  test("bytes are the UTF-8 serialized size, CJK included", () => {
    const ascii = parseBackfillBatch({ task: "abc", lanes: [], unresolved: [] });
    const cjk = parseBackfillBatch({ task: "字字字", lanes: [], unresolved: [] });
    expect(ascii.bytes).toBeLessThan(cjk.bytes);
  });

  test("one lane may not be judged twice", () => {
    const parsed = parseBackfillBatch({
      task: "t",
      lanes: [
        { tag: "alpha", text: "a" },
        { tag: "alpha", text: "b" },
      ],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain("more than once");
  });

  test("a leading # on a tag is tolerated, because the roster check is what decides", () => {
    const parsed = parseBackfillBatch({ task: "t", lanes: [{ tag: "#alpha", text: "a" }] });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.batch.lanes[0]!.tag : "").toBe("alpha");
  });

  test("an unresolved entry without a reason is malformed — a report nobody can act on is not a report", () => {
    const parsed = parseBackfillBatch({
      task: "t",
      lanes: [],
      unresolved: [{ claim: "orphan" }],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain("reason");
  });
});
