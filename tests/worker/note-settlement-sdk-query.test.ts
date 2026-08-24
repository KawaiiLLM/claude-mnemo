import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  computeSettlementWritableTurnIds,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import { claimWriterId, sessionWriterId, stampField } from "../../src/db/write-gate";
import { getOutgoingEdges } from "../../src/db/memory-edges";
import { noteInputShape, settlementNoteInputShape } from "../../src/mcp/definitions";
import {
  createNoteSettlementSdkQuery,
  SETTLEMENT_ALLOWED_TOOLS,
} from "../../src/worker/note-settlement-sdk-query";
import {
  settlementTurnWriteInputSchema,
  settlementTurnWriteInputShape,
} from "../../src/worker/note-settlement-turn-facade";
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
function seedLaneCheckFixture(db: Database): {
  sessionDbId: number;
  job: NoteSettlementJob;
  /**
   * The lane's own three turns. Peer round T1466 (finding P1-1): the checker
   * projection is seeded from the dispatch's WRITABLE SET now, not from the
   * job's prompt-number range, so a fixture has to hand its turns to the
   * request instead of relying on `windowStart`/`windowEnd` to find them.
   * `outside` (the external consume citer) stays out — it is discovered by
   * the loader's own closure, which is the property these tests exercise.
   */
  laneTurnIds: number[];
} {
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
  return { sessionDbId, job, laneTurnIds: [t1, t2, t3] };
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
        writableTurnIds: new Set([t1]),
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
        writableTurnIds: new Set([t1]),
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
        writableTurnIds: new Set([t1]),
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
        writableTurnIds: new Set([t1]),
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
      // Tag-mandate ticket 06: E5 (lane shape, ticket 04) joined the list.
      // This description and `commit`'s both enumerated E1-E4 as a CLOSED
      // list after E5 shipped, so an agent meeting an E5 refusal was told
      // about a class the surface denied existed.
      for (const errorClass of ["(E1)", "(E2)", "(E3)", "(E4)", "(E5)"]) {
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
      const { sessionDbId, job, laneTurnIds } = seedLaneCheckFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = laneCheckReceipt.content[0]!.text;
          expect(text).toContain("declaration: closed-valid");
          // floor-and-render-fidelity ticket 03: every projection turn's own
          // citedness reference is an address now, not a bare `T<dbid>`.
          expect(text).toContain("used[S");
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
        // T1466 (finding P1-1): `lane_check`'s projection is this set, so an
        // empty one is now an empty report — the fixture states its scope.
        writableTurnIds: new Set(laneTurnIds),
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
          // Floor-and-render-fidelity ticket 03: EVERY turn reference on this
          // surface is an address now — the settlement agent repairs through
          // `S<session>/T<prompt>` and cannot type a `turns.id` into `note`,
          // and that now holds for an edge's endpoints too, not just its
          // anchor (tag-mandate ticket 06's narrower scope). Both t1 and t2
          // are in this window's own projection, so both resolve.
          expect(text).toContain(
            `[E3] anchor S${sessionDbId}/T1 -- S${sessionDbId}/T1 type: [bugfix] (outside vocabulary: bugfix)`,
          );
          expect(text).toContain(
            `[E2] anchor S${sessionDbId}/T2 -- S${sessionDbId}/T2 --supersedes--> S${sessionDbId}/T1`,
          );
          expect(text).toContain(
            `[E4] anchor S${sessionDbId}/T2 -- S${sessionDbId}/T2 --extends--> S${sessionDbId}/T1 {vocab-fixture}`,
          );
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
        // T1466 (finding P1-1): the writable set IS the checker projection.
        writableTurnIds: new Set([t1, t2]),
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
        writableTurnIds: new Set([t1]),
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
          writableTurnIds: new Set([t1]),
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
        writableTurnIds: new Set([t1]),
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

/**
 * THE COMMIT GATE (tag-mandate ticket 05, spec "The commit gate" +
 * "Anchoring and repairability"). Proved at the REAL registered handler —
 * the same discipline the rest of this file uses — because the gate's whole
 * value is that the tool the model actually calls refuses, and a test against
 * a helper function would prove only that the helper computes.
 *
 * Three properties, one per test:
 *
 *   1. an error anchored INSIDE the run's immutable writable set refuses the
 *      commit, names the offending row and the move that clears it, and
 *      costs the job NOTHING (still `claimed`, same attempt count) — a
 *      refusal is an ordinary in-run tool rejection, not an attempt failure;
 *      repairing and re-calling `commit` in the SAME run then succeeds;
 *   2. the SAME error anchored outside the set commits clean — the scoping
 *      that keeps every window able to converge (spec: an error anchored
 *      outside blocks its OWN window, never this one);
 *   3. a turn-anchored class (E3) behaves identically, so the gate reads
 *      `anchorId` and nothing else — it needs no per-class knowledge.
 */
describe("commit refuses while an in-scope error remains (tag-mandate ticket 05)", () => {
  /**
   * A window (T1-T2) whose T2 carries a TAGGED `extends` at an out-of-window
   * turn that does not carry the tag — a genuine E4 subset-invariant stock
   * violation, anchored at the citing turn T2. The repair (tagging the CITED
   * endpoint) is only possible because the deadlock-guard closure puts that
   * endpoint in the writable set, so this fixture exercises the gate and the
   * closure together, which is how they meet in production.
   */
  function seedSubsetInvariantFixture(db: Database): {
    sessionDbId: number;
    t1: number;
    t2: number;
    outside: number;
    job: NoteSettlementJob;
  } {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "settlement-sdk-query-commit-gate-session",
      project: "/tmp/project-settlement-sdk-query-commit-gate",
      title: "settlement sdk-query commit-gate fixture",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;

    const insertTurn = (promptNumber: number, tags: string): number =>
      db
        .query<{ id: number }, [number, number, string, string, number, string]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, user_prompt, assistant_response,
             tool_call_count, created_at_epoch, type, tags
           ) VALUES (?, ?, 'active', ?, ?, 3, ?, '["design"]', ?)
           RETURNING id`,
        )
        .get(
          sessionDbId,
          promptNumber,
          `prompt ${promptNumber}`,
          `response ${promptNumber}`,
          NOW - 900 + promptNumber,
          tags,
        )!.id;

    const t1 = insertTurn(1, "[]");
    const t2 = insertTurn(2, '["lane"]');
    const outside = insertTurn(3, "[]");

    // Straight through the primitive, bypassing the write gate — the exact
    // orphan shape the checker exists to catch over STOCK (a later tag edit
    // on an endpoint can strand a row the gate once passed).
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: outside },
          relation: "extends",
          provenance: "asserted",
          tags: ["lane"],
        },
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
    return { sessionDbId, t1, t2, outside, job };
  }

  test("an in-scope error refuses commit naming it, costs no attempt, and a repair inside the same run commits", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, t2, outside, job } = seedSubsetInvariantFixture(db);
      const capturedDb = db;

      // The dispatch's own computation, used verbatim: window + lookback
      // (here just the window's own turns) plus the deadlock-guard closure,
      // which is what puts the CITED endpoint within repairing reach.
      const writableTurnIds = computeSettlementWritableTurnIds(db, [t1, t2]);
      expect(writableTurnIds.has(outside)).toBe(true);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const claimed = getNoteSettlementJob(capturedDb, job.id)!;
          expect(claimed.status).toBe("claimed");

          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          const refusalText = refused.content[0]!.text;
          expect(refusalText).toContain("Commit refused");
          expect(refusalText).toContain("[E4]");
          // Addressed the way the repair call itself is addressed — a raw
          // `turns.id` would make the list unactionable.
          expect(refusalText).toContain(`S${sessionDbId}/T2`);
          expect(refusalText).toContain(`S${sessionDbId}/T3`);
          expect(refusalText).toContain('"lane" missing from the cited turn\'s own tags');
          expect(refusalText).toContain("NOT a failed attempt");

          // THE PROPERTY: a refusal is an ordinary in-run tool rejection.
          // The job row is untouched — still claimed, same attempt count —
          // so nothing about this refusal moves the window toward
          // three-strike abandonment.
          const afterRefusal = getNoteSettlementJob(capturedDb, job.id)!;
          expect(afterRefusal.status).toBe("claimed");
          expect(afterRefusal.attempts).toBe(claimed.attempts);
          expect(afterRefusal.claimGeneration).toBe(claimed.claimGeneration);

          // The repair the refusal asked for, on a turn the CLOSURE (not the
          // rendered window) put in reach.
          const repair = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T3`,
            tags: ["lane"],
          })) as { content: Array<{ text: string }> };
          expect(repair.content[0]!.text).toContain("Landed");

          const committed = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(committed.content[0]!.text).toContain("Committed");

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
        writableTurnIds,
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(getTurnById(db, outside)!.tags).toEqual(["lane"]);
    } finally {
      db?.close();
    }
  });

  test("the SAME error anchored OUTSIDE the writable set never blocks this window", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, t2, job } = seedSubsetInvariantFixture(db);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const committed = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          // The error is still THERE — the checker reports it either way. It
          // simply anchors at T2, which this run's set does not name, so it
          // is another window's work.
          expect(committed.content[0]!.text).toContain("Committed");
          expect(committed.content[0]!.text).not.toContain("Commit refused");
          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("done");

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
        // T2 — the anchor — deliberately absent.
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      // Untouched by this window: the offending row still stands, waiting for
      // the window that actually owns its anchor.
      expect(getTurnById(db, t2)!.tags).toEqual(["lane"]);
    } finally {
      db?.close();
    }
  });

  test("a turn-anchored class (E3, empty type) blocks and clears the same way — the gate reads anchorId alone", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      // `seedFixture`'s turn is inserted with no `type` at all, so it carries
      // the column default `[]` — E3's emptiness case, anchored at the turn.
      const { sessionDbId, t1, job } = seedFixture(db);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(refused.content[0]!.text).toContain("[E3]");
          expect(refused.content[0]!.text).toContain(`S${sessionDbId}/T1`);
          expect(refused.content[0]!.text).toContain("type is empty");
          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("claimed");

          await handlers.get("note")!({ turn: `S${sessionDbId}/T1`, type: ["design"] });

          const committed = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(committed.content[0]!.text).toContain("Committed");

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
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(getTurnById(db, t1)!.type).toEqual(["design"]);
    } finally {
      db?.close();
    }
  });
});

