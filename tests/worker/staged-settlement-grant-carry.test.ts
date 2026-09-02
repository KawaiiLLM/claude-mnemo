import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mock } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  createUnifiedNoteSettlementSdkQuery,
} from "../../src/worker/note-settlement-sdk-query";
import { NOTE_SETTLEMENT_UNIFIED_SYSTEM_PROMPT } from "../../src/worker/note-settlement-unified-prompt";
import { RESPONSE_ORIGIN_TOOL_USE_META_KEY } from "../../src/worker/note-settlement-response-origin";
import {
  claimWriterId,
  recordFieldCompleteness,
  recordReadGrant,
  RELATIONS_GATE_FIELD,
  snapshotWriteGateSequence,
} from "../../src/db/write-gate";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * TICKET 05 (settlement-execution-repair, spec Rev 5 "Two-layer identity"
 * clause (b)): the grant-carry integration seam. Territory note: this is a
 * NEW sibling file — `staged-settlement-unified-run.test.ts` and
 * `staged-settlement-integration.test.ts` are owned by other tickets and are
 * untouched here; the fixture/harness helpers below are intentionally
 * duplicated from the unified-run suite's own pattern rather than imported,
 * since nothing in that file is exported for reuse.
 *
 * Acceptance shapes covered:
 *   - grant-carry: an edge write whose only qualifying read grant was
 *     recorded pre-transition (same generation) lands without a re-read.
 *   - non-inheritance at ONE integration shape: a different generation of the
 *     same job sees none of a predecessor generation's grant.
 */

const NOW = 1_800_000_000;
const DATA_ROOT = "/tmp/claude-mnemo-staged-grant-carry";

function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
}

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
  messageId: string;
  calls: ScriptedCall[];
}

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
  t3: number;
  job: NoteSettlementJob;
}

/**
 * MAIN-AGENT-EDGES D3 (read-once 00 addendum): the FRESH-TURN EXCEPTION is why
 * this fixture seeds an edge at all.
 *
 * `checkRelationsGate` now admits UNCONDITIONALLY when the citing turn carries
 * no outgoing relation-bearing row: an empty set holds nothing a read could
 * have delivered, so demanding one taught the writer to run a read that grants
 * nothing. Both tests below are ABOUT the grant — one that it carries across
 * the stage transition, one that it does not cross a generation — so an
 * edgeless T1 would make both of them pass for the wrong reason (the exception,
 * not the ledger). Seeding one stored edge out of T1 puts the turn in the state
 * where the gate's rule has content.
 *
 * It points at a THIRD turn, not at T2: the pair the tests write is (T1, T2),
 * and under D1 ("one pair, one row") a stored (T1, T2) row would turn that
 * write into a promotion or a no-op instead of a landed relation. The row is
 * inserted directly rather than through `writeMemoryEdges`, which would itself
 * run the gate this fixture is setting up.
 */
