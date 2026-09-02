import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createSegment, addSegmentMembers } from "../../src/db/segments";
import { insertLane, listLanesForSegment } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  ensureHomelessRecordTables,
  loadHomelessGroup,
  loadHomelessGroupMembers,
  resolveActiveHomelessDisposition,
  writeHomelessGroup,
  TASKLESS_TASK_SCOPE_ID,
} from "../../src/db/homeless-record";
import { getTurnById } from "../../src/db/turns";
import {
  createUnifiedNoteSettlementSdkQuery,
  type NoteSettlementUnifiedQueryResult,
} from "../../src/worker/note-settlement-sdk-query";
import { createUnifiedNoteSettlementDispatch } from "../../src/worker/note-settlement-dispatch";
import { NOTE_SETTLEMENT_UNIFIED_SYSTEM_PROMPT } from "../../src/worker/note-settlement-unified-prompt";
import { RESPONSE_ORIGIN_TOOL_USE_META_KEY } from "../../src/worker/note-settlement-response-origin";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * STAGE 1's SHARED LOGIC, driven at the UNIFIED harness's own registration
 * seam (settlement-execution-repair ticket 04b — restoring coverage ticket 04
 * took with it when it deleted `note-settlement-stage1.test.ts` wholesale).
 *
 * Every probe below drives `createUnifiedNoteSettlementSdkQuery` — real tool
 * registrations, a scripted `queryImpl` emitting real assistant messages so
 * the response-origin registry observes them the way the real host loop
 * would — never the retired stage-1-only registration site
 * (`createNoteSettlementStageOneSdkQuery`) ticket 04 removed. The production
 * functions under test (`evaluateStageOneTransitionGate`,
 * `collectStageOneProjection`, `checkStageOneLaneTag`, the write-gate machine
 * union, the compact-marker predicates) survive unchanged — this file only
 * re-expresses coverage against the surface that now owns them.
 *
 * The fixture is the same diseased shape the redesign was written about:
 * `mapc-terrain-research` is a DECLARED, phase-sliced legacy lane sitting on
 * two of the window's turns — the vocabulary decoy a run that judges those
 * turns to be about tile caching removes in favour of a fresh lane.
 */

const NOW = 1_800_000_000;
const DATA_ROOT = "/tmp/claude-mnemo-staged-stage-one-duties";

function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
}

/** Every registered tool's real handler, `(args, extra) => result` — the unified face's own shape. */
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
  /** The assistant `message.id` every call in this step shares — SAME id means SAME frozen origin. */
  messageId: string;
  calls: ScriptedCall[];
}

/**
 * A `queryImpl` stub that drives real assistant messages through the SAME
 * reduction `observeSdkAssistantMessage` consumes, then invokes each step's
 * calls against the REAL registered handlers with `_meta` carrying the
 * matching `tool_use` id — ported verbatim from
 * `staged-settlement-unified-run.test.ts`, the unified harness's own pattern.
 */
function scriptedUnifiedQueryImpl(
  handlers: Map<string, (args: Record<string, unknown>, extra: unknown) => unknown>,
  steps: readonly ScriptedStep[],
  results: Map<string, string>,
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
          const raw = await handler(call.args, {
            _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: call.toolUseId },
          });
          results.set(call.toolUseId, resultText(raw));
        }
      }
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );
}

function insertTurn(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
  options: { type?: string[]; tags?: string[]; titled?: boolean } = {},
): number {
  const id = db
    .query<{ id: number }, [number, number, string, string, number, string, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', ?, ?, 3, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 900 + promptNumber,
      JSON.stringify(options.type ?? ["design"]),
      JSON.stringify(options.tags ?? []),
    )!.id;
  if (options.titled !== false) {
    db.query<unknown, [string, string, number]>(
      "UPDATE turns SET title = ?, content = ? WHERE id = ?",
    ).run(`turn ${promptNumber} title`, `turn ${promptNumber} body`, id);
  }
  return id;
}