// ---------------------------------------------------------------------------
// TAG-MANDATE TICKET 06 — SETTLEMENT GOES PULL.
//
// With the window rendering retired, `recall` is the agent's ONLY view of turn
// content and of existing edges, and its own calls are what license its
// writes. Everything below is proved at the ACTUAL registered handler — the
// discipline the rest of this file already uses — because each property is a
// claim about the tool the model calls, and a test against a helper would
// prove only that the helper computes.
// ---------------------------------------------------------------------------

/**
 * One turn, typed and optionally tagged/noted. A `title`/`content` pair is
 * written to BOTH the turn row and `shadow_notes` — the shape an era turn
 * carries once the main agent's own `note` has promoted it
 * (`promoteTurnFromNote`), and the only shape recall actually renders.
 */
function insertTypedTurn(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
  options: { type?: string; tags?: string; title?: string; content?: string } = {},
): number {
  const turnId = db
    .query<{ id: number }, [number, number, string, string, number, string, string, string | null, string | null]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags, title, content
       ) VALUES (?, ?, 'active', ?, ?, 3, ?, ?, ?, ?, ?)
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
      options.title ?? null,
      options.content ?? null,
    )!.id;
  if (options.title !== undefined && options.content !== undefined) {
    upsertShadowNote(db, {
      turnId,
      title: options.title,
      content: options.content,
      nowEpoch: NOW - 500,
    });
  }
  return turnId;
}

function seedPullSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: `/tmp/project-${contentSessionId}`,
    title: contentSessionId,
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function claimWindow(
  db: Database,
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

describe("ticket 06 — the read tools the pull architecture depends on", () => {
  test("the allowlist handed to the SDK includes recall and timeline, at the real query seam", async () => {
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
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      // The SDK's OWN option, not the module constant read back at itself:
      // an allowlist that dropped `recall` would leave the agent unable to
      // see a single turn it is asked to settle.
      const allowed = seenCalls[0]?.options.allowedTools as string[];
      expect(allowed).toContain("mcp__mnemo__recall");
      expect(allowed).toContain("mcp__mnemo__timeline");
      expect(allowed).toEqual([...SETTLEMENT_ALLOWED_TOOLS]);
    } finally {
      db?.close();
    }
  });

  test("the registered recall renders the `relations` field — the pull agent's only view of existing edges", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const sessionDbId = seedPullSession(db, "settlement-pull-relations");
      const t1 = insertTypedTurn(db, sessionDbId, 1, { tags: '["lane"]' });
      const t2 = insertTypedTurn(db, sessionDbId, 2, { tags: '["lane"]' });
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: t2 },
            cited: { kind: "turn", id: t1 },
            relation: "extends",
            provenance: "asserted",
            tags: ["lane"],
          },
        ],
        NOW,
      );
      const job = claimWindow(db, sessionDbId, 1, 2);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const receipt = (await handlers.get("recall")!({
            id: `S${sessionDbId}/T1..T2`,
            filter: { fields: ["metadata", "content", "relations"] },
            turn: 4_000,
          })) as { content: Array<{ text: string }> };
          const text = receipt.content[0]!.text;

          // Both directions, the relation word, the counterpart address and
          // the canonical tag set — the completeness bar edge-read-surface
          // ticket 01 was accepted against.
          expect(text).toContain("→ extends T1 {lane}");
          expect(text).toContain("← extends from T2 {lane}");
          // And the range selector really paged BOTH turns.
          expect(text).toContain("[T1]");
          expect(text).toContain("[T2]");

          // A recall that did NOT ask for relations must not pay for them.
          const without = (await handlers.get("recall")!({
            id: `S${sessionDbId}/T2`,
            turn: 4_000,
          })) as { content: Array<{ text: string }> };
          expect(without.content[0]!.text).not.toContain("→ extends");

          expect(capturedDb).toBeDefined();
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
        writableTurnIds: new Set([t1, t2]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });
    } finally {
      db?.close();
    }
  });
});

