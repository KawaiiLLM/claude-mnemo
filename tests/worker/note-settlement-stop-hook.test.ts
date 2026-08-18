import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import { createNoteSettlementSdkQuery } from "../../src/worker/note-settlement-sdk-query";
import {
  createSettlementStagingEngine,
  type SettlementStagingEngine,
} from "../../src/worker/note-settlement-staging";
import {
  createSettlementStopHook,
  NOTE_SETTLEMENT_MAX_STOP_BLOCKS,
} from "../../src/worker/note-settlement-stop-hook";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The Stop hook an agent meets when it tries to end a settlement run (spec
 * G2's first layer, A7's accepted cost 2).
 *
 * Under staged commit an agent that stops without calling `commit` has
 * produced literally nothing, so these tests pin the two things that make it
 * load-bearing: the message says so, and the block is CAPPED — a hook that
 * can refuse a stop forever is a hang, not a safeguard.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): the
 * completion gate is now an empty shell (fence + CAS only — see
 * `db/note-settlement-completion.ts`'s module doc comment), so a window with
 * even ONE staged review call now previews as "would land" — there is no
 * more "would refuse because the window is incomplete" scenario to
 * construct (no segmentation/note/coverage/election gap exists any more).
 * The one remaining "would refuse" shape is a REPLAY conflict (a staged
 * call's target moved between stage time and the preview), covered in its
 * own describe block below.
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

function baseContext(
  job: NoteSettlementJob,
  overrides: Partial<SettlementTurnFacadeContext> = {},
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    eligibleRelationPairKeys: new Set(),
    ...overrides,
  };
}

/** Not required for gate purposes any more (ticket 05) — still a realistic fixture. */
function markNoted(turnIds: readonly number[]): void {
  for (const turnId of turnIds) {
    upsertShadowNote(db, {
      turnId,
      title: "discuss+fixture: noted",
      content: "Noted by the fixture.",
      nowEpoch: NOW - 900,
    });
  }
}

interface Run {
  sessionDbId: number;
  turnId: number;
  job: NoteSettlementJob;
  engine: SettlementStagingEngine;
}

function startRun(): Run {
  const sessionDbId = seedSession();
  const turnId = seedTurn(sessionDbId, 1);
  markNoted([turnId]);
  const job = claimWindow(sessionDbId, 1, 1);
  const engine = createSettlementStagingEngine({
    db,
    context: baseContext(job, { reviewableTurnIds: new Set([turnId]) }),
    now: () => NOW,
  });
  return { sessionDbId, turnId, job, engine };
}

describe("an agent stopping without commit is told it has produced nothing (spec A7, G2)", () => {
  test("the first stop is blocked, the reason leads with the loss, and states commit would LAND it — the gate no longer has an incompleteness reason to name (ticket 05)", async () => {
    const run = startRun();
    run.engine.stageNoteWrite({
      turn: `S${run.sessionDbId}/T1`,
      grade: 2,
      type: ["discuss"],
      tags: [],
    });

    const stop = createSettlementStopHook({ engine: run.engine });
    const first = await stop();

    expect(first.decision).toBe("block");
    const reason = first.reason ?? "";
    // The loss, stated: nothing is written, and the staged work dies with the run.
    expect(reason).toContain("without having called `commit`");
    expect(reason).toContain("Nothing you staged is written");
    expect(reason).toContain("1 staged call");
    expect(reason).toContain("produced NOTHING");
    // The empty-shell gate (ticket 05): even a single staged review is
    // already a committable window — there is no gap to name.
    expect(reason).toContain("A `commit` right now would land this window. Call it.");
    expect(reason).not.toContain("would refuse");
  });

  test("a window with a staged propose also previews as landable", async () => {
    const run = startRun();
    run.engine.stageMembershipWrite({
      action: "propose",
      addresses: [`S${run.sessionDbId}/T1`],
      title: "a lone turn's own task",
    });

    const stop = createSettlementStopHook({ engine: run.engine });
    const decision = await stop();

    expect(decision.decision).toBe("block");
    const reason = decision.reason ?? "";
    expect(reason).toContain("1 staged call");
    expect(reason).toContain("A `commit` right now would land this window. Call it.");
  });

  test("the preview writes NOTHING: the job stays claimed, no staged effect lands, and a real commit still works after it", async () => {
    const run = startRun();
    run.engine.stageNoteWrite({
      turn: `S${run.sessionDbId}/T1`,
      grade: 2,
      type: ["discuss"],
      tags: [],
    });

    const stop = createSettlementStopHook({ engine: run.engine });
    const decision = await stop();
    // The preview said this window would commit — the strongest possible
    // case for the rollback to have leaked, since the gate's own
    // compare-and-set ran and would have marked the job done.
    expect(decision.reason).toContain("would land this window");

    expect(getNoteSettlementJob(db, run.job.id)!.status).toBe("claimed");
    expect(getTurnById(db, run.turnId)!.significanceGrade).toBeNull();
    expect(getTurnById(db, run.turnId)!.type).toEqual([]);
    expect(run.engine.pendingCount()).toBe(1);
    expect(run.engine.getLastCommitMetrics()).toBeNull();

    // And the run is not spoiled by having been previewed.
    expect(run.engine.commit().content[0]!.text).toContain("Committed");
    expect(getNoteSettlementJob(db, run.job.id)!.status).toBe("done");
    expect(getTurnById(db, run.turnId)!.significanceGrade).toBe(2);
  });

  test("a run that already committed is never blocked", async () => {
    const run = startRun();
    run.engine.stageNoteWrite({
      turn: `S${run.sessionDbId}/T1`,
      grade: 2,
      type: ["discuss"],
      tags: [],
    });
    expect(run.engine.commit().content[0]!.text).toContain("Committed");

    const stop = createSettlementStopHook({ engine: run.engine });
    const decision = await stop();

    expect(decision).toEqual({ continue: true });
  });

  test("a reclaimed lease is not blocked — no commit from this run could ever succeed", async () => {
    const run = startRun();
    run.engine.stageNoteWrite({
      turn: `S${run.sessionDbId}/T1`,
      grade: 2,
      type: ["discuss"],
      tags: [],
    });
    db.query<unknown, [number]>(
      "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
    ).run(run.job.id);

    const stop = createSettlementStopHook({ engine: run.engine });
    const decision = await stop();

    expect(decision).toEqual({ continue: true });
  });
});

describe("the one remaining 'would refuse' shape: a replay conflict (ticket 05 — the gate itself never refuses)", () => {
  test("a staged review whose turn vanishes before the preview reports commit would REFUSE, quoting the conflict", async () => {
    const run = startRun();
    run.engine.stageNoteWrite({
      turn: `S${run.sessionDbId}/T1`,
      grade: 2,
      type: ["discuss"],
      tags: [],
    });
    // The world moves: the staged call's own turn is gone by the time the
    // preview replays it (a rollback, in production).
    db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(run.turnId);

    const stop = createSettlementStopHook({ engine: run.engine });
    const decision = await stop();

    expect(decision.decision).toBe("block");
    const reason = decision.reason ?? "";
    expect(reason).toContain("A `commit` right now would refuse");
    expect(reason).toContain("no turn at");
    expect(reason).toContain("then call `commit`");
  });
});

describe("the block is capped at two, and the third stop is allowed through (spec G2)", () => {
  test("stop 1 and 2 block; stop 3 passes, and so does every stop after it", async () => {
    const run = startRun();
    run.engine.stageNoteWrite({
      turn: `S${run.sessionDbId}/T1`,
      grade: 2,
      type: ["discuss"],
      tags: [],
    });
    const stop = createSettlementStopHook({ engine: run.engine });

    expect((await stop()).decision).toBe("block");
    expect((await stop()).decision).toBe("block");
    // The cap. Nothing about the run changed between stop 2 and stop 3 — the
    // window is still uncommitted — so a hook that decided on state alone
    // would block here forever, which is a hang.
    expect(await stop()).toEqual({ continue: true });
    expect(await stop()).toEqual({ continue: true });
  });

  test("the cap is the stated constant, not an accident of this fixture", async () => {
    expect(NOTE_SETTLEMENT_MAX_STOP_BLOCKS).toBe(2);

    const run = startRun();
    const stop = createSettlementStopHook({ engine: run.engine, maxBlocks: 1 });
    expect((await stop()).decision).toBe("block");
    expect(await stop()).toEqual({ continue: true });
  });
});

describe("the hook is registered on the run the tools stage into", () => {
  test("createNoteSettlementSdkQuery passes a Stop hook that sees this request's own staging", async () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    markNoted([turnId]);
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
          // The model stages one review through the REAL tool handler, then
          // tries to stop without committing.
          await toolHandlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            grade: 2,
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
      eligibleRelationPairKeys: new Set(),
    });

    expect(stopDecision).toBe("block");
    // It saw the staged call the tool handler made — same engine, same run.
    expect(stopReason).toContain("1 staged call");
    expect(stopReason).toContain("A `commit` right now would land this window. Call it.");
    // And the preview it ran left the job exactly as it found it.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    expect(getTurnById(db, turnId)!.significanceGrade).toBeNull();
  });
});

