import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  listOpenImpressionDebts,
  readLaneImpression,
} from "../../src/db/impressions";
import { insertLane } from "../../src/db/lanes";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  transitionNoteSettlementJobToEdges,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb } from "../../src/db/search";
import {
  addSegmentMembers,
  attachSegmentToSession,
  createSegment,
  readSegmentTaskImpression,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";
import { rememberTool } from "../../src/mcp/remember";
import { renderSegmentCard } from "../../src/mcp/segment-card";
import { createSettlementDirectWriteEngine } from "../../src/worker/note-settlement-direct-write";
import {
  createAttachedImpressionDebtClaimer,
  createSettlementImpressionMaintainer,
  ImpressionSettlementRefused,
} from "../../src/worker/note-settlement-impressions";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * THE CROSS-SURFACE INTEGRATION CORPUS (lane-impressions spec Rev 8; ticket 06's
 * acceptance criterion of the same name).
 *
 * Every other suite in this batch proves ONE mechanism against ONE seam. This
 * one seeds a single story and walks it end to end through all of them, in the
 * order a real deployment reaches them:
 *
 *   settlement writes  →  the lane route renders  →  the card renders
 *     →  a manual merge leaves a lifecycle debt and marks the survivor STALE
 *     →  the STALE survivor still renders (its two impressions, concatenated)
 *     →  the next attached run may not RETAIN it, rewrites it, and the flag
 *        and the debt clear together.
 *
 * The value is in the JOINS, which no single-mechanism suite can see: that the
 * bytes settlement stored are the bytes the reader gets, that the merge moves
 * the CAS coordinate the next run must carry, that the flag's forcing job and
 * the debt's ack are cleared by the SAME commit. Written as ONE test on purpose
 * — split into six, each would re-seed its own state and the joins would go
 * back to being untested.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

interface Story {
  sessionDbId: number;
  segmentId: number;
  turnIds: number[];
  job: NoteSettlementJob;
}

function seedTurn(sessionDbId: number, promptNumber: number, tags: string[]): number {
  const id = db
    .query<
      { id: number },
      [number, number, string, string, string, string, number]
    >(
      `INSERT INTO turns (
         session_id, prompt_number, status, title, tags, user_prompt,
         assistant_response, tool_call_count, created_at_epoch, files_read, files_modified
       ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, 1, ?, '[]', '[]')
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `turn ${promptNumber} title`,
      JSON.stringify(tags),
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      SETTLEMENT_ERA_CUTOFF_EPOCH + promptNumber,
    )!.id;
  reindexTurnFromDb(db, id);
  return id;
}

/**
 * One task, two declared lanes, three member turns, and a settlement job already
 * transitioned to the edge pass — the frozen worklist and per-lane member
 * snapshots the caps read exist exactly as they do for a real run at `commit`.
 * The session is ATTACHED, which is what makes its runs eligible to claim this
 * task's debts later in the story.
 */
function seedStory(): Story {
  const sessionDbId = upsertSession(db, {
    contentSessionId: "cross-surface-story",
    project: "/tmp/project-cross-surface",
    title: "cross-surface story",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const segmentId = createSegment(db, {
    title: "the elevation work",
    content: null,
    insight: null,
    type: [],
    tags: ["elevation-work"],
    nowEpoch: NOW - 5_000,
  }).id;
  attachSegmentToSession(db, sessionDbId, segmentId, NOW);

  const lanes = ["heightfield", "hillshade"];
  for (const tag of lanes) {
    insertLane(db, segmentId, tag, NOW - 4_000);
  }
  const turnIds = [
    seedTurn(sessionDbId, 1, ["elevation-work", "heightfield"]),
    seedTurn(sessionDbId, 2, ["elevation-work", "heightfield"]),
    seedTurn(sessionDbId, 3, ["elevation-work", "hillshade"]),
  ];
  addSegmentMembers(db, segmentId, turnIds, NOW);

  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 3, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const claimed = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000)!;
  transitionNoteSettlementJobToEdges(db, claimed.id, claimed.claimGeneration, NOW, {
    snapshots: {
      window: turnIds,
      lookback: [],
      closure: [],
      worklist: lanes.map((tag) => ({ segmentId, laneTag: tag })),
    },
  });
  return { sessionDbId, segmentId, turnIds, job: getNoteSettlementJob(db, claimed.id)! };
}

/**
 * A SECOND run over the same task — the "next attached settlement run" the story
 * needs after the merge. A fresh window, a fresh job, and the survivor lane in
 * its worklist.
 */
function seedFollowUpRun(story: Story, worklistTags: string[]): NoteSettlementJob {
  const turnId = seedTurn(story.sessionDbId, 4, ["elevation-work", ...worklistTags]);
  addSegmentMembers(db, story.segmentId, [turnId], NOW);
  story.turnIds.push(turnId);
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: story.sessionDbId, windowStart: 4, windowEnd: 4, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const claimed = claimNextNoteSettlementJob(db, story.sessionDbId, NOW, NOW * 1000)!;
  transitionNoteSettlementJobToEdges(db, claimed.id, claimed.claimGeneration, NOW, {
    snapshots: {
      window: [turnId],
      lookback: [],
      closure: [],
      worklist: worklistTags.map((tag) => ({ segmentId: story.segmentId, laneTag: tag })),
    },
  });
  return getNoteSettlementJob(db, claimed.id)!;
}

/**
 * The shipped commit path, with the shipped impression maintainer behind it —
 * and, since lane-impressions ticket 10, the maintainer's WRITE seam too: the
 * decisions are recorded through `decide` (what `remember` calls) and the
 * commit only checks and promotes them.
 */
function engineFor(
  story: Story,
  job: NoteSettlementJob,
): {
  engine: ReturnType<typeof createSettlementDirectWriteEngine>;
  decide: (entries: ReadonlyArray<Record<string, unknown>>) => string;
} {
  const maintainer = createSettlementImpressionMaintainer({
    db,
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    readStage: () => "edges",
    readWritableTurnIds: () => new Set(story.turnIds),
    claimImpressionDebts: createAttachedImpressionDebtClaimer({
      jobId: job.id,
      sessionId: story.sessionDbId,
      now: () => NOW,
    }),
    now: () => NOW,
  });
  const context: SettlementTurnFacadeContext = {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    stage: "edges",
    sessionId: story.sessionDbId,
    reviewableTurnIds: new Set(story.turnIds),
    contextBuiltAtEpoch: NOW,
  };
  const engine = createSettlementDirectWriteEngine({
    db,
    context,
    now: () => NOW,
    settleImpressions: (database) => {
      try {
        maintainer.settle(database);
        return { ok: true as const };
      } catch (error) {
        if (error instanceof ImpressionSettlementRefused) {
          return { ok: false as const, refusal: error.message };
        }
        throw error;
      }
    },
  });
  return {
    engine,
    decide: (entries) => {
      for (const entry of entries) {
        const result = maintainer.decide(db, { action: "impression", ...entry });
        if (!result.ok) {
          return result.text;
        }
      }
      return "";
    },
  };
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

test("one impression's whole life: settlement writes it, both surfaces render it, a merge fuses and forces it, and the next run's rewrite clears the flag and the debt together", () => {
  const story = seedStory();
  const heightfield = `E${story.segmentId}/#heightfield`;
  const hillshade = `E${story.segmentId}/#hillshade`;
  const taskId = `E${story.segmentId}`;

  const heightfieldText =
    `The heightfield lane: the packed elevation block is decoded and its lattice ` +
    `alignment measured, not assumed (S${story.sessionDbId}/T1, T2).\n` +
    `Binding: alignment comes from the cross-correlation peak, never from a guessed offset (S${story.sessionDbId}/T2).`;
  const hillshadeText =
    `The hillshade lane: a shaded render exists as an offline preview only, with no ` +
    `client integration (S${story.sessionDbId}/T3).`;
  const taskText =
    `The elevation task: two lanes, one decoded source and one unintegrated render ` +
    `(S${story.sessionDbId}/T1, T3).`;

  // ---- 1. SETTLEMENT WRITES. The shipped commit path, one transaction. -----
  const firstRun = engineFor(story, story.job);
  expect(
    firstRun.decide([
      { id: heightfield, baseRevision: 0, decision: "replace", text: heightfieldText },
      { id: hillshade, baseRevision: 0, decision: "replace", text: hillshadeText },
      { id: taskId, baseRevision: 0, decision: "replace", text: taskText },
    ]),
  ).toBe("");
  // Nothing is written until the commit promotes the decisions.
  expect(readLaneImpression(db, story.segmentId, "heightfield")!.text).toBeNull();
  const first = firstRun.engine.commit("no friction");
  expect(textOf(first)).toContain("Committed");
  expect(readLaneImpression(db, story.segmentId, "heightfield")!.text).toBe(heightfieldText);
  expect(readSegmentTaskImpression(db, story.segmentId)!.text).toBe(taskText);

  // ---- 2. THE LANE ROUTE RENDERS IT, byte-verbatim, at the head of page 1. --
  const lanePage = recallMemory(db, { id: heightfield });
  expect(lanePage.startsWith(`${heightfieldText}\n\n`)).toBe(true);
  // Its own lane, never the task's other one.
  expect(lanePage).not.toContain("The hillshade lane:");

  // ---- 3. THE CARD RENDERS THE TASK TIER in its content slot. --------------
  const card = renderSegmentCard(db, story.segmentId, {});
  expect(card).toContain("- impression:");
  expect(card).toContain("The elevation task:");
  // The card is the TASK tier's surface; a lane's own text does not leak into it.
  expect(card).not.toContain("The heightfield lane:");

  // ---- 4. A MANUAL MERGE: one debt, one STALE flag, one concatenation. -----
  const beforeMerge = readLaneImpression(db, story.segmentId, "heightfield")!;
  expect(
    textOf(rememberTool(db, { verb: "merge", id: taskId, tag: "hillshade", into: "heightfield" })),
  ).toBeTruthy();

  const fused = readLaneImpression(db, story.segmentId, "heightfield")!;
  expect(fused.stale).toBe(true);
  // The fold CONCATENATES: survivor first, one newline, both sides' bytes intact.
  expect(fused.text).toBe(`${heightfieldText}\n${hillshadeText}`);
  // The merge MOVED the CAS coordinate — a run holding the pre-merge revision
  // can no longer land against it.
  expect(fused.revision).toBeGreaterThan(beforeMerge.revision);
  const debts = listOpenImpressionDebts(db, story.segmentId);
  expect(debts.some((debt) => debt.laneTag === "heightfield")).toBe(true);

  // ---- 5. STALE STILL RENDERS (ticket 07 retired the suppression). ---------
  const stalePage = recallMemory(db, { id: heightfield });
  expect(stalePage.startsWith(`${fused.text}\n\n`)).toBe(true);
  expect(stalePage).toContain("The hillshade lane:");
  expect(stalePage).not.toContain("pending synthesis");

  // ---- 6. THE NEXT ATTACHED RUN MAY NOT RETAIN IT. ------------------------
  const followUp = seedFollowUpRun(story, ["heightfield"]);
  const followUpRun = engineFor(story, followUp);
  // The retain is refused at the WRITE now — the failure is local, and the run
  // never carries it as far as its own commit.
  const refusedWrite = followUpRun.decide([
    { id: heightfield, baseRevision: fused.revision, decision: "retain" },
  ]);
  expect(refusedWrite).toContain("Impression refused");
  expect(refusedWrite).toContain("STALE");
  // …and the duty is still owed, so the commit refuses too, naming it.
  expect(
    followUpRun.decide([
      { id: taskId, baseRevision: readSegmentTaskImpression(db, story.segmentId)!.revision, decision: "retain" },
    ]),
  ).toBe("");
  const refused = followUpRun.engine.commit("no friction");
  expect(textOf(refused)).toContain("Commit refused");
  expect(textOf(refused)).toContain(`no decision recorded for: ${heightfield}`);
  expect(readLaneImpression(db, story.segmentId, "heightfield")!.stale).toBe(true);
  expect(listOpenImpressionDebts(db, story.segmentId).length).toBeGreaterThan(0);

  // ---- 7. THE REWRITE CLEARS THE FLAG AND THE DEBT IN ONE COMMIT. ---------
  const rewritten =
    `The elevation lane: one decoded source and its offline render now read as one ` +
    `line, with client integration still open (S${story.sessionDbId}/T1, T3).`;
  const clearingRun = engineFor(story, followUp);
  expect(
    clearingRun.decide([
      { id: heightfield, baseRevision: fused.revision, decision: "replace", text: rewritten },
      { id: taskId, baseRevision: readSegmentTaskImpression(db, story.segmentId)!.revision, decision: "retain" },
    ]),
  ).toBe("");
  // STALE clears with the COMMIT, never with the write that proposed it.
  expect(readLaneImpression(db, story.segmentId, "heightfield")!.stale).toBe(true);
  const cleared = clearingRun.engine.commit("no friction");
  expect(textOf(cleared)).toContain("Committed");

  const after = readLaneImpression(db, story.segmentId, "heightfield")!;
  expect(after.text).toBe(rewritten);
  expect(after.stale).toBe(false);
  expect(listOpenImpressionDebts(db, story.segmentId)).toEqual([]);

  // ---- 8. AND THE READER SEES THE REWRITE, not the join it replaced. ------
  const finalPage = recallMemory(db, { id: heightfield });
  expect(finalPage.startsWith(`${rewritten}\n\n`)).toBe(true);
  expect(finalPage).not.toContain("The hillshade lane:");
});
