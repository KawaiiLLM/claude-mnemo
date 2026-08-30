import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createDatabase, runWriteTransaction } from "../../src/db/database";
import { ensureRecordedEraCutoff } from "../../src/db/era";
import {
  loadHomelessRetractionAuditsForGroup,
  resolveActiveHomelessDisposition,
} from "../../src/db/homeless-record";
import {
  buildSettlementWorklistRendering,
  computeSettlementShapeNumbers,
  readSettlementFrozenScope,
} from "../../src/worker/note-settlement-shape-numbers";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  computeSettlementWritableTurnIds,
  enqueueBackfillNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  listDispatchableNoteSettlementSessions,
  NOTE_SETTLEMENT_LEASE_MS,
  touchNoteSettlementJobLease,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { getLane, insertLane, listLanesForSegment } from "../../src/db/lanes";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getShadowNote, upsertShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import { claimWriterId, sessionWriterId, stampField } from "../../src/db/write-gate";
import { getOutgoingEdges } from "../../src/db/memory-edges";
import {
  readNoteSettlementWritableSnapshot,
  readNoteSettlementWritableTurnIds,
} from "../../src/db/note-settlement-snapshots";
import { noteInputShape, settlementNoteInputShape } from "../../src/mcp/definitions";
// The MAIN AGENT's own write path, imported here for exactly one test: the
// post-transition type wound has to be inflicted by a legitimate concurrent
// writer, not by SQL, or it proves nothing about what production can reach.
import { noteTool } from "../../src/mcp/note";
import { evaluateStageOneTransitionGate } from "../../src/worker/note-settlement-stage1";
import {
  createNoteSettlementSdkQuery,
  evaluateSettlementCommitGate,
  installSettlementEdgesScope,
  SETTLEMENT_ALLOWED_TOOLS,
  SETTLEMENT_COMMIT_TOOL_DESCRIPTION,
  SETTLEMENT_NOTE_TOOL_DESCRIPTION,
} from "../../src/worker/note-settlement-sdk-query";
import {
  settlementTurnWriteInputSchema,
  settlementTurnWriteInputShape,
} from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";
import type { ResponseOriginRegistry } from "../../src/worker/note-settlement-response-origin";

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

/**
 * Severed-lane fixture: one declared lane (`severed-fixture`) whose four
 * members split into two components with NO edge crossing between them —
 * t1<->t2 (`extends`) and t3<->t4 (`extends`), nothing links the two pairs.
 * Report 2's connected-components pass reports this lane SEVERED
 * (componentCount 2).
 *
 * Severed-lane ticket 02 UPGRADES this from a teaching-only WARNING (the
 * predecessor severed-lane-teaching ticket 01) to a MANDATORY-DISPOSITION
 * ERROR: `commit` now REFUSES over a touched, still-severed lane with
 * neither a stitching edge nor a `remember(justify, …)` record for its
 * fracture — see the reversed pinned test below, ticket 02's own required
 * act.
 */
function seedSeveredLaneFixture(db: Database): {
  sessionDbId: number;
  job: NoteSettlementJob;
  laneTurnIds: number[];
  laneSegmentId: number;
} {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-sdk-query-severed-lane-session",
    project: "/tmp/project-settlement-sdk-query-severed-lane",
    title: "settlement sdk-query severed-lane fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number, tags: readonly string[], response?: string): number {
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
        response ?? `response ${promptNumber}`,
        NOW - 900 + promptNumber,
        JSON.stringify(tags),
      )!.id;
  }

  // The segment's OWN curated tag — required for the WRITE gate's
  // `owningSegmentId` (db/lane-edge-gate.ts), which resolves an edge side's
  // segment from the endpoint turn's OWN tags, never from the
  // `segment_members` projection (see that module's own "WHERE A SEGMENT
  // COMES FROM" comment). Every fixture turn below carries it alongside the
  // lane tag, so a genuine `note`-tool edge write (the "stitch
  // self-evidences" test) resolves both sides to this segment exactly like
  // the pre-seeded `writeMemoryEdges` rows already do at the storage layer.
  const laneSegmentId = createSegment(db, {
    title: "severed-lane fixture",
    tags: ["severed-task"],
    nowEpoch: NOW,
  }).id;

  const t1 = insertTurn(1, ["severed-task", "severed-fixture"]);
  const t2 = insertTurn(2, ["severed-task", "severed-fixture"]);
  const t3 = insertTurn(3, ["severed-task", "severed-fixture"]);
  const t4 = insertTurn(4, ["severed-task", "severed-fixture"]);
  // T3 carries a long PROMOTED note (turns.title/content, not user_prompt/
  // assistant_response) — long enough that the lane's own default-budget
  // member-list render truncates it. The justify test needs a real gap
  // between "this lane's pages are covered" and "the OTHER representative's
  // full content is granted", and an empty/short note would close that gap
  // for free (an empty field can never render truncated).
  db.query<unknown, [string, string, number]>(
    "UPDATE turns SET title = ?, content = ? WHERE id = ?",
  ).run("T3 long note", "T3 body sentence. ".repeat(200), t3);
  addSegmentMembers(db, laneSegmentId, [t1, t2, t3, t4], NOW);
  insertLane(db, laneSegmentId, "severed-fixture", NOW);

  writeMemoryEdges(
    db,
    [
      { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["severed-fixture"]) },
      { citing: { kind: "turn", id: t4 }, cited: { kind: "turn", id: t3 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["severed-fixture"]) },
      // Deliberately nothing crosses {t1,t2} <-> {t3,t4} — the two islands
      // Report 2 finds SEVERED.
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
  return { sessionDbId, job, laneTurnIds: [t1, t2, t3, t4], laneSegmentId };
}

/**
 * Severed-lane over-blocking fix — the exact defect scenario: the SAME
 * severed lane as `seedSeveredLaneFixture` (two islands, {t1,t2} <-> {t3,t4},
 * nothing crossing them), but this time the lane's four turns are NOT the
 * dispatch's own window — two unrelated plain turns (t5, t6) are, and the
 * job's window is enqueued over THOSE. The lane's turns reach
 * `writableTurnIds` only the way a rendered LOOKBACK would put them there —
 * present in the caller's `writableTurnIds` set, absent from `windowStart`/
 * `windowEnd`. A run that never calls `note`/`remember` on any of the four
 * lane turns has not touched the lane by any of the three touch conditions
 * (an edge side, a landed tags write, a justify), so it owes no disposition
 * over it — the bug this fixture reproduces is a mandatory-disposition
 * refusal firing anyway, purely because those turns sat in the widened
 * writable set.
 */
function seedSeveredLaneLookbackFixture(db: Database): {
  sessionDbId: number;
  job: NoteSettlementJob;
  laneTurnIds: number[];
  windowTurnIds: number[];
  laneSegmentId: number;
} {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-sdk-query-severed-lane-lookback-session",
    project: "/tmp/project-settlement-sdk-query-severed-lane-lookback",
    title: "settlement sdk-query severed-lane-as-lookback fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number, tags: readonly string[]): number {
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

  const laneSegmentId = createSegment(db, {
    title: "severed-lane-as-lookback fixture",
    tags: ["severed-lookback-task"],
    nowEpoch: NOW,
  }).id;

  const t1 = insertTurn(1, ["severed-lookback-task", "severed-lookback-fixture"]);
  const t2 = insertTurn(2, ["severed-lookback-task", "severed-lookback-fixture"]);
  const t3 = insertTurn(3, ["severed-lookback-task", "severed-lookback-fixture"]);
  const t4 = insertTurn(4, ["severed-lookback-task", "severed-lookback-fixture"]);
  addSegmentMembers(db, laneSegmentId, [t1, t2, t3, t4], NOW);
  insertLane(db, laneSegmentId, "severed-lookback-fixture", NOW);

  writeMemoryEdges(
    db,
    [
      { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["severed-lookback-fixture"]) },
      { citing: { kind: "turn", id: t4 }, cited: { kind: "turn", id: t3 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["severed-lookback-fixture"]) },
      // Deliberately nothing crosses {t1,t2} <-> {t3,t4} — the two islands
      // Report 2 finds SEVERED, exactly as in `seedSeveredLaneFixture`.
    ],
    NOW,
  );

  // t5/t6 are the ACTUAL window — untagged, no lane of their own — and the
  // job is enqueued over them, not over the lane.
  const t5 = insertTurn(5, []);
  const t6 = insertTurn(6, []);

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 5, windowEnd: 6, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return {
    sessionDbId,
    job,
    laneTurnIds: [t1, t2, t3, t4],
    windowTurnIds: [t5, t6],
    laneSegmentId,
  };
}

/**
 * Touch condition (c) in isolation — a lookback-only lane with THREE islands
 * ({t1,t2}, {t3,t4}, {t5,t6}; nothing crosses any of them), so it owes TWO
 * fractures (t1<->t3, t3<->t5 by ascending representative). The window is
 * two separate, unrelated turns (t7, t8); the lane reaches `writableTurnIds`
 * only the way a rendered lookback would. Deliberately three islands, not
 * two: with only one fracture, justifying it always leaves `blocking` empty
 * regardless of whether `touched` is true — a test built on that fixture
 * cannot tell "justify made this lane touched" apart from "the one fracture
 * happened to get cleared". With two fractures, justifying only the first
 * leaves the second outstanding, and it is caught only if the run's `justify`
 * call — the ONLY interaction this fixture's test ever has with the lane —
 * is itself what made the lane touched.
 */
function seedThreeIslandLaneLookbackFixture(db: Database): {
  sessionDbId: number;
  job: NoteSettlementJob;
  laneTurnIds: number[];
  windowTurnIds: number[];
  laneSegmentId: number;
} {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-sdk-query-three-island-lane-lookback-session",
    project: "/tmp/project-settlement-sdk-query-three-island-lane-lookback",
    title: "settlement sdk-query three-island-lane-as-lookback fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number, tags: readonly string[]): number {
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

  const laneSegmentId = createSegment(db, {
    title: "three-island-lane-as-lookback fixture",
    tags: ["three-island-lookback-task"],
    nowEpoch: NOW,
  }).id;

  const t1 = insertTurn(1, ["three-island-lookback-task", "three-island-fixture"]);
  const t2 = insertTurn(2, ["three-island-lookback-task", "three-island-fixture"]);
  const t3 = insertTurn(3, ["three-island-lookback-task", "three-island-fixture"]);
  const t4 = insertTurn(4, ["three-island-lookback-task", "three-island-fixture"]);
  const t5 = insertTurn(5, ["three-island-lookback-task", "three-island-fixture"]);
  const t6 = insertTurn(6, ["three-island-lookback-task", "three-island-fixture"]);
  addSegmentMembers(db, laneSegmentId, [t1, t2, t3, t4, t5, t6], NOW);
  insertLane(db, laneSegmentId, "three-island-fixture", NOW);

  writeMemoryEdges(
    db,
    [
      { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["three-island-fixture"]) },
      { citing: { kind: "turn", id: t4 }, cited: { kind: "turn", id: t3 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["three-island-fixture"]) },
      { citing: { kind: "turn", id: t6 }, cited: { kind: "turn", id: t5 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["three-island-fixture"]) },
      // Deliberately nothing crosses {t1,t2}, {t3,t4}, {t5,t6} — three
      // islands, two fractures.
    ],
    NOW,
  );

  // t7/t8 are the ACTUAL window — untagged, no lane of their own.
  const t7 = insertTurn(7, []);
  const t8 = insertTurn(8, []);

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 7, windowEnd: 8, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return {
    sessionDbId,
    job,
    laneTurnIds: [t1, t2, t3, t4, t5, t6],
    windowTurnIds: [t7, t8],
    laneSegmentId,
  };
}

/**
 * PHASE-CONNECTIVITY TICKET 04 — the DESTRUCTIVE-touch fixture. Unlike
 * `seedSeveredLaneFixture` (born severed), this lane is born WHOLE: t1..t4
 * form one chain, t2->t1, t3->t2, t4->t3, and the middle edge t3->t2 is the
 * SOLE bridge between {t1,t2} and {t3,t4}. That gives a run two distinct ways
 * to sever the lane with a single landed write:
 *
 *   - retract t3->t2, leaving both endpoints in the lane but nothing across
 *     the gap;
 *   - drop t2's own lane tag, which takes the chain's second link OUT of the
 *     lane and strands t1 alone.
 *
 * Both used to register NO touch at all — the touch list carried a landed
 * `tags` write's NEW set and an ATTACHED edge's sides, and neither of these
 * two acts is either of those — so `commit` passed over a fracture the run had
 * just created.
 */
function seedBridgedLaneFixture(db: Database): {
  sessionDbId: number;
  job: NoteSettlementJob;
  laneTurnIds: number[];
  laneSegmentId: number;
} {
  const sessionDbId = upsertSession(db, {
    contentSessionId: `settlement-sdk-query-bridged-lane-session-${Math.random()}`,
    project: "/tmp/project-settlement-sdk-query-bridged-lane",
    title: "settlement sdk-query bridged-lane fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number, tags: readonly string[]): number {
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

  const laneSegmentId = createSegment(db, {
    title: "bridged-lane fixture",
    tags: ["bridged-task"],
    nowEpoch: NOW,
  }).id;

  const t1 = insertTurn(1, ["bridged-task", "bridged-fixture"]);
  const t2 = insertTurn(2, ["bridged-task", "bridged-fixture"]);
  const t3 = insertTurn(3, ["bridged-task", "bridged-fixture"]);
  const t4 = insertTurn(4, ["bridged-task", "bridged-fixture"]);
  addSegmentMembers(db, laneSegmentId, [t1, t2, t3, t4], NOW);
  insertLane(db, laneSegmentId, "bridged-fixture", NOW);

  writeMemoryEdges(
    db,
    [
      { citing: { kind: "turn", id: t2 }, cited: { kind: "turn", id: t1 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["bridged-fixture"]) },
      // THE BRIDGE — the only thing joining {t1,t2} to {t3,t4}.
      { citing: { kind: "turn", id: t3 }, cited: { kind: "turn", id: t2 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["bridged-fixture"]) },
      { citing: { kind: "turn", id: t4 }, cited: { kind: "turn", id: t3 }, relation: "extends", provenance: "asserted", ...deriveSideTags(["bridged-fixture"]) },
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
  return { sessionDbId, job, laneTurnIds: [t1, t2, t3, t4], laneSegmentId };
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
/**
 * TICKET 17 / ROUND-3 PEER FINDING P1-3: the `note` registration's own
 * DESCRIPTION against the allowlist the registration actually enforces
 * (`STAGE_TWO_TURN_NOTE_FIELDS` / `STAGE_TWO_SESSION_NOTE_FIELDS`).
 *
 * The two are one artifact in production — the model reads the description and
 * is judged by the allowlist — and they had drifted apart in the direction
 * that costs a run its call: the text still offered `title`/`content`/
 * `insight`, `type`/`tags` and a `mode` vocabulary on a turn address, all of
 * which the handler has refused since the re-review round. Pinned as an
 * AGREEMENT rather than as a wording, so a field added to either side
 * reddens here.
 */
describe("the stage-2 note description teaches the allowlist it is judged by (ticket 17, P1-3)", () => {
  test("a turn address offers the fourteen edge fields and names the six refusals", () => {
    const text = SETTLEMENT_NOTE_TOOL_DESCRIPTION;
    expect(text).toContain("WRITE a turn's EDGES");
    expect(text).toContain("THE FOURTEEN EDGE FIELDS");
    expect(text).toContain(
      "`title`, `content`, `insight`, `type`, `tags` and `mode` are REFUSED on a turn address",
    );
    // The promises that are gone, each one a call the handler rejects.
    expect(text).not.toContain("On `turn`: title/content/insight, type/tags and the edge fields");
    expect(text).not.toContain("A first note for a turn needs title and content together");
    expect(text).not.toContain("WRITE a turn's note, type/tags or edges");
  });

  test("the session address keeps the narrative and the mode vocabulary that is real there", () => {
    const text = SETTLEMENT_NOTE_TOOL_DESCRIPTION;
    expect(text).toContain("On `session`: `title`/`content` only — type/tags/edges are refused.");
    expect(text).toContain('`{ mode: "edit", oldString, newString }`');
    // The truncation guard travelled WITH the mode vocabulary rather than
    // being dropped with the turn-side text that used to carry it.
    expect(text).toContain(
      "A whole-field `write` over text your own `recall` delivered only truncated is refused",
    );
  });

  test("every field the text still offers on a turn is one the registration's own allowlist admits", () => {
    // The allowlist is not exported, so the agreement is checked at the
    // REGISTERED handler: each refused field, sent on a turn address, must
    // come back as a parameter error rather than land.
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, t1, job } = seedFixture(db);
      const capturedDb = db;
      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          for (const [field, value] of [
            ["title", "a title"],
            ["content", "some content"],
            ["insight", "an insight"],
            ["type", ["design"]],
            ["tags", ["lane"]],
            ["mode", { content: "write" }],
          ] as Array<[string, unknown]>) {
            const refused = (await handlers.get("note")!({
              turn: `S${sessionDbId}/T1`,
              [field]: value,
            })) as { content: Array<{ text: string }> };
            // The ALLOWLIST's own refusal, not merely some parameter error:
            // several of these fields would be rejected further downstream for
            // unrelated reasons (a first note needs title and content, say), so
            // a bare "Parameter error" would pass even with the field admitted.
            const text = refused.content[0]!.text;
            expect({ field, refusedByAllowlist: text.startsWith(`Parameter error: ${field} is refused on the edge pass`) }).toEqual({
              field,
              refusedByAllowlist: true,
            });
          }
          expect(getShadowNote(capturedDb, t1)).toBeNull();
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      return createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-sdk-query",
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
      })({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      }).finally(() => db.close());
    } catch (error) {
      db.close();
      throw error;
    }
  });
});

describe("commit's description names the four friction categories and the exclusion (settlement-commit-report ticket 01)", () => {
  test("names all four categories that motivated the field", () => {
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("where this window forced a guess");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain(
      "a relation you wanted and the seven words could not express",
    );
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("commit-gate refusal");
    // Ticket 17: E3 left the blocking set, so it can no longer BE a gate
    // refusal a run routed around — naming it here would ask for friction
    // that cannot happen.
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("(E4/E6)");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).not.toContain("(E3/E4/E6)");
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
        stage: job.stage,
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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      expect(shapes.get("note")).toBe(settlementTurnWriteInputShape);
      // Ticket 08 (write-mode-edit-semantics) made the registered shape
      // `settlementNoteInputShape` ITSELF, no local key — phase-connectivity
      // ticket 01 reopens exactly that, for exactly ticket 07's own reason:
      // `typeReason` is a SETTLEMENT-ONLY key (the main agent's own `note`
      // never reaches for it), so it is spread on TOP of the shared base
      // rather than added to the shape the main tool also registers. The two
      // are therefore no longer the SAME object — every field the shared
      // base declares is still the SAME field object, checked below.
      expect(shapes.get("note")).not.toBe(settlementNoteInputShape);
      const registered = shapes.get("note") as Record<string, unknown>;
      for (const key of Object.keys(settlementNoteInputShape)) {
        expect(registered[key]).toBe((settlementNoteInputShape as Record<string, unknown>)[key]);
      }
      expect(registered.typeReason).toBeDefined();
      // Spec D12: the mode vocabulary reaching the settlement model is the
      // main agent's own object, not a look-alike (also pinned at the
      // registration seam by tests/worker/note-settlement-parity.test.ts).
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
        stage: job.stage,
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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      const description = descriptions.get("lane_check")!;
      // lane-state-retirement ticket 01: the description named "a closed/open
      // state" among report 1's fields. Lane state is deleted, so the
      // description says so instead — a surface that kept the old phrase would
      // keep teaching a report field the tool no longer returns.
      expect(description).toContain("A lane has NO state");
      expect(description).not.toContain("closed/open state");
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
          // The `declaration:` line is deleted with lane state (ticket 01).
          // What this test is really proving — that the REAL registered
          // handler renders report 1 over a real projection — is the lane
          // heading plus its citedness line below.
          expect(text).not.toContain("declaration:");
          expect(text).toContain("Lane E");
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
        stage: job.stage,
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
        stage: job.stage,
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
 * Phase-connectivity ticket 01 fixture: three landing turns in one window —
 * one compound (T1, implement+design, zero hops), one that reaches a basis
 * by a directed walk (T2 --extends--> T3, T3 is research), and one with no
 * basis reachable at all (T4). Report-only: nothing in the commit path reads
 * a switch to decide whether to refuse (ticket 06 deleted the dead "armed"
 * constant this comment used to name — there is no arming wire yet at all),
 * so this fixture also proves the violation never blocks `commit`.
 */
function seedPhaseConnectivityFixture(db: Database): {
  sessionDbId: number;
  job: NoteSettlementJob;
  turnIds: number[];
} {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-sdk-query-phase-connectivity-session",
    project: "/tmp/project-settlement-sdk-query-phase-connectivity",
    title: "settlement sdk-query phase-connectivity fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(promptNumber: number, type: readonly string[], tags: readonly string[] = []): number {
    return db
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
        JSON.stringify(type),
        JSON.stringify(tags),
      )!.id;
  }

  const t1 = insertTurn(1, ["implement", "design"]); // compound, zero hops
  const t2 = insertTurn(2, ["fix"], ["phase-connectivity-fixture"]); // reaches t3 by a directed walk
  const t3 = insertTurn(3, ["research"], ["phase-connectivity-fixture"]); // t2's basis
  const t4 = insertTurn(4, ["implement"]); // no basis reachable — VIOLATION

  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: t2 },
        cited: { kind: "turn", id: t3 },
        relation: "extends",
        provenance: "asserted",
        tailTag: "phase-connectivity-fixture",
        headTag: "phase-connectivity-fixture",
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
  return { sessionDbId, job, turnIds: [t1, t2, t3, t4] };
}

describe("phase-connectivity ticket 01 — REPORT-ONLY findings in lane_check and commit output", () => {
  test("names the landing turn and both exits (reached-with-path, compound, and violation), and never blocks commit", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, turnIds } = seedPhaseConnectivityFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          const text = laneCheckReceipt.content[0]!.text;
          expect(text).toContain("PHASE CONNECTIVITY");
          expect(text).toContain("REPORT-ONLY");
          // BOTH exits named, plus the landing turn each names.
          expect(text).toContain(`[OK] S${sessionDbId}/T1 — compound`);
          expect(text).toContain(`[OK] S${sessionDbId}/T2 — reaches S${sessionDbId}/T3`);
          expect(text).toContain(`[VIOLATION] S${sessionDbId}/T4`);
          // 1 of 3 unreached, stated in the summary line.
          expect(text).toContain("1/3");

          // Report-only: the violation above never blocks commit, and the
          // SAME finding rides along on the successful receipt too.
          const committed = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
          expect(committed.content[0]!.text).toContain("Committed");
          expect(committed.content[0]!.text).toContain("PHASE CONNECTIVITY");
          expect(committed.content[0]!.text).toContain(`[VIOLATION] S${sessionDbId}/T4`);

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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set(turnIds),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 4,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });
});

