import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementTrigger,
} from "../../src/db/note-settlement";
import { readNoteSettlementWritableSnapshot } from "../../src/db/note-settlement-snapshots";
import { createNoteSettlementScheduler } from "../../src/worker/note-settlement";
import {
  createNoteSettlementDispatch,
  createUnifiedNoteSettlementDispatch,
} from "../../src/worker/note-settlement-dispatch";
import {
  createNoteSettlementSdkQuery,
  createUnifiedNoteSettlementSdkQuery,
} from "../../src/worker/note-settlement-sdk-query";
import { RESPONSE_ORIGIN_TOOL_USE_META_KEY } from "../../src/worker/note-settlement-response-origin";
import { createWorkerCore } from "../../src/worker/server";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from "../support/settlement-config";

/**
 * THE CONTRACT STEP (staged-settlement spec Rev 5; ticket 04 rewiring).
 *
 * Execution reshaping at the HIGHEST existing seam (spec §Testing decisions):
 * real registrations, real scheduler, only each dispatch's own `queryImpl`
 * swapped for a scripted stand-in. The unified dispatch (topics-stage claims)
 * runs through `createUnifiedNoteSettlementSdkQuery`'s REAL host loop — the
 * scripted `queryImpl` emits real assistant messages (an `id` and `tool_use`
 * content blocks) so the response-origin registry observes them exactly as
 * the real SDK stream would, with MCP `_meta` threaded through each scripted
 * call so `resolveResponseOrigin` resolves a real origin. The resume
 * dispatch (edges-stage claims, a cold retry after a crash) runs through the
 * older, single-stage `createNoteSettlementSdkQuery`, unmodified — it needs
 * no origin staging of its own.
 *
 * What this file proves, now that the same-drain chain is gone: ONE
 * `queryImpl` call settles a fresh window end to end (happy path), and a run
 * that transitions and then stops — no throw, just a final reply with no
 * `commit` — is recorded as an `edges`-stage failure carrying that reply's
 * own text, resolved by a SECOND, independent `queryImpl` call under a NEW
 * generation on the next claim (retry path).
 */

const NOW = 1_800_000_000;
const DATA_ROOT = "/tmp/claude-mnemo-staged-integration";

function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
}

/** Every registered tool's real handler, `(args, extra) => result`. */
function captureToolImpl() {
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

interface ScriptedCall {
  tool: string;
  toolUseId: string;
  args: Record<string, unknown>;
}
interface ScriptedStep {
  /** The assistant `message.id` every call in this step shares. */
  messageId: string;
  calls: ScriptedCall[];
}

/**
 * A `queryImpl` stub for the UNIFIED query: drives real assistant messages
 * through the same reduction `observeSdkAssistantMessage` consumes, then
 * invokes each step's calls against the REAL registered handlers with
 * `_meta` carrying the matching `tool_use` id — the mechanical seam a write
 * face's own `resolveResponseOrigin` reads. `finalText` is what the run's
 * final reply says once the stream drains (`queryResult.text`) — the
 * diagnosis composition's own raw material on a failed run.
 */
function scriptedUnifiedQueryImpl(
  handlers: Map<string, (args: Record<string, unknown>, extra: unknown) => unknown>,
  steps: readonly ScriptedStep[],
  finalText: string,
) {
  return mock(() =>
    (async function* () {
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
      yield { type: "result", subtype: "success", is_error: false, result: finalText };
    })(),
  );
}

type ToolScript = (
  call: (name: string, args: Record<string, unknown>) => Promise<string>,
) => Promise<void>;

/** A `queryImpl` stub for the single-stage RESUME query — no origin staging needed, it has only one stage to be. */
function scriptedResumeQueryImpl(
  handlers: Map<string, (args: Record<string, unknown>) => unknown>,
  script: ToolScript,
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
        return resultText(await handler(args));
      };
      await script(call);
      yield { type: "result", subtype: "success", is_error: false, result: "resume run finished." };
    })(),
  );
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

interface Fixture {
  db: Database;
  sessionDbId: number;
  jobId: number;
}

/**
 * A two-turn window, already typed and noted, carrying no topic word. The
 * missing word is the point: the transition gate refuses while a window turn
 * is wordless, so a run that never reached duty 2 cannot transition and this
 * fixture cannot pass by accident.
 */
