import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
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

/**
 * milestone-election ticket 04: a fixture WITH a declared lane (t1/t2/t3,
 * tagged `ownership`, t3 declares over t1/t2) plus an external same-phase
 * `consume` citer (`outside`, t4) — enough for `lane_check`'s real handler
 * to render a non-empty state line and `used[]`, proving both facts reach
 * the settlement surface (not just the CLI).
 */
function seedLaneCheckFixture(db: Database): { sessionDbId: number; job: NoteSettlementJob } {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-sdk-query-lane-check-session",
    project: "/tmp/project-settlement-sdk-query-lane-check",
    title: "settlement sdk-query lane-check fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch, type
         ) VALUES (?, ?, 'active', ?, ?, 3, ?, '["design"]')
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber, `prompt ${promptNumber}`, `response ${promptNumber}`, NOW - 900 + promptNumber)!
      .id;
  }

  const t1 = insertTurn(1);
  const t2 = insertTurn(2);
  const t3 = insertTurn(3);
  const outside = insertTurn(4);

  writeMemoryEdges(
    db,
    [
      { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", tags: ["ownership"] },
      { citing: { kind: "turn", id: t3 }, cited: { kind: "turn", id: t1 }, relation: "indexes", provenance: "asserted", tags: ["ownership"] },
      { citing: { kind: "turn", id: t3 }, cited: { kind: "turn", id: t2 }, relation: "indexes", provenance: "asserted", tags: ["ownership"] },
      { citing: { kind: "turn", id: outside }, cited: { kind: "turn", id: t1 }, relation: "consume", provenance: "asserted", tags: [] },
    ],
    NOW,
  );

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 3, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { sessionDbId, job };
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

describe("milestone-election ticket 04 — the state line and used[] reach the settlement surface, not just the CLI", () => {
  test("the lane_check tool's own description names the corrected state reading and consume-class use, guarding against the T1351 misreading", async () => {
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

      const description = descriptions.get("lane_check")!;
      expect(description).toContain("closed-valid/closed-invalid/open");
      expect(description).toContain("consume-class use");
      expect(description).toContain("still ADOPTED, not unused");
      // tag-mandate ticket 03 (superseding semantic-conformance ticket 02's
      // "vocabulary-conformance" clause): the facts are error classes now, so
      // the description must teach the ERROR/WARNING split, name the four
      // classes, and — the part that keeps a window from deadlocking — say
      // that only errors anchored inside the writable range are the agent's.
      expect(description).toContain("ERRORS");
      expect(description).toContain("WARNINGS");
      expect(description).toContain("ANCHORED");
      for (const errorClass of ["(E1)", "(E2)", "(E3)", "(E4)"]) {
        expect(description).toContain(errorClass);
      }
      expect(description).toContain("anchored OUTSIDE your range is another window's work");
    } finally {
      db?.close();
    }
  });

  test("a real lane_check call through the ACTUAL registered handler renders the state line and used[] in its text result", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, job } = seedLaneCheckFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = laneCheckReceipt.content[0]!.text;
          expect(text).toContain("declaration: closed-valid");
          expect(text).toContain("used[T");
          expect(text).not.toContain("digraph");

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
        reviewableTurnIds: new Set(),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 3,
      });
    } finally {
      db?.close();
    }
  });

  // semantic-conformance ticket 02: the vocabulary-conformance fact block
  // reaches the settlement surface too, not just the CLI — same "prove it at
  // the real registered handler" discipline as the state-line/used[] test
  // above.
  test("a real lane_check call surfaces a legacy-typed turn and a frozen-legacy supersedes edge in its text result", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const sessionDbId = upsertSession(db, {
        contentSessionId: "settlement-sdk-query-lane-check-vocab-session",
        project: "/tmp/project-settlement-sdk-query-lane-check-vocab",
        title: "settlement sdk-query lane-check vocabulary fixture",
        content: null,
        insight: null,
        createdAtEpoch: NOW - 10_000,
        updatedAtEpoch: NOW - 10_000,
        completedAtEpoch: null,
      }).id;

      function insertTurn(promptNumber: number, type: string): number {
        return db!
          .query<{ id: number }, [number, number, string, string, number, string]>(
            `INSERT INTO turns (
               session_id, prompt_number, status, user_prompt, assistant_response,
               tool_call_count, created_at_epoch, type
             ) VALUES (?, ?, 'active', ?, ?, 3, ?, ?)
             RETURNING id`,
          )
          .get(sessionDbId, promptNumber, `prompt ${promptNumber}`, `response ${promptNumber}`, NOW - 900 + promptNumber, type)!
          .id;
      }

      const t1 = insertTurn(1, '["bugfix"]'); // legacy-typed: outside MEMORY_TYPES
      const t2 = insertTurn(2, '["design"]');

      writeMemoryEdges(
        db,
        [
          { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", tags: ["vocab-fixture"] },
          { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "indexes", provenance: "asserted", tags: ["vocab-fixture"] },
          { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "supersedes", provenance: "asserted", tags: [] },
        ],
        NOW,
      );

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

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = laneCheckReceipt.content[0]!.text;
          // tag-mandate ticket 03: the same two facts, now classed as errors
          // with their anchors, in the leading ERRORS block. The tagged edges
          // this fixture writes go straight through `writeMemoryEdges`,
          // bypassing the write gate, so they ALSO stand as genuine E4 stock
          // violations (neither endpoint turn carries `vocab-fixture` in its
          // own `tags`) — the exact orphan shape the checker exists to catch.
          expect(text).toContain("## ERRORS");
          expect(text).not.toContain("## Vocabulary conformance");
          expect(text).toContain(`[E3] anchor T${t1} -- T${t1} type: [bugfix] (outside vocabulary: bugfix)`);
          expect(text).toContain(`[E2] anchor T${t2} -- T${t2} --supersedes--> T${t1}`);
          expect(text).toContain(`[E4] anchor T${t2} -- T${t2} --extends--> T${t1} {vocab-fixture}`);
          // Never admitted: the lane's own edge tally in report 1 is exactly
          // the extends+indexes pair.
          expect(text).toContain("extends=1");
          expect(text).toContain("indexes=1");
          expect(text).not.toContain("supersedes=");

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
        reviewableTurnIds: new Set(),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });
    } finally {
      db?.close();
    }
  });
});