/**
 * THE GRANT UNIFICATION, at the registered handlers (ticket 06's checkbox 1,
 * "grants unify"). The property in one sentence: a whole-field `write` over
 * ANOTHER writer's text is refused until this run's own `recall` has
 * delivered that field, and the recall that licenses it is the ordinary
 * registered tool, carrying no settlement-specific privilege.
 *
 * The negative half is the load-bearing one — a test that only proved the
 * write succeeds after a recall would also pass if the gate were simply off.
 */
describe("ticket 06 — a recall through the registered tool is what licenses a write", () => {
  function seedForeignOwnedNote(db: Database): {
    sessionDbId: number;
    t1: number;
    t2: number;
    job: NoteSettlementJob;
  } {
    const sessionDbId = seedPullSession(db, "settlement-pull-grant");
    const t1 = insertTypedTurn(db, sessionDbId, 1, {
      title: "the main agent's own title",
      content: "The main agent's own conclusion.",
    });
    const t2 = insertTypedTurn(db, sessionDbId, 2, {
      title: "another turn the run never reads",
      content: "Also the main agent's.",
    });
    // The main agent owns both fields, so the gate must consult a read grant
    // rather than admitting on the never-written rule.
    stampField(db, "turn", t1, "content", sessionWriterId(sessionDbId), NOW - 500);
    stampField(db, "turn", t2, "content", sessionWriterId(sessionDbId), NOW - 500);
    return { sessionDbId, t1, t2, job: claimWindow(db, sessionDbId, 1, 2) };
  }

  test("recall first, then the whole-field write lands; the turn never recalled is still refused", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, t2, job } = seedForeignOwnedNote(db);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // NEGATIVE FIRST: no read of T1 yet, so the gate names the remedy.
          const refused = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            content: "In hindsight: what this turn actually settled.",
            mode: { content: "write" },
          })) as { content: Array<{ text: string }> };
          expect(refused.content[0]!.text).toContain("has not been read this session");
          expect(getTurnById(capturedDb, t1)!.content).toBe("The main agent's own conclusion.");

          // Step 0's coverage read, through the registered tool.
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T1`,
            filter: { fields: ["metadata", "content", "relations"] },
            turn: 4_000,
          });

          const landed = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            content: "In hindsight: what this turn actually settled.",
            mode: { content: "write" },
          })) as { content: Array<{ text: string }> };
          expect(landed.content[0]!.text).toContain("Landed");

          // T2 was never recalled, and the grant on T1 does not spread to it.
          const stillRefused = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            content: "a rewrite of text this run never read",
            mode: { content: "write" },
          })) as { content: Array<{ text: string }> };
          expect(stillRefused.content[0]!.text).toContain("has not been read this session");
          expect(getTurnById(capturedDb, t2)!.content).toBe("Also the main agent's.");

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
        writableTurnIds: new Set([t1, t2]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      // The write landed under THIS run's claim identity — the same string
      // the recall recorded its grant under. Settlement prose lands in
      // `shadow_notes` and is deliberately never promoted onto the turn row,
      // so that is where the new text is.
      expect(getShadowNote(db, t1)!.content).toBe(
        "In hindsight: what this turn actually settled.",
      );
      const grant = db
        .query<{ count: number }, [string, number]>(
          "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn' AND entity_id = ?",
        )
        .get(claimWriterId(job.id, job.claimGeneration), t1);
      expect(grant?.count).toBe(1);
    } finally {
      db?.close();
    }
  });

  test("timeline licenses nothing — it navigates, and records no grant at all", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t1, t2, job } = seedForeignOwnedNote(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          await handlers.get("timeline")!({ id: `S${sessionDbId}` });

          const refused = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            content: "a rewrite licensed by a timeline call",
            mode: { content: "write" },
          })) as { content: Array<{ text: string }> };
          expect(refused.content[0]!.text).toContain("has not been read this session");

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
        writableTurnIds: new Set([t1, t2]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      const grants = db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = ?",
        )
        .get(claimWriterId(job.id, job.claimGeneration));
      expect(grants?.count).toBe(0);
    } finally {
      db?.close();
    }
  });
});

/**
 * THE END-TO-END PULL RUN (ticket 06's checkbox 3). One settlement against a
 * fixture database, driven entirely through the registered handlers: the
 * agent pages its whole writable set with a RANGE recall (checklist Step 0),
 * tags both lane members, wires the tagged edge the mandate requires, and
 * commits clean. Nothing here is stubbed except the model's own turn-taking.
 */
describe("ticket 06 — a full pull run: range-recall the window, tag the lane, commit clean", () => {
  test("coverage read, member tags, a tagged extends, and a clean commit", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const sessionDbId = seedPullSession(db, "settlement-pull-e2e");
      const t1 = insertTypedTurn(db, sessionDbId, 1, {
        title: "design+gate: the writable set is immutable",
        content: "Decided the set is computed before the run.",
      });
      const t2 = insertTypedTurn(db, sessionDbId, 2, {
        title: "design+gate: the set closes over cited endpoints",
        content: "Extended it with the deadlock-guard closure.",
      });
      const job = claimWindow(db, sessionDbId, 1, 2);
      const writableTurnIds = computeSettlementWritableTurnIds(db, [t1, t2]);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // STEP 0 — COVERAGE. One range call pages the whole writable set,
          // exactly the shape the prompt teaches.
          const coverage = (await handlers.get("recall")!({
            id: `S${sessionDbId}/T1..T2`,
            filter: { fields: ["metadata", "content", "relations"] },
            turn: 4_000,
          })) as { content: Array<{ text: string }> };
          const text = coverage.content[0]!.text;
          // Both turns' CONTENT, from one call. (This fixture DB records no
          // era cutoff, so recall labels each turn with its user prompt
          // rather than its title — the same legacy path the shared handler
          // takes, since both resolve the cutoff from the database.)
          expect(text).toContain("Decided the set is computed before the run.");
          expect(text).toContain("Extended it with the deadlock-guard closure.");
          // TEACHABILITY, the ticket's own coverage-contract clause: ONE
          // range call really did grant EVERY turn of the writable set, so
          // "page through every turn" is an instruction the agent can
          // actually follow in bounded calls rather than one per turn.
          const granted = capturedDb
            .query<{ entityId: number }, [string]>(
              "SELECT entity_id AS entityId FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn'",
            )
            .all(claimWriterId(job.id, job.claimGeneration))
            .map((row) => row.entityId)
            .sort((a, b) => a - b);
          expect(granted).toEqual([...writableTurnIds].sort((a, b) => a - b));

          // The lane: member tags FIRST (the subset invariant), then the edge.
          for (const promptNumber of [1, 2]) {
            const tagged = (await handlers.get("note")!({
              turn: `S${sessionDbId}/T${promptNumber}`,
              tags: ["writable-set"],
            })) as { content: Array<{ text: string }> };
            expect(tagged.content[0]!.text).toContain("Landed");
          }

          const edge = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            extends: [{ turn: `S${sessionDbId}/T1`, tags: ["writable-set"] }],
          })) as { content: Array<{ text: string }> };
          expect(edge.content[0]!.text).toContain("Landed");

          // The gate sees a legal lane: no E1 (the edge carries its tags), no
          // E4 (both endpoints carry them), no E3 (both turns are typed).
          const committed = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(committed.content[0]!.text).toContain("Committed");
          expect(committed.content[0]!.text).not.toContain("Commit refused");

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
        writableTurnIds,
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(getTurnById(db, t1)!.tags).toEqual(["writable-set"]);
      const edges = getOutgoingEdges(db, { kind: "turn", id: t2 }).filter(
        (row) => row.relation === "extends",
      );
      expect(edges).toHaveLength(1);
      expect(edges[0]!.tags).toEqual(["writable-set"]);
    } finally {
      db?.close();
    }
  });
});

/**
 * E5's own repair sentence (ticket 06's drift fix). Before this, E5 fell
 * through `describeCommitGateError`'s `default:` branch and reached the agent
 * as "[E5] S1/T2: see `lane_check` for this instance." — an anchor with no
 * move, on a class the tool descriptions did not even admit existed.
 */
describe("ticket 06 — an E5 commit refusal names the repair, not just the anchor", () => {
  test("the refusal states the two shapes and names the canonical node", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const sessionDbId = seedPullSession(db, "settlement-pull-e5");
      // One lane {shape}, one source (T1), TWO sinks (T2 and T3 both cite T1
      // and are cited by nothing) — the lane-shape law's own violation.
      const t1 = insertTypedTurn(db, sessionDbId, 1, { tags: '["shape"]' });
      const t2 = insertTypedTurn(db, sessionDbId, 2, { tags: '["shape"]' });
      const t3 = insertTypedTurn(db, sessionDbId, 3, { tags: '["shape"]' });
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: t2 },
            cited: { kind: "turn", id: t1 },
            relation: "extends",
            provenance: "asserted",
            tags: ["shape"],
          },
          {
            citing: { kind: "turn", id: t3 },
            cited: { kind: "turn", id: t1 },
            relation: "extends",
            provenance: "asserted",
            tags: ["shape"],
          },
        ],
        NOW,
      );
      const job = claimWindow(db, sessionDbId, 1, 3);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");
          expect(text).toContain("[E5]");
          expect(text).toContain("has a second sink");
          expect(text).toContain("a lane has exactly one start and one end");
          expect(text).toContain("Retag this chain into a lane of its own");
          expect(text).toContain("bridge it to the lane's real start/end");
          // Both the anchor AND the canonical node are ADDRESSES: the repair
          // is a choice between two shapes, and neither is decidable without
          // knowing which node the lane already runs to.
          expect(text).toContain(`S${sessionDbId}/T2`);
          expect(text).toContain(`S${sessionDbId}/T3`);
          // Never the bare fallback the default branch used to produce.
          expect(text).not.toContain("see `lane_check` for this instance");

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
        writableTurnIds: new Set([t1, t2, t3]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 3,
      });
    } finally {
      db?.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PEER ROUND T1466 — THE PROJECTION, THE FROZEN WORD, AND THE E5 ANCHOR.
//
// Three repairs that only meet at this seam, so all three are proved through
// the REGISTERED handlers rather than against `evaluateSettlementCommitGate`
// in isolation: the projection the gate judges is built from the request's own
// frozen writable set (P1-1), a frozen-legacy `supersedes` row has a deletion
// path in the same run that met it (P1-2), and an extra-SOURCE E5 blocks the
// window owning the CITER rather than the window owning the dangling node
// (P1-3).
// ---------------------------------------------------------------------------

describe("T1466 — the commit projection is seeded from the frozen writable set", () => {
  /**
   * A window of exactly ONE turn (prompt 3) whose writable set also carries a
   * LOOKBACK turn (prompt 2) holding two defects of its own: an empty `type`
   * (E3) and an untagged `extends` (E1), both anchored at that lookback turn.
   *
   * The lookback turn's prompt number sits OUTSIDE `[windowStart, windowEnd]`,
   * which is the whole point: no prompt-number range that describes this
   * window can contain it, so the old range-seeded projection never LOADED
   * either row and the gate's anchor filter — a subset operation over what the
   * projection produced — could not recover them.
   */
  function seedLookbackStockFixture(db: Database): {
    sessionDbId: number;
    lookback: number;
    windowTurn: number;
    job: NoteSettlementJob;
  } {
    const sessionDbId = seedPullSession(db, "settlement-lookback-stock");
    const cited = insertTypedTurn(db, sessionDbId, 1);
    const lookback = insertTypedTurn(db, sessionDbId, 2, { type: "[]" });
    const windowTurn = insertTypedTurn(db, sessionDbId, 3);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: lookback },
          cited: { kind: "turn", id: cited },
          relation: "extends",
          provenance: "asserted",
          tags: [],
        },
      ],
      NOW,
    );
    return { sessionDbId, lookback, windowTurn, job: claimWindow(db, sessionDbId, 3, 3) };
  }

  test("a lookback turn's E1 and E3 refuse commit, though no window range contains that turn", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, lookback, windowTurn, job } = seedLookbackStockFixture(db);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");
          // BOTH classes, both anchored at the LOOKBACK turn (prompt 2) — the
          // turn the window's own range excludes by construction.
          expect(text).toContain("[E1]");
          expect(text).toContain("[E3]");
          expect(text).toContain(`S${sessionDbId}/T2`);
          expect(text).toContain("type is empty");
          expect(text).toContain("carries no lane tag");
          // A refusal is an ordinary in-run rejection: the job row is untouched.
          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("claimed");

          // Both repairs, on the lookback turn the set makes writable.
          await handlers.get("note")!({ turn: `S${sessionDbId}/T2`, type: ["design"] });
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T2`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          const retracted = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            retractExtends: [`S${sessionDbId}/T1`],
          })) as { content: Array<{ text: string }> };
          expect(retracted.content[0]!.text).toContain("Retracted 1 relation(s)");

          const committed = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(committed.content[0]!.text).toContain("Committed");

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
        // window ∪ declared lookback — the frozen set, exactly as the dispatch
        // hands it to the write facade and the gate.
        writableTurnIds: new Set([lookback, windowTurn]),
        contextBuiltAtEpoch: NOW,
        windowStart: 3,
        windowEnd: 3,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(getTurnById(db, lookback)!.type).toEqual(["design"]);
      expect(getOutgoingEdges(db, { kind: "turn", id: lookback })).toHaveLength(0);
    } finally {
      db?.close();
    }
  });

  test("an E2 written from a lookback turn to an outside endpoint refuses, and retractSupersedes clears it in the same run", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const sessionDbId = seedPullSession(db, "settlement-lookback-e2");
      // The cited endpoint sits far outside the window AND outside the
      // writable set: nothing but this row's own citing side pulls it in.
      const far = insertTypedTurn(db, sessionDbId, 1);
      const lookback = insertTypedTurn(db, sessionDbId, 8);
      const windowTurn = insertTypedTurn(db, sessionDbId, 9);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: lookback },
            cited: { kind: "turn", id: far },
            relation: "supersedes",
            provenance: "asserted",
            tags: [],
          },
        ],
        NOW,
      );
      const job = claimWindow(db, sessionDbId, 9, 9);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");
          expect(text).toContain("[E2]");
          expect(text).toContain(`S${sessionDbId}/T8`);
          expect(text).toContain('"supersedes"');

          // THE DEADLOCK THIS BREAKS: `supersedes` is frozen out of the write
          // vocabulary, so before `retractSupersedes` existed there was no
          // call that could clear this row, and the window could never commit.
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T8`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          const retracted = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T8`,
            retractSupersedes: [`S${sessionDbId}/T1`],
          })) as { content: Array<{ text: string }> };
          expect(retracted.content[0]!.text).toContain("Retracted 1 relation(s)");

          // The word is retractable and NEVER assertable: writing it back is a
          // parse error at the schema, not a legal call the facade weighs.
          expect(
            settlementTurnWriteInputSchema.safeParse({
              turn: `S${sessionDbId}/T8`,
              supersedes: [`S${sessionDbId}/T1`],
            }).success,
          ).toBe(false);

          const committed = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(committed.content[0]!.text).toContain("Committed");
          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("done");

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
        writableTurnIds: new Set([lookback, windowTurn]),
        contextBuiltAtEpoch: NOW,
        windowStart: 9,
        windowEnd: 9,
      });

      expect(getOutgoingEdges(db, { kind: "turn", id: lookback })).toHaveLength(0);
      expect(getTurnById(db, far)).not.toBeNull();
    } finally {
      db?.close();
    }
  });
});

