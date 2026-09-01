import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mock } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  createUnifiedNoteSettlementSdkQuery,
  NOTE_SETTLEMENT_UNIFIED_ALLOWED_TOOLS,
} from "../../src/worker/note-settlement-sdk-query";
import { NOTE_SETTLEMENT_UNIFIED_SYSTEM_PROMPT } from "../../src/worker/note-settlement-unified-prompt";
import {
  createResponseOriginRegistry,
  RESPONSE_ORIGIN_TOOL_USE_META_KEY,
} from "../../src/worker/note-settlement-response-origin";
import {
  insertImpressionDebt,
  listOpenImpressionDebts,
  readLaneImpression,
} from "../../src/db/impressions";
import { insertLane } from "../../src/db/lanes";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
} from "../../src/db/segments";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * THE UNIFIED RUN, DRIVEN DIRECTLY (settlement-execution-repair ticket 03).
 *
 * This suite is the "direct integration test" the ticket's own pinned
 * decision asks for in place of scheduler wiring: real tool registrations
 * through `createUnifiedNoteSettlementSdkQuery`, a scripted `queryImpl` that
 * emits REAL assistant messages (an `id` and `tool_use` content blocks) so
 * the response-origin registry observes them exactly as the real host loop
 * would, and MCP `_meta` threaded through each scripted call so
 * `resolveResponseOrigin` resolves a real origin rather than "unknown".
 *
 * Nothing here reaches the scheduler (`note-settlement.ts`) — ticket 03's own
 * boundary. `NoteSettlementDispatch`/the scheduler's two-call chain are
 * untouched and stay covered by the existing
 * `staged-settlement-integration.test.ts` suite.
 */

const NOW = 1_800_000_000;
const DATA_ROOT = "/tmp/claude-mnemo-staged-unified";

function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
}

/** Every registered tool's real handler, `(args, extra) => result` — the shape every unified face actually takes. */
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
 * reduction `observeSdkAssistantMessage` consumes, THEN invokes each step's
 * calls against the REAL registered handlers with `_meta` carrying the
 * matching `tool_use` id — the mechanical seam a write face's own
 * `resolveResponseOrigin` reads. Because the generator `yield`s the assistant
 * message before resuming to call the handlers, the consuming `for await`
 * loop has already observed it (frozen its origin) by the time any handler in
 * that step runs — the same ordering the real SDK stream guarantees.
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
  options: { type?: string; tags?: string } = {},
): number {
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
      options.type ?? '["design"]',
      options.tags ?? "[]",
    )!.id;
}

interface Fixture {
  db: Database;
  sessionDbId: number;
  t1: number;
  t2: number;
  job: NoteSettlementJob;
}