describe("severed-lane ticket 02 — a touched SEVERED lane owes a mandatory disposition", () => {
  // REVERSED PINNED TEST (ticket 02's own required act — spec "Status": this
  // reversal is the ticket's act, never a side effect). The predecessor
  // severed-lane-teaching ticket 01 shipped this as "commit succeeds with no
  // stitching edge and no justification sentence… (no new refusal path)".
  // Ticket 02 upgrades exactly that finding to a MANDATORY ERROR: the same
  // fixture, the same missing disposition, now REFUSES.
  test("commit REFUSES a SEVERED touched lane with no stitching edge and no justify on record", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedSeveredLaneFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // Severed-lane over-blocking fix: `touched` is now this run's own
          // LANDED writes, never mere membership in the writable set — so
          // the refusal below has to be earned by an actual engagement with
          // the lane, not merely by the fixture's pre-seeded rows. This
          // restates the ALREADY-STORED T2->T1 edge (island 1's own internal
          // edge, seeded directly at the storage layer above) — a genuine
          // touch that stitches nothing across the two islands, so the
          // fracture this test is about stays exactly as severed as the
          // fixture made it.
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T2`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            extends: [
              { turn: `S${sessionDbId}/T1`, tailTag: "severed-fixture", headTag: "severed-fixture" },
            ],
          });

          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(laneCheckReceipt.content[0]!.text).toContain("components: 2 (SEVERED)");
          // Ticket 02: the mandatory disposition is ALSO surfaced from
          // `lane_check` itself, before the agent ever calls `commit`.
          expect(laneCheckReceipt.content[0]!.text).toContain("LANE DISPOSITION");

          const refused = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");
          expect(text).toContain("severed lane fracture");
          expect(text).toContain("LANE-DISPOSITION");
          expect(text).toContain(`S${sessionDbId}/T1`);
          expect(text).toContain(`S${sessionDbId}/T3`);
          expect(text).toContain("remember(justify");

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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set(laneTurnIds),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 4,
      });

      // A refusal is an ordinary in-run rejection: the job row is untouched,
      // exactly like the lane-checker's own E3/E4/E6 refusal.
      expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });

  test("a genuine stitching edge self-evidences — the fracture disappears and commit succeeds with no justify", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedSeveredLaneFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // Severed-lane over-blocking fix: `touched` is now this run's own
          // LANDED writes — this restates the ALREADY-STORED T2->T1 edge
          // (island 1's own internal edge, seeded directly at the storage
          // layer above), a genuine touch that stitches nothing across the
          // two islands, so `firstAttempt` below is still refused for a real
          // reason rather than by the fixture's pre-seeded rows alone.
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T2`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            extends: [
              { turn: `S${sessionDbId}/T1`, tailTag: "severed-fixture", headTag: "severed-fixture" },
            ],
          });

          const firstAttempt = (await handlers.get("commit")!({ report: "first pass" })) as {
            content: Array<{ text: string }>;
          };
          expect(firstAttempt.content[0]!.text).toContain("Commit refused");

          // The write gate for an edge needs a fresh read of the CITING
          // turn's own relations first (the same sequence every other edge
          // write in this file follows).
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T3`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          await handlers.get("note")!({
            turn: `S${sessionDbId}/T3`,
            extends: [
              { turn: `S${sessionDbId}/T2`, tailTag: "severed-fixture", headTag: "severed-fixture" },
            ],
          });

          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          // The stitch merged the two islands: Report 2 now reports the lane
          // WHOLE, and the disposition section has nothing left to name.
          expect(laneCheckReceipt.content[0]!.text).toContain("components: 1");
          expect(laneCheckReceipt.content[0]!.text).not.toContain("LANE DISPOSITION");

          const committed = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set(laneTurnIds),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 4,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(result.commitMetrics?.report).toBe("no friction this window");
    } finally {
      db?.close();
    }
  });

  test("remember(justify) unblocks the commit once the lane is recalled in full and the other representative holds a full-content grant", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // Recall-before-justify, half 1: a justify BEFORE the lane has ever
          // been recalled is refused, naming the missing receipt.
          const tooEarly = (await handlers.get("remember")!({
            action: "justify",
            id: `E${laneSegmentId}`,
            tag: "severed-fixture",
            representative: `S${sessionDbId}/T1`,
            otherRepresentative: `S${sessionDbId}/T3`,
            reason:
              `S${sessionDbId}/T1 and S${sessionDbId}/T3 are two independent fixes, no shared ` +
              "claim between them.",
          })) as { content: Array<{ text: string }> };
          expect(tooEarly.content[0]!.text).toContain("has not recalled");

          // Page through the whole lane (4 members, well under one page).
          await handlers.get("recall")!({ id: `E${laneSegmentId}/#severed-fixture` });

          // Recall-before-justify, half 2: the OTHER representative's full
          // content is still ungranted.
          const noGrant = (await handlers.get("remember")!({
            action: "justify",
            id: `E${laneSegmentId}`,
            tag: "severed-fixture",
            representative: `S${sessionDbId}/T1`,
            otherRepresentative: `S${sessionDbId}/T3`,
            reason:
              `S${sessionDbId}/T1 and S${sessionDbId}/T3 are two independent fixes, no shared ` +
              "claim between them.",
          })) as { content: Array<{ text: string }> };
          expect(noGrant.content[0]!.text).toContain("no full-content read grant");

          await handlers.get("recall")!({
            id: `S${sessionDbId}/T3`,
            filter: { fields: ["content"] },
            turn: 4_000,
          });

          const justified = (await handlers.get("remember")!({
            action: "justify",
            id: `E${laneSegmentId}`,
            tag: "severed-fixture",
            representative: `S${sessionDbId}/T1`,
            otherRepresentative: `S${sessionDbId}/T3`,
            reason:
              `S${sessionDbId}/T1 and S${sessionDbId}/T3 are two independent fixes, no shared ` +
              "claim between them.",
          })) as { content: Array<{ text: string }> };
          expect(justified.content[0]!.text).toContain("Landed justify");

          const committed = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
          expect(committed.content[0]!.text).toContain("Committed");
          // TICKET 08 follow-up (peer round eleven): `justify` arrived as a
          // FOURTH lane action after `accumulateMembershipWriteCounts` was
          // written, and its catch-all default reported every justification as
          // a lane MERGE -- a mutation that never happened, in metrics that
          // outlive the run. This pass moved no lane row at all.
          expect(committed.content[0]!.text).toContain("0 merged");
          expect(committed.content[0]!.text).toContain("1 justified");

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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set(laneTurnIds),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 4,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(result.commitMetrics?.report).toBe("no friction this window");
    } finally {
      db?.close();
    }
  });

  // OVER-BLOCKING FIX (the defect this file's own gate had): `touched` used
  // to be "any island member sits inside `scope.writableTurnIds`" — window ∪
  // lookback ∪ closure — so a severed lane this run never once wrote a field
  // into still owed a mandatory disposition whenever any of its members
  // merely fell inside the rendered lookback. This is that exact scenario,
  // reproduced with `seedSeveredLaneLookbackFixture`: the severed lane's four
  // turns are NOT this dispatch's window (t5/t6 are), only present in the
  // widened `writableTurnIds` the way a lookback render would put them
  // there, and the run makes no `note`/`remember` call on any of the four —
  // no edge side, no tags write, no justify.
  test("a SEVERED lane whose members sit only in the lookback-widened writable set, untouched by any write this run made, does NOT block commit", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, windowTurnIds } =
        seedSeveredLaneLookbackFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          // Report 2 still finds and names the severed lane — connectivity
          // reporting is unconditional, never gated by touch.
          expect(laneCheckReceipt.content[0]!.text).toContain("components: 2 (SEVERED)");
          // But the mandatory-disposition section owes nothing over it: this
          // run has written nothing into the lane at all.
          expect(laneCheckReceipt.content[0]!.text).not.toContain("LANE DISPOSITION");

          const committed = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
          expect(committed.content[0]!.text).toContain("Committed");
          expect(committed.content[0]!.text).not.toContain("LANE-DISPOSITION");

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
        stage: job.stage,
        sessionId: sessionDbId,
        // The widened writable set (window ∪ lookback): t5/t6 ARE the
        // window (windowStart/windowEnd below); t1-t4 (the severed lane)
        // arrive only the way a rendered lookback would put them here.
        writableTurnIds: new Set([...windowTurnIds, ...laneTurnIds]),
        contextBuiltAtEpoch: NOW,
        windowStart: 5,
        windowEnd: 6,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(result.commitMetrics?.report).toBe("no friction this window");
    } finally {
      db?.close();
    }
  });

  // Touch condition (b): a landed TAGS write, no edge, no justify. Distinct
  // from the pinned refusal test above (which touches via a restated edge
  // side) — this proves the OTHER non-justify touch source alone is enough
  // to trigger the mandatory disposition.
  // RE-REVIEW ROUND, FINDING 1 — THE FROZEN-MEMBERSHIP COUNTEREXAMPLE, and
  // the reason this test inverted. It used to LAND a stage-2 tags write and
  // assert the resulting lane touch blocked commit. A tags write is a
  // MEMBERSHIP write (`updateTurnById` -> `deriveTurnSegmentMembership`), and
  // stage 2's whole authority is the snapshot stage 1 froze: the worklist, the
  // member lists, the shape receipt. A legal other-lane tag written here moves
  // live membership underneath all three and nothing downstream notices. So
  // the face refuses it, and the lane it would have touched stays untouched —
  // which is what lets this severed-but-untouched lane commit clean, exactly
  // as the lookback-only test below already showed for a lane no write reached.
  //
  // CONSEQUENCE, FLAGGED FOR THE REVIEWER: touch condition (b) — "a landed
  // tags write touches its lane" — is now UNREACHABLE from stage 2, and stage
  // 2 is the only pass with a commit gate. The condition still exists in
  // `db/lane-disposition.ts` and stage 1 still produces it; nothing at a
  // commit gate can observe it any more.
  test("a stage-2 tags write on a frozen lane is REFUSED, so the lane stays untouched and commit is clean", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedSeveredLaneFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // Grants tags-write completeness (type/tags render inside
          // `metadata`, same as every other tags write in this file).
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T1`,
            filter: { fields: ["metadata"] },
            turn: 4_000,
          });
          // The counterexample in its sharpest form: `#beta` on a turn the
          // frozen snapshot holds as an `#alpha` singleton. Both words are
          // legal vocabulary and the tag gate would pass it — the refusal has
          // to come from the STAGE, which is the whole finding.
          const refusedTags = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            tags: ["severed-task", "severed-fixture"],
            mode: { tags: "write" },
          })) as { content: Array<{ text: string }> };
          const tagsText = refusedTags.content[0]!.text;
          expect(tagsText).toContain("Parameter error");
          expect(tagsText).toContain("tags");
          expect(tagsText).toContain("edge pass");
          expect(tagsText).toContain("Nothing was written.");
          expect(tagsText).not.toContain("Landed");

          // Prose and type go the same way, and the refusal names them.
          const refusedProse = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            title: "a hindsight retitle",
            content: "a hindsight re-note",
            type: ["design"],
          })) as { content: Array<{ text: string }> };
          expect(refusedProse.content[0]!.text).toContain("Parameter error");
          for (const field of ["title", "content", "type"]) {
            expect(refusedProse.content[0]!.text).toContain(field);
          }

          // NOTHING WAS TOUCHED, so this severed lane commits clean — the
          // same outcome the lookback-only test below gets for a lane no write
          // reached at all. Before the guard, the refused write above landed
          // and this commit was a LANE-DISPOSITION refusal.
          const committed = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set(laneTurnIds),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 4,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      // The frozen membership is intact: the refused write left the turn's
      // tags exactly as the snapshot describes them.
      expect(getTurnById(db, laneTurnIds[0]!)!.tags).toEqual([
        "severed-task",
        "severed-fixture",
      ]);
    } finally {
      db?.close();
    }
  });

  // Touch condition (c) in isolation — see `seedThreeIslandLaneLookbackFixture`
  // for why three islands (two fractures) rather than two: it is the only
  // shape that can tell "the justify itself made this lane touched" apart
  // from "the one fracture the justify names happened to clear".
  test("a lane touched ONLY by a landed justify (no edge, no tags write, members only in lookback) still blocks over its OTHER remaining fracture", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, windowTurnIds, laneSegmentId } =
        seedThreeIslandLaneLookbackFixture(db);

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const laneCheckReceipt = (await handlers.get("lane_check")!({})) as {
            content: Array<{ text: string }>;
          };
          expect(laneCheckReceipt.content[0]!.text).toContain("components: 3 (SEVERED)");
          // Untouched so far — no LANE DISPOSITION section yet, exactly the
          // over-blocking fix's own contract.
          expect(laneCheckReceipt.content[0]!.text).not.toContain("LANE DISPOSITION");

          // Recall-before-justify: the whole lane's membership (6 turns, one
          // page), then the OTHER representative's full content.
          await handlers.get("recall")!({ id: `E${laneSegmentId}/#three-island-fixture` });
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T3`,
            filter: { fields: ["content"] },
            turn: 4_000,
          });

          const justified = (await handlers.get("remember")!({
            action: "justify",
            id: `E${laneSegmentId}`,
            tag: "three-island-fixture",
            representative: `S${sessionDbId}/T1`,
            otherRepresentative: `S${sessionDbId}/T3`,
            reason:
              `S${sessionDbId}/T1 and S${sessionDbId}/T3 are two independent fixes, no shared ` +
              "claim between them.",
          })) as { content: Array<{ text: string }> };
          expect(justified.content[0]!.text).toContain("Landed justify");

          // The FIRST fracture (T1<->T3) is now disposed. The SECOND
          // (T3<->T5) is not — and this run made no other write of any
          // kind. If `touched` were still false for this lane (no edge, no
          // tags write, and the fixture never puts any of its turns in the
          // window), this refusal would never fire and the outstanding
          // fracture would silently pass through commit.
          const refused = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
          const text = refused.content[0]!.text;
          expect(text).toContain("Commit refused");
          expect(text).toContain("severed lane fracture");
          expect(text).toContain(`S${sessionDbId}/T3`);
          expect(text).toContain(`S${sessionDbId}/T5`);
          // The healed fracture must not be re-demanded.
          expect(text).not.toContain(`S${sessionDbId}/T1 <-> S${sessionDbId}/T3`);

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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([...windowTurnIds, ...laneTurnIds]),
        contextBuiltAtEpoch: NOW,
        windowStart: 7,
        windowEnd: 8,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });
});

/**
 * PHASE-CONNECTIVITY TICKET 05 — "a read receipt that counts members, not
 * pages". `hasFullLaneReadCoverage` divided the member count by a hardcoded
 * `LANE_READ_PAGE_SIZE = 10` while `recall` honours a caller-supplied
 * `pageSize`, so a single page at `pageSize: 1` "covered" a four-member lane
 * after showing one member, and the justify was accepted. Coverage is over
 * the member ids a call actually rendered now, scoped to the OTHER
 * representative's component — "read the side you are not standing on".
 */
describe("phase-connectivity ticket 05 — a justify's read obligation counts members", () => {
  const JUSTIFY_REASON_TEMPLATE = (sessionDbId: number): string =>
    `S${sessionDbId}/T1 and S${sessionDbId}/T3 are two independent fixes, no shared claim ` +
    "between them.";

  function runSettlement(
    db: Database,
    job: NoteSettlementJob,
    sessionDbId: number,
    laneTurnIds: number[],
    body: (handlers: Map<string, (args: Record<string, unknown>) => unknown>) => Promise<void>,
  ): Promise<unknown> {
    const { toolImpl, handlers } = captureToolImpl();
    const queryImpl = mock(() =>
      (async function* () {
        await body(handlers);
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
    return runQuery({
      prompt: "settle",
      systemPrompt: "system",
      model: "claude-sonnet-5",
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      stage: job.stage,
      sessionId: sessionDbId,
      writableTurnIds: new Set(laneTurnIds),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 4,
    });
  }

  /**
   * THE LAUNDERING PATH THE PEER FOUND, as written. `seedSeveredLaneFixture`'s
   * lane has four members; under the old arithmetic it needed
   * `ceil(4 / 10) = 1` page, so ONE call at `pageSize: 1` — which shows a
   * single member — satisfied the whole obligation.
   */
  test("a justify after paging the lane at pageSize 1 for fewer pages than the component has members is REFUSED, naming what is still unread", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);

      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        await handlers.get("recall")!({
          id: `E${laneSegmentId}/#severed-fixture`,
          page: 1,
          pageSize: 1,
        });
        // The full-content grant on the other representative is already in
        // hand, so the ONLY thing that can refuse below is the read coverage.
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });

        const refused = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON_TEMPLATE(sessionDbId),
        })) as { content: Array<{ text: string }> };
        const text = refused.content[0]!.text;
        // Ticket 07 decision 1 renamed the count for what it now measures:
        // the obligation is the other island's ERA-VISIBLE members. Nothing
        // is excluded in this fixture (no era cutoff is recorded), so the
        // number is unchanged — only the word it carries.
        expect(text).toContain("has not read all 2 era-visible member(s)");
        // Named, not merely counted: page 1 at pageSize 1 rendered T1, which
        // is not even in the component being justified against — both of
        // T3's own component's members are still unread.
        expect(text).toContain("still unread:");
        expect(text).toContain(`S${sessionDbId}/T3`);
        expect(text).toContain(`S${sessionDbId}/T4`);
      });
    } finally {
      db?.close();
    }
  });

  test("a justify after genuinely paging every member is ACCEPTED", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);

      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        for (let page = 1; page <= 4; page += 1) {
          await handlers.get("recall")!({
            id: `E${laneSegmentId}/#severed-fixture`,
            page,
            pageSize: 1,
          });
        }
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });

        const justified = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON_TEMPLATE(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(justified.content[0]!.text).toContain("Landed justify");
      });
    } finally {
      db?.close();
    }
  });

  test("coverage accumulates across calls with DIFFERENT page sizes", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);

      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        // Page 3 at pageSize 1 shows T3 alone — one of the two members owed.
        await handlers.get("recall")!({
          id: `E${laneSegmentId}/#severed-fixture`,
          page: 3,
          pageSize: 1,
        });
        const halfway = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON_TEMPLATE(sessionDbId),
        })) as { content: Array<{ text: string }> };
        // T3 is read, T4 is not — the unread LIST names T4 and only T4.
        expect(halfway.content[0]!.text).toContain(`still unread: S${sessionDbId}/T4.`);

        // A SECOND call at a DIFFERENT size closes the gap — and closes ONLY
        // the gap: pages of size 3 over the lane's four members are
        // [T1,T2,T3] and [T4], so page 2 shows T4 alone. NEITHER call covers
        // the obligation on its own, which is what makes this an
        // accumulation test rather than a one-shot read wearing two calls.
        await handlers.get("recall")!({
          id: `E${laneSegmentId}/#severed-fixture`,
          page: 2,
          pageSize: 3,
        });
        // The full-content grant LAST: a lane render marks its own
        // (truncated) grant on the members it shows, so a lane page after
        // this one would take it back.
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        const justified = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON_TEMPLATE(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(justified.content[0]!.text).toContain("Landed justify");
      });
    } finally {
      db?.close();
    }
  });

  test("a reason that omits either representative is refused naming the missing one; one naming both is accepted", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);

      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        for (let page = 1; page <= 4; page += 1) {
          await handlers.get("recall")!({
            id: `E${laneSegmentId}/#severed-fixture`,
            page,
            pageSize: 1,
          });
        }
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });

        const justify = (reason: string): Promise<unknown> =>
          Promise.resolve(
            handlers.get("remember")!({
              action: "justify",
              id: `E${laneSegmentId}`,
              tag: "severed-fixture",
              representative: `S${sessionDbId}/T1`,
              otherRepresentative: `S${sessionDbId}/T3`,
              reason,
            }),
          );

        // Non-empty, and about nothing checkable — what the predecessor
        // accepted, since its only test was non-emptiness.
        const neither = (await justify(
          "two independent fixes, no shared claim between them",
        )) as { content: Array<{ text: string }> };
        expect(neither.content[0]!.text).toContain(`does not name S${sessionDbId}/T1`);
        expect(neither.content[0]!.text).toContain(`S${sessionDbId}/T3`);

        const onlyOne = (await justify(
          `S${sessionDbId}/T1 stands alone; nothing else is claimed here.`,
        )) as { content: Array<{ text: string }> };
        expect(onlyOne.content[0]!.text).toContain(`does not name S${sessionDbId}/T3`);
        expect(onlyOne.content[0]!.text).not.toContain(`does not name S${sessionDbId}/T1`);

        const both = (await justify(JUSTIFY_REASON_TEMPLATE(sessionDbId))) as {
          content: Array<{ text: string }>;
        };
        expect(both.content[0]!.text).toContain("Landed justify");
      });
    } finally {
      db?.close();
    }
  });
});

