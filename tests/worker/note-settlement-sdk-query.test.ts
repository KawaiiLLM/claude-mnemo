import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { noteInputShape, settlementNoteInputShape } from "../../src/mcp/definitions";
import { createNoteSettlementSdkQuery } from "../../src/worker/note-settlement-sdk-query";
import { settlementTurnWriteInputShape } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The settlement subagent's SDK tool registration
 * (`createNoteSettlementSdkQuery`): `note-settlement-call.test.ts` drives
 * the dispatch seam with a directly-supplied `runQuery`, never through this
 * module's own `toolImpl`/`createSdkMcpServerImpl` wiring. This file proves,
 * at the ACTUAL registration seam rather than against the staging engine
 * alone: no `check` tool ever reaches the SDK; the registered `note` tool's
 * shape is the SAME object `mcp/definitions.ts` exports (not a look-alike
 * copy); and a staged write through the real registered handler is
 * invisible until `commit`, exactly like `note-settlement-staging.test.ts`'s
 * acceptance criterion 1, now proven one layer further out.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): the
 * `NoteSettlementQueryRequest` fixtures below drop `reconstructableTurnIds`/
 * `attachedSegmentIds`/`rideTurnId`/`writerModel` (all retired), and the
 * staging-isolation demonstration stages a plain REVIEW call instead of a
 * reconstruction — title/content/insight are refused outright now.
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
        reviewableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      expect([...handlers.keys()].sort()).toEqual([
        "commit",
        "lane_check",
        "note",
        "recall",
        "remember",
        "timeline",
      ]);
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
        reviewableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      expect(shapes.get("note")).toBe(settlementTurnWriteInputShape);
      // Ticket 08 (write-mode-edit-semantics): the registered shape is
      // `settlementNoteInputShape` ITSELF again — `mode` folded back into that
      // shape, so the facade's export is a plain re-export and this identity
      // holds as it did before ticket 07 spread one key on top of it.
      expect(shapes.get("note")).toBe(settlementNoteInputShape);
      // Spec D12: the mode vocabulary reaching the settlement model is the
      // main agent's own object, not a look-alike (also pinned at the
      // registration seam by tests/worker/note-settlement-parity.test.ts).
      const registered = shapes.get("note") as Record<string, unknown>;
      expect(registered.mode).toBe(noteInputShape.mode);
    } finally {
      db?.close();
    }
  });

  // Round-4 review #9: the registered description used to teach the retired
  // `collects` word, an "out-of-branch collects target" rejection example,
  // and "address/phase/flow shape" validation — all flow/branch-era
  // language the lane model retired. Pinned at the ACTUAL registration seam
  // (not a hand-copied excerpt) so a future edit to the constant cannot
  // silently reintroduce it.
  test("the registered note tool's description teaches indexes, not collects, with no flow/branch language", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, job } = seedFixture(db);

      const { toolImpl, descriptions } = captureToolImpl();
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
        reviewableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      const description = descriptions.get("note")!;
      expect(description).toContain("indexes");
      expect(description).not.toContain("collects");
      expect(description).not.toContain("out-of-branch");
      expect(description).not.toContain("flow");
      expect(description).not.toContain("branch");
      // The current contract: entries are bare-or-`{turn, tags}`, and
      // validation is phase domains + tag legality + the self-citation gate.
      expect(description).toContain("{turn, tags}");
      expect(description).toContain("self-citation gate");
    } finally {
      db?.close();
    }
  });
});

describe("direct write holds through the real registered handlers (ticket 05: staging is unwired)", () => {
  test("a note call through the actual SDK tool lands IMMEDIATELY — no staging, commit only marks the job done", async () => {
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
            type: ["design"],
            tags: ["lease"],
          })) as { content: Array<{ text: string }> };
          expect(noteReceipt.content[0]!.text).toContain("Landed");
          expect(noteReceipt.content[0]!.text).not.toContain("Staged");
          expect(noteReceipt.content[0]!.text).not.toContain("pending commit");

          // The load-bearing assertion: the write landed ALREADY, through the
          // ACTUAL registered handler, before `commit` was ever called.
          expect(getTurnById(capturedDb, t1)!.type).toEqual(["design"]);
          expect(getTurnById(capturedDb, t1)!.tags).toEqual(["lease"]);

          // The job itself is still open — only `commit` marks it done.
          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("claimed");

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
        reviewableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      // After commit: the job itself is durably complete.
      expect(getTurnById(db, t1)!.type).toEqual(["design"]);
      expect(getTurnById(db, t1)!.tags).toEqual(["lease"]);
      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });
});
