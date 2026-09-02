import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  getSegmentMemberTurnIds,
  writeMembershipTags,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  claimWriterId,
  recordReadGrant,
  snapshotWriteGateSequence,
} from "../../src/db/write-gate";
import { noteInputShape } from "../../src/mcp/definitions";
import {
  evaluateSettlementTurnWrite,
  renderSettlementTurnWriteReceipt,
  settlementTurnWriteInputSchema,
  settlementTurnWriteInputShape,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteEvaluation,
  type SettlementTurnWriteInput,
} from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * THE BATCH TAG WRITE (settlement-read-once spec D4; ticket 02).
 *
 * `note(turns: […], task: "E<n>", addTags: […])` — SETTLEMENT-ONLY, tags-only,
 * additive, all-or-nothing, one transaction. It exists so that tagging a
 * topic's N turns costs one round trip and one result rather than N of each,
 * and it is fixed in shape on purpose: there is no assignment verb (T2386),
 * and seeding never moves a turn between tasks.
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

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-batch-tag-write",
    project: "/tmp/project-batch-tag",
    title: "batch tag fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number, tags: string[] = []): number {
  return db
    .query<{ id: number }, [number, number, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tags, created_at_epoch
       ) VALUES (?, ?, 'extracted', 'p', 'r', ?, ?)
       RETURNING id`,
    )
    .get(sessionDbId, promptNumber, JSON.stringify(tags), NOW - 1_000 + promptNumber)!.id;
}

function claimWindow(sessionDbId: number): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 9, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

function contextFor(
  job: NoteSettlementJob,
  reviewableTurnIds: number[],
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    stage: job.stage,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(reviewableTurnIds),
    contextBuiltAtEpoch: NOW,
  };
}

function write(
  context: SettlementTurnFacadeContext,
  input: SettlementTurnWriteInput,
): SettlementTurnWriteEvaluation {
  return evaluateSettlementTurnWrite(db, context, input, NOW);
}

function storedTags(turnId: number): string[] {
  const raw = db
    .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
    .get(turnId)!.tags;
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}

/** A named task with two declared lanes, plus a window of three tagged-nothing turns. */
function fixture(): {
  sessionDbId: number;
  job: NoteSettlementJob;
  segmentId: number;
  turns: number[];
  context: SettlementTurnFacadeContext;
} {
  const sessionDbId = seedSession();
  const segmentId = createSegment(db, {
    title: "the pager work",
    tags: ["pager-task"],
    nowEpoch: NOW,
  }).id;
  insertLane(db, segmentId, "pager-lane", NOW);
  insertLane(db, segmentId, "second-lane", NOW);
  const turns = [1, 2, 3].map((promptNumber) => seedTurn(sessionDbId, promptNumber));
  const job = claimWindow(sessionDbId);
  return { sessionDbId, job, segmentId, turns, context: contextFor(job, turns) };
}

describe("the batch tag write lives on the SETTLEMENT shape only", () => {
  test("`turns` / `task` / `addTags` are declared on the settlement shape", () => {
    for (const key of ["turns", "task", "addTags"] as const) {
      expect(settlementTurnWriteInputShape[key]).toBeDefined();
    }
    expect(() =>
      settlementTurnWriteInputSchema.parse({
        turns: ["S1/T1"],
        task: "E1",
        addTags: ["a-lane"],
      }),
    ).not.toThrow();
  });

  test("the PUBLIC `noteInputShape` is unchanged — the main agent's per-turn note keeps its own contract", () => {
    for (const key of ["turns", "task", "addTags"]) {
      expect(key in noteInputShape).toBe(false);
    }
  });
});

describe("the batch tag write", () => {
  test("adds the lane tag to every named turn in ONE call, and the task tag rides along", () => {
    const { sessionDbId, segmentId, turns, context } = fixture();

    const result = write(context, {
      turns: turns.map((_, index) => `S${sessionDbId}/T${index + 1}`),
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.batch).toMatchObject({
      segmentId,
      taskTag: "pager-task",
      addedTags: ["pager-lane"],
      changed: 3,
    });
    for (const turnId of turns) {
      expect(storedTags(turnId)).toEqual(["pager-task", "pager-lane"]);
    }
    expect(getSegmentMemberTurnIds(db, segmentId).sort()).toEqual([...turns].sort());
    // One result, not N: the receipt is a single line however many members.
    expect(renderSettlementTurnWriteReceipt(result.outcome)).toContain("Landed tags on 3 turn(s)");
  });

  test("UNION, never replacement — a member's `topic:` words survive the batch", () => {
    const { sessionDbId, segmentId, turns, context } = fixture();
    // Written raw, as a turn that ALREADY carried a topic word — the point of
    // the test is what the batch does to a value it did not put there.
    db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
      JSON.stringify(["topic:pager-latency"]),
      turns[0]!,
    );

    const result = write(context, {
      turns: [`S${sessionDbId}/T1`],
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
    });

    expect(result.ok).toBe(true);
    expect(storedTags(turns[0]!)).toEqual(["topic:pager-latency", "pager-task", "pager-lane"]);
  });

  test("a member already carrying a DIFFERENT task's tag refuses the batch, naming it", () => {
    const { sessionDbId, segmentId, turns, context } = fixture();
    const other = createSegment(db, {
      title: "another task",
      tags: ["other-task"],
      nowEpoch: NOW,
    }).id;
    writeMembershipTags(db, {
      operation: "normal",
      writes: [{ turnId: turns[1]!, tags: ["other-task"] }],
      nowEpoch: NOW,
    });

    const result = write(context, {
      turns: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`S${sessionDbId}/T2`);
    expect(result.message).toContain('already carries "other-task"');
    expect(result.message).toContain(`E${other}`);
    expect(result.message).toContain("no assignment verb");
    // ALL-OR-NOTHING: the innocent member did not land either.
    expect(storedTags(turns[0]!)).toEqual([]);
  });

  test("every `addTags` entry must be a lane DECLARED in `task`", () => {
    const { sessionDbId, segmentId, context } = fixture();

    const result = write(context, {
      turns: [`S${sessionDbId}/T1`],
      task: `E${segmentId}`,
      addTags: ["pager-lane", "never-declared"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('"never-declared" is not a lane');
    expect(result.message).toContain(`E${segmentId}`);
    expect(result.message).toContain("pager-lane, second-lane");
  });

  test("ALL-OR-NOTHING, with EVERY failure named — one repair call fixes the batch", () => {
    const { sessionDbId, segmentId, turns, context } = fixture();
    const outside = seedTurn(sessionDbId, 7);

    const result = write(context, {
      turns: [
        `S${sessionDbId}/T1`,
        `S${sessionDbId}/T7`, // outside the reviewable window
        `S${sessionDbId}/T99`, // no such turn
        "not-an-address",
      ],
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("3 of 4 turn(s) refused");
    expect(result.message).toContain("NOTHING was written");
    expect(result.message).toContain(`S${sessionDbId}/T7: outside this dispatch's reviewable window`);
    expect(result.message).toContain(`S${sessionDbId}/T99: no such turn`);
    expect(result.message).toContain('"not-an-address": not a fully qualified');
    expect(storedTags(turns[0]!)).toEqual([]);
    expect(storedTags(outside)).toEqual([]);
  });

  test("an UNNAMED task refuses the batch — an unnamed task takes no members", () => {
    const sessionDbId = seedSession();
    const unnamed = createSegment(db, { title: "unnamed", nowEpoch: NOW }).id;
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId);

    const result = write(contextFor(job, [turnId]), {
      turns: [`S${sessionDbId}/T1`],
      task: `E${unnamed}`,
      addTags: ["whatever"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("has no task tag");
    expect(result.message).toContain("takes no members");
  });

  test("a FROZEN-owned member refuses, naming its unnamed owner", () => {
    const { sessionDbId, segmentId, turns, context } = fixture();
    const frozen = createSegment(db, { title: "legacy", nowEpoch: NOW }).id;
    addSegmentMembers(db, frozen, [turns[1]!], NOW);

    const result = write(context, {
      turns: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`owned by unnamed E${frozen}`);
    expect(result.message).toContain("name it or detach first");
    expect(storedTags(turns[0]!)).toEqual([]);
  });

  test("a THAWED task accepts the very same batch", () => {
    const { sessionDbId, segmentId, turns, context } = fixture();
    const frozen = createSegment(db, { title: "legacy", nowEpoch: NOW }).id;
    addSegmentMembers(db, frozen, [turns[1]!], NOW);
    const batch: SettlementTurnWriteInput = {
      turns: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
    };
    expect(write(context, batch).ok).toBe(false);

    // Naming the frozen owner thaws its rows; the turn now has a real task,
    // and the batch's refusal becomes the "different task" one instead — so
    // detach it and the identical call lands.
    writeMembershipTags(db, {
      operation: "forced-detach",
      writes: [{ turnId: turns[1]!, tags: [] }],
      nowEpoch: NOW,
    });
    const after = write(context, batch);
    expect(after.ok).toBe(true);
    expect(storedTags(turns[1]!)).toEqual(["pager-task", "pager-lane"]);
  });

  test("tags-only: any other content field beside `turns` refuses", () => {
    const { sessionDbId, segmentId, context } = fixture();

    const result = write(context, {
      turns: [`S${sessionDbId}/T1`],
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
      title: "a title",
      type: ["design"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("TAGS-ONLY");
    expect(result.message).toContain("title, type");
  });

  test("`turns` and `turn` are mutually exclusive", () => {
    const { sessionDbId, segmentId, context } = fixture();
    const result = write(context, {
      turns: [`S${sessionDbId}/T1`],
      turn: `S${sessionDbId}/T2`,
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("mutually exclusive with turn and session");
  });

  test("`task`/`addTags` without `turns` are refused rather than silently ignored", () => {
    const { sessionDbId, segmentId, context } = fixture();
    const result = write(context, {
      turn: `S${sessionDbId}/T1`,
      task: `E${segmentId}`,
      tags: ["pager-task"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("require turns");
  });

  test("ONE TRANSACTION: a refusal after the first member was checked leaves the table byte-identical", () => {
    const { sessionDbId, segmentId, turns, context } = fixture();
    const snapshot = () =>
      JSON.stringify(
        db
          .query<Record<string, unknown>, []>(
            "SELECT id, tags FROM turns ORDER BY id",
          )
          .all(),
      ) +
      JSON.stringify(
        db
          .query<Record<string, unknown>, []>(
            "SELECT * FROM segment_members ORDER BY segment_id, turn_id",
          )
          .all(),
      );
    const before = snapshot();

    expect(
      write(context, {
        turns: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`, `S${sessionDbId}/T404`],
        task: `E${segmentId}`,
        addTags: ["pager-lane"],
      }).ok,
    ).toBe(false);

    expect(snapshot()).toBe(before);
    expect(getSegmentMemberTurnIds(db, segmentId)).toEqual([]);
    expect(turns.every((turnId) => storedTags(turnId).length === 0)).toBe(true);
  });

  test("CONCURRENCY: another mutator moving a member's tags through the primitive makes this writer's batch stale", () => {
    const { sessionDbId, segmentId, turns, context } = fixture();
    const writer = claimWriterId(context.jobId, context.claimGeneration, context.stage);

    // This writer read the turn's metadata…
    recordReadGrant(db, writer, "turn", turns[0]!, NOW, snapshotWriteGateSequence(db));

    // …and only THEN does another mutator move the tags through the primitive,
    // whose stamp is what the gate compares against the grant.
    writeMembershipTags(db, {
      operation: "normal",
      writes: [{ turnId: turns[0]!, tags: ["second-lane", "pager-task"] }],
      writer: "someone-else",
      nowEpoch: NOW + 1,
    });

    const result = write(context, {
      turns: [`S${sessionDbId}/T1`],
      task: `E${segmentId}`,
      addTags: ["pager-lane"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`S${sessionDbId}/T1`);
    expect(result.message).toContain("was changed by someone-else since you last read it");
    // Nothing was written, so the repair is a re-read and one more call.
    expect(storedTags(turns[0]!)).toEqual(["second-lane", "pager-task"]);
  });
});