interface Fixture {
  db: Database;
  sessionDbId: number;
  segmentId: number;
  job: NoteSettlementJob;
  /** T1..T4 are the window; T5 is an out-of-window citer of T2. */
  t1: number;
  t2: number;
  t3: number;
  t4: number;
  t5: number;
}

/** The shared fixture — same shape as the retired stage-1-only suite's own `seed()`. */
function seed(): Fixture {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const sessionDbId = upsertSession(db, {
    contentSessionId: "stage-one-duties-session",
    project: "/tmp/project-stage-one-duties",
    title: "stage one duties fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  const segmentId = createSegment(db, {
    title: "map extraction",
    tags: ["mapc"],
    nowEpoch: NOW,
  }).id;

  // T1 already sits in a legitimate, subject-named lane. T2/T3 carry the
  // PHASE-SLICED legacy lane — the decoy. T3 additionally has no type and no
  // note at all: the turn-scope duty this pass owes. T4 belongs to no task.
  const t1 = insertTurn(db, sessionDbId, 1, { tags: ["mapc", "terrain-model"] });
  const t2 = insertTurn(db, sessionDbId, 2, { tags: ["mapc", "mapc-terrain-research"] });
  const t3 = insertTurn(db, sessionDbId, 3, {
    tags: ["mapc", "mapc-terrain-research"],
    type: [],
    titled: false,
  });
  const t4 = insertTurn(db, sessionDbId, 4, { tags: [] });
  const t5 = insertTurn(db, sessionDbId, 5, { tags: ["mapc", "mapc-terrain-research"] });

  addSegmentMembers(db, segmentId, [t1, t2, t3, t5], NOW);
  insertLane(db, segmentId, "terrain-model", NOW);
  insertLane(db, segmentId, "mapc-terrain-research", NOW);

  writeMemoryEdges(
    db,
    [
      // A PRE-EXISTING BARE DRAFT inside the window — neither side placed.
      {
        citing: { kind: "turn", id: t2 },
        cited: { kind: "turn", id: t1 },
        ...wordEdgeClass("extends"),
        provenance: "asserted",
        ...deriveSideTags([]),
      },
      // An out-of-window citer whose HEAD side names the legacy lane on T2.
      {
        citing: { kind: "turn", id: t5 },
        cited: { kind: "turn", id: t2 },
        ...wordEdgeClass("grounds"),
        provenance: "asserted",
        ...deriveSideTags(["mapc-terrain-research"]),
      },
    ],
    NOW,
  );

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 4, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { db, sessionDbId, segmentId, job, t1, t2, t3, t4, t5 };
}

function addr(sessionDbId: number, promptNumber: number): string {
  return `S${sessionDbId}/T${promptNumber}`;
}

function baseRequest(fixture: Fixture) {
  const writableTurnIds = new Set([fixture.t1, fixture.t2, fixture.t3, fixture.t4]);
  return {
    prompt: "irrelevant — queryImpl is scripted",
    systemPrompt: NOTE_SETTLEMENT_UNIFIED_SYSTEM_PROMPT,
    model: "claude-unified-test",
    jobId: fixture.job.id,
    claimGeneration: fixture.job.claimGeneration,
    stage: fixture.job.stage,
    sessionId: fixture.sessionDbId,
    writableTurnIds,
    scopeProvenance: {
      window: writableTurnIds,
      baseLookback: new Set<number>(),
      closureOnly: new Set<number>(),
    },
    contextBuiltAtEpoch: NOW,
    windowStart: 1,
    windowEnd: 4,
  };
}