/**
 * T1466 (finding P1-3 + P2-7): an extra SOURCE owns no outgoing row — that
 * absence is what makes it a source — so the only retractable/retaggable row
 * touching it belongs to a CITER. The anchor moved there, and the refusal copy
 * has to follow: it names the dangling node explicitly (it is no longer "this
 * turn"), says why the anchor is the one being asked to repair, and stops
 * calling proper-superset the unconditional answer.
 */
describe("T1466 — an extra-SOURCE E5 blocks the window owning the CITER", () => {
  /** Lane {shape}: T3 cites BOTH T1 and T2, so the lane has two sources and one sink. */
  function seedExtraSourceFixture(db: Database): {
    sessionDbId: number;
    t1: number;
    t2: number;
    t3: number;
  } {
    const sessionDbId = seedPullSession(db, "settlement-e5-source");
    const t1 = insertTypedTurn(db, sessionDbId, 1, { tags: '["shape"]' });
    const t2 = insertTypedTurn(db, sessionDbId, 2, { tags: '["shape"]' });
    const t3 = insertTypedTurn(db, sessionDbId, 3, { tags: '["shape"]' });
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t3 },
          cited: { kind: "turn", id: t1 },
          relation: "extends",
          provenance: "asserted",
          tags: ["shape"],
        },
        {
          citing: { kind: "turn", id: t3 },
          cited: { kind: "turn", id: t2 },
          relation: "extends",
          provenance: "asserted",
          tags: ["shape"],
        },
      ],
      NOW,
    );
    return { sessionDbId, t1, t2, t3 };
  }

  test("the citer's window is refused, and the copy names the dangling node and conditions the branch idiom", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t3 } = seedExtraSourceFixture(db);
      const job = claimWindow(db, sessionDbId, 3, 3);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");
          expect(text).toContain("[E5]");
          expect(text).toContain("has a second source");
          // The DANGLING node is T2 and the ANCHOR is T3; the line has to name
          // the dangling node, because "this turn dangles" is false here.
          expect(text).toContain(`S${sessionDbId}/T2 dangles beside S${sessionDbId}/T1`);
          expect(text).not.toContain("this turn dangles");
          // …and say why the refusal is nonetheless the anchor's to clear.
          expect(text).toContain(`you own the edge into S${sessionDbId}/T2`);
          // P2-7: proper-superset is CONDITIONAL, and the default for an
          // unrelated chain is its own independent exact set.
          expect(text).toContain("an independent line of work takes its own independent EXACT tag set");
          expect(text).toContain(
            "a proper-superset set is the BRANCH idiom only when the new chain is rooted at a node of the parent lane",
          );

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
        // The window that owns the CITER — the turn holding the repairable row.
        writableTurnIds: new Set([t3]),
        contextBuiltAtEpoch: NOW,
        windowStart: 3,
        windowEnd: 3,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });

  test("a window holding only the dangling node commits clean — the checker still REPORTS the instance", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      const { sessionDbId, t2 } = seedExtraSourceFixture(db);
      const job = claimWindow(db, sessionDbId, 2, 2);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // The instance is VISIBLE — the projection widens to the whole lane
          // from this one seed turn — and it is advisory here, not blocking:
          // reporting and blocking are two different questions, and only the
          // anchor answers the second.
          const preview = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(preview.content[0]!.text).toContain("[E5]");
          expect(preview.content[0]!.text).toContain(`anchor S${sessionDbId}/T3`);

          const committed = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(committed.content[0]!.text).toContain("Committed");
          expect(committed.content[0]!.text).not.toContain("Commit refused");
          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("done");

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
        // ONLY the dangling node — it owns no row that could clear this.
        writableTurnIds: new Set([t2]),
        contextBuiltAtEpoch: NOW,
        windowStart: 2,
        windowEnd: 2,
      });
    } finally {
      db?.close();
    }
  });
});