describe("ticket 15 finding 5 — the Stop hook returns a bounded decision when it cannot get the lock", () => {
  test(
    "a real writer lock held by a second connection makes the hook block with an honest message, not throw or hang",
    async () => {
      // A genuine cross-connection lock: an in-memory db can't produce one
      // (SQLite's locking is per FILE, not per Database object), and
      // injecting the contending write from INSIDE the transaction under
      // test would land it inside that same transaction rather than contend
      // with it. This needs a second, real connection on a real file — the
      // fixture `tests/db/database.test.ts` already uses for the identical
      // reason.
      db.close();
      const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-stop-hook-busy-"));
      const path = join(directory, "settlement.sqlite");
      db = createDatabase(path); // production default busy_timeout (5s) — the whole point of this test.
      initializeSchema(db);

      const sessionDbId = seedSession();
      const turnId = seedTurn(sessionDbId, 1);
      markNoted([turnId]);
      const job = claimWindow(sessionDbId, 1, 1);
      const engine = createSettlementStagingEngine({
        db,
        context: baseContext(job, { reviewableTurnIds: new Set([turnId]) }),
        now: () => NOW,
      });
      engine.stageNoteWrite({
        turn: `S${sessionDbId}/T1`,
        grade: 2,
        type: ["discuss"],
        tags: [],
      });

      // A second REAL connection to the SAME file holds the write lock open,
      // uncommitted — `busyTimeoutMs: 0` so acquiring it never makes THIS
      // connection wait; it is the engine's own connection whose busy
      // behaviour is under test.
      const contender = createDatabase(path, { busyTimeoutMs: 0 });
      contender.exec("BEGIN IMMEDIATE");
      contender
        .query<unknown, [number]>("UPDATE sessions SET title = title WHERE id = ?")
        .run(sessionDbId);

      try {
        const stop = createSettlementStopHook({ engine });
        const start = Date.now();
        const decision = await stop();
        const elapsedMs = Date.now() - start;

        // Bounded, and NOT a throw: the pre-fix code ran `previewCommit`
        // through the ordinary `runWriteTransaction` (three attempts, no
        // elapsed-time ceiling) against a connection opened at the
        // production 5s busy_timeout — up to three attempts of ~5s each
        // before propagating `SQLITE_BUSY` straight out of the hook. This
        // must neither throw nor take anywhere near that long.
        expect(decision.decision).toBe("block");
        expect(decision.reason).toContain("completion check itself could not run");
        expect(decision.reason).toContain("Call `commit` directly");
        expect(elapsedMs).toBeLessThan(4_000);
      } finally {
        contender.exec("ROLLBACK");
        contender.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
