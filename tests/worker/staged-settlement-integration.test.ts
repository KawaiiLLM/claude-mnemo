import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  type NoteSettlementTrigger,
} from "../../src/db/note-settlement";
import { readNoteSettlementWritableSnapshot } from "../../src/db/note-settlement-snapshots";
import {
  createNoteSettlementScheduler,
  type NoteSettlementDispatch,
} from "../../src/worker/note-settlement";
import { createNoteSettlementDispatch } from "../../src/worker/note-settlement-dispatch";
import { createNoteSettlementSdkQuery } from "../../src/worker/note-settlement-sdk-query";
import {
  createNoteSettlementStageOneDispatch,
  createNoteSettlementStageOneSdkQuery,
} from "../../src/worker/note-settlement-stage1";
import { createWorkerCore } from "../../src/worker/server";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from "../support/settlement-config";

/**
 * THE CONTRACT STEP (staged-settlement spec Rev 5; ticket 08).
 *
 * Everything below drives the REAL stage 1 and the REAL stage 2 — the actual
 * dispatches and their actual tool registrations — through the actual
 * scheduler. Only the model is fake: each stage's `queryImpl` scripts the tool
 * calls a run would make, which is the same seam every other suite in this
 * batch uses and the reason every assertion here is about what the two passes
 * WROTE rather than about what either was told.
 *
 * What this file adds to the seven closed tickets is the join: that a window
 * enters on stage `topics`, leaves stage 1 through a landed transition, is
 * picked up by stage 2 IN THE SAME CLAIM, and ends `done` with the cursor
 * advanced — for every trigger type the queue can hold, not just the one the
 * unit suites happen to enqueue.
 */

const NOW = 1_800_000_000;
const DATA_ROOT = "/tmp/claude-mnemo-staged-integration";

/** Every trigger the job table accepts. The staged flow is indifferent to which, and this proves it rather than assuming it. */
const EVERY_TRIGGER: readonly NoteSettlementTrigger[] = [
  "consecutive",
  "compact",
  "residual",
  "sessionend",
  "backfill",
];

interface Fixture {
  db: Database;
  sessionDbId: number;
  jobId: number;
}

function insertTurn(db: Database, sessionDbId: number, promptNumber: number): number {
  const id = db
    .query<{ id: number }, [number, number, string, string, number, string, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', ?, ?, 2, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 900 + promptNumber,
      JSON.stringify(["design"]),
      JSON.stringify([]),
    )!.id;
  db.query<unknown, [string, string, number]>(
    "UPDATE turns SET title = ?, content = ? WHERE id = ?",
  ).run(`turn ${promptNumber} title`, `turn ${promptNumber} body`, id);
  return id;
}

/**
 * A two-turn window, already typed and noted, carrying no topic word.
 *
 * The missing word is the point: stage 1's own transition gate refuses while a
 * window turn is wordless, so a run that never reached duty 2 cannot transition
 * and this fixture cannot pass by accident.
 */
function seed(trigger: NoteSettlementTrigger): Fixture {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const sessionDbId = upsertSession(db, {
    contentSessionId: `staged-integration-${trigger}`,
    project: "/tmp/project-staged-integration",
    title: "staged integration fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  insertTurn(db, sessionDbId, 1);
  insertTurn(db, sessionDbId, 2);

  const [job] = enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 2, triggerType: trigger }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  if (!job) {
    throw new Error(`fixture failed to enqueue a ${trigger} window`);
  }
  return { db, sessionDbId, jobId: job.id };
}

/** Capture every registered tool's handler — the pattern both stage suites already use. */
function captureToolImpl() {
  const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const toolImpl = mock(
    (
      name: string,
      _description: string,
      _shape: unknown,
      handler: (args: Record<string, unknown>) => unknown,
    ) => {
      handlers.set(name, handler);
      return { name };
    },
  );
  return { toolImpl, handlers };
}

function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
}

type ToolScript = (
  call: (name: string, args: Record<string, unknown>) => Promise<string>,
) => Promise<void>;

/**
 * A stage's query seam, real registrations and all, with the model's turn
 * replaced by `script`. The generator body runs lazily, so by the time the
 * script executes the tools are registered and every call goes through the
 * production handler.
 */
