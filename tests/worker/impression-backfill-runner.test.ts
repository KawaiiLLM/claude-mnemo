import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextPendingImpressionBackfillJob,
  getImpressionBackfillJobForSegment,
  listImpressionBackfillJobs,
  readLaneImpression,
  requeueImpressionBackfillJob,
} from "../../src/db/impressions";
import { insertLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  createSegment,
  getSegment,
  readSegmentTaskImpression,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { updateTurnById } from "../../src/db/turns";
import {
  enqueueImpressionBackfillJobsForLegacyTasks,
  IMPRESSION_BACKFILL_CLAIM_LEASE_SECONDS,
  IMPRESSION_BACKFILL_MAX_ATTEMPTS,
  requeueStaleImpressionBackfillClaims,
  runImpressionBackfillJobs,
  type ImpressionBackfillGenerator,
} from "../../src/worker/impression-backfill-runner";
import {
  renderImpressionBackfillInput,
  renderImpressionBackfillPrompt,
} from "../../src/worker/impression-backfill-teaching";
import {
  assembleBackfillInput,
  type BackfillTaskInput,
} from "../../src/worker/impression-backfill";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * THE MIGRATION JOB LIFECYCLE (lane-impressions spec Rev 8, "Job lifecycle";
 * ticket 05). The model is a SEAM here, exactly as it is in production — every
 * fixture supplies its own generator, so what is under test is the runner's
 * discipline (claim, bounded retry, idempotent re-read, terminal state) rather
 * than any writer's prose.
 */

const NOW = 1_800_000_000;
const SILENT = { error: () => {} };

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

interface Fixture {
  sessionDbId: number;
  segmentId: number;
  turnIds: number[];
}

function seedFixture(title = "runner fixture task"): Fixture {
  const sessionDbId = upsertSession(db, {
    contentSessionId: `runner-${title}`,
    project: "/tmp/project-backfill-runner",
    title: "runner fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const segmentId = createSegment(db, {
    title,
    content: "the legacy content blob",
    insight: null,
    type: [],
    tags: [title.replace(/\s+/g, "-")],
    nowEpoch: NOW - 5_000,
  }).id;
  const turnIds = [1, 2].map(
    (promptNumber) =>
      db
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
        )!.id,
  );
  addSegmentMembers(db, segmentId, turnIds, NOW);
  insertLane(db, segmentId, "alpha", NOW - 4_000);
  for (const turnId of turnIds) {
    updateTurnById(db, turnId, {
      type: ["design"],
      tags: [title.replace(/\s+/g, "-"), "alpha"],
      updatedAtEpoch: NOW,
    });
  }
  appendSegmentWorkingStateRows(db, segmentId, "done", ["alpha is settled"], NOW);
  appendSegmentWorkingStateRows(db, segmentId, "next_steps", ["beta is owed"], NOW);
  return { sessionDbId, segmentId, turnIds };
}

function legalBatch(input: BackfillTaskInput): Record<string, unknown> {
  const anchor = input.anchorIndex[0]!.address;
  return {
    lanes: [{ tag: "alpha", text: `The #alpha lane: one decision governs it (${anchor}).` }],
    task: `E${input.segmentId}: one lane, one arc (${anchor}).`,
    unresolved: [],
  };
}

function generatorOf(
  impl: (request: { input: BackfillTaskInput; feedback: string | null; attempt: number }) => unknown,
): ImpressionBackfillGenerator {
  return async (request) => impl(request);
}

// ---------------------------------------------------------------------------
// Coverage enqueue, and where it may NOT happen
// ---------------------------------------------------------------------------

