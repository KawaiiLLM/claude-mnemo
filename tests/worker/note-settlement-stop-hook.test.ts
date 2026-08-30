import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  completeNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import {
  composeSettlementDiagnosis,
  createUnifiedNoteSettlementDispatch,
} from "../../src/worker/note-settlement-dispatch";
import {
  createNoteSettlementSdkQuery,
  createUnifiedNoteSettlementSdkQuery,
} from "../../src/worker/note-settlement-sdk-query";
import { RESPONSE_ORIGIN_TOOL_USE_META_KEY } from "../../src/worker/note-settlement-response-origin";
import {
  createSettlementStopHook,
  NOTE_SETTLEMENT_MAX_STOP_BLOCKS,
} from "../../src/worker/note-settlement-stop-hook";
import { SETTLEMENT_ENABLED_CONFIG, SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The Stop hook an agent meets when it tries to end a settlement run
 * (settlement-execution-repair ticket 06, "Stop hook, stage-aware and
 * bounded" — building on read-write-contract ticket 06's direct-write probe).
 *
 * TICKET 06'S OWN REPAIR (this file): the hook used to teach a single
 * hardcoded `commit` reason regardless of which stage the job row actually
 * owed, and blocked up to twice. It now reads the job row's OWN `stage` on
 * every stop — `topics` names `finalize`, `edges` names `commit` — and nudges
 * at most ONCE per run; a second stop without the terminal call is accepted
 * as the run's answer and flows into `note-settlement-dispatch.ts`'s failure
 * accounting (ticket 04's `composeSettlementDiagnosis`), preserving the run's
 * own final text.
 */

const NOW = 1_800_000_000;
const DATA_ROOT = "/tmp/claude-mnemo-settlement-stop-hook";

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

describe("an agent stopping without its stage's terminal call is warned, but nothing it wrote is at risk (ticket 06)", () => {
  test("a fresh (topics-stage) claim: the first stop blocks, states writes already landed, and says finalize is what remains", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    expect(job.stage).toBe("topics");

    const stop = createSettlementStopHook({ db, jobId: job.id, claimGeneration: job.claimGeneration });
    const first = await stop();

    expect(first.decision).toBe("block");
    const reason = first.reason ?? "";
    expect(reason).toContain("without having called `finalize`");
    expect(reason).toContain("already landed");
    expect(reason).toContain("nothing is lost");
    expect(reason).toContain("Call `finalize` now");
    expect(reason).not.toContain("`commit`");
    // The probe is a read only — the job row is untouched by asking.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });

  test("an edges-stage claim (already transitioned): the first stop blocks, states writes already landed, and says commit is what remains", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW);

    const stop = createSettlementStopHook({ db, jobId: job.id, claimGeneration: job.claimGeneration });
    const first = await stop();

    expect(first.decision).toBe("block");
    const reason = first.reason ?? "";
    expect(reason).toContain("without having called `commit`");
    expect(reason).toContain("already landed");
    expect(reason).toContain("nothing is lost");
    expect(reason).toContain("Call `commit` now");
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

  test("a reclaimed lease (this run's generation no longer current) is never blocked — no terminal call from here could ever succeed", async () => {
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

describe("the block is capped at ONE, and the second stop is allowed through (settlement-execution-repair spec, down from read-write-contract's 'at most twice')", () => {
  test("stop 1 blocks; stop 2 passes, and so does every stop after it", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const stop = createSettlementStopHook({ db, jobId: job.id, claimGeneration: job.claimGeneration });

    expect((await stop()).decision).toBe("block");
    // The bound. Nothing about the job row changed between stop 1 and stop 2
    // — it is still `claimed`, not `done` — so a hook that decided on state
    // alone would block here forever, which is a hang. The pass-through shape
    // at THIS seam is exactly what the dispatch layer turns into deterministic
    // failure accounting (see the integration test below).
    expect(await stop()).toEqual({ continue: true });
    expect(await stop()).toEqual({ continue: true });
  });

  test("the cap is the stated constant, not an accident of this fixture", async () => {
    expect(NOTE_SETTLEMENT_MAX_STOP_BLOCKS).toBe(1);

    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    // An injected override proves the bound is read from `maxBlocks`, not
    // hardcoded past the constant's own default.
    const stop = createSettlementStopHook({
      db,
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      maxBlocks: 2,
    });
    expect((await stop()).decision).toBe("block");
    expect((await stop()).decision).toBe("block");
    expect(await stop()).toEqual({ continue: true });
  });
});

describe("the hook is registered on the run's own job identity (single-stage query)", () => {
  test("createNoteSettlementSdkQuery passes a Stop hook that reads THIS request's own job row, after a direct write already landed", async () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    // A cold edges-shaped resume — production always claims this query at
    // `edges` (see note-settlement-dispatch.ts's `createNoteSettlementDispatch`).
    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW);

    const toolHandlers = new Map<string, (args: never) => Promise<unknown>>();
    let stopReason: string | undefined;
    let stopDecision: string | undefined;

    const runQuery = createNoteSettlementSdkQuery({
      db,
      dataRoot: DATA_ROOT,
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
            session: `S${sessionDbId}`,
            content: "In hindsight: what this window settled.",
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
      stage: "edges",
      sessionId: sessionDbId,
      writableTurnIds: new Set([turnId]),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 1,
    });

    expect(stopDecision).toBe("block");
    expect(stopReason).toContain("already landed");
    expect(stopReason).toContain("Call `commit` now");
    // The write already landed for real — direct write, not staged.
    expect(getSession(db, sessionDbId)!.content).toContain("what this window settled");
    // ...but the job itself stays open: only `commit` marks it done.
    expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
  });

  // AMENDMENT / FINDING 3 REPAIR: the OLD read-write-contract-era behaviour
  // here was "a stage-1 child stopping after its own transition is let
  // through, because stage 2 belongs to a DIFFERENT dispatch" — a fact about
  // the now-retired two-session architecture (`createNoteSettlementStageOneSdkQuery`
  // is gone). This hook is generic — whichever wrapper constructs it, a row
  // that has moved on since construction is read FRESH and still nudges,
  // naming whatever the row's CURRENT stage owes.
  test("a row that has moved on since construction is still nudged — for the tool its CURRENT stage owes, not the constructor's", async () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    // The row is on `edges` now; this request still declares itself `topics`
    // — the exact shape a constructor-time value would get stale under.
    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW);

    let stopDecision: string | undefined;
    let stopReason: string | undefined;
    const runQuery = createNoteSettlementSdkQuery({
      db,
      dataRoot: DATA_ROOT,
      now: () => NOW,
      createSdkMcpServerImpl: (() => ({ type: "sdk", name: "mnemo" })) as never,
      toolImpl: ((name: string) => ({ name })) as never,
      queryImpl: ((call: { options: Record<string, unknown> }) =>
        (async function* () {
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
          yield { type: "result", subtype: "success", is_error: false, result: "stopped" };
        })()) as never,
    });

    await runQuery({
      prompt: "settle it",
      systemPrompt: "system",
      model: "claude-sonnet-5",
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      stage: "topics",
      sessionId: sessionDbId,
      writableTurnIds: new Set([turnId]),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 1,
    });

    expect(stopDecision).toBe("block");
    expect(stopReason).toContain("without having called `commit`");
    // A let-through/nudge is a read, never a write.
    expect(getNoteSettlementJob(db, job.id)!.stage).toBe("edges");
  });
});

// ---------------------------------------------------------------------------
// The unified run: stop after transition, driven through the real registry
// ---------------------------------------------------------------------------

type SettlementStopHookResultLike = { continue: true; decision?: string; reason?: string };

function captureUnifiedToolImpl() {
  const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => unknown>();
  const toolImpl = mock(
    (
      name: string,
      _description: string,
      _shape: unknown,
      handler: (args: Record<string, unknown>, extra: unknown) => unknown,
    ) => {
      handlers.set(name, handler);
      return { name };
    },
  );
  return { toolImpl, handlers };
}

interface UnifiedScriptedCall {
  tool: string;
  toolUseId: string;
  args: Record<string, unknown>;
}
interface UnifiedScriptedStep {
  messageId: string;
  calls: UnifiedScriptedCall[];
}

function insertTypedTurn(sessionDbId: number, promptNumber: number): number {
  return db
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
}

function unifiedAddr(sessionDbId: number, promptNumber: number): string {
  return `S${sessionDbId}/T${promptNumber}`;
}

interface UnifiedFixture {
  sessionDbId: number;
  t1: number;
  t2: number;
  job: NoteSettlementJob;
}

/** A clean two-turn window, typed and untagged — the topic pass owes both turns a `topic:` word before `finalize` will transition. */
function seedUnifiedFixture(): UnifiedFixture {
  const sessionDbId = seedSession();
  const t1 = insertTypedTurn(sessionDbId, 1);
  const t2 = insertTypedTurn(sessionDbId, 2);
  const job = claimWindow(sessionDbId, 1, 2);
  return { sessionDbId, t1, t2, job };
}

function unifiedBaseRequest(fixture: UnifiedFixture) {
  return {
    prompt: "irrelevant — queryImpl is scripted",
    systemPrompt: "system",
    model: "claude-unified-test",
    jobId: fixture.job.id,
    claimGeneration: fixture.job.claimGeneration,
    stage: fixture.job.stage,
    sessionId: fixture.sessionDbId,
    writableTurnIds: new Set([fixture.t1, fixture.t2]),
    scopeProvenance: {
      window: new Set([fixture.t1, fixture.t2]),
      baseLookback: new Set<number>(),
      closureOnly: new Set<number>(),
    },
    contextBuiltAtEpoch: NOW,
    windowStart: 1,
    windowEnd: 2,
  };
}

/** The topic-pass steps every test below shares: tag both turns, then finalize — the real transition, not a raw DB helper call. */
function topicPassSteps(fixture: UnifiedFixture): UnifiedScriptedStep[] {
  return [
    {
      messageId: "msg_A_topics",
      calls: [
        {
          tool: "note",
          toolUseId: "tu_note_t1",
          args: { turn: unifiedAddr(fixture.sessionDbId, 1), tags: ["topic:tile-cache"] },
        },
        {
          tool: "note",
          toolUseId: "tu_note_t2",
          args: { turn: unifiedAddr(fixture.sessionDbId, 2), tags: ["topic:tile-cache"] },
        },
      ],
    },
    {
      messageId: "msg_A_finalize",
      calls: [
        { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
      ],
    },
  ];
}

/** Drives `steps` against the REAL registered handlers with `_meta` threaded, exactly as the real SDK stream would; then hands the generator's own `call.options.hooks.Stop` to `driveStops`. */
async function* driveUnifiedSteps(
  handlers: Map<string, (args: Record<string, unknown>, extra: unknown) => unknown>,
  steps: readonly UnifiedScriptedStep[],
) {
  for (const step of steps) {
    yield {
      type: "assistant",
      message: {
        id: step.messageId,
        content: step.calls.map((call) => ({
          type: "tool_use",
          id: call.toolUseId,
          name: call.tool,
          input: call.args,
        })),
      },
    };
    for (const call of step.calls) {
      const handler = handlers.get(call.tool);
      if (!handler) {
        throw new Error(`the unified run registered no "${call.tool}" tool`);
      }
      await handler(call.args, {
        _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: call.toolUseId },
      });
    }
  }
}

describe("the unified run — a stop after transition is nudged for the tool it now owes (AMENDMENT, ticket-03 finding)", () => {
  test("stop after finalize, before commit: the nudge names commit, not finalize", async () => {
    const fixture = seedUnifiedFixture();
    const { toolImpl, handlers } = captureUnifiedToolImpl();
    const stopDecisions: SettlementStopHookResultLike[] = [];

    const queryImpl = ((call: { options: Record<string, unknown> }) =>
      (async function* () {
        yield* driveUnifiedSteps(handlers, topicPassSteps(fixture));

        const hooks = call.options.hooks as
          | { Stop?: Array<{ hooks: Array<() => Promise<SettlementStopHookResultLike>> }> }
          | undefined;
        const stop = hooks?.Stop?.[0]?.hooks?.[0];
        if (!stop) {
          throw new Error("no Stop hook was registered on the unified query");
        }
        // Two stops: the first must be the bound's only nudge, the second its pass-through.
        stopDecisions.push(await stop());
        stopDecisions.push(await stop());

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "stopped after transition without commit.",
        };
      })()) as never;

    const runQuery = createUnifiedNoteSettlementSdkQuery({
      db,
      dataRoot: DATA_ROOT,
      queryImpl: queryImpl as never,
      createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
      toolImpl: toolImpl as never,
      now: () => NOW,
    });

    await runQuery(unifiedBaseRequest(fixture));

    expect(stopDecisions[0]?.decision).toBe("block");
    expect(stopDecisions[0]?.reason).toContain("without having called `commit`");
    expect(stopDecisions[0]?.reason).not.toContain("`finalize`");
    expect(stopDecisions[1]).toEqual({ continue: true });

    const settled = getNoteSettlementJob(db, fixture.job.id);
    expect(settled?.stage).toBe("edges");
    expect(settled?.status).toBe("claimed");
  });
});

describe("two stops without the terminal call becomes a recorded failure with the diagnosis preserved (ticket 04 integration, pinned at the hook seam)", () => {
  test("stop, stop again: the dispatch reports a deterministic failure carrying the run's own final text", async () => {
    const fixture = seedUnifiedFixture();
    const { toolImpl, handlers } = captureUnifiedToolImpl();
    const finalText =
      "T41 wall: the gate is unsatisfiable for this window — nothing left to try.";

    const queryImpl = ((call: { options: Record<string, unknown> }) =>
      (async function* () {
        yield* driveUnifiedSteps(handlers, topicPassSteps(fixture));

        const hooks = call.options.hooks as
          | { Stop?: Array<{ hooks: Array<() => Promise<SettlementStopHookResultLike>> }> }
          | undefined;
        const stop = hooks?.Stop?.[0]?.hooks?.[0];
        if (!stop) {
          throw new Error("no Stop hook was registered on the unified query");
        }
        await stop(); // blocks — this run's one nudge
        await stop(); // passes through — accepted as the run's answer

        yield { type: "result", subtype: "success", is_error: false, result: finalText };
      })()) as never;

    const runQuery = createUnifiedNoteSettlementSdkQuery({
      db,
      dataRoot: DATA_ROOT,
      queryImpl: queryImpl as never,
      createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
      toolImpl: toolImpl as never,
      now: () => NOW,
    });

    const dispatch = createUnifiedNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      logger: { warn: () => {}, error: () => {} },
      runQuery,
    });

    const outcome = await dispatch({ job: fixture.job });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("unreachable — asserted above");
    }
    expect(outcome.reason).toBe(
      composeSettlementDiagnosis(
        "edges",
        "stopped without commit (job status: claimed)",
        finalText,
      ),
    );
    expect(outcome.reason).toContain(finalText);
    expect(outcome.failureClass).toBe("deterministic");

    const settled = getNoteSettlementJob(db, fixture.job.id);
    expect(settled?.status).toBe("claimed");
    expect(settled?.stage).toBe("edges");
  });
});
