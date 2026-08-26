import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  computeSettlementWritableTurnIds,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  listDispatchableNoteSettlementSessions,
  NOTE_SETTLEMENT_LEASE_MS,
  touchNoteSettlementJobLease,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { insertLane } from "../../src/db/lanes";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
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


/**
 * Ticket 14 (lane-model-v12 spec D3b/D3e): `tags` draws from a closed
 * vocabulary — a segment's ONE globally unique tag, or a lane declared in it.
 * These SDK-surface tests are about tool registration, grants and durability,
 * not about which words are legal, so each bare word they write is made a
 * container of its own here. A turn carrying one becomes that container's
 * member, which is the model rather than a side effect of the fixture.
 */
function seedTagContainers(db: Database): void {
  for (const tag of ["lease", "lane"]) {
    // Idempotent: some of these tests re-initialise the same database.
    const held = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM segments WHERE json_extract(tags, '$[0]') = ?",
      )
      .get(tag);
    if (!held) {
      createSegment(db, { title: `${tag} container`, tags: [tag], nowEpoch: 100 });
    }
  }
}

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

  function insertTurn(promptNumber: number, tags: readonly string[] = []): number {
    return db
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
        JSON.stringify(tags),
      )!.id;
  }

  // MEMBERSHIP IS A NODE FACT (lane-model-v12 ticket 10): the lane's three
  // turns carry its tag themselves, a segment owns them, and that segment
  // declares the lane. `outside` deliberately carries nothing — it is the
  // external consume citer report 1's `used[]` is about.
  const t1 = insertTurn(1, ["ownership"]);
  const t2 = insertTurn(2, ["ownership"]);
  const t3 = insertTurn(3, ["ownership"]);
  const outside = insertTurn(4);
  const laneSegmentId = createSegment(db, { title: "lane-check fixture", nowEpoch: NOW }).id;
  addSegmentMembers(db, laneSegmentId, [t1, t2, t3, outside], NOW);
  insertLane(db, laneSegmentId, "ownership", NOW);

  writeMemoryEdges(
    db,
    [
      { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["ownership"]) },
      { citing: { kind: "turn", id: t3 }, cited: { kind: "turn", id: t1 }, relation: "indexes", provenance: "asserted", ...deriveSideTags(["ownership"]) },
      { citing: { kind: "turn", id: t3 }, cited: { kind: "turn", id: t2 }, relation: "indexes", provenance: "asserted", ...deriveSideTags(["ownership"]) },
      { citing: { kind: "turn", id: outside }, cited: { kind: "turn", id: t1 }, relation: "consume", provenance: "asserted", ...deriveSideTags([]) },
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
      seedTagContainers(db);
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
      seedTagContainers(db);
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
      seedTagContainers(db);
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
      // The current contract: entries are bare-or-`{turn, tailTag, headTag}`, and
      // validation is phase domains + tag legality + the self-citation gate.
      expect(description).toContain("{turn, tailTag, headTag}");
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
      seedTagContainers(db);
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
      expect(description).toContain("closed/open");
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
      // This description and `commit`'s both enumerate the classes as a
      // CLOSED list, so an agent meeting a refusal in a class the surface
      // denied existed would be told nothing it could act on — which is why
      // a DELETED class must leave this list in the same batch. E1 went with
      // the tag mandate (lane-declaration ticket 02); E5, the lane-shape
      // class, went with lane-model-v12 ticket 04.
      for (const errorClass of ["(E2)", "(E3)", "(E4)"]) {
        expect(description).toContain(errorClass);
      }
      expect(description).not.toContain("(E1)");
      expect(description).not.toContain("(E5)");
      expect(description).toContain("An untagged extends/narrows is NOT an error");
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
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedLaneCheckFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = laneCheckReceipt.content[0]!.text;
          expect(text).toContain("declaration: closed");
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
  //
  // Lane-model-v12 ticket 03 made the E2 half UNREACHABLE through any write:
  // `memory_edges`' CHECK is now exactly the seven-word write vocabulary, and
  // the two words that used to sit outside it were migrated onto `override`.
  // The class itself still exists in the checker, so the fixture says what it
  // now means — a row a build older than that migration left behind — with
  // the narrowest tool that writes one.
  test("a real lane_check call surfaces a legacy-typed turn and a pre-migration out-of-vocabulary edge in its text result", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
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

      function insertTurn(promptNumber: number, type: string, tags = "[]"): number {
        return db!
          .query<{ id: number }, [number, number, string, string, number, string, string]>(
            `INSERT INTO turns (
               session_id, prompt_number, status, user_prompt, assistant_response,
               tool_call_count, created_at_epoch, type, tags
             ) VALUES (?, ?, 'active', ?, ?, 3, ?, ?, ?)
             RETURNING id`,
          )
          .get(sessionDbId, promptNumber, `prompt ${promptNumber}`, `response ${promptNumber}`, NOW - 900 + promptNumber, type, tags)!
          .id;
      }

      const t1 = insertTurn(1, '["bugfix"]'); // legacy-typed: outside MEMORY_TYPES, and carrying no lane tag
      // Ticket 10: the CITING turn claims the lane in its own tags, so the
      // lane exists and report 1 has a tally to print; the CITED turn
      // deliberately does not, which is exactly the E4 orphan asserted below.
      const t2 = insertTurn(2, '["design"]', '["vocab-fixture"]');
      const vocabSegmentId = createSegment(db, { title: "vocab fixture", nowEpoch: NOW }).id;
      addSegmentMembers(db, vocabSegmentId, [t1, t2], NOW);
      insertLane(db, vocabSegmentId, "vocab-fixture", NOW);

      writeMemoryEdges(
        db,
        [
          { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["vocab-fixture"]) },
          { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "indexes", provenance: "asserted", ...deriveSideTags(["vocab-fixture"]) },
        ],
        NOW,
      );
      // The out-of-vocabulary row, written the only way one can now exist.
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.query<unknown, [number, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, relation, provenance, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'supersedes', 'asserted', ${NOW})`,
      ).run(t2, t1);
      db.exec("PRAGMA ignore_check_constraints = OFF");

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
      seedTagContainers(db);
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
        seedTagContainers(db);
      seedTagContainers(db);
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
      seedTagContainers(db);
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
          ...deriveSideTags(["lane"]),
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
      seedTagContainers(db);
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
      seedTagContainers(db);
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
      seedTagContainers(db);
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
      seedTagContainers(db);
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
      seedTagContainers(db);
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
            ...deriveSideTags(["lane"]),
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
      seedTagContainers(db);
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
      seedTagContainers(db);
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
      seedTagContainers(db);
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

          // The lane, in the order lane-declaration D2 forces and the prompt
          // teaches: a HOME for the members, the lane DECLARED in it, member
          // tags (the subset invariant), then the edge. All four through
          // settlement's own facade — `declare`/`undeclare` reach it too
          // (spec D4), which is what makes the prompt's "declare a fresh tag
          // when none fits" a followable instruction.
          const created = (await handlers.get("remember")!({
            action: "create",
            title: "the writable-set arc",
            // Ticket 14: a container has to be NAMED before anything can join
            // it — membership is derived from this word.
            tag: "writable-arc",
            turns: [`S${sessionDbId}/T1`, `S${sessionDbId}/T2`],
          })) as { content: Array<{ text: string }> };
          expect(created.content[0]!.text).toContain("Landed create");
          const segmentId = capturedDb
            .query<{ segmentId: number }, []>(
              "SELECT MIN(segment_id) AS segmentId FROM segment_members",
            )
            .get()!.segmentId;

          const declared = (await handlers.get("remember")!({
            action: "declare",
            id: `E${segmentId}`,
            tag: "writable-set",
          })) as { content: Array<{ text: string }> };
          expect(declared.content[0]!.text).toContain('Landed declare: lane "writable-set"');

          for (const promptNumber of [1, 2]) {
            const tagged = (await handlers.get("note")!({
              turn: `S${sessionDbId}/T${promptNumber}`,
              tags: ["writable-arc", "writable-set"],
            })) as { content: Array<{ text: string }> };
            expect(tagged.content[0]!.text).toContain("Landed");
          }

          const edge = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            extends: [
              { turn: `S${sessionDbId}/T1`, tailTag: "writable-set", headTag: "writable-set" },
            ],
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
      expect(getTurnById(db, t1)!.tags).toEqual(["writable-arc", "writable-set"]);
      const edges = getOutgoingEdges(db, { kind: "turn", id: t2 }).filter(
        (row) => row.relation === "extends",
      );
      expect(edges).toHaveLength(1);
      expect([edges[0]!.tailTag, edges[0]!.headTag]).toEqual(["writable-set", "writable-set"]);
    } finally {
      db?.close();
    }
  });
});

// lane-model-v12 ticket 04 deleted E5, and with it ticket 06's drift fix for
// its commit-refusal copy (before that fix an E5 fell through
// `describeCommitGateError`'s `default:` branch and reached the agent as an
// anchor with no move). The exhaustive-switch discipline that fix
// established still covers E2/E3/E4 in the block above.

// ---------------------------------------------------------------------------
// PEER ROUND T1466 — THE PROJECTION, THE FROZEN WORD, AND THE E5 ANCHOR.
//
// Three repairs that only meet at this seam, so all three are proved through
// the REGISTERED handlers rather than against `evaluateSettlementCommitGate`
// in isolation: the projection the gate judges is built from the request's own
// frozen writable set (P1-1) and a frozen-legacy `supersedes` row has a
// deletion path in the same run that met it (P1-2). The third (P1-3, the
// extra-SOURCE E5 anchor) went with E5 itself in lane-model-v12 ticket 04.
// ---------------------------------------------------------------------------

describe("T1466 — the commit projection is seeded from the frozen writable set", () => {
  /**
   * A window of exactly ONE turn (prompt 3) whose writable set also carries a
   * LOOKBACK turn (prompt 2) holding two defects of its own: an empty `type`
   * (E3) and a tagged edge neither endpoint's own tags carry (E4), both
   * anchored at that lookback turn. (It used to be E3 plus an untagged
   * `extends` — E1, retired with the tag mandate by lane-declaration ticket
   * 02; then E3 plus an out-of-vocabulary `supersedes` — E2, which lane-model
   * v12 ticket 03 made unwritable by narrowing the table's CHECK onto the
   * write vocabulary. E4 is the same shape and the point is the shape: an
   * edge error anchored at its citing turn, repaired by a retraction.)
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
          ...deriveSideTags(["lookback-lane"]),
        },
      ],
      NOW,
    );
    return { sessionDbId, lookback, windowTurn, job: claimWindow(db, sessionDbId, 3, 3) };
  }

  test("a lookback turn's E4 and E3 refuse commit, though no window range contains that turn", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
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
          expect(text).toContain("[E4]");
          expect(text).toContain("[E3]");
          expect(text).toContain(`S${sessionDbId}/T2`);
          expect(text).toContain("type is empty");
          expect(text).toContain("lookback-lane");
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
            retractExtends: [
              { turn: `S${sessionDbId}/T1`, tailTag: "lookback-lane", headTag: "lookback-lane" },
            ],
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

  test("an edge error from a lookback turn to an OUTSIDE endpoint refuses, and a retraction clears it in the same run", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
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
            relation: "extends",
            provenance: "asserted",
            ...deriveSideTags(["outside-lane"]),
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
          expect(text).toContain("[E4]");
          expect(text).toContain(`S${sessionDbId}/T8`);
          expect(text).toContain("outside-lane");

          // THE PROPERTY: the cited endpoint sits outside both the window and
          // the writable set, and the defect still refuses — then clears
          // through the ordinary retraction mirror, in the same run.
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T8`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          const retracted = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T8`,
            retractExtends: [
              { turn: `S${sessionDbId}/T1`, tailTag: "outside-lane", headTag: "outside-lane" },
            ],
          })) as { content: Array<{ text: string }> };
          expect(retracted.content[0]!.text).toContain("Retracted 1 relation(s)");

          // The two words lane-model-v12 ticket 03 retired stay unwritable on
          // this facade, and their retraction mirrors are gone with the rows.
          for (const field of ["supersedes", "refutes", "retractSupersedes", "retractRefutes"]) {
            expect(
              settlementTurnWriteInputSchema.safeParse({
                turn: `S${sessionDbId}/T8`,
                [field]: [`S${sessionDbId}/T1`],
              }).success,
            ).toBe(false);
          }

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

// lane-model-v12 ticket 04 deleted E5 (the lane-shape error class), and with
// it the T1466 anchor block that lived here: an extra-SOURCE instance anchored
// at its earliest in-lane CITER rather than at the dangling node, so the
// window able to retract the row was the one refused. There is no class left
// to anchor. The frozen-writable-set projection and the `supersedes` deletion
// path — the other two T1466 repairs — keep their own describes above.


// S15069/T1540 ruling ("写操作续租"), widened to every tool call because the
// read-only prelude alone outran the lease on two measured runs (S15069/T1539:
// 502s and 666s before the first write, against a 600s lease). The heartbeat
// lives in the tool FACTORY, so these tests drive it through a registered tool
// rather than by calling the db helper directly.
describe("the lease heartbeat", () => {
  // `commit` is excluded from the behavioural loop for a real reason, not
  // convenience: it renews like the rest, then COMPLETES the job in the same
  // call, which nulls `claimed_at_epoch` — the renewal is unobservable after
  // its own terminal write. The source pin below is what covers it.
  const REGISTERED = ["recall", "timeline", "note", "remember", "lane_check"];

  async function registerTools(db: Database, options: { generation?: number } = {}) {
    const { sessionDbId, job, laneTurnIds } = seedFixture(db);
    const { toolImpl, handlers } = captureToolImpl();
    const queryImpl = mock(() =>
      (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done" };
      })(),
    );
    const runQuery = createNoteSettlementSdkQuery({
      db,
      dataRoot: "/tmp/claude-mnemo-settlement-lease",
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
      claimGeneration: options.generation ?? job.claimGeneration,
      sessionId: sessionDbId,
      writableTurnIds: new Set(laneTurnIds),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 3,
    });
    // Age the lease past its own window so a renewal is visible as a change.
    const stale = NOW - Math.floor(NOTE_SETTLEMENT_LEASE_MS / 1000) - 60;
    db.run("UPDATE note_settlement_jobs SET claimed_at_epoch = ? WHERE id = ?", [stale, job.id]);
    return { job, handlers, stale };
  }

  test("a READ tool renews the lease — the prelude is where the old lease died", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { job, handlers, stale } = await registerTools(db);
      expect(getNoteSettlementJob(db, job.id)?.claimedAtEpoch).toBe(stale);

      await Promise.resolve(handlers.get("timeline")!({ id: "S1" })).catch(() => undefined);

      expect(getNoteSettlementJob(db, job.id)?.claimedAtEpoch).toBe(NOW);
    } finally {
      db?.close();
    }
  });

  test("every registered tool renews, so a tool added later cannot forget to", async () => {
    for (const name of REGISTERED) {
      let db: Database | undefined;
      try {
        db = createDatabase(":memory:");
        initializeSchema(db);
        seedTagContainers(db);
      seedTagContainers(db);
        const { job, handlers, stale } = await registerTools(db);
        expect(getNoteSettlementJob(db, job.id)?.claimedAtEpoch).toBe(stale);

        await Promise.resolve(handlers.get(name)!({})).catch(() => undefined);

        expect({ name, at: getNoteSettlementJob(db, job.id)?.claimedAtEpoch }).toEqual({
          name,
          at: NOW,
        });
      } finally {
        db?.close();
      }
    }
  });

  test("no tool is registered outside the leased factory — the structural half of the guard", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/worker/note-settlement-sdk-query.ts"),
      "utf8",
    );
    // Registrations are indented eight spaces inside the tools array; the
    // factory itself is defined at four. A raw registration would read
    // `        toolImpl(` and skip the heartbeat entirely.
    expect(source).not.toContain("        toolImpl(");
    expect(source.match(/ {8}leasedTool\(/g)?.length).toBe(6);
  });

  test("a dispatch whose generation already moved renews nothing — a heartbeat can never resurrect a lost lease", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { job, handlers, stale } = await registerTools(db, { generation: 99 });

      await Promise.resolve(handlers.get("timeline")!({ id: "S1" })).catch(() => undefined);

      expect(getNoteSettlementJob(db, job.id)?.claimedAtEpoch).toBe(stale);
    } finally {
      db?.close();
    }
  });

  test("a renewed lease stops the job being dispatchable — the reclaim counts from the last sign of life", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job } = seedFixture(db);
      const stale = NOW - Math.floor(NOTE_SETTLEMENT_LEASE_MS / 1000) - 60;
      db.run("UPDATE note_settlement_jobs SET claimed_at_epoch = ? WHERE id = ?", [stale, job.id]);

      expect(listDispatchableNoteSettlementSessions(db, { nowMs: NOW * 1000 })).toContain(sessionDbId);

      expect(touchNoteSettlementJobLease(db, job.id, job.claimGeneration, NOW)).toBe(true);

      expect(listDispatchableNoteSettlementSessions(db, { nowMs: NOW * 1000 })).not.toContain(sessionDbId);
    } finally {
      db?.close();
    }
  });
});