function scriptedQueryImpl(
  handlers: Map<string, (args: Record<string, unknown>) => unknown>,
  script: ToolScript,
  transcript: string[],
) {
  return mock(() =>
    (async function* () {
      const call = async (
        name: string,
        args: Record<string, unknown>,
      ): Promise<string> => {
        const handler = handlers.get(name);
        if (!handler) {
          throw new Error(`this stage registered no ${name} tool`);
        }
        const text = resultText(await handler(args));
        transcript.push(`${name}: ${text}`);
        return text;
      };
      await script(call);
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );
}

function realStageOne(db: Database, script: ToolScript, transcript: string[]): NoteSettlementDispatch {
  const { toolImpl, handlers } = captureToolImpl();
  return createNoteSettlementStageOneDispatch({
    db,
    config: SETTLEMENT_ENABLED_CONFIG,
    now: () => NOW,
    logger: { warn: () => {}, error: () => {} },
    runQuery: createNoteSettlementStageOneSdkQuery({
      db,
      dataRoot: DATA_ROOT,
      queryImpl: scriptedQueryImpl(handlers, script, transcript) as never,
      createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
      toolImpl: toolImpl as never,
      now: () => NOW,
    }),
  });
}

function realStageTwo(
  db: Database,
  script: ToolScript,
  transcript: string[],
  /** Every prompt stage 2 was actually handed, for the monolith-retirement probe. */
  prompts: string[] = [],
): NoteSettlementDispatch {
  const { toolImpl, handlers } = captureToolImpl();
  const runQuery = createNoteSettlementSdkQuery({
    db,
    dataRoot: DATA_ROOT,
    queryImpl: scriptedQueryImpl(handlers, script, transcript) as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
  });
  return createNoteSettlementDispatch({
    db,
    config: SETTLEMENT_ENABLED_CONFIG,
    now: () => NOW,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    runQuery: async (request) => {
      prompts.push(request.prompt);
      return runQuery(request);
    },
  });
}

/** Duty 2 then duty 8: a subject word on each window turn, then the transition. */
const STAGE_ONE_SCRIPT: ToolScript = async (call) => {
  await call("note", { turn: "S1/T1", tags: ["topic:tile-cache"] });
  await call("note", { turn: "S1/T2", tags: ["topic:tile-cache"] });
  await call("finalize", { summary: "one line: tile cache" });
};

/** Stage 2 finds nothing to relate and says so with an empty-handed commit — still the terminal act. */
const STAGE_TWO_SCRIPT: ToolScript = async (call) => {
  await call("commit", { report: "no edges this window" });
};

describe("every trigger type drives topics -> edges -> done through the real two stages", () => {
  for (const trigger of EVERY_TRIGGER) {
    test(`a ${trigger} window settles end to end in one claim`, async () => {
      const fixture = seed(trigger);
      const stageOneTranscript: string[] = [];
      const stageTwoTranscript: string[] = [];
      try {
        const scheduler = createNoteSettlementScheduler({
          db: fixture.db,
          config: SETTLEMENT_ENABLED_CONFIG,
          now: () => NOW,
          nowMs: () => NOW * 1000,
          stage1Dispatch: realStageOne(fixture.db, STAGE_ONE_SCRIPT, stageOneTranscript),
          dispatch: realStageTwo(fixture.db, STAGE_TWO_SCRIPT, stageTwoTranscript),
          logger: { warn: () => {}, error: () => {} },
        });

        const dispatched = await scheduler.drainSession(fixture.sessionDbId);
        expect(dispatched.map((job) => job.id)).toEqual([fixture.jobId]);

        // BOTH passes ran, in order, on one claim.
        expect(stageOneTranscript.at(-1)).toContain("Finalized");
        expect(stageTwoTranscript.at(-1)).toContain("Committed");

        const settled = getNoteSettlementJob(fixture.db, fixture.jobId)!;
        expect(settled.status).toBe("done");
        expect(settled.stage).toBe("edges");
        // The generation never bumps at the transition — one claim, two stages.
        expect(settled.claimGeneration).toBe(1);
        expect(settled.attempts).toBe(1);
        expect(settled.transitionSeq).not.toBeNull();
        // The transition really froze the writable set stage 2 then read.
        expect(readNoteSettlementWritableSnapshot(fixture.db, fixture.jobId).size).toBe(2);
        // Only the terminal commit advances the cursor — stage 1 never does.
        // A `backfill` job re-settles a range BEHIND the cursor by definition
        // and has never moved it; staging did not change that, and asserting
        // the same number for it would be asserting a regression.
        expect(getNoteSettlementCursor(fixture.db, fixture.sessionDbId)).toBe(
          trigger === "backfill" ? 0 : 2,
        );
      } finally {
        fixture.db.close();
      }
    });
  }
});

describe("the worker core mounts stage 1 (ticket 08's server wiring)", () => {
  test("a stage-1 payload handed to the core reaches the scheduler and runs before stage 2", async () => {
    const fixture = seed("consecutive");
    const order: string[] = [];
    try {
      const stageOneTranscript: string[] = [];
      const stageTwoTranscript: string[] = [];
      const stage1 = realStageOne(fixture.db, STAGE_ONE_SCRIPT, stageOneTranscript);
      const stage2 = realStageTwo(fixture.db, STAGE_TWO_SCRIPT, stageTwoTranscript);
      const core = createWorkerCore({
        db: fixture.db,
        config: SETTLEMENT_ENABLED_CONFIG,
        now: () => NOW,
        nowMs: () => NOW * 1000,
        logger: { warn: () => {}, error: () => {} },
        noteSettlementStage1DispatchImpl: async (args) => {
          order.push(`topics:${args.job.stage}`);
          return stage1(args);
        },
        noteSettlementDispatchImpl: async (args) => {
          order.push(`edges:${args.job.stage}`);
          return stage2(args);
        },
      });

      await core.noteSettlement.drainSession(fixture.sessionDbId);

      // The stage each payload SAW is the proof that the core routed by stage
      // rather than calling one of them twice.
      expect(order).toEqual(["topics:topics", "edges:edges"]);
      expect(getNoteSettlementJob(fixture.db, fixture.jobId)?.status).toBe("done");
    } finally {
      fixture.db.close();
    }
  });

  test("with no stage-1 payload the core still hosts no model: the transition-only default carries the window into stage 2", async () => {
    const fixture = seed("consecutive");
    try {
      const stageTwoTranscript: string[] = [];
      const core = createWorkerCore({
        db: fixture.db,
        config: SETTLEMENT_ENABLED_CONFIG,
        now: () => NOW,
        nowMs: () => NOW * 1000,
        logger: { warn: () => {}, error: () => {} },
        noteSettlementDispatchImpl: realStageTwo(
          fixture.db,
          STAGE_TWO_SCRIPT,
          stageTwoTranscript,
        ),
      });

      await core.noteSettlement.drainSession(fixture.sessionDbId);

      const settled = getNoteSettlementJob(fixture.db, fixture.jobId)!;
      expect(settled.status).toBe("done");
      expect(settled.transitionSeq).not.toBeNull();
      // Nothing was frozen, because nothing judged — and stage 2 still ran,
      // reading the empty worklist that fact honestly produces.
      expect(readNoteSettlementWritableSnapshot(fixture.db, fixture.jobId).size).toBe(0);
      expect(stageTwoTranscript.at(-1)).toContain("Committed");
    } finally {
      fixture.db.close();
    }
  });
});

describe("the single-pass settlement flow has no caller left", () => {
  /**
   * The monolith retired as a RENDERING, and this is the end-to-end statement
   * of it: whatever the transition froze — a full worklist or an empty one —
   * the prompt the real dispatch hands the real query seam declares the split
   * and declares the worklist. There is no shape of the flow that produces the
   * old combined prompt, because the branch that produced it is gone and the
   * parameter that selected it is required.
   */
  test("the prompt stage 2 is actually handed always declares the split and the worklist", async () => {
    const fixture = seed("consecutive");
    const prompts: string[] = [];
    try {
      const scheduler = createNoteSettlementScheduler({
        db: fixture.db,
        config: SETTLEMENT_ENABLED_CONFIG,
        now: () => NOW,
        nowMs: () => NOW * 1000,
        stage1Dispatch: realStageOne(fixture.db, STAGE_ONE_SCRIPT, []),
        dispatch: realStageTwo(fixture.db, STAGE_TWO_SCRIPT, [], prompts),
        logger: { warn: () => {}, error: () => {} },
      });

      await scheduler.drainSession(fixture.sessionDbId);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("You are the SECOND of two passes");
      expect(prompts[0]).toContain("YOUR WORKLIST (frozen by the stage-1 transition");
      expect(prompts[0]).toContain("lanes to work, in stage 1's own order (0)");
    } finally {
      fixture.db.close();
    }
  });

  test("even a window nobody judged — the transition-only default's own output — gets the two-pass prompt", async () => {
    const fixture = seed("consecutive");
    const prompts: string[] = [];
    try {
      const scheduler = createNoteSettlementScheduler({
        db: fixture.db,
        config: SETTLEMENT_ENABLED_CONFIG,
        now: () => NOW,
        nowMs: () => NOW * 1000,
        // No stage1Dispatch at all: the scheduler's transition-only default
        // freezes nothing, which is the exact input that used to select the
        // single-pass rendering.
        dispatch: realStageTwo(fixture.db, STAGE_TWO_SCRIPT, [], prompts),
        logger: { warn: () => {}, error: () => {} },
      });

      await scheduler.drainSession(fixture.sessionDbId);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("You are the SECOND of two passes");
      expect(prompts[0]).toContain("YOUR WORKLIST (frozen by the stage-1 transition");
    } finally {
      fixture.db.close();
    }
  });
});