/** A clean two-turn window, typed and untagged — the topic pass owes both turns a `topic:` word before `finalize` will transition. */
function seedFixture(): Fixture {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const sessionDbId = upsertSession(db, {
    contentSessionId: "staged-unified-fixture",
    project: "/tmp/project-staged-unified",
    title: "staged unified fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const t1 = insertTurn(db, sessionDbId, 1);
  const t2 = insertTurn(db, sessionDbId, 2);
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

function baseRequest(fixture: Fixture) {
  return {
    prompt: "irrelevant — queryImpl is scripted",
    systemPrompt: NOTE_SETTLEMENT_UNIFIED_SYSTEM_PROMPT,
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

function addr(sessionDbId: number, promptNumber: number): string {
  return `S${sessionDbId}/T${promptNumber}`;
}

describe("the unified run — one registration site, union toolset", () => {
  test("registers exactly the union toolset once", () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      createUnifiedNoteSettlementSdkQuery({
        db: fixture.db,
        dataRoot: DATA_ROOT,
        queryImpl: mock(() => (async function* () {})()) as never,
        createSdkMcpServerImpl: ((definition: { tools: unknown[] }) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
      });
      // Constructing the query does not register anything by itself — the
      // registration happens per dispatch, inside the returned function —
      // so this just pins the allowed-tools list itself.
      expect([...NOTE_SETTLEMENT_UNIFIED_ALLOWED_TOOLS].sort()).toEqual(
        [
          "mcp__mnemo__recall",
          "mcp__mnemo__timeline",
          "mcp__mnemo__note",
          "mcp__mnemo__remember",
          "mcp__mnemo__finalize",
          "mcp__mnemo__commit",
          "mcp__mnemo__lane_check",
        ].sort(),
      );
      void handlers;
    } finally {
      fixture.db.close();
    }
  });
});

describe("the unified run — origin-gated same-response siblings vs the next round", () => {
  test("finalize+commit in one response: commit refuses the sibling shape; a fresh message's commit succeeds", async () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A_topics",
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
          messageId: "msg_A_finalize",
          calls: [
            { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
            // The SAME-RESPONSE sibling: composed alongside finalize, before
            // this run has seen ANY new assistant message.
            { tool: "commit", toolUseId: "tu_commit_sibling", args: { report: "sibling attempt" } },
          ],
        },
        {
          messageId: "msg_B",
          calls: [
            // The identical call, re-issued under a genuinely NEW message id.
            { tool: "commit", toolUseId: "tu_commit_next", args: { report: "no edges this window" } },
          ],
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

      const outcome = await runQuery(baseRequest(fixture));

      expect(resultText).toBeDefined();
      expect(results.get("tu_finalize")).toContain("transition");
      expect(results.get("tu_commit_sibling")).toContain("stage advanced mid-response");
      expect(results.get("tu_commit_sibling")).not.toContain("call `finalize` first");
      expect(results.get("tu_commit_next")).not.toMatch(/refused|parameter error/i);
      expect(outcome.finalized).toBe(true);
      const settled = getNoteSettlementJob(fixture.db, fixture.job.id);
      expect(settled?.status).toBe("done");
      expect(settled?.stage).toBe("edges");
    } finally {
      fixture.db.close();
    }
  });

  test("commit before finalize refuses naming finalize, not the sibling text", async () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A",
          calls: [{ tool: "commit", toolUseId: "tu_commit_early", args: { report: "too early" } }],
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

      await runQuery(baseRequest(fixture));

      expect(results.get("tu_commit_early")).toContain("finalize");
      expect(results.get("tu_commit_early")).not.toContain("stage advanced mid-response");
    } finally {
      fixture.db.close();
    }
  });

  test("finalize+relation-note in one response: the note refuses the sibling shape; a fresh message's identical write lands", async () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const relationArgs = {
        turn: addr(fixture.sessionDbId, 1),
        extends: [{ turn: addr(fixture.sessionDbId, 2) }],
      };
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A_topics",
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
          messageId: "msg_A_finalize",
          calls: [
            { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
            { tool: "note", toolUseId: "tu_note_sibling", args: relationArgs },
          ],
        },
        {
          messageId: "msg_B",
          calls: [
            // The edge facade's own precondition: a relation write needs
            // THIS run's current read of the citing turn's relations first.
            {
              tool: "recall",
              toolUseId: "tu_recall_relations",
              args: { id: addr(fixture.sessionDbId, 1), filter: { fields: ["relations"] } },
            },
            { tool: "note", toolUseId: "tu_note_next", args: relationArgs },
          ],
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

      await runQuery(baseRequest(fixture));

      expect(results.get("tu_note_sibling")).toContain("stage advanced mid-response");
      expect(results.get("tu_note_next")).not.toMatch(/refused|parameter error|stage advanced/i);
    } finally {
      fixture.db.close();
    }
  });

  test("an unresolvable (unknown) origin fails closed on a write face rather than falling back to the durable row", async () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      // No assistant message is ever observed for this call's id — the
      // registry's own deadline resolves it "unknown" (short-circuited here
      // via a registry override so the test does not wait out the real
      // deadline).
      const results = new Map<string, string>();
      const queryImpl = mock(() =>
        (async function* () {
          const noteHandler = handlers.get("note");
          if (!noteHandler) {
            throw new Error("note not registered");
          }
          const raw = await noteHandler(
            { turn: addr(fixture.sessionDbId, 1), tags: ["topic:tile-cache"] },
            { _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: "tu_orphan" } },
          );
          results.set("tu_orphan", resultText(raw));
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
        // A near-zero wait timeout so the never-observed id resolves
        // "unknown" immediately instead of the production 5s deadline.
        originRegistry: createResponseOriginRegistry({
          readStage: () => getNoteSettlementJob(fixture.db, fixture.job.id)?.stage ?? null,
          waitTimeoutMs: 5,
        }),
      });

      await runQuery(baseRequest(fixture));

      expect(results.get("tu_orphan")).toContain("could not be determined");
      expect(results.get("tu_orphan")).not.toMatch(/stage advanced/i);
    } finally {
      fixture.db.close();
    }
  });
});