/**
 * PHASE-CONNECTIVITY TICKET 07 — the three defects the ninth peer round found
 * in ticket 05's repair, at the settlement seam:
 *
 *   1. A lane page the worker envelope CUTS credited itself in full (the
 *      receipt was written before the render, out of the page arithmetic).
 *   2. The read obligation covered island members `recall` is structurally
 *      forbidden to show — the checker's islands carry no era filter while
 *      the lane render does, and the era grant lands at COMMIT, which this
 *      gate precedes. The obligation was unsatisfiable by any sequence of
 *      calls (USER RULING [S15069/T1964]: the obligation is the era-VISIBLE
 *      members).
 *   3. The full-content grant was tested for `complete` alone, so another
 *      writer changing that field inside the same claim left the stale grant
 *      accepted.
 */
describe("phase-connectivity ticket 07 — a receipt for what was delivered, an obligation that can be discharged", () => {
  const JUSTIFY_REASON = (sessionDbId: number): string =>
    `S${sessionDbId}/T1 and S${sessionDbId}/T3 are two independent fixes, no shared claim ` +
    "between them.";

  function runSettlement(
    db: Database,
    job: NoteSettlementJob,
    sessionDbId: number,
    laneTurnIds: number[],
    windowEnd: number,
    body: (handlers: Map<string, (args: Record<string, unknown>) => unknown>) => Promise<void>,
  ): Promise<unknown> {
    const { toolImpl, handlers } = captureToolImpl();
    const queryImpl = mock(() =>
      (async function* () {
        await body(handlers);
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
    return runQuery({
      prompt: "settle",
      systemPrompt: "system",
      model: "claude-sonnet-5",
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      stage: job.stage,
      sessionId: sessionDbId,
      writableTurnIds: new Set(laneTurnIds),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd,
    });
  }

  /**
   * The same two-island shape `seedSeveredLaneFixture` builds, widened to SIX
   * members each carrying ~24K characters of content. At the PUBLIC per-item
   * ceiling (`MAX_TURN_BUDGET` = 5000 tokens, ~20K characters) one default
   * page of this lane renders past the 100,000-character envelope — which is
   * the only way to reach decision 3's "a truncated delivery credits nothing"
   * without reaching for a budget no real caller may pass.
   */
  function seedBulkySeveredLaneFixture(db: Database): {
    sessionDbId: number;
    job: NoteSettlementJob;
    laneTurnIds: number[];
    laneSegmentId: number;
  } {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "settlement-sdk-query-bulky-lane-session",
      project: "/tmp/project-settlement-sdk-query-bulky-lane",
      title: "settlement sdk-query bulky severed-lane fixture",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;

    const laneSegmentId = createSegment(db, {
      title: "bulky severed-lane fixture",
      tags: ["bulky-task"],
      nowEpoch: NOW,
    }).id;

    const ids: number[] = [];
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      ids.push(
        db
          .query<{ id: number }, [number, number, string, number, string, string]>(
            `INSERT INTO turns (
               session_id, prompt_number, status, user_prompt, assistant_response,
               tool_call_count, created_at_epoch, type, tags, title, content
             ) VALUES (?, ?, 'active', 'p', 'r', 3, ?, '["design"]', ?, ?, ?)
             RETURNING id`,
          )
          .get(
            sessionDbId,
            promptNumber,
            NOW - 900 + promptNumber,
            JSON.stringify(["bulky-task", "bulky-fixture"]),
            `bulky note ${promptNumber}`,
            "sentence ".repeat(2_700),
          )!.id,
      );
    }
    addSegmentMembers(db, laneSegmentId, ids, NOW);
    insertLane(db, laneSegmentId, "bulky-fixture", NOW);

    const side = deriveSideTags(["bulky-fixture"]);
    writeMemoryEdges(
      db,
      [
        // Island A: {T1, T2}. Island B: {T3, T4, T5, T6}. Nothing crosses.
        { citing: { kind: "turn", id: ids[1]! }, cited: { kind: "turn", id: ids[0]! }, relation: "extends", provenance: "asserted", ...side },
        { citing: { kind: "turn", id: ids[3]! }, cited: { kind: "turn", id: ids[2]! }, relation: "extends", provenance: "asserted", ...side },
        { citing: { kind: "turn", id: ids[4]! }, cited: { kind: "turn", id: ids[3]! }, relation: "extends", provenance: "asserted", ...side },
        { citing: { kind: "turn", id: ids[5]! }, cited: { kind: "turn", id: ids[4]! }, relation: "extends", provenance: "asserted", ...side },
      ],
      NOW,
    );

    enqueueNoteSettlementWindows(
      db,
      [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 6, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
    if (!job) {
      throw new Error("fixture failed to claim a settlement job");
    }
    return { sessionDbId, job, laneTurnIds: ids, laneSegmentId };
  }

  /**
   * DECISION 3. The whole lane is recalled — every member is in the rendered
   * text — but the text is longer than the envelope will carry, so the reader
   * saw a prefix and the receipt says nothing rather than saying something
   * false. The refusal that follows explains the cap, so a run that DID
   * recall the lane is not left reading "you never recalled it" as a
   * contradiction.
   */
  test("a lane page the worker envelope would cut writes NO receipt, and the refusal names the cap", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedBulkySeveredLaneFixture(db);

      await runSettlement(db, job, sessionDbId, laneTurnIds, 6, async (handlers) => {
        const oversize = (await handlers.get("recall")!({
          id: `E${laneSegmentId}/#bulky-fixture`,
          turn: 5_000,
        })) as { content: Array<{ text: string }> };
        // The envelope really did cut it — this is the delivery the receipt
        // refuses to credit, not a hypothetical one.
        expect(oversize.content[0]!.text).toContain("工具返回已达上限");

        const refused = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "bulky-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(refused.content[0]!.text).toContain("has not recalled");
        expect(refused.content[0]!.text).toContain("records no receipt at all");

        // The SAME lane, paged small enough to be delivered whole, does earn
        // a receipt — so the silence above is the cap speaking, not the
        // receipt path having gone dead.
        const small = (await handlers.get("recall")!({
          id: `E${laneSegmentId}/#bulky-fixture`,
          page: 1,
          pageSize: 2,
          turn: 5_000,
        })) as { content: Array<{ text: string }> };
        expect(small.content[0]!.text).not.toContain("工具返回已达上限");

        const nowCredited = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "bulky-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(nowCredited.content[0]!.text).not.toContain("has not recalled");
        expect(nowCredited.content[0]!.text).toContain("has not read all 4 era-visible member(s)");
      });
    } finally {
      db?.close();
    }
  });

  /**
   * DECISION 1 (USER RULING [S15069/T1964]). T4 is moved before the recorded
   * era cutoff and carries no era grant, so `recall`'s lane route can never
   * render it — while the checker's islands, which apply no era filter, still
   * count it a member of T3's component. Before this ticket that lane owed a
   * justify no sequence of calls could satisfy.
   */
  test("an out-of-era, ungranted member of the other island is excluded from the obligation — the deadlock is gone", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);
      const [, , t3, t4] = laneTurnIds as [number, number, number, number];
      db.query<unknown, [number, number]>(
        "INSERT INTO era_state (id, cutoff_epoch, recorded_at_epoch) VALUES (1, ?, ?)",
      ).run(NOW - 1_000, NOW);
      db.query<unknown, [number, number]>(
        "UPDATE turns SET created_at_epoch = ? WHERE id = ?",
      ).run(NOW - 5_000, t4);

      await runSettlement(db, job, sessionDbId, laneTurnIds, 4, async (handlers) => {
        // Page ONE member — T3's own component still owes T3, and the refusal
        // has to distinguish that from T4, which is owed by nobody.
        await handlers.get("recall")!({
          id: `E${laneSegmentId}/#severed-fixture`,
          page: 1,
          pageSize: 1,
        });
        const partial = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        const partialText = partial.content[0]!.text;
        // ONE era-visible member owed, not two — and T4 is named as excluded
        // rather than silently dropped.
        expect(partialText).toContain("has not read all 1 era-visible member(s)");
        expect(partialText).toContain(`still unread: S${sessionDbId}/T3.`);
        expect(partialText).toContain("excluded from this obligation as OUT-OF-ERA");
        expect(partialText).toContain(`S${sessionDbId}/T4`);

        // Every era-visible member of T3's component, rendered. T4 never can
        // be, and is no longer asked for.
        await handlers.get("recall")!({ id: `E${laneSegmentId}/#severed-fixture` });
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        const justified = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(justified.content[0]!.text).toContain("Landed justify");
        // The excluded member is still a member: nothing about this ticket
        // moved T4 out of the island, only out of the READ obligation.
        expect(getTurnById(db!, t4)!.tags).toContain("severed-fixture");
        expect(t3).toBeGreaterThan(0);
      });
    } finally {
      db?.close();
    }
  });

  /**
   * REVERSED BY PHASE-CONNECTIVITY TICKET 08, decision 1 — this is that
   * reversal's own site, and the reversal is the ticket's own act rather than
   * a side effect of one.
   *
   * What stood here pinned ticket 07's reviewer ruling [S15069/T1965]: that
   * the full-content grant is WAIVED when the other representative is out of
   * era, "since no recall can deliver an out-of-era turn whole". That premise
   * is FALSE, and the tenth peer round proved it by running the read inside
   * this very fixture. Era filtering applies to segment/lane MEMBERSHIP reads;
   * `applyTurnSelector` (mcp/recall.ts) loads an `S<n>/T<m>` address straight
   * from the session with no era predicate at all. The waiver therefore
   * excused the rule for exactly the old lanes the rule was written for, and
   * excused it for nothing: direct recall is the narrow path through the era
   * boundary, and the refusal now points at it.
   *
   * Note what is NOT touched: the MEMBERSHIP obligation keeps its era split
   * (USER RULING [S15069/T1964]), because that one is earned through the lane
   * route, which really is era-filtered.
   */
  test("a justify against an out-of-era representative is REFUSED without a grant, and ACCEPTED after the turn is recalled by address", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);
      const [, , t3, t4] = laneTurnIds as [number, number, number, number];
      db.query<unknown, [number, number]>(
        "INSERT INTO era_state (id, cutoff_epoch, recorded_at_epoch) VALUES (1, ?, ?)",
      ).run(NOW - 1_000, NOW);
      // The WHOLE other component falls out of era, its REPRESENTATIVE included.
      db.query<unknown, [number, number, number]>(
        "UPDATE turns SET created_at_epoch = ? WHERE id IN (?, ?)",
      ).run(NOW - 5_000, t3, t4);

      await runSettlement(db, job, sessionDbId, laneTurnIds, 4, async (handlers) => {
        // The lane render cannot show T3 at all, so the membership obligation
        // is discharged by the era split alone — the ONLY thing left to refuse
        // over is the grant.
        await handlers.get("recall")!({ id: `E${laneSegmentId}/#severed-fixture` });
        const justify = (): Promise<unknown> =>
          Promise.resolve(
            handlers.get("remember")!({
              action: "justify",
              id: `E${laneSegmentId}`,
              tag: "severed-fixture",
              representative: `S${sessionDbId}/T1`,
              otherRepresentative: `S${sessionDbId}/T3`,
              reason: JUSTIFY_REASON(sessionDbId),
            }),
          );

        const refused = (await justify()) as { content: Array<{ text: string }> };
        const refusedText = refused.content[0]!.text;
        expect(refusedText).toContain("no full-content read grant");
        // The refusal names the move that clears it, and says why that move
        // works on a turn the lane route cannot show.
        expect(refusedText).toContain(`recall(id="S${sessionDbId}/T3"`);
        expect(refusedText).toContain("not an explicit turn address");
        // Nothing in the tree lets an out-of-era representative off any more.
        expect(refusedText).not.toContain("waived");

        // The probe that proved the premise false, run as the remedy.
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        const justified = (await justify()) as { content: Array<{ text: string }> };
        const text = justified.content[0]!.text;
        expect(text).toContain("Landed justify");
        expect(text).not.toContain("WITHOUT a full-content grant");
        expect(t4).toBeGreaterThan(0);
      });
    } finally {
      db?.close();
    }
  });

  /**
   * DECISION 4 / P1-3. The whole-field authorization this codebase already
   * runs (`db/write-gate.ts`'s `checkFieldGate`) compares the completeness
   * record's own sequence against the field's write stamp; `justify` tested
   * `complete` alone, forty lines away. Claim scoping stops cross-claim
   * reuse — it says nothing about a foreign write INSIDE one claim.
   */
  test("a full-content grant taken before another writer changed that content is REFUSED as stale, naming the field", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);
      const t3 = laneTurnIds[2]!;

      await runSettlement(db, job, sessionDbId, laneTurnIds, 4, async (handlers) => {
        await handlers.get("recall")!({ id: `E${laneSegmentId}/#severed-fixture` });
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });

        // ANOTHER writer changes the very field the grant is about, inside
        // this same claim.
        stampField(db!, "turn", t3, "content", sessionWriterId(sessionDbId), NOW + 1);

        const stale = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        const staleText = stale.content[0]!.text;
        expect(staleText).toContain("predates");
        expect(staleText).toContain('"content"');
        expect(staleText).toContain(sessionWriterId(sessionDbId));
        // Not the never-granted refusal: the grant EXISTS, it is just old.
        expect(staleText).not.toContain("no full-content read grant");

        // A read taken AFTER that write is accepted.
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        const fresh = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(fresh.content[0]!.text).toContain("Landed justify");
      });
    } finally {
      db?.close();
    }
  });
});