/** Duties 1-2 and 7: the whole projection this fixture's window deserves, as scripted tool calls. */
function projectionStep(fixture: Fixture, options: { omitTaskless?: boolean } = {}): ScriptedStep {
  const calls: ScriptedCall[] = [
    // Duty 1+2 on T1: a topic word onto a turn that already carries lane tags.
    {
      tool: "note",
      toolUseId: "tu_proj_t1",
      args: {
        turn: addr(fixture.sessionDbId, 1),
        tags: ["mapc", "terrain-model", "topic:terrain-model"],
        mode: { tags: "write" },
      },
    },
    // Duty 1: T3 has no type and no note at all — re-typed and re-noted.
    {
      tool: "note",
      toolUseId: "tu_proj_t3_retype",
      args: {
        turn: addr(fixture.sessionDbId, 3),
        title: "tile cache sizing",
        content: "Chose a 512-tile LRU; rejected an unbounded map.",
        type: ["design"],
      },
    },
    // Duty 5: the line these two turns are really about gets its OWN lane.
    { tool: "remember", toolUseId: "tu_proj_lane", args: { action: "create", id: "E1", tag: "tile-cache" } },
    // Duty 7: REPLACEMENT SEMANTICS — `mapc-terrain-research` is not
    // assigned, so it is removed from both members.
    {
      tool: "note",
      toolUseId: "tu_proj_t2",
      args: {
        turn: addr(fixture.sessionDbId, 2),
        tags: ["mapc", "tile-cache", "topic:tile-cache"],
        mode: { tags: "write" },
      },
    },
    {
      tool: "note",
      toolUseId: "tu_proj_t3",
      args: {
        turn: addr(fixture.sessionDbId, 3),
        tags: ["mapc", "tile-cache", "topic:tile-cache"],
        mode: { tags: "write" },
      },
    },
  ];
  if (!options.omitTaskless) {
    // T4 belongs to no task — a topic word, and nothing else it could carry.
    calls.push({
      tool: "note",
      toolUseId: "tu_proj_t4",
      args: { turn: addr(fixture.sessionDbId, 4), tags: ["topic:build-scripts"] },
    });
  }
  return { messageId: "msg_projection", calls };
}

/** Runs the unified query directly over a scripted step list and hands back the per-call results plus the outcome. */
async function runUnified(
  fixture: Fixture,
  steps: readonly ScriptedStep[],
): Promise<{ results: Map<string, string>; outcome: NoteSettlementUnifiedQueryResult }> {
  const { toolImpl, handlers } = captureToolImpl();
  const results = new Map<string, string>();
  const queryImpl = scriptedUnifiedQueryImpl(handlers, steps, results);
  const runQuery = createUnifiedNoteSettlementSdkQuery({
    db: fixture.db,
    dataRoot: DATA_ROOT,
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
  });
  const outcome = await runQuery(baseRequest(fixture));
  return { results, outcome };
}

// ---------------------------------------------------------------------------
// BLOCK 1 — the 0.26.1 regression pins (shipped production fix, ticket
// 772f689, previously unpinned once ticket 04 deleted the old suite).
// ---------------------------------------------------------------------------