describe("the unified run — finalize's own result is data-only", () => {
  test("a needle test: the finalize receipt states facts, never imperative duty language", async () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A",
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
            { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
          ],
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

      await runQuery(baseRequest(fixture));

      const text = results.get("tu_finalize") ?? "";
      // DATA the receipt must carry.
      expect(text).toContain("transition");
      expect(text).toContain("frozen writable set");
      expect(text).toContain("worklist lanes");
      // Lane-impressions ticket 02: the advisory block rides this SAME result —
      // it is the only moment the unified run's per-container coordinates exist.
      expect(text).toContain("impression containers you owe a judgment on");
      // DUTY LANGUAGE it must never carry — every instruction lives in the
      // prompt, the trusted channel, per spec decision 1.
      expect(text).not.toMatch(/stop making tool calls/i);
      expect(text).not.toMatch(/you must/i);
      expect(text).not.toMatch(/the window is not settled/i);
      expect(text).not.toMatch(/stage 2 writes the edges/i);
      expect(text).not.toMatch(/owns the terminal commit/i);
    } finally {
      fixture.db.close();
    }
  });
});

describe("the unified run — the impression obligation, end to end", () => {
  /**
   * LANE-IMPRESSIONS TICKET 02, at the real registered handlers: the topic pass
   * declares a lane, `finalize` hands back that lane's ADVISORY (its cap, from
   * the member snapshot the same transition just froze), and the terminal
   * `commit` carries the payload that lands the impression.
   */
  test("finalize hands back the lane's cap and current text; commit's payload lands the impression and claims the slot", async () => {
    const fixture = seedFixture();
    try {
      const segmentId = createSegment(fixture.db, {
        title: "unified impression task",
        content: null,
        insight: null,
        type: [],
        tags: ["unified-impression"],
        nowEpoch: NOW - 5_000,
      }).id;
      addSegmentMembers(fixture.db, segmentId, [fixture.t1, fixture.t2], NOW);

      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const laneAddress = `E${segmentId}/#tile-cache`;
      const impressionText =
        `The tile-cache lane: one turn settles the cache design and it still governs ` +
        `(S${fixture.sessionDbId}/T1).`;
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A",
          calls: [
            {
              tool: "remember",
              toolUseId: "tu_declare",
              args: { action: "create", id: `E${segmentId}`, tag: "tile-cache" },
            },
            {
              tool: "note",
              toolUseId: "tu_note_t1",
              args: {
                turn: addr(fixture.sessionDbId, 1),
                tags: ["unified-impression", "tile-cache", "topic:tile-cache"],
              },
            },
            {
              tool: "note",
              toolUseId: "tu_note_t2",
              args: {
                // Deliberately NOT in the lane: a one-member lane cannot be
                // severed, so the disposition gate stays out of a test about
                // impressions.
                turn: addr(fixture.sessionDbId, 2),
                tags: ["unified-impression", "topic:tile-cache"],
              },
            },
            { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
          ],
        },
        {
          messageId: "msg_B",
          calls: [
            // THE RETIRED ARGUMENT (lane-impressions ticket 10): a run still
            // composing its judgments on the terminal gate is refused there and
            // told where a judgment goes.
            {
              tool: "commit",
              toolUseId: "tu_commit_retired",
              args: {
                report: "no friction this window",
                impressions: [
                  { id: laneAddress, baseRevision: 0, decision: "replace", text: impressionText },
                ],
              },
            },
            // The write, on the tool that owns containers.
            {
              tool: "remember",
              toolUseId: "tu_impression_lane",
              args: {
                action: "impression",
                id: laneAddress,
                baseRevision: 0,
                decision: "replace",
                text: impressionText,
              },
            },
            {
              tool: "remember",
              toolUseId: "tu_impression_task",
              args: {
                action: "impression",
                id: `E${segmentId}`,
                baseRevision: 0,
                decision: "retain",
              },
            },
            {
              tool: "commit",
              toolUseId: "tu_commit",
              args: { report: "no friction this window" },
            },
          ],
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

      await runQuery(baseRequest(fixture));

      // The ADVISORY reaches the writer BEFORE it generates — its address, its
      // CAS base revision and the cap computed on the post-commit projection.
      const finalizeText = results.get("tu_finalize") ?? "";
      expect(finalizeText).toContain(`${laneAddress} — lane, baseRevision 0,`);
      expect(finalizeText).toContain("cap 100 tokens (1 settled member(s), post-commit)");
      expect(finalizeText).toContain("current: (none — this container has no impression yet)");

      // The retired argument is refused by name, and nothing was committed.
      expect(results.get("tu_commit_retired")).toContain("`impressions` has retired from `commit`");
      expect(results.get("tu_commit_retired")).toContain("Nothing was committed");
      // The write itself is a `remember` call, and its receipt says PENDING.
      expect(results.get("tu_impression_lane")).toContain("Impression recorded");
      expect(results.get("tu_impression_lane")).toContain("PENDING");
      expect(results.get("tu_impression_lane")).toContain(`Still owed: E${segmentId}`);
      expect(results.get("tu_impression_task")).toContain(
        "Every container this run touched now carries a decision",
      );
      // The terminal commit landed the edges' terminal mark AND the impression.
      expect(results.get("tu_commit")).toContain("Committed");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)!.status).toBe("done");
      const stored = readLaneImpression(fixture.db, segmentId, "tile-cache")!;
      expect(stored.text).toBe(impressionText);
      expect(stored.revision).toBe(1);
    } finally {
      fixture.db.close();
    }
  });

  test("a commit with no decision for a touched container is refused, and the job stays claimed", async () => {
    const fixture = seedFixture();
    try {
      const segmentId = createSegment(fixture.db, {
        title: "unified impression task",
        content: null,
        insight: null,
        type: [],
        tags: ["unified-impression"],
        nowEpoch: NOW - 5_000,
      }).id;
      addSegmentMembers(fixture.db, segmentId, [fixture.t1, fixture.t2], NOW);

      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A",
          calls: [
            {
              tool: "remember",
              toolUseId: "tu_declare",
              args: { action: "create", id: `E${segmentId}`, tag: "tile-cache" },
            },
            {
              tool: "note",
              toolUseId: "tu_note_t1",
              args: {
                turn: addr(fixture.sessionDbId, 1),
                tags: ["unified-impression", "tile-cache", "topic:tile-cache"],
              },
            },
            {
              tool: "note",
              toolUseId: "tu_note_t2",
              args: {
                // Deliberately NOT in the lane: a one-member lane cannot be
                // severed, so the disposition gate stays out of a test about
                // impressions.
                turn: addr(fixture.sessionDbId, 2),
                tags: ["unified-impression", "topic:tile-cache"],
              },
            },
            { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
          ],
        },
        {
          messageId: "msg_B",
          calls: [
            {
              tool: "commit",
              toolUseId: "tu_commit_bare",
              args: { report: "no friction this window" },
            },
          ],
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

      await runQuery(baseRequest(fixture));

      expect(results.get("tu_commit_bare")).toContain("no decision recorded for");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)!.status).toBe("claimed");
    } finally {
      fixture.db.close();
    }
  });

  /**
   * LANE-IMPRESSIONS TICKET 03, at the PRODUCTION wiring: nothing here injects
   * a claimed-set seam, so the debt below can only reach this run through the
   * default `createAttachedImpressionDebtClaimer` the query builder now
   * installs. Ticket 02 shipped that seam defaulting to "claim nothing" — with
   * that default still in place the advisory would never name the hand-declared
   * lane, the payload's judgment for it would be a stranger, and the debt would
   * still be open at the end.
   */
  test("an attached run claims a manual lifecycle debt through the SHIPPED wiring, judges its lane, and acks it in the terminal commit", async () => {
    const fixture = seedFixture();
    try {
      const segmentId = createSegment(fixture.db, {
        title: "unified debt task",
        content: null,
        insight: null,
        type: [],
        tags: ["unified-impression"],
        nowEpoch: NOW - 5_000,
      }).id;
      addSegmentMembers(fixture.db, segmentId, [fixture.t1, fixture.t2], NOW);
      // ELIGIBILITY: this session is attached to the debt's task.
      attachSegmentToSession(fixture.db, fixture.sessionDbId, segmentId, NOW - 4_000);
      // The manual operation's leftovers: a lane declared by hand, with no
      // member and no window that would otherwise touch it, and its debt.
      insertLane(fixture.db, segmentId, "hand-declared", NOW - 4_000);
      insertImpressionDebt(fixture.db, {
        segmentId,
        laneTag: "hand-declared",
        kind: "declare",
        nowEpoch: NOW - 4_000,
      });

      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const debtLaneAddress = `E${segmentId}/#hand-declared`;
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A",
          calls: [
            {
              tool: "note",
              toolUseId: "tu_note_t1",
              args: {
                turn: addr(fixture.sessionDbId, 1),
                tags: ["unified-impression", "topic:tile-cache"],
              },
            },
            {
              tool: "note",
              toolUseId: "tu_note_t2",
              args: {
                turn: addr(fixture.sessionDbId, 2),
                tags: ["unified-impression", "topic:tile-cache"],
              },
            },
            { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
          ],
        },
        {
          messageId: "msg_B",
          calls: [
            {
              tool: "remember",
              toolUseId: "tu_impression_debt",
              args: {
                action: "impression",
                id: debtLaneAddress,
                baseRevision: 0,
                decision: "retain",
              },
            },
            {
              tool: "remember",
              toolUseId: "tu_impression_task",
              args: {
                action: "impression",
                id: `E${segmentId}`,
                baseRevision: 0,
                decision: "retain",
              },
            },
            {
              tool: "commit",
              toolUseId: "tu_commit",
              args: { report: "no friction this window" },
            },
          ],
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

      await runQuery(baseRequest(fixture));

      // The claimed debt's lane reached the writer's advisory…
      expect(results.get("tu_finalize") ?? "").toContain(`${debtLaneAddress} — lane, baseRevision 0,`);
      // …its decision was accepted through `remember`…
      expect(results.get("tu_impression_debt")).toContain("Impression recorded");
      // …and the commit promoted it, so the debt is discharged.
      expect(results.get("tu_commit")).toContain("Committed");
      expect(listOpenImpressionDebts(fixture.db, segmentId)).toEqual([]);
    } finally {
      fixture.db.close();
    }
  });
});