/**
 * PHASE-CONNECTIVITY TICKET 08 — a justification can go stale.
 *
 * `hasLaneDispositionJustification` selected on
 * (segment_id, lane_tag, component_fingerprint) alone: no job scope and no
 * freshness. So the sequence "read B whole, justify A<->B, edit B's content
 * (topology unchanged), commit" passed the gate on evidence that no longer
 * described B — and every later run inherited that row permanently. Ticket 05's
 * fingerprint ruling stands and is about something else: a MEMBERSHIP change
 * that preserves both representatives is the same fracture, and the fingerprint
 * is right to keep matching it. What nothing covered was the two turns' own
 * text moving underneath a durable judgment about it.
 */
describe("phase-connectivity ticket 08 — a justification carries the evidence it was granted on", () => {
  const JUSTIFY_REASON = (sessionDbId: number): string =>
    `S${sessionDbId}/T1 and S${sessionDbId}/T3 are two independent fixes, no shared claim ` +
    "between them.";

  function runSettlement(
    db: Database,
    job: NoteSettlementJob,
    sessionDbId: number,
    laneTurnIds: number[],
    body: (handlers: Map<string, (args: Record<string, unknown>) => unknown>) => Promise<void>,
  ): Promise<unknown> {
    const { toolImpl, handlers } = captureToolImpl();
    const queryImpl = mock(() =>
      (async function* () {
        await body(handlers);
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
    return runQuery({
      prompt: "settle",
      systemPrompt: "system",
      model: "claude-sonnet-5",
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      stage: job.stage,
      sessionId: sessionDbId,
      writableTurnIds: new Set(laneTurnIds),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 4,
    });
  }

  test("a write to a representative's content between the justify and the commit makes the commit REFUSE, naming the fracture and the moved evidence", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);
      const t3 = laneTurnIds[2]!;

      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        await handlers.get("recall")!({ id: `E${laneSegmentId}/#severed-fixture` });
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        const justified = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(justified.content[0]!.text).toContain("Landed justify");

        // ANOTHER writer changes the very content the disposition was
        // reasoned from. The TOPOLOGY is untouched — same two islands, same
        // two representatives, same fingerprint — so nothing ticket 05's
        // fingerprint watches has moved.
        stampField(db!, "turn", t3, "content", sessionWriterId(sessionDbId), NOW + 1);

        const refused = (await handlers.get("commit")!({
          report: "no friction this window",
        })) as { content: Array<{ text: string }> };
        const text = refused.content[0]!.text;
        expect(text).toContain("Commit refused");
        expect(text).toContain("LANE-DISPOSITION");
        // The fracture, by both representative addresses…
        expect(text).toContain(`S${sessionDbId}/T1 <-> S${sessionDbId}/T3`);
        // …and the moved evidence, distinguished from "there is no justify".
        expect(text).toContain("MOVED since");
        expect(text).toContain(`S${sessionDbId}/T3 was written after that justify landed`);
        expect(text).not.toContain("no stitching edge and no justify on");
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });

  test("a later run does not inherit a justification whose evidence has moved", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds, laneSegmentId } = seedSeveredLaneFixture(db);
      const t3 = laneTurnIds[2]!;

      // RUN ONE earns and files the justification, then dies without
      // committing — the touch ledger is durable, so the obligation outlives it.
      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        await handlers.get("recall")!({ id: `E${laneSegmentId}/#severed-fixture` });
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        const justified = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(justified.content[0]!.text).toContain("Landed justify");
      });

      stampField(db, "turn", t3, "content", sessionWriterId(sessionDbId), NOW + 1);

      // RUN TWO: a fresh engine, writing nothing of its own. Under the
      // predecessor's fingerprint-only lookup the stored row cleared its gate
      // outright, forever.
      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        const refused = (await handlers.get("commit")!({
          report: "no friction this window",
        })) as { content: Array<{ text: string }> };
        expect(refused.content[0]!.text).toContain("LANE-DISPOSITION");
        expect(refused.content[0]!.text).toContain("MOVED since");
      });

      // …and re-reading the moved representative and re-justifying clears it,
      // which is what makes the refusal a step rather than a wall.
      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        await handlers.get("recall")!({ id: `E${laneSegmentId}/#severed-fixture` });
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["content"] },
          turn: 4_000,
        });
        const rejustified = (await handlers.get("remember")!({
          action: "justify",
          id: `E${laneSegmentId}`,
          tag: "severed-fixture",
          representative: `S${sessionDbId}/T1`,
          otherRepresentative: `S${sessionDbId}/T3`,
          reason: JUSTIFY_REASON(sessionDbId),
        })) as { content: Array<{ text: string }> };
        expect(rejustified.content[0]!.text).toContain("Landed justify");
        const committed = (await handlers.get("commit")!({
          report: "no friction this window",
        })) as { content: Array<{ text: string }> };
        expect(committed.content[0]!.text).toContain("Committed");
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });
});

/**
 * PHASE-CONNECTIVITY TICKET 04 — "a touch ledger as durable as the writes it
 * guards". Two holes the eighth peer round found in the touch set, both
 * asserted here at the SETTLEMENT SEAM (the real registered handlers), never
 * against the push site:
 *
 *   1. DESTRUCTIVE topology changes registered no touch. A retraction and a
 *      tag removal each sever a lane while leaving it "untouched", so `commit`
 *      passed with neither stitch nor justify — the exact guarantee ticket 02
 *      sold.
 *   2. The touch set did not survive an attempt. Direct writes commit
 *      immediately; the sets lived on the engine instance. Attempt A landed a
 *      severing write and died, attempt B rebuilt empty sets. Settlement caps
 *      attempts at 3, so that is an ordinary path.
 */