function seed(trigger: NoteSettlementTrigger = "consecutive"): Fixture {
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

/** The real unified dispatch, its own real tool registrations, and a scripted model. */
function realUnified(
  db: Database,
  steps: readonly ScriptedStep[],
  finalText = "the unified run finished.",
) {
  const { toolImpl, handlers } = captureToolImpl();
  const queryImpl = scriptedUnifiedQueryImpl(handlers, steps, finalText);
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
  return { dispatch, queryImpl };
}

/** The real resume (cold, stage-2-shaped) dispatch, its own real tool registrations, and a scripted model. */
function realResume(db: Database, script: ToolScript) {
  const { toolImpl, handlers } = captureToolImpl();
  const queryImpl = scriptedResumeQueryImpl(handlers, script);
  const runQuery = createNoteSettlementSdkQuery({
    db,
    dataRoot: DATA_ROOT,
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
  });
  const dispatch = createNoteSettlementDispatch({
    db,
    config: SETTLEMENT_ENABLED_CONFIG,
    now: () => NOW,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    runQuery,
  });
  return { dispatch, queryImpl };
}

describe("one dispatch per claim, happy path: a fresh window settles in ONE queryImpl call", () => {
  test("topic words, the transition, and an empty-handed commit all land through the SAME registry, on one call", async () => {
    const fixture = seed();
    try {
      const unified = realUnified(fixture.db, [
        {
          messageId: "msg-topics",
          calls: [
            {
              tool: "note",
              toolUseId: "tu-note-1",
              args: { turn: "S1/T1", tags: ["topic:tile-cache"] },
            },
            {
              tool: "note",
              toolUseId: "tu-note-2",
              args: { turn: "S1/T2", tags: ["topic:tile-cache"] },
            },
            {
              tool: "finalize",
              toolUseId: "tu-finalize",
              args: { summary: "one line: tile cache" },
            },
          ],
        },
        {
          // A NEW assistant message id — the observable "the model has
          // received the finalize result" boundary the edge pass begins at.
          messageId: "msg-edges",
          calls: [
            {
              tool: "commit",
              toolUseId: "tu-commit",
              args: { report: "no edges this window" },
            },
          ],
        },
      ]);

      const scheduler = createNoteSettlementScheduler({
        db: fixture.db,
        config: SETTLEMENT_ENABLED_CONFIG,
        now: () => NOW,
        nowMs: () => NOW * 1000,
        stage1Dispatch: unified.dispatch,
        logger: { warn: () => {}, error: () => {} },
      });

      const dispatched = await scheduler.drainSession(fixture.sessionDbId);
      expect(dispatched.map((job) => job.id)).toEqual([fixture.jobId]);

      // ONE queryImpl call for the whole claim — no second cold session.
      expect(unified.queryImpl).toHaveBeenCalledTimes(1);

      const settled = getNoteSettlementJob(fixture.db, fixture.jobId)!;
      expect(settled.status).toBe("done");
      expect(settled.stage).toBe("edges");
      // The generation never bumps at the transition — one claim, one call.
      expect(settled.claimGeneration).toBe(1);
      expect(settled.attempts).toBe(1);
      expect(settled.transitionSeq).not.toBeNull();
      expect(settled.lastError).toBeNull();
      // The transition really froze the writable set the edge pass then read.
      expect(readNoteSettlementWritableSnapshot(fixture.db, fixture.jobId).size).toBe(2);
    } finally {
      fixture.db.close();
    }
  });

  test("the worker core mounts the unified dispatch at the topics slot and reaches the same result", async () => {
    const fixture = seed();
    try {
      const unified = realUnified(fixture.db, [
        {
          messageId: "msg-topics",
          calls: [
            { tool: "note", toolUseId: "tu-1", args: { turn: "S1/T1", tags: ["topic:tile-cache"] } },
            { tool: "note", toolUseId: "tu-2", args: { turn: "S1/T2", tags: ["topic:tile-cache"] } },
            { tool: "finalize", toolUseId: "tu-3", args: { summary: "one line: tile cache" } },
          ],
        },
        {
          messageId: "msg-edges",
          calls: [{ tool: "commit", toolUseId: "tu-4", args: { report: "no edges this window" } }],
        },
      ]);
      const core = createWorkerCore({
        db: fixture.db,
        config: SETTLEMENT_ENABLED_CONFIG,
        now: () => NOW,
        nowMs: () => NOW * 1000,
        logger: { warn: () => {}, error: () => {} },
        noteSettlementStage1DispatchImpl: unified.dispatch,
      });

      await core.noteSettlement.drainSession(fixture.sessionDbId);

      expect(unified.queryImpl).toHaveBeenCalledTimes(1);
      expect(getNoteSettlementJob(fixture.db, fixture.jobId)?.status).toBe("done");
    } finally {
      fixture.db.close();
    }
  });
});

describe("one dispatch per claim, retry path: a run that transitions and stops fails at `edges`, resumed by a NEW generation", () => {
  test("a run that stops after `finalize` without `commit` records an `edges` failure carrying its own final text, and the next claim resolves it in one more queryImpl call", async () => {
    const fixture = seed();
    try {
      const finalText =
        "I audited both turns, drew the tile-cache line, and finalized — then hit the " +
        "context limit before I could write any edges. Nothing further was possible " +
        "this run; the window's judgment stands ready for the next pass.";
      const unified = realUnified(
        fixture.db,
        [
          {
            messageId: "msg-topics",
            calls: [
              { tool: "note", toolUseId: "tu-1", args: { turn: "S1/T1", tags: ["topic:tile-cache"] } },
              { tool: "note", toolUseId: "tu-2", args: { turn: "S1/T2", tags: ["topic:tile-cache"] } },
              { tool: "finalize", toolUseId: "tu-3", args: { summary: "one line: tile cache" } },
            ],
          },
          // The stream ends here — no further assistant message, no `commit`.
        ],
        finalText,
      );

      const scheduler = createNoteSettlementScheduler({
        db: fixture.db,
        config: SETTLEMENT_ENABLED_CONFIG,
        now: () => NOW,
        nowMs: () => NOW * 1000,
        stage1Dispatch: unified.dispatch,
        logger: { warn: () => {}, error: () => {} },
      });

      await scheduler.drainSession(fixture.sessionDbId);

      expect(unified.queryImpl).toHaveBeenCalledTimes(1);
      const afterFirst = getNoteSettlementJob(fixture.db, fixture.jobId)!;
      expect(afterFirst.status).toBe("failed");
      // Stage KEPT: the transition landed and stands.
      expect(afterFirst.stage).toBe("edges");
      expect(afterFirst.transitionSeq).not.toBeNull();
      expect(afterFirst.failureClass).toBe("deterministic");
      // The diagnosis carries the run's own final text — never a generic
      // reason once a final text existed.
      expect(afterFirst.lastError).toContain("stage edges");
      expect(afterFirst.lastError).toContain("hit the context limit");
      expect(afterFirst.lastError!.length).toBeLessThanOrEqual(500);

      // THE RETRY: a fresh claim, a NEW generation, resolved by the cold
      // resume dispatch — edges-shaped, one more queryImpl call. The
      // deterministic failure's own backoff must elapse first.
      const RETRY_NOW = NOW + 3_600;
      const resume = realResume(fixture.db, async (call) => {
        await call("commit", { report: "no edges this window" });
      });
      const resumeScheduler = createNoteSettlementScheduler({
        db: fixture.db,
        config: SETTLEMENT_ENABLED_CONFIG,
        now: () => RETRY_NOW,
        nowMs: () => RETRY_NOW * 1000,
        dispatch: resume.dispatch,
        logger: { warn: () => {}, error: () => {} },
      });

      const resumed = await resumeScheduler.drainSession(fixture.sessionDbId);
      expect(resumed.map((job) => job.id)).toEqual([fixture.jobId]);
      expect(resume.queryImpl).toHaveBeenCalledTimes(1);

      const settled = getNoteSettlementJob(fixture.db, fixture.jobId)!;
      expect(settled.status).toBe("done");
      expect(settled.stage).toBe("edges");
      // A reclaim IS a new claim, and it costs an attempt; the transition
      // itself is not re-taken.
      expect(settled.attempts).toBe(2);
      expect(settled.claimGeneration).toBeGreaterThan(afterFirst.claimGeneration);
      expect(settled.transitionSeq).toBe(afterFirst.transitionSeq);
      expect(settled.lastError).toBeNull();
    } finally {
      fixture.db.close();
    }
  });
});