describe("enqueue is a coverage sweep, and it is not a schema migration", () => {
  test("opening the database enqueues NOTHING — a model job may not run inside a schema migration", () => {
    seedFixture();
    initializeSchema(db);
    expect(listImpressionBackfillJobs(db)).toHaveLength(0);
  });

  test("the sweep enqueues one job per covered task and is idempotent", () => {
    const first = seedFixture("task one");
    const second = seedFixture("task two");

    const run1 = enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);
    expect(run1.covered).toBe(2);
    expect(run1.enqueued).toBe(2);
    expect(new Set(run1.jobs.map((job) => job.segmentId))).toEqual(
      new Set([first.segmentId, second.segmentId]),
    );

    const run2 = enqueueImpressionBackfillJobsForLegacyTasks(db, NOW + 1);
    expect(run2.covered).toBe(2);
    expect(run2.enqueued).toBe(0);
    expect(listImpressionBackfillJobs(db)).toHaveLength(2);
  });

  test("a second sweep does not reset a DONE job", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);
    await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input }) => legalBatch(input)),
      now: () => NOW,
      logger: SILENT,
    });
    expect(getImpressionBackfillJobForSegment(db, fixture.segmentId)!.status).toBe("done");

    // The task no longer carries legacy fields, so the sweep does not even see
    // it; and the row it already has is returned untouched either way.
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW + 10);
    expect(getImpressionBackfillJobForSegment(db, fixture.segmentId)!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("a job runs asynchronously to a terminal state", () => {
  test("one generation, job done, cutover landed", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    let calls = 0;
    const results = await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input }) => {
        calls += 1;
        return legalBatch(input);
      }),
      now: () => NOW,
      logger: SILENT,
    });

    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("done");
    expect(getImpressionBackfillJobForSegment(db, fixture.segmentId)!.status).toBe("done");
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.origin).toBe("backfill");
    expect(getSegment(db, fixture.segmentId)!.done).toBeNull();
  });

  test("the generator is AWAITED — a batch that only arrives on a later tick still commits", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    const results = await runImpressionBackfillJobs(db, {
      generate: async ({ input }) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return legalBatch(input);
      },
      now: () => NOW,
      logger: SILENT,
    });

    expect(results[0]!.status).toBe("done");
    expect(readLaneImpression(db, fixture.segmentId, "alpha")!.origin).toBe("backfill");
  });

  test("jobs are claimed one at a time until none is pending", async () => {
    seedFixture("task one");
    seedFixture("task two");
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    const results = await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input }) => legalBatch(input)),
      now: () => NOW,
      logger: SILENT,
    });

    expect(results.map((result) => result.status)).toEqual(["done", "done"]);
    expect(claimNextPendingImpressionBackfillJob(db, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bounded retry
// ---------------------------------------------------------------------------

describe("retry is bounded, and it is spent only on what regeneration can repair", () => {
  test("a regenerable refusal is retried, and the writer is handed the refusal verbatim", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    const feedbacks: Array<string | null> = [];
    const results = await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input, feedback, attempt }) => {
        feedbacks.push(feedback);
        return attempt === 1 ? { lanes: [] } : legalBatch(input);
      }),
      now: () => NOW,
      logger: SILENT,
    });

    expect(results[0]!.status).toBe("done");
    expect(feedbacks[0]).toBeNull();
    expect(feedbacks[1]).toContain('"task" is required');
    expect(getImpressionBackfillJobForSegment(db, fixture.segmentId)!.status).toBe("done");
  });

  test("a generator that never repairs spends exactly the attempt budget, then fails operator-visibly", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    let calls = 0;
    const errors: string[] = [];
    const results = await runImpressionBackfillJobs(db, {
      generate: generatorOf(() => {
        calls += 1;
        return { lanes: [] };
      }),
      now: () => NOW,
      logger: { error: (message: string) => errors.push(message) },
    });

    // PINNED, not read off the constant the runner also reads: a budget lowered
    // to 1 must fail this test rather than redefine what it asserts.
    expect(IMPRESSION_BACKFILL_MAX_ATTEMPTS).toBe(3);
    expect(calls).toBe(3);
    expect(results[0]!.status).toBe("failed");
    const job = getImpressionBackfillJobForSegment(db, fixture.segmentId)!;
    expect(job.status).toBe("failed");
    expect(job.retryCount).toBe(1);
    expect(job.lastError).toContain('"task" is required');
    expect(errors.join("\n")).toContain(`E${fixture.segmentId}`);
    // Nothing landed and nothing was cleared.
    expect(getSegment(db, fixture.segmentId)!.done).not.toBeNull();
  });

  test("an UNRESOLVED report spends ONE generation, not the budget — the answer cannot change", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    let calls = 0;
    const results = await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input }) => {
        calls += 1;
        return {
          ...legalBatch(input),
          unresolved: [{ claim: "an orphan ruling", reason: "belongs to no lane" }],
        };
      }),
      now: () => NOW,
      logger: SILENT,
    });

    expect(calls).toBe(1);
    const result = results[0]!;
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.unresolved : []).toEqual([
      { claim: "an orphan ruling", reason: "belongs to no lane" },
    ]);
    const job = getImpressionBackfillJobForSegment(db, fixture.segmentId)!;
    expect(job.lastError).toContain("an orphan ruling");
    // The refusal's whole point: the source is still there.
    const segment = getSegment(db, fixture.segmentId)!;
    expect(segment.done).not.toBeNull();
    expect(segment.nextSteps).not.toBeNull();
    expect(readSegmentTaskImpression(db, fixture.segmentId)!.origin).toBeNull();
  });

  test("a source-snapshot drift self-heals on the next attempt, because the input is re-read", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    const seenDone: Array<string | null> = [];
    const results = await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input, attempt }) => {
        seenDone.push(input.source.done);
        if (attempt === 1) {
          // A `remember` write landing while this attempt was generating.
          appendSegmentWorkingStateRows(
            db,
            fixture.segmentId,
            "done",
            ["a row that landed mid-call"],
            NOW + 1,
          );
        }
        return legalBatch(input);
      }),
      now: () => NOW,
      logger: SILENT,
    });

    expect(results[0]!.status).toBe("done");
    expect(seenDone[0]).not.toContain("a row that landed mid-call");
    // THE IDEMPOTENT RE-CLAIM: attempt 2 read the CURRENT fields, not a cache.
    expect(seenDone[1]).toContain("a row that landed mid-call");
  });

  test("a THROWING generator is a failed attempt, never a job stranded in `claimed`", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    const results = await runImpressionBackfillJobs(db, {
      generate: async () => {
        throw new Error("the model call timed out");
      },
      now: () => NOW,
      logger: SILENT,
    });

    expect(results[0]!.status).toBe("failed");
    const job = getImpressionBackfillJobForSegment(db, fixture.segmentId)!;
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("the model call timed out");
  });
});