describe("phase-connectivity ticket 04 — a destructive write touches the lane it broke, durably", () => {
  function runSettlement(
    db: Database,
    job: NoteSettlementJob,
    sessionDbId: number,
    writableTurnIds: number[],
    body: (handlers: Map<string, (args: Record<string, unknown>) => unknown>) => Promise<void>,
    claimGeneration: number = job.claimGeneration,
  ): Promise<unknown> {
    const { toolImpl, handlers } = captureToolImpl();
    const queryImpl = mock(() =>
      (async function* () {
        await body(handlers);
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
    return runQuery({
      prompt: "settle",
      systemPrompt: "system",
      model: "claude-sonnet-5",
      jobId: job.id,
      claimGeneration,
      stage: job.stage,
      sessionId: sessionDbId,
      writableTurnIds: new Set(writableTurnIds),
      contextBuiltAtEpoch: NOW,
      windowStart: 1,
      windowEnd: 4,
    });
  }

  /** The bridge retraction, through the real `note` handler — the write gate wants a fresh read of the citing turn's own relation set first. */
  async function retractTheBridge(
    handlers: Map<string, (args: Record<string, unknown>) => unknown>,
    sessionDbId: number,
  ): Promise<string> {
    await handlers.get("recall")!({
      id: `S${sessionDbId}/T3`,
      filter: { fields: ["relations"] },
      turn: 4_000,
    });
    const retracted = (await handlers.get("note")!({
      turn: `S${sessionDbId}/T3`,
      retractExtends: [
        { turn: `S${sessionDbId}/T2`, tailTag: "bridged-fixture", headTag: "bridged-fixture" },
      ],
    })) as { content: Array<{ text: string }> };
    return retracted.content[0]!.text;
  }

  test("retracting the SOLE bridging edge of an otherwise-whole lane leaves it touched — commit refuses without a stitch or justify", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedBridgedLaneFixture(db);

      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        const laneCheckBefore = (await handlers.get("lane_check")!({})) as {
          content: Array<{ text: string }>;
        };
        // Born WHOLE — the severing is this run's own act, not the fixture's.
        expect(laneCheckBefore.content[0]!.text).toContain("components: 1");

        expect(await retractTheBridge(handlers, sessionDbId)).toContain("Retracted 1 relation(s)");

        const refused = (await handlers.get("commit")!({
          report: "no friction this window",
        })) as { content: Array<{ text: string }> };
        const text = refused.content[0]!.text;
        expect(text).toContain("Commit refused");
        expect(text).toContain("severed lane fracture");
        expect(text).toContain("LANE-DISPOSITION");
        expect(text).toContain(`S${sessionDbId}/T1`);
        expect(text).toContain(`S${sessionDbId}/T3`);
      });

      // A refusal is an ordinary in-run rejection: the job row is untouched.
      expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });

  /**
   * ASSERTED AT `lane_check`, NOT AT `commit`, AND THAT IS STRUCTURAL RATHER
   * THAN A CONVENIENCE. A turn whose lane tag can be dropped to SEVER a lane
   * is by definition a cut vertex of that lane's tagged-edge graph, so it
   * carries at least two edge sides naming the lane — and the instant its tag
   * goes, every one of those sides is an E4 ("tag missing from the citing/
   * cited turn's own tags"). `evaluateSettlementCommitGate` runs BEFORE the
   * disposition gate and returns on the first refusal, so `commit`'s answer
   * to this exact scenario is always the E4 list, never the LANE-DISPOSITION
   * one. Both halves used to be asserted below.
   *
   * RE-REVIEW ROUND, FINDING 1 — INVERTED. Everything above describes a write
   * stage 2 can no longer make: dropping a member's lane tag is the most
   * destructive membership write there is, and the frozen worklist and member
   * snapshots this pass reads would go on describing the lane it just cut. So
   * the face refuses it and the lane survives whole. What the paragraph above
   * still documents correctly is the ORDER of the two gates, which is why the
   * assertion below is at `lane_check` rather than at `commit`.
   *
   * CONSEQUENCE, FLAGGED FOR THE REVIEWER: `laneKeyTouches` — the
   * REMOVED-tag half of the lane-touch accounting
   * (`note-settlement-turn-facade.ts`) — now has no test anywhere in the
   * suite, because stage 2 was its only reachable producer and stage 1 has no
   * commit gate to observe it. The code is live and unexercised.
   */
  test("a stage-2 tags write that would SEVER a lane is refused, and the lane survives whole", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedBridgedLaneFixture(db);

      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        const before = (await handlers.get("lane_check")!({})) as {
          content: Array<{ text: string }>;
        };
        expect(before.content[0]!.text).toContain("components: 1");
        expect(before.content[0]!.text).not.toContain("LANE DISPOSITION");

        // type/tags render inside `metadata` — the grant every tags write needs.
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T2`,
          filter: { fields: ["metadata"] },
          turn: 4_000,
        });
        // The NEW set keeps the segment tag and DROPS the lane tag. T2 is the
        // chain's second link, so the lane it left would strand T1 on its own:
        // {T1} | {T3,T4}. It never gets that far.
        const refusedTags = (await handlers.get("note")!({
          turn: `S${sessionDbId}/T2`,
          tags: ["bridged-task"],
          mode: { tags: "write" },
        })) as { content: Array<{ text: string }> };
        expect(refusedTags.content[0]!.text).toContain("Parameter error");
        expect(refusedTags.content[0]!.text).toContain("Nothing was written.");
        expect(refusedTags.content[0]!.text).not.toContain("Landed review");

        const after = (await handlers.get("lane_check")!({})) as {
          content: Array<{ text: string }>;
        };
        const laneCheckText = after.content[0]!.text;
        // Still whole, still untouched, still nothing to dispose of.
        expect(laneCheckText).toContain("components: 1");
        expect(laneCheckText).not.toContain("SEVERED");
        expect(laneCheckText).not.toContain("LANE DISPOSITION");

        // And no E4 either: every edge side's lane tag is still on its turn,
        // because the write that would have removed one never landed.
        const committed = (await handlers.get("commit")!({
          report: "no friction this window",
        })) as { content: Array<{ text: string }> };
        expect(committed.content[0]!.text).toContain("Committed");
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
    } finally {
      db?.close();
    }
  });

  test("a retraction that does NOT sever refuses nothing — a touch is not by itself an obligation", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedBridgedLaneFixture(db);
      // A SECOND crossing (T4 -> T2), so T3 -> T2 is no longer the sole
      // bridge and retracting it leaves the lane whole.
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: laneTurnIds[3]! },
            cited: { kind: "turn", id: laneTurnIds[1]! },
            relation: "extends",
            provenance: "asserted",
            ...deriveSideTags(["bridged-fixture"]),
          },
        ],
        NOW,
      );

      const result = (await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        expect(await retractTheBridge(handlers, sessionDbId)).toContain("Retracted 1 relation(s)");

        const committed = (await handlers.get("commit")!({
          report: "no friction this window",
        })) as { content: Array<{ text: string }> };
        expect(committed.content[0]!.text).toContain("Committed");
        expect(committed.content[0]!.text).not.toContain("LANE-DISPOSITION");
      })) as { commitMetrics?: { report?: string } };

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      expect(result.commitMetrics?.report).toBe("no friction this window");
    } finally {
      db?.close();
    }
  });

  test("a touch survives the engine instance that made it: attempt A severs and dies, attempt B's fresh engine still refuses", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedBridgedLaneFixture(db);

      // ATTEMPT A: lands the severing retraction, then dies without committing.
      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        expect(await retractTheBridge(handlers, sessionDbId)).toContain("Retracted 1 relation(s)");
      });
      expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");

      // ATTEMPT B: a brand-new engine on the same database and the same job.
      // It writes nothing at all — its in-memory touch sets are empty, and
      // only the durable ledger can still hold attempt A's obligation.
      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        const refused = (await handlers.get("commit")!({
          report: "no friction this window",
        })) as { content: Array<{ text: string }> };
        expect(refused.content[0]!.text).toContain("Commit refused");
        expect(refused.content[0]!.text).toContain("LANE-DISPOSITION");
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
    } finally {
      db?.close();
    }
  });

  test("the ledger is job-scoped, not claim-scoped: a claim-generation bump inherits the obligation", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job, laneTurnIds } = seedBridgedLaneFixture(db);

      await runSettlement(db, job, sessionDbId, laneTurnIds, async (handlers) => {
        expect(await retractTheBridge(handlers, sessionDbId)).toContain("Retracted 1 relation(s)");
      });

      // A RECLAIM, reduced to the one fact the ledger's key is about: the
      // job stays `claimed` and its generation rises, so the next dispatch
      // runs under a writer identity the first one's rows were never
      // written under.
      db.query<unknown, [number]>(
        "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
      ).run(job.id);

      await runSettlement(
        db,
        job,
        sessionDbId,
        laneTurnIds,
        async (handlers) => {
          const refused = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
          expect(refused.content[0]!.text).toContain("Commit refused");
          expect(refused.content[0]!.text).toContain("LANE-DISPOSITION");
        },
        job.claimGeneration + 1,
      );

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("claimed");
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
        stage: job.stage,
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
          expect(defaultText).not.toContain("declaration:");
          expect(defaultText).toContain("Lane E");

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
        stage: job.stage,
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
        stage: job.stage,
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
        stage: job.stage,
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
          expect(defaultCall.content[0]!.text).toContain("Lane E");

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
        stage: job.stage,
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
        stage: job.stage,
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
          stage: job.stage,
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
      // The turn arrives ALREADY TYPED, because under the staged flow it must:
      // stage 1's own transition gate refuses to hand stage 2 a turn with an
      // empty type, and stage 2 can no longer set one (re-review finding 1).
      // The old shape — untyped turn, repaired by a stage-2 `type` write — is
      // not a state this pass can be in any more.
      db.query("UPDATE turns SET type = ? WHERE id = ?").run(
        JSON.stringify(["design"]),
        t1,
      );

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // RE-REVIEW ROUND, FINDING 1: this used to be a turn `type`/`tags`
          // write, which stage 2's face now refuses. The SUBJECT is staging,
          // not which field — so it moved to the session-addressed narrative,
          // which is stage 2's own write and takes the identical direct-write
          // path (`writeNote` -> `evaluateSettlementTurnWrite` -> one
          // transaction, no staging table anywhere).
          const noteReceipt = (await handlers.get("note")!({
            session: `S${sessionDbId}`,
            content: "In hindsight: what this window settled.",
          })) as { content: Array<{ text: string }> };
          expect(noteReceipt.content[0]!.text).toContain("Landed");
          expect(noteReceipt.content[0]!.text).not.toContain("Staged");
          expect(noteReceipt.content[0]!.text).not.toContain("pending commit");

          // The load-bearing assertion: the write landed ALREADY, through the
          // ACTUAL registered handler, before `commit` was ever called.
          expect(getSession(capturedDb, sessionDbId)!.content).toContain(
            "what this window settled",
          );
          // And the turn is untouched — the refused half of the same face.
          expect(getTurnById(capturedDb, t1)!.tags).toEqual([]);

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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      // After commit: the job itself is durably complete, and the narrative
      // the run wrote mid-flight is still there.
      expect(getSession(db, sessionDbId)!.content).toContain("what this window settled");
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
 *   3. the turn-anchored class (E3) is the ONE exception, and ticket 17 made
 *      it total: an empty type never blocks this gate on any provenance,
 *      because no edge pass holds the pen that repairs it. The anchor filter
 *      still runs first; the class filter is what follows it.
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

          // THE REPAIR, AND WHICH REPAIR IS LEFT (re-review round, finding
          // 1). The refusal names two routes — tag the cited endpoint, or
          // retract the edge — and stage 2 now holds only the second: a tags
          // write on the closure-only endpoint is a membership write, refused
          // at this face. Retraction is the edge pass's own pen, so the E4
          // clears without anything touching the frozen partition.
          const refusedTagRepair = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T3`,
            tags: ["lane"],
          })) as { content: Array<{ text: string }> };
          expect(refusedTagRepair.content[0]!.text).toContain("Parameter error");
          expect(refusedTagRepair.content[0]!.text).toContain("Nothing was written.");

          // A relation write is gated on having READ the turn's relations —
          // ticket 06's grant, unchanged by this ticket.
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T2`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          const repair = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            retractExtends: [
              { turn: `S${sessionDbId}/T3`, tailTag: "lane", headTag: "lane" },
            ],
          })) as { content: Array<{ text: string }> };
          expect(repair.content[0]!.text).toContain("Retracted 1 relation(s)");

          const SUCCESSFUL_COMMIT_REPORT =
            "Routed around an E4 refusal by retracting the edge whose endpoint was untagged.";
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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds,
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      // The closure-only endpoint's tags are UNTOUCHED — the repair was the
      // retraction, and the frozen partition never moved.
      expect(getTurnById(db, outside)!.tags).toEqual([]);
      // Acceptance criterion 4 (settlement-commit-report ticket 01): the
      // report the gate-refused call carried is nowhere in the final
      // record — only the successful retry's report survives.
      expect(result.commitMetrics?.report).toBe(
        "Routed around an E4 refusal by retracting the edge whose endpoint was untagged.",
      );
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
        stage: job.stage,
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

  test("a WINDOW turn's E3 (empty type) does not block the terminal commit — the repairability ruling, ticket 17", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      // `seedFixture`'s turn is inserted with no `type` at all, so it carries
      // the column default `[]` — E3's emptiness case, anchored at the turn.
      // It is an ORDINARY window member here: full note-field provenance, and
      // under the pre-ticket-17 filter that was exactly what made it block.
      const { sessionDbId, t1, job } = seedFixture(db);
      const capturedDb = db;

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          // THE TERMINAL TRAP THIS CLOSES. E3 ("type is empty") is a
          // TURN-FIELD defect and stage 2 holds no field pen on ANY
          // provenance, so an E3 that blocked here would be terminal for the
          // run: refuse, refuse, refuse, three attempts, abandoned window,
          // nothing repaired by the abandonment. The earlier reading called
          // the class dormant because stage 1's transition gate refuses to
          // hand over an unfinished type — but the main agent's own public
          // `note` accepts `type: []` and a stage-2 retry resumes at `edges`
          // without re-running stage 1, so it is reachable concurrently. The
          // enforcement stays at stage 1, where the authority is.
          const refusedRepair = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            type: ["design"],
          })) as { content: Array<{ text: string }> };
          expect(refusedRepair.content[0]!.text).toContain("Parameter error");
          expect(refusedRepair.content[0]!.text).toContain("Nothing was written.");
          expect(getTurnById(capturedDb, t1)!.type).toEqual([]);

          // So the commit lands, first call, with the debt still standing.
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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      // The window is settled and the type debt SURVIVES it, untouched — that
      // is the ruling, not a leak: the debt is stage 1's, and the next
      // window's stage-1 lookback is where it is met again.
      expect(getTurnById(db, t1)!.type).toEqual([]);
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
 * OWN independent blocking defect (a DRAFT edge, E6) so each origin
 * contributes a finding that is unambiguously its own, not shared. (The
 * defect used to be an empty type, E3, until ticket 17 took that class out of
 * the blocking set entirely.) `scopeProvenance` is supplied by
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
      const closureTurn = insertTypedTurn(db, sessionDbId, 1);
      const lookbackTurn = insertTypedTurn(db, sessionDbId, 2);
      const windowTurn = insertTypedTurn(db, sessionDbId, 3);
      // TICKET 17 CHANGED THIS FIXTURE'S VEHICLE, not its subject. It used to
      // give each turn an empty `type` (E3); E3 no longer blocks on any
      // provenance, so it can no longer contribute a SECTION LINE to a
      // refusal. E6 (a DRAFT edge, both sides unplaced) is the same shape for
      // this test's purposes — one blocking error anchored at each of the
      // three turns, independent of the other two. Every draft cites the same
      // out-of-set turn T9, whose address is deliberately not one this test
      // asserts absent from any section.
      const citedOutside = insertTypedTurn(db, sessionDbId, 9);
      writeMemoryEdges(
        db,
        [closureTurn, lookbackTurn, windowTurn].map((citing) => ({
          citing: { kind: "turn" as const, id: citing },
          cited: { kind: "turn" as const, id: citedOutside },
          relation: "grounds" as const,
          provenance: "asserted" as const,
          ...deriveSideTags([]),
        })),
        NOW,
      );
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
        stage: job.stage,
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
      // A blocking defect anchored at T1: a DRAFT edge (E6). `seedFixture`'s
      // turn carries an empty `type` too, but ticket 17 took E3 out of the
      // blocking set, so an E3-only fixture would now produce no refusal at
      // all and this test would pass vacuously.
      db.query("UPDATE turns SET type = ? WHERE id = ?").run(JSON.stringify(["design"]), t1);
      const citedOutside = insertTypedTurn(db, sessionDbId, 9);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: t1 },
            cited: { kind: "turn", id: citedOutside },
            relation: "grounds",
            provenance: "asserted",
            ...deriveSideTags([]),
          },
        ],
        NOW,
      );

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
        stage: job.stage,
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
        stage: job.stage,
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
          // ticket 01 was accepted against. Fork-tree spec (ticket 12): T1's
          // own edge renders as an in-branch under its own root address; T2's
          // is its main out-chain.
          expect(text).toContain("└<-extends- T2 {lane}");
          expect(text).toContain("S1/T2 -extends-> T1 {lane}");
          // And the range selector really paged BOTH turns.
          expect(text).toContain("T1 ");
          expect(text).toContain("T2 ");

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
        stage: job.stage,
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
          // RE-REVIEW ROUND, FINDING 1: the gated field moved from `content`
          // to `relations`. Stage 2's face no longer carries a turn's prose,
          // but the GRANT MECHANISM this test exists for is unchanged and
          // still reachable — a relation write is gated on having read the
          // turn's `relations` under this run's own claim identity, through
          // the same `checkFieldGate`/`recordReadGrants` seam.
          //
          // NEGATIVE FIRST: no read of T1 yet, so the gate names the remedy.
          const refused = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            extends: [{ turn: `S${sessionDbId}/T2` }],
          })) as { content: Array<{ text: string }> };
          expect(refused.content[0]!.text).toContain("were not delivered to this run");
          expect(getOutgoingEdges(capturedDb, { kind: "turn", id: t1 })).toHaveLength(0);

          // Step 0's coverage read, through the registered tool.
          await handlers.get("recall")!({
            id: `S${sessionDbId}/T1`,
            filter: { fields: ["metadata", "content", "relations"] },
            turn: 4_000,
          });

          const landed = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            extends: [{ turn: `S${sessionDbId}/T2` }],
          })) as { content: Array<{ text: string }> };
          expect(landed.content[0]!.text).toContain("Landed");

          // T2 was never recalled, and the grant on T1 does not spread to it.
          const stillRefused = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            extends: [{ turn: `S${sessionDbId}/T1` }],
          })) as { content: Array<{ text: string }> };
          expect(stillRefused.content[0]!.text).toContain("were not delivered to this run");
          expect(getOutgoingEdges(capturedDb, { kind: "turn", id: t2 })).toHaveLength(0);

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
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1, t2]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 2,
      });

      // The write landed under THIS run's claim identity — the same string
      // the recall recorded its grant under.
      expect(getOutgoingEdges(db, { kind: "turn", id: t1 })).toHaveLength(1);
      const grant = db
        .query<{ count: number }, [string, number]>(
          "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn' AND entity_id = ?",
        )
        .get(claimWriterId(job.id, job.claimGeneration, job.stage), t1);
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

          // Re-review round, finding 1: the gated field is `relations` now —
          // see the sibling test above for why. `timeline` grants neither.
          const refused = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T1`,
            extends: [{ turn: `S${sessionDbId}/T2` }],
          })) as { content: Array<{ text: string }> };
          expect(refused.content[0]!.text).toContain("were not delivered to this run");

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
        stage: job.stage,
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
        .get(claimWriterId(job.id, job.claimGeneration, job.stage));
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
  test("coverage read, a REFUSED member retag, a tagged extends, and a clean commit", async () => {
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
      // The lane this pass works, DECLARED BEFORE the run — stage 1's act, and
      // this pass has no verb for it (finding 1).
      insertLane(db, segmentId, "writable-set", NOW);
      // RE-REVIEW ROUND, FINDING 1: the members arrive ALREADY TAGGED. Stage 1
      // wrote this membership and the transition froze it; stage 2's `note`
      // face refuses a tags write outright, so seeding it here is not a
      // shortcut — it is the only way the state can arise.
      for (const turnId of [t1, t2]) {
        db.query("UPDATE turns SET tags = ? WHERE id = ?").run(
          JSON.stringify(["lane", "writable-set"]),
          turnId,
        );
      }

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
            .all(claimWriterId(job.id, job.claimGeneration, job.stage))
            .map((row) => row.entityId)
            .sort((a, b) => a - b);
          expect(granted).toEqual([...writableTurnIds].sort((a, b) => a - b));

          // FINAL REVIEW, FINDING 1: this pass mints NOTHING. The lane it
          // works was declared by stage 1 and frozen by the transition (this
          // fixture seeds it directly, which is the same thing one layer
          // down); the membership-mutation verbs are refused at the toolset.
          const minted = (await handlers.get("remember")!({
            action: "create",
            id: `E${segmentId}`,
            tag: "writable-arc",
          })) as { content: Array<{ text: string }> };
          expect(minted.content[0]!.text).toContain("refused on the edge pass");
          expect(minted.content[0]!.text).toContain("Nothing was written.");
          expect(getLane(capturedDb, segmentId, "writable-arc")).toBeNull();

          // Nor may it RE-ASSERT the membership it was handed: a tags write
          // is a membership write whatever value it carries, and the frozen
          // snapshots are this pass's only authority over the partition.
          for (const promptNumber of [1, 2]) {
            const retag = (await handlers.get("note")!({
              turn: `S${sessionDbId}/T${promptNumber}`,
              tags: ["lane", "writable-set"],
            })) as { content: Array<{ text: string }> };
            expect(retag.content[0]!.text).toContain("refused on the edge pass");
            expect(retag.content[0]!.text).toContain("Nothing was written.");
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
        stage: job.stage,
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

  test("a lookback turn's E4 refuses commit though no window range contains that turn, and its E3 is reported without blocking", async () => {
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
          // The E4 anchors at the LOOKBACK turn (prompt 2) — the turn the
          // window's own range excludes by construction — and it is what the
          // projection had to LOAD for the gate to reach at all.
          expect(text).toContain("[E4]");
          expect(text).toContain(`S${sessionDbId}/T2`);
          expect(text).toContain("lookback-lane");
          // The same turn's E3 is inside the writable set and is NOT blocking
          // (ticket 17). It is still ACCOUNTED FOR rather than dropped, and in
          // its own words — the out-of-scope line would be a lie about an
          // error anchored squarely inside the set.
          expect(text).not.toContain("[E3]");
          expect(text).toContain("turn-TYPE debts (E3)");
          expect(text).not.toContain("anchor OUTSIDE your writable set");
          // A refusal is an ordinary in-run rejection: the job row is untouched.
          expect(getNoteSettlementJob(capturedDb, job.id)!.status).toBe("claimed");

          // The E4 is an EDGE defect and retraction clears it. The type write
          // that would clear the E3 is refused by this face (re-review finding
          // 1) and is not needed: the debt is not this gate's to collect.
          const refusedType = (await handlers.get("note")!({
            turn: `S${sessionDbId}/T2`,
            type: ["design"],
          })) as { content: Array<{ text: string }> };
          expect(refusedType.content[0]!.text).toContain("Parameter error");
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
        stage: job.stage,
        sessionId: sessionDbId,
        // window ∪ declared lookback — the frozen set, exactly as the dispatch
        // hands it to the write facade and the gate.
        writableTurnIds: new Set([lookback, windowTurn]),
        contextBuiltAtEpoch: NOW,
        windowStart: 3,
        windowEnd: 3,
      });

      expect(getNoteSettlementJob(db, job.id)!.status).toBe("done");
      // The type debt outlives the window it was never this pass's to pay.
      expect(getTurnById(db, lookback)!.type).toEqual([]);
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
        stage: job.stage,
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
      // The row's OWN stage: the heartbeat is fenced on the full tuple, so a
      // fixture that named a different pass would renew nothing (finding 3).
      stage: job.stage,
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

  // FINAL REVIEW, FINDING 3: the heartbeat's fence is the FULL ownership tuple.
  // The generation deliberately does not move at the stage transition, so a
  // stage-1 child that outlived its own `finalize` still holds a valid
  // generation — fenced on that alone it would keep renewing the lease of the
  // stage-2 run that now owns the row, and the reclaim meant to rescue a hung
  // stage 2 would never come due.
  test("a stale TOPICS child cannot renew an EDGES lease, and the row's own pass still can", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, job } = seedFixture(db);
      const stale = NOW - Math.floor(NOTE_SETTLEMENT_LEASE_MS / 1000) - 60;
      transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW);
      db.run("UPDATE note_settlement_jobs SET claimed_at_epoch = ? WHERE id = ?", [stale, job.id]);

      // Same job, same generation, the pass it has LEFT — renews nothing.
      expect(
        touchNoteSettlementJobLease(db, job.id, job.claimGeneration, NOW, "topics"),
      ).toBe(false);
      expect(getNoteSettlementJob(db, job.id)?.claimedAtEpoch).toBe(stale);
      expect(listDispatchableNoteSettlementSessions(db, { nowMs: NOW * 1000 })).toContain(
        sessionDbId,
      );

      expect(touchNoteSettlementJobLease(db, job.id, job.claimGeneration, NOW, "edges")).toBe(
        true,
      );
      expect(getNoteSettlementJob(db, job.id)?.claimedAtEpoch).toBe(NOW);
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

      expect(touchNoteSettlementJobLease(db, job.id, job.claimGeneration, NOW, "topics")).toBe(
        true,
      );

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
        stage: job.stage,
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
        stage: job.stage,
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

// ---------------------------------------------------------------------------
// STAGED SETTLEMENT ticket 05 — THE PER-PROVENANCE TERMINAL GATE
// (spec Rev 5, §Per-provenance gate filter).
//
// Driven against `evaluateSettlementCommitGate` directly, with a REAL
// transition snapshot underneath it: the subject is which errors the gate
// blocks on given a turn's provenance, and the snapshot is what states that
// provenance. Building the same situation through the registered handlers
// would add a model run and a whole stage-2 dispatch (tickets 06/07) without
// asking one more question of the filter.
// ---------------------------------------------------------------------------

describe("staged settlement — the terminal gate blocks per provenance", () => {
  /**
   * THE MANUFACTURED-E4 PROBE (acceptance 4). Stage 1 removes lane `lane-x`
   * from an in-window CITED endpoint; the edge that named it on its head side
   * now points at a lane its own endpoint has left, and only the CITING turn —
   * which sits outside every window this job rendered — can repair it. The
   * transition's own closure is what puts that citer in the writable set, with
   * `removed-side-citer` provenance and relation-only authority.
   */
  function seedRemovedSideFixture(db: Database): {
    cited: number;
    citer: number;
    job: NoteSettlementJob;
  } {
    const sessionDbId = seedPullSession(db, "settlement-removed-side-citer");
    // The cited endpoint's post-removal state: stage 1 has already written
    // `tags` without `lane-x` by the time the transition runs, which is why
    // the removal travels to the snapshot as a declared fact rather than
    // being read back out of the database.
    const cited = insertTypedTurn(db, sessionDbId, 1, { tags: "[]" });
    // The citer is OUT of the window and out of the lookback — nothing but the
    // closure puts it in reach.
    const citer = insertTypedTurn(db, sessionDbId, 5, { tags: "[]" });
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citer },
          cited: { kind: "turn", id: cited },
          relation: "extends",
          provenance: "asserted",
          ...deriveSideTags(["lane-x"]),
        },
      ],
      NOW,
    );
    const job = claimWindow(db, sessionDbId, 1, 1);
    const transitioned = transitionNoteSettlementJobToEdges(
      db,
      job.id,
      job.claimGeneration,
      NOW,
      {
        snapshots: {
          window: [cited],
          lookback: [],
          closure: [],
          worklist: [],
          removedLanes: [{ turnId: cited, laneTag: "lane-x" }],
        },
      },
    );
    expect(transitioned).not.toBeNull();
    return { cited, citer, job: transitioned! };
  }

  function stage2Scope(db: Database, jobId: number) {
    return {
      writableTurnIds: new Set(readNoteSettlementWritableTurnIds(db, jobId)),
      writableProvenance: readNoteSettlementWritableSnapshot(db, jobId),
    };
  }

  test("the closure files the citer as removed-side-citer and nothing else", () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { cited, citer, job } = seedRemovedSideFixture(db);
      const snapshot = readNoteSettlementWritableSnapshot(db, job.id);
      expect([...(snapshot.get(cited) ?? [])]).toEqual(["window"]);
      expect([...(snapshot.get(citer) ?? [])]).toEqual(["removed-side-citer"]);
    } finally {
      db.close();
    }
  });

  test("the citer's E4 blocks the terminal commit, and an unrelated E3 there does NOT", () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { citer, job } = seedRemovedSideFixture(db);
      // An E3 of the citer's own — an empty type. It is a NOTE FIELD debt,
      // anchored at the turn itself, and a relation-only authority can never
      // discharge it: blocking on it would be a terminal state nothing in this
      // job could clear.
      db.query<unknown, [number]>("UPDATE turns SET type = '[]' WHERE id = ?").run(citer);

      const refusal = evaluateSettlementCommitGate(db, stage2Scope(db, job.id));
      expect(refusal).not.toBeNull();
      expect(refusal!).toContain("[E4]");
      expect(refusal!).not.toContain("[E3]");
      // The non-blocking E3 is ACCOUNTED FOR rather than silently dropped, and
      // in its own words — it anchors INSIDE the writable set, so the
      // out-of-scope line would be a lie about it. Ticket 17 restated those
      // words: the remainder is now every in-set E3, not only the ones on a
      // relations-only turn, so a line naming that provenance would be false
      // about the rest.
      expect(refusal!).toContain("turn-TYPE debts (E3)");
      expect(refusal!).not.toContain("RELATIONS on only");
      expect(refusal!).not.toContain("anchor OUTSIDE your writable set");

      // Stage 2 discharges the debt the only way its authority allows: it
      // retracts the edge. The E3 is still there and the window commits.
      db.query<unknown, [number]>("DELETE FROM memory_edges WHERE citing_id = ?").run(citer);
      expect(evaluateSettlementCommitGate(db, stage2Scope(db, job.id))).toBeNull();
    } finally {
      db.close();
    }
  });

  test("an unrelated E6 on the same relation-only citer DOES block", () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { cited, citer, job } = seedRemovedSideFixture(db);
      db.query<unknown, [number]>("UPDATE turns SET type = '[]' WHERE id = ?").run(citer);
      // Clear the manufactured E4 so E6 is the only relation-grammar defect
      // left, then plant a DRAFT edge: both sides unplaced. It is relation
      // grammar, repairable with exactly the authority the debt granted.
      db.query<unknown, [number]>("DELETE FROM memory_edges WHERE citing_id = ?").run(citer);
      writeMemoryEdges(
        db,
        [
          {
            citing: { kind: "turn", id: citer },
            cited: { kind: "turn", id: cited },
            relation: "grounds",
            provenance: "asserted",
            ...deriveSideTags([]),
          },
        ],
        NOW,
      );

      const refusal = evaluateSettlementCommitGate(db, stage2Scope(db, job.id));
      expect(refusal).not.toBeNull();
      expect(refusal!).toContain("[E6]");
      expect(refusal!).not.toContain("[E3]");
    } finally {
      db.close();
    }
  });

  /**
   * REVIEWER GUARDRAIL 1 (acceptance 3) STILL HOLDS FOR THE RELATION HALF, and
   * ticket 17 removed the half it used to prove with E3. The permission model
   * is still a UNION rather than the mutually-exclusive three-way — that is
   * `settlementWritePermissions`' business, and the snapshot below still
   * reports both classes. What no longer follows from the union is an E3
   * BLOCK: adding `window` provenance grants field authority over the turn,
   * but the stage-2 `note` face refuses `type` regardless of provenance, so
   * the authority the union grants is one this pass cannot exercise, and a
   * gate that blocked on it would be demanding a repair its own toolset
   * forbids.
   */
  test("window + removed-side provenance takes the UNION, and E3 still does not block", () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { citer, job } = seedRemovedSideFixture(db);
      db.query<unknown, [number]>("UPDATE turns SET type = '[]' WHERE id = ?").run(citer);
      expect(evaluateSettlementCommitGate(db, stage2Scope(db, job.id))!).not.toContain("[E3]");

      db.query<unknown, [number, number]>(
        `INSERT INTO note_settlement_writable_turns (job_id, turn_id, provenance)
         VALUES (?, ?, 'window')`,
      ).run(job.id, citer);
      const provenances = readNoteSettlementWritableSnapshot(db, job.id).get(citer)!;
      expect([...provenances].sort()).toEqual(["removed-side-citer", "window"]);

      const refusal = evaluateSettlementCommitGate(db, stage2Scope(db, job.id));
      expect(refusal).not.toBeNull();
      expect(refusal!).toContain("[E4]");
      expect(refusal!).not.toContain("[E3]");
      expect(refusal!).toContain("turn-TYPE debts (E3)");
    } finally {
      db.close();
    }
  });

  test("with no provenance snapshot at all, E4 still blocks and E3 still does not", () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { citer, job } = seedRemovedSideFixture(db);
      db.query<unknown, [number]>("UPDATE turns SET type = '[]' WHERE id = ?").run(citer);
      // An ABSENT snapshot means "full authority on every writable id" — the
      // pre-staging reading, and the correct one for a job that never
      // transitioned. The E3 exemption is not a provenance rule any more, so
      // it survives that reading too.
      const refusal = evaluateSettlementCommitGate(db, {
        writableTurnIds: new Set(readNoteSettlementWritableTurnIds(db, job.id)),
      });
      expect(refusal).not.toBeNull();
      expect(refusal!).toContain("[E4]");
      expect(refusal!).not.toContain("[E3]");
    } finally {
      db.close();
    }
  });

  /**
   * THE CONCURRENCY SHAPE THAT REJECTED THE DORMANCY READING (round-3 peer
   * finding P0-1). The claim it killed: "a window-provenance E3 cannot reach a
   * stage-2 gate, because stage 1's transition gate refuses to hand over an
   * unfinished type." True at the instant of transition, and false one write
   * later — nothing freezes a turn's `type` after it.
   *
   * The sequence, in order:
   *
   *   1. stage 1 finishes a clean window turn (a legal `type`) and the
   *      transition gate passes it — `evaluateStageOneTransitionGate` returns
   *      null, which is what "dormant" was resting on;
   *   2. the job transitions to `edges` with that turn in the WINDOW
   *      provenance;
   *   3. ANOTHER legitimate writer — the main agent's own public `note`, whose
   *      schema accepts `type: []` — empties the turn's type. This is the
   *      whole point of driving it through `noteTool` rather than SQL: the
   *      shape is only a trap if a supported call can produce it;
   *   4. stage 2's terminal gate now sees a window-provenance E3 and, under
   *      the ruling, COMMITS ANYWAY. A retry would resume at `edges` without
   *      re-running stage 1, so a block here is a 1+1 abandonment that repairs
   *      nothing;
   *   5. the debt is not lost. A NEXT job's stage-1 transition gate over the
   *      same turn REFUSES until the type is repaired, and passes once it is —
   *      enforcement where the authority is.
   */
  test("a type emptied through the PUBLIC note path after the transition does not trap stage 2, and stage 1 still collects it", () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const sessionDbId = seedPullSession(db, "settlement-post-transition-type-wound");
      const windowTurn = insertTypedTurn(db, sessionDbId, 1, {
        type: '["design"]',
        tags: '["topic:gate"]',
      });
      const job = claimWindow(db, sessionDbId, 1, 1);

      // (1) Stage 1's own gate is satisfied — the turn has a legal type and a
      // topic word, which is the entire basis of the dormancy claim.
      expect(
        evaluateStageOneTransitionGate(db, {
          writableTurnIds: new Set([windowTurn]),
          windowTurnIds: new Set([windowTurn]),
        }),
      ).toBeNull();

      // (2) …and the transition hands the turn over as a WINDOW member.
      const transitioned = transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
        snapshots: {
          window: [windowTurn],
          lookback: [],
          closure: [],
          worklist: [],
          removedLanes: [],
        },
      });
      expect(transitioned).not.toBeNull();
      const scope = {
        writableTurnIds: new Set(readNoteSettlementWritableTurnIds(db, job.id)),
        writableProvenance: readNoteSettlementWritableSnapshot(db, job.id),
      };
      expect([...(scope.writableProvenance.get(windowTurn) ?? [])]).toEqual(["window"]);
      expect(evaluateSettlementCommitGate(db, scope)).toBeNull();

      // (3) THE CONCURRENT WRITER. Not this pass, not SQL — the main agent's
      // own tool, taking the empty array its public schema documents.
      const emptied = noteTool(
        db,
        {
          turn: `S${sessionDbId}/T1`,
          type: [],
          mode: { type: "write" },
        } as never,
        { now: () => NOW + 1 },
      );
      expect(emptied.content[0]!.text).not.toContain("Parameter error");
      expect(getTurnById(db, windowTurn)!.type).toEqual([]);

      // (4) The gate sees the wound and does not trap the run on it.
      const afterWound = evaluateSettlementCommitGate(db, scope);
      expect(afterWound).toBeNull();

      // (5) The debt is still collectable, by the stage that holds the pen.
      const nextWindowGate = () =>
        evaluateStageOneTransitionGate(db, {
          writableTurnIds: new Set([windowTurn]),
          windowTurnIds: new Set([windowTurn]),
        });
      expect(nextWindowGate()).not.toBeNull();
      // Stage 1 renders the same class in its OWN vocabulary — it is a duty
      // list for the pass that owns the field, not a lane-checker dump.
      expect(nextWindowGate()!).toContain("TYPE (1)");
      expect(nextWindowGate()!).toContain(`S${sessionDbId}/T1`);
      expect(nextWindowGate()!).toContain("set a legal type on this turn");

      db.query<unknown, [string, number]>("UPDATE turns SET type = ? WHERE id = ?").run(
        JSON.stringify(["design"]),
        windowTurn,
      );
      expect(nextWindowGate()).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// STAGED SETTLEMENT TICKET 07 — the stage-2 edge pass