function seedOutgoingRelation(db: Database, citingTurnId: number, citedTurnId: number): void {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO memory_edges (
       citing_kind, citing_id, cited_kind, cited_id,
       relation, provenance, tail_tag, head_tag,
       relation_class, relation_coverage, created_at_epoch
     ) VALUES ('turn', ?, 'turn', ?, 'consume', 'asserted', '', '', 'use', '', ?)`,
  ).run(citingTurnId, citedTurnId, NOW - 5_000);
}

function seedFixture(): Fixture {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const sessionDbId = upsertSession(db, {
    contentSessionId: "staged-grant-carry-fixture",
    project: "/tmp/project-staged-grant-carry",
    title: "staged grant-carry fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const t1 = insertTurn(db, sessionDbId, 1);
  const t2 = insertTurn(db, sessionDbId, 2);
  // Outside the settlement window on purpose: it exists only to be the head of
  // the pre-existing edge below. See `seedOutgoingRelation`.
  const t3 = insertTurn(db, sessionDbId, 3);
  seedOutgoingRelation(db, t1, t3);
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
  return { db, sessionDbId, t1, t2, t3, job };
}

function baseRequest(fixture: Fixture, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function addr(sessionDbId: number, promptNumber: number): string {
  return `S${sessionDbId}/T${promptNumber}`;
}

describe("grant-carry across the transition (ticket 05) — the edges phase inherits the SAME generation's topics-phase reads", () => {
  test("an edges-stage relation write lands using a relations read the topics phase already recorded, with no re-read after finalize", async () => {
    const fixture = seedFixture();
    try {
      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const relationArgs = {
        turn: addr(fixture.sessionDbId, 1),
        use: [{ turn: addr(fixture.sessionDbId, 2) }],
      };
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A_topics",
          calls: [
            // The topics phase's own relations read — this is what the
            // edges phase below must be able to carry forward.
            {
              tool: "recall",
              toolUseId: "tu_recall_relations",
              args: { id: addr(fixture.sessionDbId, 1), filter: { fields: ["relations"] } },
            },
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
        {
          messageId: "msg_B_edges",
          calls: [
            // NO recall here — the whole point: the only qualifying relations
            // read happened pre-transition, under the topics identity.
            { tool: "note", toolUseId: "tu_note_edge", args: relationArgs },
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
      const edgeResult = results.get("tu_note_edge") ?? "";
      expect(edgeResult).toContain("relation(s)");
      expect(edgeResult).not.toMatch(
        /refused|not delivered|never.?read|incomplete.?read|stage advanced/i,
      );
    } finally {
      fixture.db.close();
    }
  });

  test("non-inheritance at the integration seam: a reclaimed job's NEW generation sees none of the predecessor generation's relations grant", async () => {
    const fixture = seedFixture();
    try {
      // Seed a COMPLETE, fresh relations read for T1 under generation 1's
      // topics identity — the shape a stage-1 phase would have left behind
      // had this claim not been reclaimed.
      const priorGeneration = fixture.job.claimGeneration;
      const staleGenerationTopicsWriter = claimWriterId(fixture.job.id, priorGeneration, "topics");
      recordReadGrant(
        fixture.db,
        staleGenerationTopicsWriter,
        "turn",
        fixture.t1,
        NOW,
        snapshotWriteGateSequence(fixture.db),
      );
      recordFieldCompleteness(
        fixture.db,
        staleGenerationTopicsWriter,
        [{ entityType: "turn", entityId: fixture.t1, field: RELATIONS_GATE_FIELD, complete: true }],
        NOW,
        snapshotWriteGateSequence(fixture.db),
      );

      // The reclaim itself: the job stays `claimed`, its generation rises,
      // and (a cold `edges` resume's own shape) the row is already at
      // `edges` — the same fact `note-settlement-sdk-query.test.ts`'s own
      // "ledger is job-scoped, not claim-scoped" fixture bumps by raw SQL.
      fixture.db
        .query<unknown, [number]>(
          `UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1, stage = 'edges' WHERE id = ?`,
        )
        .run(fixture.job.id);
      const newGeneration = priorGeneration + 1;

      const { toolImpl, handlers } = captureToolImpl();
      const results = new Map<string, string>();
      const relationArgs = {
        turn: addr(fixture.sessionDbId, 1),
        use: [{ turn: addr(fixture.sessionDbId, 2) }],
      };
      const steps: ScriptedStep[] = [
        {
          messageId: "msg_A_edges_resume",
          // No recall in this generation at all — if the predecessor
          // generation's grant leaked in, this would land; it must not.
          calls: [{ tool: "note", toolUseId: "tu_note_edge_new_gen", args: relationArgs }],
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

      await runQuery(
        baseRequest(fixture, { claimGeneration: newGeneration, stage: "edges" }),
      );

      expect(results.get("tu_note_edge_new_gen")).toMatch(/not delivered/i);
    } finally {
      fixture.db.close();
    }
  });
});
