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
  SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
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

// ---------------------------------------------------------------------------
// Settlement-commit-report ticket 01 (acceptance criterion 6): the CONTRACT
// for `report` lives in the tool's own description, not only in the prompt —
// asserted directly against the exported constant, no DB or fixture needed,
// since the description is a plain string built once at module load.
// ---------------------------------------------------------------------------
describe("commit's description names the four friction categories and the exclusion (settlement-commit-report ticket 01)", () => {
  test("names all four categories that motivated the field", () => {
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("where this window forced a guess");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain(
      "a relation you wanted and the seven words could not express",
    );
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("commit-gate refusal");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("(E3/E4/E6)");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("a turn you could not read");
  });

  test("states the exclusion — never a restatement of the counts", () => {
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("never a restatement of the");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("counts");
  });

  test("states the contract: required, capped at 1000, refused rather than truncated", () => {
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("REQUIRED");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("1000 characters");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("never truncated");
  });
});

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
      // a DELETED class must leave this list in the same batch, and an ADDED
      // one must join it in the same batch. E1 went with the tag mandate
      // (lane-declaration ticket 02); E5, the lane-shape class, went with
      // lane-model-v12 ticket 04; E2 went with ticket 11 — no stored row can
      // carry a word outside the seven and no write face can create one, so as
      // an ERROR it could never arrive (the FACT still reaches a hard-readonly
      // reader of legacy stock, on the warning side). E6, the DRAFT edge, ARRIVED
      // with ticket 20 and is here for exactly the same reason.
      for (const errorClass of ["(E3)", "(E4)", "(E6)"]) {
        expect(description).toContain(errorClass);
      }
      expect(description).not.toContain("(E1)");
      expect(description).not.toContain("(E2)");
      expect(description).not.toContain("(E5)");
      // Ticket 20 REVERSED the sentence that used to stand here ("An untagged
      // edge is NOT an error"). A draft is legal to WRITE and not legal to
      // LEAVE, and the surface has to say both halves or an agent learns only
      // the one that lets it commit dirty.
      expect(description).not.toContain("An untagged edge is NOT an error");
      expect(description).toContain("a DRAFT edge with either side still empty (E6)");
      expect(description).toContain("A draft is a legal row to WRITE");
      expect(description).toContain("not a legal row to LEAVE");
      // Requirement 6's teaching half: the same rows appear in the attribution
      // warning, and the surface says so rather than letting a reader read one
      // fact as two independent findings.
      expect(description).toContain("ALSO listed one by one as E6 above");
      expect(description).toContain("not as a double count");
      expect(description).toContain("anchored OUTSIDE your range is another window's work");

      // The OTHER half of the closed list. It was never asserted here, which
      // is how a class could have entered `lane_check`'s enumeration and not
      // `commit`'s — the surface that actually delivers the refusal.
      const commitDescription = descriptions.get("commit")!;
      for (const errorClass of ["(E3)", "(E4)", "(E6)"]) {
        expect(commitDescription, errorClass).toContain(errorClass);
      }
      expect(commitDescription).not.toContain("(E1)");
      expect(commitDescription).not.toContain("(E2)");
      expect(commitDescription).not.toContain("(E5)");
      // And the reversal, on the surface that refuses: the WORD still needs no
      // tag, but a draft left inside the writable set does block.
      expect(commitDescription).toContain("No WORD requires a lane tag");
      expect(commitDescription).toContain(
        "an edge left with an empty side inside your writable set is unfinished settlement",
      );
      expect(commitDescription).not.toContain("never blocks a commit");
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
          // Ticket 11: an out-of-vocabulary relation is no longer an ERROR
          // class — it cannot be written, only inherited — so it surfaces as
          // stock the checker admitted to no graph. Asserting the location,
          // not just the text, is the point: a reader who is not told these
          // rows exist sees a silently under-reported scope.
          expect(text).not.toContain("[E2]");
          expect(text).toContain(
            "edge(s) whose relation is outside the seven-word vocabulary -- pre-migration stock, admitted to no graph",
          );
          expect(text).toContain(
            `  S${sessionDbId}/T2 --supersedes--> S${sessionDbId}/T1`,
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

/**
 * SETTLEMENT-ERGONOMICS TICKET 05 (spec D3 items 1/2/4) — `lane_check` gains
 * its first two parameters. Proved at the ACTUAL registered handler, the
 * same discipline the rest of this file uses: the render-layer pagination
 * mechanism itself (aggregation, page packing, the continuation footer) is
 * pinned exhaustively in `tests/shared/lane-checker-render.test.ts` against
 * a large deterministic fixture — this file's own job is narrower, proving
 * only that `page`/`pageBudget` actually REACH that render from the real
 * tool call, through the real zod shape, at the real registration seam.
 */
describe("settlement-ergonomics ticket 05 — lane_check is paged (page/pageBudget), at the real registered handler", () => {
  test("the registered shape declares page/pageBudget, both optional", async () => {
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

      const shape = shapes.get("lane_check") as Record<string, { isOptional?: () => boolean } | undefined>;
      expect(shape.page).toBeDefined();
      expect(shape.pageBudget).toBeDefined();
      expect(shape.page?.isOptional?.()).toBe(true);
      expect(shape.pageBudget?.isOptional?.()).toBe(true);
    } finally {
      db?.close();
    }
  });

  test("a tiny pageBudget forces a second page whose content differs from the first, and the continuation hint names the exact next call — the default zero-argument call is untouched", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedLaneCheckFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const page1 = (await handlers.get("lane_check")!({ pageBudget: 5 })) as {
            content: Array<{ text: string }>;
          };
          const text1 = page1.content[0]!.text;
          expect(text1).toContain("-- page 1/");
          expect(text1).toMatch(/call lane_check\(page=2\) for the next/);

          const page2 = (await handlers.get("lane_check")!({ page: 2, pageBudget: 5 })) as {
            content: Array<{ text: string }>;
          };
          const text2 = page2.content[0]!.text;
          expect(text2.length).toBeGreaterThan(0);
          // Real content moved -- page 2 is not a repeat of page 1.
          expect(text2).not.toBe(text1);

          // The DEFAULT (zero-argument) call is untouched by any of the
          // above: this fixture's own report still fits on one page at the
          // real default budget, so it carries no continuation footer at
          // all, exactly like every OTHER test in this file that calls
          // `lane_check` with `{}`.
          const defaultCall = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          const defaultText = defaultCall.content[0]!.text;
          expect(defaultText).not.toContain("-- page");
          expect(defaultText).toContain("declaration: closed");

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
        writableTurnIds: new Set(laneTurnIds),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 3,
      });
    } finally {
      db?.close();
    }
  });
});