//
// One fixture carries every duty the pass owns, because they are not
// independent: the worklist decides which lanes get in-lane edges, the frozen
// member snapshot decides what the shape numbers count, the removed-side debt
// and the homeless disposition are two different retractions with two
// different authorities, and ONLY the terminal commit publishes any of it.
// Splitting them into five fixtures would prove each in a world where the
// others do not exist.
// ---------------------------------------------------------------------------

/** Above every seeded turn's own epoch, so the whole window is PRE-ERA and the terminal commit's grant is observable. */
const STAGE_TWO_CUTOFF = NOW + 1;

interface StageTwoFixture {
  sessionDbId: number;
  job: NoteSettlementJob;
  taskId: number;
  /** Lane `alpha`'s three window members, in prompt order. */
  alpha: [number, number, number];
  /** Lane `beta`'s single window member. */
  beta: number;
  /** The homeless turn — no task tag, so no lane can ever place a side of its edges. */
  homeless: number;
  /** The removed-side citer: OUTSIDE the window, writable only through the debt closure. */
  citer: number;
}

function seedStageTwoFixture(db: Database): StageTwoFixture {
  // Recorded BEFORE anything reads it: `resolveEraCutoff` memoizes the first
  // non-null answer per Database.
  ensureRecordedEraCutoff(db, STAGE_TWO_CUTOFF);

  const sessionDbId = upsertSession(db, {
    contentSessionId: `settlement-stage-two-session-${Math.random()}`,
    project: "/tmp/project-settlement-stage-two",
    // Both narrative fields start EMPTY: the acceptance is that stage 2 is the
    // pass that writes them, and a pre-filled title would only prove the
    // mode vocabulary works.
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  function insertTurn(
    promptNumber: number,
    tags: readonly string[],
    options: { type?: string; content?: string } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, string, number, string, string, string | null]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch, type, tags, content
         ) VALUES (?, ?, 'active', ?, ?, 3, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        sessionDbId,
        promptNumber,
        `prompt ${promptNumber}`,
        `response ${promptNumber}`,
        NOW - 900 + promptNumber,
        options.type ?? '["design"]',
        JSON.stringify(tags),
        options.content ?? null,
      )!.id;
  }

  const taskId = createSegment(db, {
    title: "stage-2 task",
    tags: ["staged-task"],
    nowEpoch: NOW,
  }).id;

  const a1 = insertTurn(1, ["staged-task", "alpha"]);
  const a2 = insertTurn(2, ["staged-task", "alpha"]);
  const a3 = insertTurn(3, ["staged-task", "alpha"]);
  const beta = insertTurn(4, ["staged-task", "beta"]);
  // The homeless turn's own prose NAMES a1 — which is what makes retracting
  // its last relation restore the bare citation row rather than dropping the
  // pair entirely.
  const homeless = insertTurn(5, [], { content: `follows on from [S${sessionDbId}/T1]` });
  // The removed-side citer: prompt 7 is outside the 1-5 window, and its type is
  // EMPTY on purpose — that E3 is the error the terminal gate must NOT block on.
  const citer = insertTurn(7, [], { type: "[]" });

  addSegmentMembers(db, taskId, [a1, a2, a3, beta], NOW);
  insertLane(db, taskId, "alpha", NOW);
  insertLane(db, taskId, "beta", NOW);

  writeMemoryEdges(
    db,
    [
      // A PRE-EXISTING BARE DRAFT on the (a2, a1) pair — both sides unsettled.
      { citing: { kind: "turn", id: a2 }, cited: { kind: "turn", id: a1 }, relation: "extends", provenance: "asserted", tailTag: "", headTag: "" },
      // THE REMOVED-SIDE DEBT: a head side naming `gamma`, a lane the stage-1
      // projection took off a2.
      { citing: { kind: "turn", id: citer }, cited: { kind: "turn", id: a2 }, relation: "consume", provenance: "asserted", tailTag: "", headTag: "gamma" },
      // TWO HOMELESS DRAFTS: neither side can ever be placed, because their
      // citing turn belongs to no task at all.
      { citing: { kind: "turn", id: homeless }, cited: { kind: "turn", id: a1 }, relation: "grounds", provenance: "asserted", tailTag: "", headTag: "" },
      { citing: { kind: "turn", id: homeless }, cited: { kind: "turn", id: a3 }, relation: "consume", provenance: "asserted", tailTag: "", headTag: "" },
    ],
    NOW,
  );

  const enqueued = enqueueBackfillNoteSettlementJob(
    db,
    sessionDbId,
    1,
    5,
    NOW,
    STAGE_TWO_CUTOFF,
    { allowPreEra: true },
  );
  if (!enqueued.ok) {
    throw new Error(`fixture failed to enqueue the backfill window: ${enqueued.reason}`);
  }
  const claimed = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!claimed) {
    throw new Error("fixture failed to claim the stage-2 job");
  }

  const transitioned = transitionNoteSettlementJobToEdges(
    db,
    claimed.id,
    claimed.claimGeneration,
    NOW,
    {
      stage1Metrics: JSON.stringify({ summary: "two lines found" }),
      snapshots: {
        window: [a1, a2, a3, beta, homeless],
        lookback: [],
        closure: [],
        worklist: [
          { segmentId: taskId, laneTag: "alpha" },
          { segmentId: taskId, laneTag: "beta" },
        ],
        // The projection took `gamma` off a2 — the fact that exists nowhere in
        // the database to be read back, which is why it is supplied.
        removedLanes: [{ turnId: a2, laneTag: "gamma" }],
      },
      homelessGroups: [
        {
          taskScopeId: 0,
          canonicalLabel: "an orphan line",
          memberFingerprint: "stage-two-fp",
          reason: "no attached task covers this subject",
          turnIds: [homeless],
        },
      ],
    },
  );
  if (!transitioned) {
    throw new Error("fixture failed to transition the stage-2 job");
  }

  return {
    sessionDbId,
    job: transitioned,
    taskId,
    alpha: [a1, a2, a3],
    beta,
    homeless,
    citer,
  };
}