describe("the 0.26.1 regression pins — compact markers and machine tags through the real stage-1 write path", () => {
  // The first live windows (S18993 T41, job 140; S15069 T1960/T1971/T2047,
  // job 148) all abandoned on the same structural deadlock: a /compact
  // boundary marker sits IN the window, the gate demanded a topic word on it
  // and the removal of its hook-written `compact:` tags, and both write faces
  // refuse a marker categorically — a debt no tool could discharge. The gate
  // skips what the write path refuses.
  test("a compact marker in the window owes neither a topic word nor tag purity — the transition lands", async () => {
    const fixture = seed();
    try {
      // What history actually leaves at a /compact boundary: a marker row
      // typed `compact`, carrying only hook-written machine tags, wordless.
      fixture.db
        .query<unknown, [string, string, number]>(
          "UPDATE turns SET type = ?, tags = ? WHERE id = ?",
        )
        .run(
          JSON.stringify(["compact"]),
          JSON.stringify(["compact:trigger=manual", "compact:pre_tokens=0"]),
          fixture.t4,
        );

      const { results } = await runUnified(fixture, [
        projectionStep(fixture, { omitTaskless: true }),
        {
          messageId: "msg_finalize",
          calls: [
            {
              tool: "finalize",
              toolUseId: "tu_finalize",
              args: { summary: "two lines: terrain model, tile cache" },
            },
          ],
        },
      ]);

      expect(results.get("tu_finalize")).toContain("transition");
      const job = getNoteSettlementJob(fixture.db, fixture.job.id);
      expect(job?.stage).toBe("edges");
      expect(job?.status).toBe("claimed");
    } finally {
      fixture.db.close();
    }
  });

  test("a hook-owned machine tag on a live turn survives the projection write and raises no stray debt", async () => {
    const fixture = seed();
    try {
      // History left a delivery marker on T1 (hooks write these straight to
      // the column). The projection write below OMITS it — the write gate's
      // machine union must carry it through, and the transition's stray-tag
      // audit must not raise a debt no agent write could discharge.
      fixture.db
        .query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?")
        .run(JSON.stringify(["mapc", "terrain-model", "delivery:dropped:notified"]), fixture.t1);

      const { results } = await runUnified(fixture, [
        projectionStep(fixture),
        {
          messageId: "msg_finalize",
          calls: [
            {
              tool: "finalize",
              toolUseId: "tu_finalize",
              args: { summary: "two lines: terrain model, tile cache" },
            },
          ],
        },
      ]);

      expect(results.get("tu_finalize")).not.toMatch(/finalize refused/);
      expect(results.get("tu_finalize")).toContain("transition");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("edges");
      const storedTags = getTurnById(fixture.db, fixture.t1)!.tags;
      expect(storedTags).toContain("delivery:dropped:notified");
      expect(storedTags).toContain("topic:terrain-model");
    } finally {
      fixture.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// BLOCK 2 — transition-gate field-shape refusals.
// ---------------------------------------------------------------------------

describe("the stage-1 gate judges field shape and vocabulary, and nothing else", () => {
  test("an unfinished type and a missing topic word both block, named by address; a refusal costs no attempt; repair lands the transition in the same run", async () => {
    const fixture = seed();
    const attemptsBefore = fixture.job.attempts;
    try {
      const { results } = await runUnified(fixture, [
        {
          messageId: "msg_too_early",
          calls: [{ tool: "finalize", toolUseId: "tu_refusal", args: { summary: "too early" } }],
        },
        projectionStep(fixture),
        {
          messageId: "msg_finalize",
          calls: [{ tool: "finalize", toolUseId: "tu_finalize", args: { summary: "two lines" } }],
        },
      ]);

      const refusal = results.get("tu_refusal")!;
      expect(refusal).toContain("finalize refused");
      expect(refusal).toContain("TYPE (1)");
      expect(refusal).toContain(addr(fixture.sessionDbId, 3));
      expect(refusal).toContain("TOPIC WORD (4)");

      expect(results.get("tu_finalize")).toContain("transition");
      const job = getNoteSettlementJob(fixture.db, fixture.job.id)!;
      expect(job.stage).toBe("edges");
      expect(job.attempts).toBe(attemptsBefore);
      expect(job.claimGeneration).toBe(fixture.job.claimGeneration);
    } finally {
      fixture.db.close();
    }
  });

  // FINAL REVIEW, FINDING 5: the projection is EXACT. A legacy free-form word
  // that rides out of stage 1 untouched is neither a lane (no snapshot lists
  // it) nor a topic word (nothing preserves it on purpose) — a vocabulary
  // decoy for every later reader. Refused by NAME.
  test("a stray legacy word refuses the transition, naming the word and the turn — and repairs in the same run", async () => {
    const fixture = seed();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      // Captured INSIDE the generator, at the instant the refusal lands —
      // the run keeps going afterwards (repair, then a successful finalize),
      // so a check made only after `runQuery` resolves would observe the
      // FINAL state, not the refused one.
      let stageAtRefusal: string | null = null;
      const queryImpl = mock(() =>
        (async function* () {
          const step1 = projectionStep(fixture);
          yield {
            type: "assistant",
            message: {
              id: step1.messageId,
              content: step1.calls.map((call) => ({
                type: "tool_use",
                id: call.toolUseId,
                name: call.tool,
                input: call.args,
              })),
            },
          };
          for (const call of step1.calls) {
            const raw = await handlers.get(call.tool)!(call.args, {
              _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: call.toolUseId },
            });
            results.set(call.toolUseId, resultText(raw));
          }

          // A LEGACY word, written the only way one can exist: straight onto
          // the row, the way history left it. The live write gate refuses
          // such a tag outright — precisely why the transition needs its own
          // check, since this word predates it.
          fixture.db
            .query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?")
            .run(
              JSON.stringify(["mapc", "terrain-model", "topic:terrain-model", "san11-live-demo-ops"]),
              fixture.t1,
            );

          yield {
            type: "assistant",
            message: {
              id: "msg_stray_finalize",
              content: [{ type: "tool_use", id: "tu_stray_refusal", name: "finalize", input: { summary: "two lines" } }],
            },
          };
          const refusalRaw = await handlers.get("finalize")!(
            { summary: "two lines" },
            { _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: "tu_stray_refusal" } },
          );
          results.set("tu_stray_refusal", resultText(refusalRaw));
          stageAtRefusal = getNoteSettlementJob(fixture.db, fixture.job.id)?.stage ?? null;

          yield {
            type: "assistant",
            message: {
              id: "msg_repair",
              content: [
                {
                  type: "tool_use",
                  id: "tu_repair",
                  name: "note",
                  input: {
                    turn: addr(fixture.sessionDbId, 1),
                    tags: ["mapc", "terrain-model", "topic:terrain-model"],
                    mode: { tags: "write" },
                  },
                },
              ],
            },
          };
          const repairRaw = await handlers.get("note")!(
            {
              turn: addr(fixture.sessionDbId, 1),
              tags: ["mapc", "terrain-model", "topic:terrain-model"],
              mode: { tags: "write" },
            },
            { _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: "tu_repair" } },
          );
          results.set("tu_repair", resultText(repairRaw));

          yield {
            type: "assistant",
            message: {
              id: "msg_finalize_ok",
              content: [{ type: "tool_use", id: "tu_finalize_ok", name: "finalize", input: { summary: "two lines" } }],
            },
          };
          const okRaw = await handlers.get("finalize")!(
            { summary: "two lines" },
            { _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: "tu_finalize_ok" } },
          );
          results.set("tu_finalize_ok", resultText(okRaw));

          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );
      const runQuery = createUnifiedNoteSettlementSdkQuery({
        db: fixture.db,
        dataRoot: DATA_ROOT,
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
      });
      await runQuery(baseRequest(fixture));

      const refusal = results.get("tu_stray_refusal")!;
      expect(refusal).toContain("finalize refused");
      expect(refusal).toContain("TAGS (1)");
      expect(refusal).toContain(addr(fixture.sessionDbId, 1));
      expect(refusal).toContain('"san11-live-demo-ops"');
      expect(stageAtRefusal).toBe("topics");

      expect(results.get("tu_finalize_ok")).toContain("transition");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("edges");
    } finally {
      fixture.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// BLOCK 3 — homeless disposition through the real producer.
// ---------------------------------------------------------------------------

describe("homeless disposition, through the real producer", () => {
  test("recorded per member through the layer's sole entry, with no lane invented for it", async () => {
    const fixture = seed();
    const { db } = fixture;
    try {
      const lanesBefore = listLanesForSegment(db, fixture.segmentId).length;
      const { results } = await runUnified(fixture, [
        projectionStep(fixture),
        {
          messageId: "msg_finalize",
          calls: [
            {
              tool: "finalize",
              toolUseId: "tu_finalize",
              args: {
                summary: "T4 has no task",
                homeless: [
                  {
                    label: "build-scripts",
                    reason: "no attached task covers it",
                    turns: [addr(fixture.sessionDbId, 4)],
                  },
                ],
              },
            },
          ],
        },
      ]);
      expect(results.get("tu_finalize")).not.toMatch(/finalize refused/);
      expect(results.get("tu_finalize")).toContain("transition");

      const disposition = resolveActiveHomelessDisposition(db, fixture.t4);
      expect(disposition).not.toBeNull();
      expect(disposition!.canonicalLabel).toBe("build-scripts");
      expect(disposition!.taskScopeId).toBe(TASKLESS_TASK_SCOPE_ID);
      const job = getNoteSettlementJob(db, fixture.job.id)!;
      expect(loadHomelessGroup(db, disposition!.groupId)!.transitionSeq).toBe(job.transitionSeq);
      expect(loadHomelessGroupMembers(db, disposition!.groupId)).toEqual([fixture.t4]);

      // NO LANE was invented to house it: only `tile-cache` was added.
      const lanes = listLanesForSegment(db, fixture.segmentId).map((lane) => lane.tag);
      expect(lanes).toHaveLength(lanesBefore + 1);
      expect(lanes).not.toContain("build-scripts");
    } finally {
      db.close();
    }
  });

  /** A homeless group from an EARLIER window, exactly as a previous job would have left it. */
  function seedEarlierHomelessGroup(fixture: Fixture, turnIds: readonly number[]): number {
    const { db } = fixture;
    ensureHomelessRecordTables(db);
    const [earlierJob] = enqueueNoteSettlementWindows(
      db,
      [{ sessionId: fixture.sessionDbId, windowStart: 6, windowEnd: 9, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    if (!earlierJob) {
      throw new Error("fixture failed to enqueue the earlier window");
    }
    db.exec(
      `INSERT INTO note_settlement_transition_seq (id, last_value) VALUES (1, 1)
         ON CONFLICT(id) DO UPDATE SET last_value = 1`,
    );
    return writeHomelessGroup(db, {
      jobId: earlierJob.id,
      taskScopeId: TASKLESS_TASK_SCOPE_ID,
      canonicalLabel: "an earlier orphan line",
      memberFingerprint: "earlier-fp",
      reason: "no task covered it then",
      transitionSeq: 1,
      turnIds,
      createdAtEpoch: NOW - 100,
    }).groupId;
  }

  test("homing a turn ends its homeless disposition; a member this window never covered keeps its own (supersession activeness)", async () => {
    const fixture = seed();
    const { db } = fixture;
    try {
      // T1 is inside this window and will be HOMED by the projection; T5 sits
      // outside it entirely — the partial-overlap half.
      const oldGroupId = seedEarlierHomelessGroup(fixture, [fixture.t1, fixture.t5]);
      expect(resolveActiveHomelessDisposition(db, fixture.t1)?.groupId).toBe(oldGroupId);

      const { results } = await runUnified(fixture, [
        projectionStep(fixture),
        {
          messageId: "msg_finalize",
          calls: [{ tool: "finalize", toolUseId: "tu_finalize", args: { summary: "two lines" } }],
        },
      ]);
      expect(results.get("tu_finalize")).not.toMatch(/finalize refused/);
      expect(getNoteSettlementJob(db, fixture.job.id)?.stage).toBe("edges");

      // HOMED: it carries a task tag and a lane declared in that task now.
      expect(resolveActiveHomelessDisposition(db, fixture.t1)).toBeNull();
      // NOT COVERED: this window had no authority over T5.
      expect(resolveActiveHomelessDisposition(db, fixture.t5)?.groupId).toBe(oldGroupId);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// BLOCK 4 — the phase-token refusal on a topic word (one shape) and the
// summary over-cap refusal (one shape).
// ---------------------------------------------------------------------------

describe("the phase-token predicate and the summary cap, through the real write faces", () => {
  test("a phase-bearing topic word is refused, naming the phase word, and nothing is written", async () => {
    const fixture = seed();
    try {
      const { results } = await runUnified(fixture, [
        {
          messageId: "msg_phase",
          calls: [
            {
              tool: "note",
              toolUseId: "tu_phase",
              args: {
                turn: addr(fixture.sessionDbId, 1),
                tags: ["mapc", "terrain-model", "topic:terrain-model-verification"],
                mode: { tags: "write" },
              },
            },
          ],
        },
      ]);

      const refusal = results.get("tu_phase")!;
      expect(refusal).toContain("phase word");
      expect(refusal).toContain('"verification"');
      const storedTags = getTurnById(fixture.db, fixture.t1)!.tags;
      expect(storedTags).toEqual(["mapc", "terrain-model"]);
    } finally {
      fixture.db.close();
    }
  });

  test("a summary over the 1000-character cap refuses the transition", async () => {
    const fixture = seed();
    try {
      const { results } = await runUnified(fixture, [
        projectionStep(fixture),
        {
          messageId: "msg_over_cap",
          calls: [
            { tool: "finalize", toolUseId: "tu_over_cap", args: { summary: "x".repeat(1001) } },
          ],
        },
      ]);

      expect(results.get("tu_over_cap")).toContain("1000-character cap");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("topics");
    } finally {
      fixture.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// BLOCK 5 — ticket-04 residual pin at the DISPATCH seam.
// ---------------------------------------------------------------------------

describe("the unified dispatch's structural guarantee: ok:true implies the row is already done", () => {
  /** A clean two-turn window, typed and untagged — no segment needed here, the dispatch seam is what is under test. */
  function seedSimpleFixture(): { db: Database; sessionDbId: number; t1: number; t2: number; job: NoteSettlementJob } {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionDbId = upsertSession(db, {
      contentSessionId: "stage-one-duties-dispatch",
      project: "/tmp/project-stage-one-duties-dispatch",
      title: "dispatch-seam fixture",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;
    const t1 = insertTurn(db, sessionDbId, 1, { tags: [] });
    const t2 = insertTurn(db, sessionDbId, 2, { tags: [] });
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 2, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
    if (!job) {
      throw new Error("fixture failed to claim a settlement job");
    }
    return { db, sessionDbId, t1, t2, job };
  }

  test("a scripted full run (finalize + commit) through the real dispatch reports ok:true only once the row is already status=done", async () => {
    const fixture = seedSimpleFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_topics",
          calls: [
            {
              tool: "note",
              toolUseId: "tu_note_t1",
              args: { turn: addr(fixture.sessionDbId, 1), tags: ["topic:tile-cache"] },
            },
            {
              tool: "note",
              toolUseId: "tu_note_t2",
              args: { turn: addr(fixture.sessionDbId, 2), tags: ["topic:tile-cache"] },
            },
          ],
        },
        {
          messageId: "msg_finalize",
          calls: [{ tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } }],
        },
        {
          // A genuinely NEW message id — `commit` in the SAME response as
          // `finalize` would be refused as a same-response sibling, which is
          // not this pin's concern.
          messageId: "msg_edges",
          calls: [{ tool: "commit", toolUseId: "tu_commit", args: { report: "no edges this window" } }],
        },
      ];
      const queryImpl = scriptedUnifiedQueryImpl(handlers, steps, results);
      const runQuery = createUnifiedNoteSettlementSdkQuery({
        db: fixture.db,
        dataRoot: DATA_ROOT,
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
      });

      // `createUnifiedNoteSettlementDispatch` (note-settlement-dispatch.ts)
      // builds its OWN request internally and calls `runQuery` once, then
      // reads the row — it never writes completion itself on this path (only
      // the empty-window branch calls `completeNoteSettlementJob` directly).
      // So `ok: true` can only ever coincide with a row the COMMIT already
      // marked done, never with a write the dispatch performs on the
      // scheduler's behalf.
      const dispatch = createUnifiedNoteSettlementDispatch({
        db: fixture.db,
        runQuery,
        now: () => NOW,
      });

      const outcome = await dispatch({ job: fixture.job });

      expect(outcome.ok).toBe(true);
      expect(results.get("tu_finalize")).toContain("transition");
      expect(results.get("tu_commit")).not.toMatch(/refused/i);
      const row = getNoteSettlementJob(fixture.db, fixture.job.id);
      expect(row?.status).toBe("done");
      expect(row?.stage).toBe("edges");
    } finally {
      fixture.db.close();
    }
  });
});
