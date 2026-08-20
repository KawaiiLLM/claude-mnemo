import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  completeNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { createNoteSettlementSdkQuery } from "../../src/worker/note-settlement-sdk-query";
import {
  createSettlementStopHook,
  NOTE_SETTLEMENT_MAX_STOP_BLOCKS,
} from "../../src/worker/note-settlement-stop-hook";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The Stop hook an agent meets when it tries to end a settlement run
 * (ticket 06, read-write-contract spec "Stop hook 重实现").
 *
 * TICKET 06'S REPLACEMENT: direct write (ticket 05) means every `note`/
 * `remember` call has ALREADY landed the instant it ran — nothing is lost
 * when the process exits. What can still go wrong is `commit` never
 * running, which leaves the job stuck `claimed` instead of `done`. The
 * probe is therefore a PLAIN READ of the job row ("job claimed but not
 * terminal") — no write, no busy-timeout budget to protect, no preview
 * transaction, no staged-count reasoning. The old `previewCommit`-based
 * design (spec A7/G8, ticket 11, ticket 15 finding 5's busy-timeout repair)
 * is retired along with the staging engine it read; this file no longer
 * needs a real-file busy-lock fixture at all.
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
    contentSessionId: "settlement-stop-hook-session",
    project: "/tmp/project-settlement-stop-hook",
    title: "settlement stop hook fixture",
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
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

describe("an agent stopping without commit is warned, but nothing it wrote is at risk (ticket 06)", () => {
  test("the first stop blocks, states writes already landed, and says commit is what remains", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const stop = createSettlementStopHook({ db, jobId: job.id, claimGeneration: job.claimGeneration });
    const first = await stop();

    expect(first.decision).toBe("block");
    const reason = first.reason ?? "";
    expect(reason).toContain("without having called `commit`");
    expect(reason).toContain("already landed");
    expect(reason).toContain("nothing is lost");
    expect(reason).toContain("Call `commit` now");
    // The probe is a read only — the job row is untouched by asking.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });

  test("a run that already committed is never blocked", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    expect(completeNoteSettlementJob(db, job.id, NOW, job.claimGeneration)).toBe(true);

    const stop = createSettlementStopHook({ db, jobId: job.id, claimGeneration: job.claimGeneration });
    expect(await stop()).toEqual({ continue: true });
  });

  test("a reclaimed lease (this run's generation no longer current) is never blocked — no commit from here could ever succeed", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(job.id);

    const stop = createSettlementStopHook({ db, jobId: job.id, claimGeneration: job.claimGeneration });
    expect(await stop()).toEqual({ continue: true });
  });

  test("a job that no longer exists (e.g. its session was deleted) is never blocked", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const stop = createSettlementStopHook({ db, jobId: job.id + 999, claimGeneration: job.claimGeneration });
    expect(await stop()).toEqual({ continue: true });
  });
});

describe("the block is capped at two, and the third stop is allowed through (spec G2, unchanged by ticket 06)", () => {
  test("stop 1 and 2 block; stop 3 passes, and so does every stop after it", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const stop = createSettlementStopHook({ db, jobId: job.id, claimGeneration: job.claimGeneration });

    expect((await stop()).decision).toBe("block");
    expect((await stop()).decision).toBe("block");
    // The cap. Nothing about the job row changed between stop 2 and stop 3 —
    // it is still `claimed`, not `done` — so a hook that decided on state
    // alone would block here forever, which is a hang.
    expect(await stop()).toEqual({ continue: true });
    expect(await stop()).toEqual({ continue: true });
  });

  test("the cap is the stated constant, not an accident of this fixture", async () => {
    expect(NOTE_SETTLEMENT_MAX_STOP_BLOCKS).toBe(2);

    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const stop = createSettlementStopHook({
      db,
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      maxBlocks: 1,
    });
    expect((await stop()).decision).toBe("block");
    expect(await stop()).toEqual({ continue: true });
  });
});

describe("the hook is registered on the run's own job identity", () => {
  test("createNoteSettlementSdkQuery passes a Stop hook that reads THIS request's own job row, after a direct write already landed", async () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const toolHandlers = new Map<string, (args: never) => Promise<unknown>>();
    let stopReason: string | undefined;
    let stopDecision: string | undefined;

    const runQuery = createNoteSettlementSdkQuery({
      db,
      dataRoot: "/tmp/claude-mnemo-settlement-stop-hook",
      now: () => NOW,
      createSdkMcpServerImpl: (() => ({ type: "sdk", name: "mnemo" })) as never,
      toolImpl: ((
        name: string,
        _description: string,
        _shape: unknown,
        handler: (args: never) => Promise<unknown>,
      ) => {
        toolHandlers.set(name, handler);
        return { name };
      }) as never,
      queryImpl: ((call: { options: Record<string, unknown> }) =>
        (async function* () {
          // The model writes one review DIRECTLY — it lands immediately, no
          // staging — then tries to stop without ever calling commit.
          await toolHandlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            type: ["discuss"],
            tags: [],
          } as never);

          const hooks = call.options.hooks as
            | { Stop?: Array<{ hooks: Array<() => Promise<Record<string, string>>> }> }
            | undefined;
          const stop = hooks?.Stop?.[0]?.hooks?.[0];
          if (!stop) {
            throw new Error("no Stop hook was registered on the settlement query");
          }
          const decision = await stop();
          stopDecision = decision.decision;
          stopReason = decision.reason;

          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "stopped",
          };
        })()) as never,
    });

    await runQuery({
      prompt: "settle it",
      systemPrompt: "system",
      model: "claude-sonnet-5",
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      sessionId: sessionDbId,
      reviewableTurnIds: new Set([turnId]),
      contextBuiltAtEpoch: NOW,
    });

    expect(stopDecision).toBe("block");
    expect(stopReason).toContain("already landed");
    expect(stopReason).toContain("Call `commit` now");
    // The write already landed for real — direct write, not staged.
    expect(getTurnById(db, turnId)!.type).toEqual(["discuss"]);
    // ...but the job itself stays open: only `commit` marks it done.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });
});