function runStageTwo(
  db: Database,
  fixture: StageTwoFixture,
  body: (handlers: Map<string, (args: Record<string, unknown>) => unknown>) => Promise<void>,
  options: { runWriteTransaction?: typeof runWriteTransaction } = {},
): Promise<unknown> {
  const { toolImpl, handlers } = captureToolImpl();
  const queryImpl = mock(() =>
    (async function* () {
      await body(handlers);
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );
  const runQuery = createNoteSettlementSdkQuery({
    db,
    dataRoot: "/tmp/claude-mnemo-settlement-stage-two",
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
    ...(options.runWriteTransaction
      ? { runWriteTransaction: options.runWriteTransaction }
      : {}),
  });
  return runQuery({
    prompt: "settle the edges",
    systemPrompt: "system",
    model: "claude-sonnet-5",
    jobId: fixture.job.id,
    claimGeneration: fixture.job.claimGeneration,
    stage: fixture.job.stage,
    sessionId: fixture.sessionDbId,
    // DELIBERATELY WRONG and deliberately narrow: the request names a set that
    // is missing the debt's citer entirely. The snapshot is what the run must
    // actually work, and the assertions below only pass if it wins.
    writableTurnIds: new Set(fixture.alpha),
    contextBuiltAtEpoch: NOW,
    windowStart: 1,
    windowEnd: 5,
  });
}

async function callText(
  handlers: Map<string, (args: Record<string, unknown>) => unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = (await handlers.get(name)!(args)) as { content: Array<{ text: string }> };
  return result.content[0]!.text;
}

/**
 * FINAL REVIEW, FINDING 9: the commit report's shape numbers describe the
 * state the TERMINAL COMMIT left, and nothing later.
 *
 * They were read after the transaction closed — a plain look at the live edge
 * table, in which any writer that landed in between is already visible. The
 * receipt would then report a graph this job never settled, with nothing in
 * it to say so, and the frozen-vertex discipline the whole snapshot design
 * buys would leak at the last step. The seam below lands the competing edge in
 * exactly that gap: after the terminal transaction commits, before the report
 * is rendered.
 */
/**
 * FINAL REVIEW, FINDING 1 (P0): stage 2 holds NO membership-mutation surface.
 *
 * The partition is stage 1's judgment and the transition froze it; the facade
 * stage 2 was handed could rewrite it wholesale, and `mergeLaneTag` in
 * particular moves every member turn's tags and every edge side of a whole
 * task — past the writable set and past a frozen worklist that then describes
 * nothing. The mechanism is a refusal at the TOOLSET, the same mechanism
 * commit-unreachability is for stage 1: the write layer underneath stays
 * stage-agnostic on purpose.
 */
describe("stage 2's remember tool is justify and nothing else", () => {
  test("merge, create and delete are all refused, and the registry is untouched", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);
      const captured = db;
      const refusals: string[] = [];

      await runStageTwo(db, fixture, async (handlers) => {
        for (const args of [
          { action: "merge", id: `E${fixture.taskId}`, tag: "beta", into: "alpha" },
          { action: "create", id: `E${fixture.taskId}`, tag: "a-fresh-line" },
          { action: "delete", id: `E${fixture.taskId}`, tag: "beta" },
        ]) {
          refusals.push(await callText(handlers, "remember", args));
        }
      });

      for (const refusal of refusals) {
        expect(refusal).toContain("refused on the edge pass");
        expect(refusal).toContain("Nothing was written.");
      }
      // NOTHING MOVED: both lanes still declared, `beta`'s member still its
      // own, `alpha` not swollen by a fold.
      expect(
        listLanesForSegment(captured, fixture.taskId).map((lane) => lane.tag).sort(),
      ).toEqual(["alpha", "beta"]);
      expect(getLane(captured, fixture.taskId, "a-fresh-line")).toBeNull();
      expect(getTurnById(captured, fixture.beta)!.tags).toContain("beta");
    } finally {
      db?.close();
    }
  });

  test("justify is the one action that still reaches the write layer", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);
      let text = "";

      await runStageTwo(db, fixture, async (handlers) => {
        text = await callText(handlers, "remember", {
          action: "justify",
          id: `E${fixture.taskId}`,
          tag: "alpha",
          representative: `S${fixture.sessionDbId}/T1`,
          otherRepresentative: `S${fixture.sessionDbId}/T3`,
          reason: "the two halves share no use-relation",
        });
      });

      // It reaches the write layer and is judged on its own terms — the
      // evidence reads it demands — rather than being turned away at the
      // toolset like the three above.
      expect(text).not.toContain("refused on the edge pass");
    } finally {
      db?.close();
    }
  });
});

describe("the shape numbers are captured inside the terminal transaction", () => {
  test("an in-lane edge written after the commit is absent from the receipt, and present in a fresh read", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);
      const [a1, a2] = fixture.alpha;
      let receipt = "";
      let landed = false;

      await runStageTwo(
        db,
        fixture,
        async (handlers) => {
          // The window's own drafts are retracted so the gate lets the commit
          // through; none of them is an in-lane placed edge, so `alpha` reaches
          // the commit with THREE members and no edges at all.
          await handlers.get("recall")!({
            id: `S${fixture.sessionDbId}/T2`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          await callText(handlers, "note", {
            turn: `S${fixture.sessionDbId}/T2`,
            retractExtends: [`S${fixture.sessionDbId}/T1`],
          });
          await handlers.get("recall")!({
            id: `S${fixture.sessionDbId}/T5`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          await callText(handlers, "note", {
            turn: `S${fixture.sessionDbId}/T5`,
            retractGrounds: [`S${fixture.sessionDbId}/T1`],
            retractConsume: [`S${fixture.sessionDbId}/T3`],
          });
          await handlers.get("recall")!({
            id: `S${fixture.sessionDbId}/T7`,
            filter: { fields: ["relations"] },
            turn: 4_000,
          });
          await callText(handlers, "note", {
            turn: `S${fixture.sessionDbId}/T7`,
            retractConsume: [
              { turn: `S${fixture.sessionDbId}/T2`, tailTag: "", headTag: "gamma" },
            ],
          });
          receipt = await callText(handlers, "commit", { report: "nothing to relate" });
        },
        {
          // THE GAP: the terminal transaction has committed and the report has
          // not been rendered yet.
          runWriteTransaction: (database, fn) => {
            const result = runWriteTransaction(database, fn);
            // Only the TERMINAL one: the earlier retractions each open a
            // transaction of their own, and an edge landing after one of those
            // would be inside the commit's own view and prove nothing. The job
            // reading `done` is exactly "the terminal transaction just closed".
            if (!landed && getNoteSettlementJob(database, fixture.job.id)?.status === "done") {
              landed = true;
              writeMemoryEdges(
                database,
                [
                  {
                    citing: { kind: "turn", id: a2 },
                    cited: { kind: "turn", id: a1 },
                    relation: "extends",
                    provenance: "asserted",
                    tailTag: "alpha",
                    headTag: "alpha",
                  },
                ],
                NOW,
              );
            }
            return result;
          },
        },
      );

      expect(receipt).toContain("Committed");
      // WHAT THE RECEIPT SAYS: three members, no edges, three components — the
      // graph as this commit left it.
      expect(receipt).toContain(`E${fixture.taskId}/#alpha — 3 member(s), 3 weak component(s), 0 in-lane edge(s)`);
      // WHAT IS TRUE NOW: the later writer's edge, visible to a fresh read and
      // to nobody's receipt.
      const fresh = computeSettlementShapeNumbers(db, fixture.job.id);
      expect(fresh.lanes[0]).toMatchObject({
        laneTag: "alpha",
        memberCount: 3,
        edgeCount: 1,
        componentCount: 2,
      });
    } finally {
      db?.close();
    }
  });
});

describe("staged settlement ticket 07 — the stage-2 edge pass, at the real registered handlers", () => {
  test("a seam-driven run writes in-lane and crossing edges, reconciles a draft, discharges a removed-side debt, retracts the homeless drafts and lands the terminal commit", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);
      const { sessionDbId, alpha, taskId } = fixture;
      const [a1, a2, a3] = alpha;

      await runStageTwo(db, fixture, async (handlers) => {
        // ---- The gate, BEFORE any work: E6 blocks, the citer's E3 does not --
        const early = await callText(handlers, "commit", { report: "early" });
        expect(early).toContain("Commit refused");
        expect(early).toContain("[E6]");
        // The citer is in the writable set ONLY through the frozen snapshot —
        // the request never named it — and its E3 is exempt by AUTHORITY.
        // Ticket 17 widened that exemption to every provenance, so the
        // accounting line no longer names one.
        expect(early).toContain("turn-TYPE debts (E3)");
        expect(early).not.toContain("[E3]");

        // `lane_check`'s preview LAGS the gate: the same E3 prints as
        // actionable there (ticket 05's handoff, taught rather than fixed).
        expect(await callText(handlers, "lane_check", {})).toContain("E3");

        // ---- Draft reconciliation: retract the unsettled row, place the row -
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T2`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        const reconciled = await callText(handlers, "note", {
          turn: `S${sessionDbId}/T2`,
          retractExtends: [`S${sessionDbId}/T1`],
          extends: [{ turn: `S${sessionDbId}/T1`, tailTag: "alpha", headTag: "alpha" }],
        });
        expect(reconciled).toContain("Retracted 1 relation(s)");

        // ---- A second in-lane edge ----------------------------------------
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T3`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        await callText(handlers, "note", {
          turn: `S${sessionDbId}/T3`,
          extends: [{ turn: `S${sessionDbId}/T2`, tailTag: "alpha", headTag: "alpha" }],
        });

        // ---- The crossing pass --------------------------------------------
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T4`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        await callText(handlers, "note", {
          turn: `S${sessionDbId}/T4`,
          consume: [{ turn: `S${sessionDbId}/T3`, tailTag: "beta", headTag: "alpha" }],
        });

        // ---- The homeless retractions -------------------------------------
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T5`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        expect(
          await callText(handlers, "note", {
            turn: `S${sessionDbId}/T5`,
            retractGrounds: [`S${sessionDbId}/T1`],
            retractConsume: [`S${sessionDbId}/T3`],
          }),
        ).toContain("Retracted 2 relation(s)");

        // ---- The removed-side debt, on RELATION-ONLY authority --------------
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T7`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        expect(
          await callText(handlers, "note", {
            turn: `S${sessionDbId}/T7`,
            retractConsume: [{ turn: `S${sessionDbId}/T2`, tailTag: "", headTag: "gamma" }],
          }),
        ).toContain("Retracted 1 relation(s)");

        // ---- The session narrative, at THIS pass ---------------------------
        await callText(handlers, "note", {
          session: `S${sessionDbId}`,
          title: "the stage-2 window",
          content: "two lines, one crossing.",
        });

        // ---- The terminal commit -------------------------------------------
        const committed = await callText(handlers, "commit", {
          report: "the gamma debt had no legal re-placement, so it was retracted",
        });
        expect(committed).toContain("Committed");
        // The shape numbers, on the frozen vertices.
        expect(committed).toContain("SHAPE NUMBERS");
        expect(committed).toContain(`E${taskId}/#alpha — 3 member(s), 1 weak component(s)`);
        expect(committed).toContain(`E${taskId}/#beta — 1 member(s), 1 weak component(s)`);
        expect(committed).toContain(`E${taskId}/#alpha <-> E${taskId}/#beta: consume 1`);
        // The homeless retractions, each with its cause.
        expect(committed).toContain("HOMELESS-MOTIVATED RETRACTIONS (2)");
        expect(committed).toContain('"an orphan line"');
        expect(committed).toContain("relation retracted, bare restored");

        // ---- Round-5 P1: the idempotent SECOND commit replays nothing ------
        // The first call's shape/retraction artifacts live in the handler
        // closure; the repeat returns "Already committed" WITHOUT opening a
        // transaction, so captureAtCommit never runs — without the handler's
        // reset, the first call's blocks would re-render here as fresh output.
        const repeated = await callText(handlers, "commit", {
          report: "repeat call after completion",
        });
        expect(repeated).toContain("Already committed");
        expect(repeated).not.toContain("SHAPE NUMBERS");
        expect(repeated).not.toContain("HOMELESS-MOTIVATED RETRACTIONS");
      });

      // ---- What actually landed --------------------------------------------
      const settled = getNoteSettlementJob(db, fixture.job.id)!;
      expect(settled.status).toBe("done");
      expect(settled.stage).toBe("edges");

      // The reconciled pair holds ONE extends row, placed — not the draft
      // beside a duplicate.
      const fromA2 = getOutgoingEdges(db, { kind: "turn", id: a2 }).filter(
        (edge) => edge.relation === "extends",
      );
      expect(fromA2).toHaveLength(1);
      expect(fromA2[0]!.tailTag).toBe("alpha");
      expect(fromA2[0]!.headTag).toBe("alpha");

      // The debt is discharged and the homeless drafts are gone.
      expect(getOutgoingEdges(db, { kind: "turn", id: fixture.citer })).toHaveLength(0);
      const fromHomeless = getOutgoingEdges(db, { kind: "turn", id: fixture.homeless });
      // The bare citation the prose still asserts is BACK; the relation is not.
      expect(fromHomeless).toHaveLength(1);
      expect(fromHomeless[0]!.relation).toBeNull();
      expect(fromHomeless[0]!.cited.id).toBe(a1);

      // The session narrative, written by this pass.
      const session = db
        .query<{ title: string | null }, [number]>("SELECT title FROM sessions WHERE id = ?")
        .get(sessionDbId)!;
      expect(session.title).toBe("the stage-2 window");

      // The era grant — exclusive to this terminal commit, over the window's
      // whole coverage.
      const granted = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM turns WHERE era_granted_at_epoch IS NOT NULL`,
        )
        .get()!;
      expect(granted.count).toBe(5);
      expect(a1).toBeGreaterThan(0);
      expect(a3).toBeGreaterThan(0);
    } finally {
      db?.close();
    }
  });

  test("a homeless-motivated retraction records the deleted row's full composite identity, and the last relation records the bare restore", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);
      const { sessionDbId, alpha, homeless } = fixture;
      const [a1, , a3] = alpha;

      const groupId = resolveActiveHomelessDisposition(db, homeless)!.groupId;

      await runStageTwo(db, fixture, async (handlers) => {
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T5`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        await callText(handlers, "note", {
          turn: `S${sessionDbId}/T5`,
          retractGrounds: [`S${sessionDbId}/T1`],
          retractConsume: [`S${sessionDbId}/T3`],
        });
      });

      const audits = loadHomelessRetractionAuditsForGroup(db, groupId);
      expect(audits).toHaveLength(2);
      const grounds = audits.find((row) => row.relationWord === "grounds")!;
      const consume = audits.find((row) => row.relationWord === "consume")!;

      // FULL composite identity, every field of it.
      expect(grounds.jobId).toBe(fixture.job.id);
      expect(grounds.causeGroupId).toBe(groupId);
      expect(grounds.edgeId).toBeGreaterThan(0);
      expect(grounds.citingKind).toBe("turn");
      expect(grounds.citingId).toBe(homeless);
      expect(grounds.citedKind).toBe("turn");
      expect(grounds.citedId).toBe(a1);
      expect(grounds.tailTag).toBe("");
      expect(grounds.headTag).toBe("");
      expect(grounds.createdAtEpoch).toBe(NOW);

      // The (homeless, a1) pair is the one the prose still names, so its last
      // relation leaving RESTORES the bare row — and the record says so.
      expect(grounds.outcome).toBe("retracted-bare-restored");
      // The (homeless, a3) pair is named nowhere, so nothing came back.
      expect(consume.citedId).toBe(a3);
      expect(consume.outcome).toBe("retracted");
    } finally {
      db?.close();
    }
  });

  test("an ordinary retraction on a turn with no active homeless disposition writes no audit row at all", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);
      const { sessionDbId, homeless } = fixture;
      const groupId = resolveActiveHomelessDisposition(db, homeless)!.groupId;

      await runStageTwo(db, fixture, async (handlers) => {
        await handlers.get("recall")!({
          id: `S${sessionDbId}/T2`,
          filter: { fields: ["relations"] },
          turn: 4_000,
        });
        await callText(handlers, "note", {
          turn: `S${sessionDbId}/T2`,
          retractExtends: [`S${sessionDbId}/T1`],
        });
      });

      expect(loadHomelessRetractionAuditsForGroup(db, groupId)).toHaveLength(0);
    } finally {
      db?.close();
    }
  });

  test("the shape numbers are the induced subgraph on the frozen vertices: an edgeless member is its own component, a later member is invisible, and a retry answers identically", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);
      const { taskId, alpha, beta } = fixture;
      const [a1, a2, a3] = alpha;

      // a1 <- a2 in-lane; a3 is a frozen member no edge touches.
      writeMemoryEdges(
        db,
        [
          { citing: { kind: "turn", id: a2 }, cited: { kind: "turn", id: a1 }, relation: "extends", provenance: "judged", tailTag: "alpha", headTag: "alpha" },
          // Two crossings, two different words — grouped, not summed into one.
          { citing: { kind: "turn", id: beta }, cited: { kind: "turn", id: a1 }, relation: "consume", provenance: "judged", tailTag: "beta", headTag: "alpha" },
          { citing: { kind: "turn", id: beta }, cited: { kind: "turn", id: a3 }, relation: "grounds", provenance: "judged", tailTag: "beta", headTag: "alpha" },
          // NOT induced: a placed row whose sides name the lane but whose
          // endpoints are the same pair under a DIFFERENT word is fine — this
          // one is excluded because its head side is unsettled.
          { citing: { kind: "turn", id: a3 }, cited: { kind: "turn", id: a2 }, relation: "narrows", provenance: "judged", tailTag: "alpha", headTag: "" },
        ],
        NOW + 1,
      );

      const before = computeSettlementShapeNumbers(db, fixture.job.id);
      const alphaShape = before.lanes.find((lane) => lane.laneTag === "alpha")!;
      expect(alphaShape.memberCount).toBe(3);
      expect(alphaShape.edgeCount).toBe(1);
      // {a1,a2} joined, a3 alone — the edgeless member is its OWN component.
      expect(alphaShape.componentCount).toBe(2);
      expect(before.lanes.find((lane) => lane.laneTag === "beta")!.componentCount).toBe(1);

      expect(before.pairs).toHaveLength(1);
      expect(before.pairs[0]!.byRelation).toEqual([
        { relation: "consume", count: 1 },
        { relation: "grounds", count: 1 },
      ]);

      // A CONCURRENTLY ADDED MEMBER: laned, owned by the same task, edged into
      // the lane — and invisible, because the transition froze the vertices.
      const latecomer = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, user_prompt, assistant_response,
             tool_call_count, created_at_epoch, type, tags
           ) VALUES (?, 9, 'active', 'late', 'late', 1, ${NOW}, '["design"]', '["staged-task","alpha"]')
           RETURNING id`,
        )
        .get(fixture.sessionDbId)!.id;
      addSegmentMembers(db, taskId, [latecomer], NOW);
      writeMemoryEdges(
        db,
        [
          { citing: { kind: "turn", id: latecomer }, cited: { kind: "turn", id: a3 }, relation: "extends", provenance: "judged", tailTag: "alpha", headTag: "alpha" },
        ],
        NOW + 2,
      );

      const after = computeSettlementShapeNumbers(db, fixture.job.id);
      expect(after).toEqual(before);
      // And a retry over the identical state answers identically.
      expect(computeSettlementShapeNumbers(db, fixture.job.id)).toEqual(after);
    } finally {
      db?.close();
    }
  });

  test("the frozen scope is what the run works: the snapshot's writable set and provenance buckets win over the request's own", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);

      const scope = readSettlementFrozenScope(db, fixture.job.id)!;
      expect([...scope.writableTurnIds].sort((a, b) => a - b)).toEqual(
        [...fixture.alpha, fixture.beta, fixture.homeless, fixture.citer].sort((a, b) => a - b),
      );
      expect(scope.scopeProvenance.window.has(fixture.alpha[0])).toBe(true);
      // Relation-only, so it files under the closure bucket rather than the
      // window it was never in.
      expect(scope.scopeProvenance.window.has(fixture.citer)).toBe(false);
      expect(scope.scopeProvenance.closureOnly.has(fixture.citer)).toBe(true);
      expect(scope.worklist.map((lane) => lane.laneTag)).toEqual(["alpha", "beta"]);
      expect(scope.debts).toHaveLength(1);
      expect(scope.debts[0]!.removedLaneTag).toBe("gamma");
      expect(scope.debts[0]!.citingTurnId).toBe(fixture.citer);

      // A job that never transitioned has no frozen judgment, and says so.
      const { job } = seedFixture(db);
      expect(readSettlementFrozenScope(db, job.id)).toBeNull();
    } finally {
      db?.close();
    }
  });

  // -------------------------------------------------------------------------
  // TICKET 02 (settlement-execution-repair, "The frozen scope install seam")
  // — the PREFACTOR seam: one exported function owns read-frozen-scope-and-
  // build-edges-context, callable at construction now and later (ticket 03)
  // against a live run, without re-deriving anything the old inline
  // `frozen?.x ?? request.x` fallthrough at construction used to compute.
  // -------------------------------------------------------------------------

  test("installSettlementEdgesScope: install against a seeded job's persisted snapshots matches the old direct-read path (writable set + provenance + worklist, fixture-pinned)", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);

      // THE OLD PATH: what `note-settlement-sdk-query.ts` used to compute
      // inline at request construction, before this ticket — a bare
      // `readSettlementFrozenScope` call, snapshot wins unconditionally once
      // the job has transitioned.
      const oldPath = readSettlementFrozenScope(db, fixture.job.id)!;

      // THE NEW SEAM: the same read, routed through the one exported install
      // function, with a caller-supplied fallback that must lose (the job
      // already transitioned) — proving the fallback path is dead weight here,
      // not a second derivation the snapshot has to out-race.
      const holder = installSettlementEdgesScope(db, fixture.job.id, {
        writableTurnIds: new Set([999999]),
        scopeProvenance: undefined,
      });

      expect([...holder.current.writableTurnIds].sort((a, b) => a - b)).toEqual(
        [...oldPath.writableTurnIds].sort((a, b) => a - b),
      );
      expect(holder.current.writableProvenance).toEqual(oldPath.writableProvenance);
      expect(holder.current.scopeProvenance).toEqual(oldPath.scopeProvenance);
      expect(holder.current.worklist).toEqual(oldPath.worklist);
      expect(holder.current.debts).toEqual(oldPath.debts);
      expect(holder.current.laneMembers).toEqual(oldPath.laneMembers);

      // Cross-check against the fixture's own declared shape, so a future
      // change to `seedStageTwoFixture` that silently narrowed the frozen set
      // fails this test rather than passing on an accidental tautology.
      expect([...holder.current.writableTurnIds].sort((a, b) => a - b)).toEqual(
        [...fixture.alpha, fixture.beta, fixture.homeless, fixture.citer].sort((a, b) => a - b),
      );
      expect(holder.current.worklist.map((lane) => lane.laneTag)).toEqual(["alpha", "beta"]);
    } finally {
      db?.close();
    }
  });

  test("installSettlementEdgesScope: a later install into the SAME holder mutates it in place — the seam ticket 03 hangs its finalize-time swap on", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);

      // FIRST install, at a construction-time-shaped call: no frozen snapshot
      // exists yet, so the fallback (this dispatch's own live-computed
      // writable set) stands — exactly the pre-staging behaviour.
      const pre = seedFixture(db);
      const holder = installSettlementEdgesScope(db, pre.job.id, {
        writableTurnIds: new Set([pre.t1]),
        scopeProvenance: undefined,
      });
      expect([...holder.current.writableTurnIds]).toEqual([pre.t1]);
      expect(holder.current.worklist).toEqual([]);

      // SECOND install, against a DIFFERENT job that DOES carry a frozen
      // snapshot — standing in for ticket 03's "after this run's own
      // finalize just persisted the snapshots" call. Passing the SAME holder
      // must mutate `.current` in place and return the identical reference,
      // so every closure that closed over `holder` (never over its old
      // contents) observes the swap without the write engine being rebuilt.
      const post = seedStageTwoFixture(db);
      const reinstalled = installSettlementEdgesScope(
        db,
        post.job.id,
        { writableTurnIds: new Set(), scopeProvenance: undefined },
        holder,
      );

      expect(reinstalled).toBe(holder);
      expect([...holder.current.writableTurnIds].sort((a, b) => a - b)).toEqual(
        [...post.alpha, post.beta, post.homeless, post.citer].sort((a, b) => a - b),
      );
      expect(holder.current.worklist.map((lane) => lane.laneTag)).toEqual(["alpha", "beta"]);
    } finally {
      db?.close();
    }
  });

  test("the prompt's frozen worklist declares the lanes, their members, the debts and the homeless dispositions", () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const fixture = seedStageTwoFixture(db);

      const rendering = buildSettlementWorklistRendering(db, fixture.job.id)!;
      expect(rendering.lanes.map((lane) => lane.address)).toEqual([
        `E${fixture.taskId}/#alpha`,
        `E${fixture.taskId}/#beta`,
      ]);
      expect(rendering.lanes[0]!.memberAddresses).toEqual([
        `S${fixture.sessionDbId}/T1`,
        `S${fixture.sessionDbId}/T2`,
        `S${fixture.sessionDbId}/T3`,
      ]);
      expect(rendering.debts[0]!.citingAddress).toBe(`S${fixture.sessionDbId}/T7`);
      expect(rendering.debts[0]!.removedLaneTag).toBe("gamma");
      expect(rendering.homeless).toHaveLength(1);
      expect(rendering.homeless[0]!.label).toBe("an orphan line");
      expect(rendering.homeless[0]!.memberAddresses).toEqual([
        `S${fixture.sessionDbId}/T5`,
      ]);
    } finally {
      db?.close();
    }
  });

  test("the commit tool's own description states the E3 exemption and the shape numbers it returns", () => {
    // Ticket 17: the exemption is TOTAL, and the description must say so — a
    // text that scoped it to relations-only turns would send a window-member
    // run chasing a `type` write its own `note` refuses.
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain(
      "NEVER blocks this commit, on any turn in your set — not a removed-side citer's, not a window member's",
    );
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).not.toContain(
      "an E3 anchored on a turn you may write RELATIONS on only",
    );
    // The blocking enumeration itself must have dropped E3, not merely gained
    // a sentence contradicting it.
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).not.toContain(
      "an empty or out-of-vocabulary turn type (E3), a tagged edge",
    );
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("this gate is the truth");
    expect(SETTLEMENT_COMMIT_TOOL_DESCRIPTION).toContain("SHAPE NUMBERS");
  });
});

