import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import { settlementNoteInputShape } from "../../src/mcp/definitions";
import { createNoteSettlementSdkQuery } from "../../src/worker/note-settlement-sdk-query";
import { settlementTurnWriteInputShape } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Ticket 07 (ADR-0007, semantic-container) — the settlement subagent's SDK
 * tool registration (`createNoteSettlementSdkQuery`) had no dedicated test
 * before this file: `note-settlement-call.test.ts` drives the dispatch
 * seam with a directly-supplied `runQuery`, never through this module's own
 * `toolImpl`/`createSdkMcpServerImpl` wiring. This file proves, at the ACTUAL
 * registration seam rather than against the staging engine alone: no `check`
 * tool ever reaches the SDK; the registered `note` tool's shape is the SAME
 * object `mcp/definitions.ts` exports (not a look-alike copy); and a staged
 * write through the real registered handler is invisible until `commit`,
 * exactly like `note-settlement-staging.test.ts`'s acceptance criterion 1,
 * now proven one layer further out.
 */

const NOW = 1_800_000_000;

function seedFixture(db: Database): { sessionDbId: number; t1: number; job: NoteSettlementJob } {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-sdk-query-session",
    project: "/tmp/project-settlement-sdk-query",
    title: "settlement sdk-query fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  const t1 = db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(sessionDbId, 1, "prompt 1", "response 1", NOW - 900)!.id;

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { sessionDbId, t1, job };
}

/** Mirrors diary-sdk-query.test.ts's mocking pattern: capture every registered tool's name/description/shape/handler. */
function captureToolImpl() {
  const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const shapes = new Map<string, unknown>();
  const descriptions = new Map<string, string>();
  const toolImpl = mock(
    (name: string, description: string, shape: unknown, handler: (args: Record<string, unknown>) => unknown) => {
      handlers.set(name, handler);
      shapes.set(name, shape);
      descriptions.set(name, description);
      return { name };
    },
  );
  return { toolImpl, handlers, shapes, descriptions };
}

describe("settlement's registered tool surface has no check (ticket 07, ADR-0007)", () => {
  test("exactly recall/timeline/note/segment/commit are registered — check is not among them", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, job } = seedFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const runQuery = createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-sdk-query",
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
      });

      await runQuery({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        sessionId: sessionDbId,
        reconstructableTurnIds: new Set([t1]),
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set(),
        contextBuiltAtEpoch: NOW,
        rideTurnId: null,
        writerModel: "claude-sonnet-5",
        eligibleRelationPairKeys: new Set(),
      });

      expect([...handlers.keys()].sort()).toEqual(["commit", "note", "recall", "remember", "timeline"]);
      expect(handlers.has("check")).toBe(false);
    } finally {
      db?.close();
    }
  });

  test("the registered note tool's shape is the SAME object mcp/definitions.ts exports, not a duplicate", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, job } = seedFixture(db);

      const { toolImpl, shapes } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const runQuery = createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-sdk-query",
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
      });

      await runQuery({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        sessionId: sessionDbId,
        reconstructableTurnIds: new Set([t1]),
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set(),
        contextBuiltAtEpoch: NOW,
        rideTurnId: null,
        writerModel: "claude-sonnet-5",
        eligibleRelationPairKeys: new Set(),
      });

      expect(shapes.get("note")).toBe(settlementTurnWriteInputShape);
      expect(shapes.get("note")).toBe(settlementNoteInputShape);
    } finally {
      db?.close();
    }
  });
});

describe("staging isolation holds through the real registered handlers (ticket 07)", () => {
  test("a staged note call through the actual SDK tool touches no row until commit lands it", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, job } = seedFixture(db);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const noteReceipt = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            title: "reconstructed via the real tool",
            content: "Filled in from raw material.",
            insight: null,
            grade: 2,
            type: ["design"],
            tags: ["lease"],
          })) as { content: Array<{ text: string }> };
          expect(noteReceipt.content[0]!.text).toContain("Staged");

          // Completion gate satisfaction (ticket 08's re-key): this
          // fixture's session attaches no segment, so the segmentation
          // check is trivially satisfied without any `remember` call —
          // unrelated to the note isolation claim this test is about.

          // The load-bearing assertion: nothing landed yet, through the ACTUAL
          // registered handler, not the engine called directly.
          expect(getTurnById(capturedDb, t1)!.significanceGrade).toBeNull();
          expect(getShadowNote(capturedDb, t1)).toBeNull();

          const commitReceipt = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(commitReceipt.content[0]!.text).toContain("Committed");

          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const runQuery = createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-sdk-query",
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
      });

      await runQuery({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        sessionId: sessionDbId,
        reconstructableTurnIds: new Set([t1]),
        reviewableTurnIds: new Set([t1]),
        attachedSegmentIds: new Set(),
        contextBuiltAtEpoch: NOW,
        rideTurnId: null,
        writerModel: "claude-sonnet-5",
        eligibleRelationPairKeys: new Set(),
      });

      // After commit: the write landed for real.
      expect(getTurnById(db, t1)!.significanceGrade).toBe(2);
      expect(getShadowNote(db, t1)!.title).toBe("reconstructed via the real tool");
    } finally {
      db?.close();
    }
  });
});