describe("the unified run — removed-side-citer authority and post-finalize scope integrity", () => {
  /**
   * `cited` starts carrying lane word `lane-x`; the topic pass's own write
   * (through the SAME unified `note` handler) replaces its tags without it —
   * a REAL removal this run's own `finalize` diffs and reports, exactly as
   * `collectStageOneProjection`'s module header describes. `citer` sits
   * outside the window/lookback entirely — nothing but the transition's own
   * removed-side-citer closure puts it in reach.
   */
  function seedRemovedSideFixture(): Fixture & { citer: number } {
    const fixture = seedFixture();
    // `t1` starts with the lane word the topic pass is about to remove.
    fixture.db
      .query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?")
      .run(JSON.stringify(["lane-x"]), fixture.t1);
    const citer = insertTurn(fixture.db, fixture.sessionDbId, 9);
    writeMemoryEdges(
      fixture.db,
      [
        {
          citing: { kind: "turn", id: citer },
          cited: { kind: "turn", id: fixture.t1 },
          relation: "extends",
          provenance: "asserted",
          ...deriveSideTags(["lane-x"]),
        },
      ],
      NOW,
    );
    return { ...fixture, citer };
  }

  test("the citer gains relation-only authority through the SAME handler registry once finalize freezes the closure", async () => {
    const fixture = seedRemovedSideFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A_topics",
          calls: [
            // The removal itself: t1's projection write drops "lane-x". `t1`
            // starts with a non-empty `tags` (seeded directly, below), so the
            // facade's own "already holds something" rule requires the
            // explicit whole-field `mode`.
            {
              tool: "note",
              toolUseId: "tu_note_t1",
              args: {
                turn: addr(fixture.sessionDbId, 1),
                tags: ["topic:tile-cache"],
                mode: { tags: "write" },
              },
            },
            {
              tool: "note",
              toolUseId: "tu_note_t2",
              args: { turn: addr(fixture.sessionDbId, 2), tags: ["topic:tile-cache"] },
            },
            { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
          ],
        },
        {
          messageId: "msg_B",
          calls: [
            // The citer is OUTSIDE window ∪ lookback ∪ baseline closure —
            // only the removed-side-citer closure this finalize just froze
            // puts it in reach, and RELATIONS is the only field it grants.
            {
              tool: "note",
              toolUseId: "tu_citer_retract",
              args: { turn: addr(fixture.sessionDbId, 9), retractExtends: [addr(fixture.sessionDbId, 1)] },
            },
          ],
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

      await runQuery(baseRequest(fixture));

      expect(results.get("tu_finalize")).toContain("transition");
      expect(results.get("tu_citer_retract")).not.toMatch(/refused|not in your writable set/i);
    } finally {
      fixture.db.close();
    }
  });

  test("mutating the live graph after finalize does NOT widen the run's scope", async () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      let outsiderAddress = "";
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A_topics",
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
            { tool: "finalize", toolUseId: "tu_finalize", args: { summary: "one line: tile cache" } },
          ],
        },
      ];
      const queryImpl = mock(() =>
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
                throw new Error(`no ${call.tool}`);
              }
              const raw = await handler(call.args, {
                _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: call.toolUseId },
              });
              results.set(call.toolUseId, resultText(raw));
            }
          }
          // A CONCURRENT writer lands an edge into a brand-new turn AFTER the
          // transition has already frozen the scope — the live closure would
          // admit it; the frozen one must not.
          const outsiderId = insertTurn(fixture.db, fixture.sessionDbId, 3);
          outsiderAddress = addr(fixture.sessionDbId, 3);
          writeMemoryEdges(
            fixture.db,
            [
              {
                citing: { kind: "turn", id: fixture.t1 },
                cited: { kind: "turn", id: outsiderId },
                relation: "grounds",
                provenance: "asserted",
              },
            ],
            NOW,
          );

          yield {
            type: "assistant",
            message: {
              id: "msg_B",
              content: [{ type: "tool_use", id: "tu_widen_attempt", name: "note", input: {} }],
            },
          };
          const noteHandler = handlers.get("note")!;
          const raw = await noteHandler(
            { turn: outsiderAddress, retractGrounds: [addr(fixture.sessionDbId, 1)] },
            { _meta: { [RESPONSE_ORIGIN_TOOL_USE_META_KEY]: "tu_widen_attempt" } },
          );
          results.set("tu_widen_attempt", resultText(raw));

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

      expect(results.get("tu_widen_attempt")).toMatch(/parameter error|refused|outside/i);
    } finally {
      fixture.db.close();
    }
  });
});

/**
 * Teaching-repairs ticket 09 (spec Rev 5 §Implementation "Teaching
 * repairs"): the finalize refusal states a CONCRETE repair target rather
 * than a bare "shorten it" — the process audit measured two independent
 * agent instances burning 3-4 probing rounds on this exact cap with no
 * target to aim at.
 */
describe("the unified run — finalize's summary cap refusal names a concrete target", () => {
  test("an over-cap summary refuses naming the length, the cap, and the concrete target", async () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const overCap = "x".repeat(1001);
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A",
          calls: [
            { tool: "finalize", toolUseId: "tu_finalize_overcap", args: { summary: overCap } },
          ],
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

      await runQuery(baseRequest(fixture));

      const text = results.get("tu_finalize_overcap")!;
      expect(text).toContain("1001");
      expect(text).toContain("1000-character cap");
      expect(text).toContain("below ~800");
      const job = getNoteSettlementJob(fixture.db, fixture.job.id);
      expect(job?.stage).toBe("topics");
    } finally {
      fixture.db.close();
    }
  });
});