// ---------------------------------------------------------------------------
// TICKET 19, finding 1 — THE TERMINAL GATES RUN INSIDE THE TERMINAL
// TRANSACTION.
//
// The gates used to be evaluated by the `commit` HANDLER, before it called
// `writes.commit()` — i.e. before the engine ever opened `BEGIN IMMEDIATE`,
// and nothing re-ran them under the lock. Any writer landing in that window
// (a public `note` minting a draft edge, a tag write severing a lane) was
// invisible to the verdict and the commit marked the job `done` over it.
//
// MUTATION NOTE. Move the evaluation back out — drop `evaluateTerminalGates`
// from the engine's options and re-run the same two gates at the top of the
// `commit` handler — and the test below goes RED with "Committed": the
// preflight is genuinely clean, so an evaluation that happens before the lock
// cannot see the row the seam mints inside it. Every other gate-refusal test
// in this file stays green under that mutation, which is what makes this one
// the pin on WHERE the gates run rather than on WHAT they refuse.
// ---------------------------------------------------------------------------

describe("ticket 19 — a write that lands between a clean preflight and the lock still refuses the commit", () => {
  test("a draft edge minted inside the terminal transaction refuses that same commit, and the run can still finish", async () => {
    let db: Database | undefined;
    try {
      db = createDatabase(":memory:");
      initializeSchema(db);
      seedTagContainers(db);
      const sessionDbId = seedPullSession(db, "settlement-terminal-gate-toctou");
      const t1 = insertTypedTurn(db, sessionDbId, 1);
      const t2 = insertTypedTurn(db, sessionDbId, 2);
      const job = claimWindow(db, sessionDbId, 1, 2);
      const capturedDb = db;
      const writableTurnIds = new Set([t1, t2]);

      // THE PREFLIGHT IS CLEAN. Both turns are typed, nothing is tagged, and
      // there is no edge at all — so the refusal below cannot be a property of
      // the fixture, and an evaluation made at any point before the lock would
      // return exactly this.
      expect(evaluateSettlementCommitGate(db, { writableTurnIds })).toBeNull();
      expect(getOutgoingEdges(db, { kind: "turn", id: t2 })).toHaveLength(0);

      // THE COMPETING WRITER. It runs inside the engine's own transaction, on
      // the engine's own handle — the seam the engine documents as the only
      // way to interleave a write with a lock it holds. Placed before `fn()`,
      // it lands strictly after anything the outer layer could have evaluated
      // and strictly before the completion CAS: exactly the window the old
      // shape left open.
      let mintOnNextTransaction = false;
      const interleaved: typeof runWriteTransaction = (database, fn) =>
        runWriteTransaction(database, () => {
          if (mintOnNextTransaction) {
            mintOnNextTransaction = false;
            writeMemoryEdges(
              database,
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
          }
          return fn();
        });

      const { toolImpl, handlers } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          const claimed = getNoteSettlementJob(capturedDb, job.id)!;
          expect(claimed.status).toBe("claimed");

          mintOnNextTransaction = true;
          const refused = (await handlers.get("commit")!({
            report: "raced by a draft edge",
          })) as { content: Array<{ text: string }> };
          const text = refused.content[0]!.text;
          // The gate SAW the row that was not there when the run began.
          expect(text).toContain("Commit refused");
          expect(text).toContain("[E6]");
          expect(text).toContain(`S${sessionDbId}/T2`);
          expect(text).toContain("DRAFT edge, neither side names a lane");
          // The refusal is an ordinary in-run rejection: the transaction rolled
          // back whole, so the job row never moved.
          const afterRefusal = getNoteSettlementJob(capturedDb, job.id)!;
          expect(afterRefusal.status).toBe("claimed");
          expect(afterRefusal.attempts).toBe(claimed.attempts);
          expect(afterRefusal.claimGeneration).toBe(claimed.claimGeneration);

          // And the run may still finish. The rollback took the seam's own
          // injected row with it — an artifact of a single-connection
          // interleave, not of the gate — so the second call meets the clean
          // window the first one was promised and lands.
          const committed = (await handlers.get("commit")!({
            report: "no friction this window",
          })) as { content: Array<{ text: string }> };
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
        runWriteTransaction: interleaved,
      });

      await runQuery({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds,
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
});

// ---------------------------------------------------------------------------
// The response-origin coordinator's host-loop half (settlement-execution-
// repair ticket 01). The pure registry logic is unit-tested on its own in
// note-settlement-response-origin.test.ts; what belongs HERE is that this
// host loop actually drives it — feeds every observed assistant message,
// closes the last response when the stream drains, and aborts it when the
// query does. Ticket 01 arms no refusal on any of this (the registry is
// inert), so `originRegistry` is a TEST-ONLY override (see that option's own
// doc comment) — production always builds its own, fresh per dispatch.
// ---------------------------------------------------------------------------

function spyOriginRegistry(): ResponseOriginRegistry & {
  observeCalls: Array<{ messageId: string; toolUseIds: string[] }>;
  closeResponseCalls: number;
  abortCalls: number;
  disposeCalls: number;
} {
  const spy = {
    observeCalls: [] as Array<{ messageId: string; toolUseIds: string[] }>,
    closeResponseCalls: 0,
    abortCalls: 0,
    disposeCalls: 0,
    observeAssistantMessage(messageId: string, blocks: readonly { type: string; toolUseId?: string }[]) {
      spy.observeCalls.push({
        messageId,
        toolUseIds: blocks
          .map((block) => block.toolUseId)
          .filter((id): id is string => typeof id === "string"),
      });
    },
    closeResponse() {
      spy.closeResponseCalls += 1;
    },
    abort() {
      spy.abortCalls += 1;
    },
    dispose() {
      spy.disposeCalls += 1;
    },
    resolveOrigin: async () => "unknown" as const,
    pendingWaiterCount: () => 0,
  };
  return spy;
}

function assistantMessage(messageId: string, toolUseIds: string[]) {
  return {
    type: "assistant",
    message: {
      id: messageId,
      content: [
        { type: "text", text: "thinking" },
        ...toolUseIds.map((id) => ({ type: "tool_use", id, name: "note", input: {} })),
      ],
    },
  };
}

describe("the host loop feeds the response-origin coordinator (ticket 01)", () => {
  test("every assistant message observed is forwarded, and the last response is closed once the stream drains", async () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, t1, job } = seedFixture(db);
      const { toolImpl } = captureToolImpl();
      const registry = spyOriginRegistry();
      const queryImpl = mock(() =>
        (async function* () {
          yield assistantMessage("msg_1", ["tu_1"]);
          yield assistantMessage("msg_2", ["tu_2", "tu_3"]);
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const runQuery = createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-origin-observe",
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
        originRegistry: registry,
      });

      await runQuery({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      expect(registry.observeCalls).toEqual([
        { messageId: "msg_1", toolUseIds: ["tu_1"] },
        { messageId: "msg_2", toolUseIds: ["tu_2", "tu_3"] },
      ]);
      // Closed once the stream fully drained, and disposed in `finally` —
      // both run exactly once on the happy path.
      expect(registry.closeResponseCalls).toBe(1);
      expect(registry.disposeCalls).toBe(1);
      expect(registry.abortCalls).toBe(0);
    } finally {
      db?.close();
    }
  });

  test("a query abort reaches the registry too, not just the SDK's own AbortController", async () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, t1, job } = seedFixture(db);
      const { toolImpl } = captureToolImpl();
      const registry = spyOriginRegistry();
      const controller = new AbortController();
      const queryImpl = mock(() =>
        (async function* () {
          yield assistantMessage("msg_1", ["tu_1"]);
          controller.abort(new Error("caller gave up"));
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const runQuery = createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-origin-abort",
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
        originRegistry: registry,
      });

      await runQuery({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
        signal: controller.signal,
      });

      expect(registry.abortCalls).toBe(1);
    } finally {
      db?.close();
    }
  });

  // A regression pin: the registry's abort listener MUST be attached to
  // `abortController.signal` before `forwardAbort` can ever fire it. An
  // `AbortSignal` only notifies listeners registered before `.abort()` runs
  // — a signal that is ALREADY aborted when this closure starts fires
  // `forwardAbort()` synchronously, and a listener wired even one statement
  // too late would silently never see it.
  test("a signal that is ALREADY aborted before the run starts still reaches the registry", async () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, t1, job } = seedFixture(db);
      const { toolImpl } = captureToolImpl();
      const registry = spyOriginRegistry();
      const controller = new AbortController();
      controller.abort(new Error("gave up before the run ever started"));
      const queryImpl = mock(() =>
        (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const runQuery = createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-origin-pre-abort",
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
        originRegistry: registry,
      });

      await runQuery({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
        signal: controller.signal,
      });

      expect(registry.abortCalls).toBe(1);
    } finally {
      db?.close();
    }
  });

  test("a real assistant message in the stream does not disturb the happy path (default, un-overridden registry)", async () => {
    const db = createDatabase(":memory:");
    try {
      initializeSchema(db);
      seedTagContainers(db);
      const { sessionDbId, t1, job } = seedFixture(db);
      const { toolImpl } = captureToolImpl();
      const queryImpl = mock(() =>
        (async function* () {
          yield assistantMessage("msg_1", ["tu_1"]);
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        })(),
      );

      const result = await createNoteSettlementSdkQuery({
        db,
        dataRoot: "/tmp/claude-mnemo-settlement-origin-default",
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
        toolImpl: toolImpl as never,
        now: () => NOW,
      })({
        prompt: "settle",
        systemPrompt: "system",
        model: "claude-sonnet-5",
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        stage: job.stage,
        sessionId: sessionDbId,
        writableTurnIds: new Set([t1]),
        contextBuiltAtEpoch: NOW,
        windowStart: 1,
        windowEnd: 1,
      });

      expect(result.text).toBe("done");
    } finally {
      db?.close();
    }
  });

  test("the leased-tool wrapper threads `extra` through to the handler (structural pin)", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/worker/note-settlement-sdk-query.ts"),
      "utf8",
    );
    expect(source).toContain(
      "handler: (args: Record<string, unknown>, extra: unknown) => unknown,",
    );
    expect(source).toContain("return handler(args, extra);");
  });
});