/**
 * SETTLEMENT-ERGONOMICS TICKET 06 (spec D3 item 3) — `lane_check` gains its
 * THIRD parameter, `scope`. Same division of labour as ticket 05's own
 * describe block above: the per-family PREDICATE is pinned exhaustively in
 * `tests/shared/lane-checker-render.test.ts` against a dedicated fixture
 * (`buildScopeFixture`) — this file's job is narrower, proving only that
 * `scope` and this dispatch's own `request.scopeProvenance.window` (spec D0,
 * the SAME field ticket 07's commit-refusal partition already threads) reach
 * that render from the REAL tool call, through the real zod shape, at the
 * real registration seam.
 */
describe("settlement-ergonomics ticket 06 — lane_check scope (actionable default / all), at the real registered handler", () => {
  test('the registered shape declares scope as an optional enum accepting exactly "actionable"/"all"', async () => {
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

      const shape = shapes.get("lane_check") as Record<
        string,
        | {
            isOptional?: () => boolean;
            safeParse?: (value: unknown) => { success: boolean };
          }
        | undefined
      >;
      expect(shape.scope).toBeDefined();
      expect(shape.scope?.isOptional?.()).toBe(true);
      expect(shape.scope?.safeParse?.("actionable").success).toBe(true);
      expect(shape.scope?.safeParse?.("all").success).toBe(true);
      expect(shape.scope?.safeParse?.("bogus").success).toBe(false);
    } finally {
      db?.close();
    }
  });

  test("scope=actionable (the default) covers the whole WRITABLE SET, so it cannot hide a row commit will refuse over", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const sessionDbId = seedPullSession(db, "settlement-lane-check-scope");
      // Two INDEPENDENT E3 defects (empty type), one on a WINDOW turn and one
      // on a declared-lookback turn. Both sit in the writable set, so both
      // block `commit` — and before peer round three finding 04 the default
      // scope filtered against `window` alone, which meant the lookback one
      // was invisible here and fatal there, while the prompt told the agent
      // the two lists were the same. This test used to assert that hiding.
      const lookbackTurn = insertTypedTurn(db, sessionDbId, 1, { type: "[]" });
      const windowTurn = insertTypedTurn(db, sessionDbId, 2, { type: "[]" });
      const job = claimWindow(db, sessionDbId, 2, 2);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const actionable = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          const actionableText = actionable.content[0]!.text;
          // The window turn AND the lookback turn — the default view is the
          // commit gate's own list now, not a narrower preview of it.
          expect(actionableText).toContain(`S${sessionDbId}/T2`);
          expect(actionableText).toContain(`S${sessionDbId}/T1`);
          expect(actionableText).toContain("2 error(s)");

          // `all` widens the SCOPE, and with nothing outside the writable set
          // in this fixture there is nothing left for it to add.
          const all = (await handlers.get("lane_check")!({ scope: "all" })) as {
            content: Array<{ text: string }>;
          };
          expect(all.content[0]!.text).toContain(`S${sessionDbId}/T1`);
          expect(all.content[0]!.text).toContain("2 error(s)");

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
        writableTurnIds: new Set([lookbackTurn, windowTurn]),
        scopeProvenance: {
          window: new Set([windowTurn]),
          baseLookback: new Set([lookbackTurn]),
          closureOnly: new Set(),
        },
        contextBuiltAtEpoch: NOW,
        windowStart: 2,
        windowEnd: 2,
      });
    } finally {
      db?.close();
    }
  });

  test("the default scope reads the request's writable set, so omitting scopeProvenance changes nothing", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedLaneCheckFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const defaultCall = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          const allCall = (await handlers.get("lane_check")!({ scope: "all" })) as {
            content: Array<{ text: string }>;
          };
          // No `scopeProvenance` on this request (below). It used to be what
          // the default scope filtered against, so its absence was a
          // fail-open case with its own convention; finding 04 moved the
          // default onto `request.writableTurnIds`, which is always present,
          // so the field no longer participates and the two renders agree for
          // the ordinary reason: nothing in this fixture anchors outside the
          // writable set.
          // What the two scopes now differ over, and the only thing they do:
          // a finding anchored OUTSIDE the writable set is another window's
          // work — it cannot block this commit and the default does not show
          // it. `all` still does.
          expect(defaultCall.content[0]!.text).toContain("(none)");
          expect(allCall.content[0]!.text).toContain("[E6]");
          expect(allCall.content[0]!.text).toContain("1 error(s)");
          expect(defaultCall.content[0]!.text).toContain("declaration: closed");

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
        writableTurnIds: new Set(laneTurnIds),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 3,
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

          const commitReceipt = (await handlers.get("commit")!({ report: "no friction this window" })) as {
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

          // Settlement-commit-report ticket 01 (acceptance criterion 4 + 6):
          // a report on the GATE-REFUSED call, deliberately distinct from
          // the one the eventual successful call carries below — this call
          // never reaches `writes.commit()` at all (the gate returns
          // first), so this string must NOT be the one that survives to the
          // run's own metrics.
          const refused = (await handlers.get("commit")!({
            report: "GATE-REFUSED — must never reach the final metrics.",
          })) as {
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

          const SUCCESSFUL_COMMIT_REPORT =
            "Routed around an E4 refusal by tagging the closure-only endpoint.";
          const committed = (await handlers.get("commit")!({
            report: SUCCESSFUL_COMMIT_REPORT,
          })) as {
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

      const result = await runQuery({
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
      // Acceptance criterion 4 (settlement-commit-report ticket 01): the
      // report the gate-refused call carried is nowhere in the final
      // record — only the successful retry's report survives.
      expect(result.commitMetrics?.report).toBe("Routed around an E4 refusal by tagging the closure-only endpoint.");
      expect(result.commitMetrics?.report).not.toContain("GATE-REFUSED");
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
          const committed = (await handlers.get("commit")!({ report: "no friction this window" })) as {
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

          const committed = (await handlers.get("commit")!({ report: "no friction this window" })) as {
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

/**
 * SETTLEMENT-ERGONOMICS TICKET 07 (spec D0/D5): the commit refusal's finding
 * list, partitioned by ERROR ORIGIN. Measured on a real 100-turn run: 63
 * refusal errors reached the agent in one undifferentiated list, spread
 * across the window, the declared lookback and the deadlock-guard closure,
 * and the agent could not tell which were its own to fix.
 *
 * A single scenario spanning all three origins (the ticket's own acceptance
 * bar: "用一个跨三段的构造场景断言分区正确") — three turns, each carrying its
 * OWN independent E3 defect (empty type) so each origin contributes a finding
 * that is unambiguously its own, not shared. `scopeProvenance` is supplied by
 * hand here, same as this file's other commit-gate tests supply
 * `writableTurnIds` by hand (T1466 above) — this proves the SDK QUERY LAYER's
 * own partitioning given a scope, not the DISPATCH's derivation of one; that
 * derivation is proved separately, at the seam that computes it
 * (note-settlement-call.test.ts, "the dispatch declares one immutable
 * writable set").
 *
 * NOT a writability claim: all three turns are equally writable (the same
 * `writableTurnIds` carries all three) — only the printed SECTION differs,
 * and this test's whole point is that it differs correctly.
 */
describe("commit refusal partitions by error origin (settlement-ergonomics ticket 07)", () => {
  test("a window error, a lookback error and a closure-only error each land in their own section", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const sessionDbId = seedPullSession(db, "settlement-scope-partition");
      // Distinct single-digit prompt numbers — no address is a substring of
      // another (`T1`/`T2`/`T3` vs., say, `T1`/`T10`), so the section-slice
      // assertions below cannot pass on a substring accident.
      const closureTurn = insertTypedTurn(db, sessionDbId, 1, { type: "[]" });
      const lookbackTurn = insertTypedTurn(db, sessionDbId, 2, { type: "[]" });
      const windowTurn = insertTypedTurn(db, sessionDbId, 3, { type: "[]" });
      const job = claimWindow(db, sessionDbId, 3, 3);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");

          const windowIdx = text.indexOf("IN THIS WINDOW");
          const lookbackIdx = text.indexOf("IN YOUR DECLARED LOOKBACK");
          const closureIdx = text.indexOf("PULLED IN ONLY BY AN EDGE");
          expect(windowIdx).toBeGreaterThanOrEqual(0);
          expect(lookbackIdx).toBeGreaterThan(windowIdx);
          expect(closureIdx).toBeGreaterThan(lookbackIdx);

          const windowSection = text.slice(windowIdx, lookbackIdx);
          const lookbackSection = text.slice(lookbackIdx, closureIdx);
          const closureSection = text.slice(closureIdx);

          // Each finding names its OWN turn and no other — the property a
          // merge back to one flat list would destroy.
          expect(windowSection).toContain(`S${sessionDbId}/T3`);
          expect(windowSection).not.toContain(`S${sessionDbId}/T2`);
          expect(windowSection).not.toContain(`S${sessionDbId}/T1`);

          expect(lookbackSection).toContain(`S${sessionDbId}/T2`);
          expect(lookbackSection).not.toContain(`S${sessionDbId}/T3`);
          expect(lookbackSection).not.toContain(`S${sessionDbId}/T1`);

          expect(closureSection).toContain(`S${sessionDbId}/T1`);
          expect(closureSection).not.toContain(`S${sessionDbId}/T3`);
          expect(closureSection).not.toContain(`S${sessionDbId}/T2`);

          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("claimed");

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
        writableTurnIds: new Set([closureTurn, lookbackTurn, windowTurn]),
        scopeProvenance: {
          window: new Set([windowTurn]),
          baseLookback: new Set([lookbackTurn]),
          closureOnly: new Set([closureTurn]),
        },
        contextBuiltAtEpoch: NOW,
        windowStart: 3,
        windowEnd: 3,
      });
    } finally {
      db?.close();
    }
  });

  test("omitting scopeProvenance falls back to the old flat, undifferentiated list", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, t1, job } = seedFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");
          expect(text).toContain(`S${sessionDbId}/T1`);
          expect(text).not.toContain("IN THIS WINDOW");
          expect(text).not.toContain("IN YOUR DECLARED LOOKBACK");
          expect(text).not.toContain("PULLED IN ONLY BY AN EDGE");

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
      // Ticket 15: the home already EXISTS — settlement does not mint one.
      // `seedTagContainers` created it; membership is derived from its tag.
      const segmentId = db
        .query<{ id: number }, [string]>(
          "SELECT id FROM segments WHERE json_extract(tags, '$[0]') = ?",
        )
        .get("lane")!.id;

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

          // Lane-model-v12 ticket 15: settlement no longer MINTS the home —
          // `create` retired, and a stale caller gets its replacement named
          // rather than a silent no-op. The container this fixture seeded
          // before the run is the home; a turn joins it by carrying its tag,
          // which is what the `note` calls below do.
          // [S15069/T1738] The retirement this probes MOVED. `create` used to be
          // refused here outright ("settlement does not open segments"); it is
          // now the LANE-minting verb, and `declare` is the retired word. The
          // stale-caller probe therefore points at `declare`, and the mint that
          // follows is the same act under its current name.
          const retired = (await handlers.get("remember")!({
            action: "declare",
            id: `E${segmentId}`,
            tag: "writable-arc",
          })) as { content: Array<{ text: string }> };
          expect(retired.content[0]!.text).toContain('action "declare" has retired');
          expect(retired.content[0]!.text).toContain('"create"');

          const declared = (await handlers.get("remember")!({
            action: "create",
            id: `E${segmentId}`,
            tag: "writable-set",
          })) as { content: Array<{ text: string }> };
          expect(declared.content[0]!.text).toContain('Landed create: lane "writable-set"');

          for (const promptNumber of [1, 2]) {
            const tagged = (await handlers.get("note")!({
              turn: `S${sessionDbId}/T${promptNumber}`,
              tags: ["lane", "writable-set"],
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
          const committed = (await handlers.get("commit")!({ report: "no friction this window" })) as {
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
      expect(getTurnById(db, t1)!.tags).toEqual(["lane", "writable-set"]);
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

          const committed = (await handlers.get("commit")!({ report: "no friction this window" })) as {
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

          const committed = (await handlers.get("commit")!({ report: "no friction this window" })) as {
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

// ---------------------------------------------------------------------------
// TICKET 20 — a DRAFT edge blocks the window it anchors in, and only that one.
//
// The refusal ticket 08 put at the WRITE GATE (`lane-half-settled`) moved here:
// an edge with either side empty is written without complaint and refused at
// `commit` as error class E6. Two properties, one per test, and they are the
// two halves of the ruling — "计算时视为无边" is pinned in the checker's own
// tests; this file pins "结算的 commit … 应该出 error 提示" and its scoping.
//
// MUTATION NOTES. Two independent mutations, two different tests:
//   - make `computeDraftEdgeErrors` (shared/lane-checker.ts) return `[]` —
//     BOTH tests below go red, and so does the checker's own E6 block;
//   - leave the class in place and drop it at the GATE instead (add
//     `.filter((error) => error.class !== "E6")` to `evaluateSettlementCommitGate`'s
//     `blocking`) — only the in-range test below goes red, which is what shows
//     the gate is pinned separately from the class.
// ---------------------------------------------------------------------------

describe("ticket 20 — commit refuses while a DRAFT edge anchors inside the writable set", () => {
  /**
   * A window (T1-T2) whose T2 cites T1 through a BARE edge — both sides `''`,
   * the shape the settlement facade now writes without complaint. Nothing else
   * is wrong with the fixture: both turns are typed and tagged, so E3 and E4
   * are silent and E6 is the only class in play.
   */
  function seedDraftEdgeFixture(db: Database, contentSessionId: string) {
    const sessionDbId = seedPullSession(db, contentSessionId);
    const t1 = insertTypedTurn(db, sessionDbId, 1);
    const t2 = insertTypedTurn(db, sessionDbId, 2);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          relation: "extends",
          provenance: "asserted",
          ...deriveSideTags([]),
        },
      ],
      NOW,
    );
    return { sessionDbId, t1, t2, job: claimWindow(db, sessionDbId, 1, 2) };
  }

  test("a draft edge inside the range refuses commit naming the row and both open sides, and a retraction clears it in the same run", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, t1, t2, job } = seedDraftEdgeFixture(db, "settlement-draft-edge-in");
      const capturedDb = db;
      // Not vacuous: the row really is stored with two empty sides — the write
      // face accepted exactly the shape ticket 08 used to refuse.
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toHaveLength(1);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const refused = (await handlers.get("commit")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");
          expect(text).toContain("[E6]");
          // Addressed the way the repair call is addressed, both ends.
          expect(text).toContain(`S${sessionDbId}/T2`);
          expect(text).toContain(`S${sessionDbId}/T1`);
          expect(text).toContain("DRAFT edge, neither side names a lane");
          expect(text).toContain("Place both sides");
          // No other class is involved — this fixture is clean but for the draft.
          expect(text).not.toContain("[E3]");
          expect(text).not.toContain("[E4]");
          // A refusal costs the job nothing.
          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("claimed");

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

          const committed = (await handlers.get("commit")!({ report: "no friction this window" })) as {
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
        writableTurnIds: new Set([t1, t2]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toHaveLength(0);
    } finally {
      db?.close();
    }
  });

  test("the SAME draft edge anchored OUTSIDE the writable set never blocks this window", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, t1, t2, job } = seedDraftEdgeFixture(db, "settlement-draft-edge-out");
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const committed = (await handlers.get("commit")!({ report: "no friction this window" })) as {
            content: Array<{ text: string }>;
          };
          // The draft is still THERE and the checker still reports it; it just
          // anchors at T2, which this run's set does not name.
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
        // T2 — the draft's anchor — deliberately absent.
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      // Untouched by this window: the row still stands, for the window that
      // actually owns its anchor.
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toHaveLength(1);
    } finally {
      db?.close();
    }
  });
});