// ---------------------------------------------------------------------------
// Idempotent re-claim
// ---------------------------------------------------------------------------

describe("a re-claimed job re-reads and regenerates from scratch", () => {
  test("a requeued job's second run migrates the CURRENT fields, not the ones its first run saw", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    await runImpressionBackfillJobs(db, {
      generate: generatorOf(() => ({ lanes: [] })),
      now: () => NOW,
      logger: SILENT,
    });
    const failed = getImpressionBackfillJobForSegment(db, fixture.segmentId)!;
    expect(failed.status).toBe("failed");

    appendSegmentWorkingStateRows(
      db,
      fixture.segmentId,
      "done",
      ["written between the two runs"],
      NOW + 100,
    );
    expect(requeueImpressionBackfillJob(db, failed.id, NOW + 100)).toBe(true);

    const seen: Array<string | null> = [];
    const results = await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input }) => {
        seen.push(input.source.done);
        return legalBatch(input);
      }),
      now: () => NOW + 100,
      logger: SILENT,
    });

    expect(results[0]!.status).toBe("done");
    expect(seen[0]).toContain("written between the two runs");
    // The retry bookkeeping survives the requeue.
    expect(getImpressionBackfillJobForSegment(db, fixture.segmentId)!.retryCount).toBe(1);
  });

  test("a claim that outlived its lease is taken back; a fresh one is not", () => {
    seedFixture("stale task");
    seedFixture("fresh task");
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    const stale = claimNextPendingImpressionBackfillJob(db, NOW - IMPRESSION_BACKFILL_CLAIM_LEASE_SECONDS - 1)!;
    const fresh = claimNextPendingImpressionBackfillJob(db, NOW)!;

    const requeued = requeueStaleImpressionBackfillClaims(db, NOW);
    expect(requeued).toEqual([stale.id]);

    expect(listImpressionBackfillJobs(db, "pending").map((job) => job.id)).toEqual([stale.id]);
    expect(listImpressionBackfillJobs(db, "claimed").map((job) => job.id)).toEqual([fresh.id]);
    // A crash is a failed attempt, not a free one.
    expect(getImpressionBackfillJobForSegment(db, stale.segmentId)!.retryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The model context
// ---------------------------------------------------------------------------

describe("the migration prompt", () => {
  test("builds on the settlement teaching rather than forking it, and supersedes only its submission shape", async () => {
    const fixture = seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    let prompt = "";
    await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input, feedback }) => {
        prompt = renderImpressionBackfillPrompt(input, feedback);
        return legalBatch(input);
      }),
      now: () => NOW,
      logger: SILENT,
    });

    // The shared law, verbatim.
    expect(prompt).toContain("THE STATE CEILING.");
    expect(prompt).toContain("THE FOUR QUESTIONS.");
    // The migration's own additions.
    expect(prompt).toContain("ANCHORS COME FROM THE INDEX, AND FROM NOWHERE ELSE.");
    expect(prompt).toContain("supersedes the shared law's `HOW YOU SUBMIT IT` paragraph");
    // The task's own data.
    expect(prompt).toContain("the legacy content blob");
    expect(prompt).toContain("alpha is settled");
    expect(prompt).toContain(`S${fixture.sessionDbId}/T1`);
  });

  test("a regeneration is told exactly what it must repair", async () => {
    seedFixture();
    enqueueImpressionBackfillJobsForLegacyTasks(db, NOW);

    const prompts: string[] = [];
    await runImpressionBackfillJobs(db, {
      generate: generatorOf(({ input, feedback, attempt }) => {
        prompts.push(renderImpressionBackfillPrompt(input, feedback));
        return attempt === 1 ? { lanes: [] } : legalBatch(input);
      }),
      now: () => NOW,
      logger: SILENT,
    });

    expect(prompts[0]).not.toContain("Your previous attempt was refused");
    expect(prompts[1]).toContain("Your previous attempt was refused");
    expect(prompts[1]).toContain('"task" is required');
  });

  test("the whole member/anchor index renders — a truncated index would make re-sourcing unachievable", () => {
    const fixture = seedFixture();
    // Enough members that any per-index render cap would bite.
    const extra: number[] = [];
    for (let promptNumber = 3; promptNumber <= 60; promptNumber += 1) {
      extra.push(
        db
          .query<{ id: number }, [number, number, string, string, number]>(
            `INSERT INTO turns (
               session_id, prompt_number, status, user_prompt, assistant_response,
               tool_call_count, created_at_epoch
             ) VALUES (?, ?, 'active', ?, ?, 1, ?)
             RETURNING id`,
          )
          .get(
            fixture.sessionDbId,
            promptNumber,
            `prompt ${promptNumber}`,
            `response ${promptNumber}`,
            SETTLEMENT_ERA_CUTOFF_EPOCH + promptNumber,
          )!.id,
      );
    }
    addSegmentMembers(db, fixture.segmentId, extra, NOW);
    for (const turnId of extra) {
      updateTurnById(db, turnId, {
        type: ["design"],
        tags: ["runner-fixture-task", "alpha"],
        updatedAtEpoch: NOW,
      });
    }

    const input = assembleBackfillInput(db, fixture.segmentId)!;
    expect(input.anchorIndex).toHaveLength(60);
    const rendered = renderImpressionBackfillInput(input);
    for (let promptNumber = 1; promptNumber <= 60; promptNumber += 1) {
      expect(rendered).toContain(`S${fixture.sessionDbId}/T${promptNumber} `);
    }
  });
});