describe("ticket 01 (agent-thinking-config): maxThinkingTokens passthrough", () => {
  test("a configured value reaches the SDK query options verbatim", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, job } = seedFixture(db);

      const { toolImpl } = captureToolImpl();
      const seenCalls: Array<{ options: Record<string, unknown> }> = [];
      const queryImpl = mock((call: { options: Record<string, unknown> }) => {
        seenCalls.push(call);
        return (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })();
      });

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
        maxThinkingTokens: 4_000,
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        sessionId: sessionDbId,
        reviewableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      expect(seenCalls[0]?.options.maxThinkingTokens).toBe(4_000);
    } finally {
      db?.close();
    }
  });

  test.each([
    ["null", null],
    ["absent", undefined],
  ] as const)(
    "%s configuration omits the key from the SDK query options (absence, not undefined-valued presence)",
    async (_label, value) => {
      let db: Database | undefined;
      try {
        db = createDatabase(":memory:");
        initializeSchema(db);
        const { sessionDbId, t1, job } = seedFixture(db);

        const { toolImpl } = captureToolImpl();
        const seenCalls: Array<{ options: Record<string, unknown> }> = [];
        const queryImpl = mock((call: { options: Record<string, unknown> }) => {
          seenCalls.push(call);
          return (async function* () {
            yield { type: "result", subtype: "success", is_error: false, result: "done" };
          })();
        });

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
          maxThinkingTokens: value,
          jobId: job.id,
          claimGeneration: job.claimGeneration,
          sessionId: sessionDbId,
          reviewableTurnIds: new Set([t1]),
          contextBuiltAtEpoch: NOW,
          windowStart: 1,
          windowEnd: 1,
        });

        expect("maxThinkingTokens" in seenCalls[0]!.options).toBe(false);
      } finally {
        db?.close();
      }
    },
  );
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
