import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { insertLane, listLanesForSegment } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  readNoteSettlementLaneMemberSnapshot,
  readNoteSettlementWorklistSnapshot,
  readNoteSettlementWritableSnapshot,
  laneSnapshotKey,
} from "../../src/db/note-settlement-snapshots";
import {
  loadHomelessGroup,
  loadHomelessGroupMembers,
  resolveActiveHomelessDisposition,
} from "../../src/db/homeless-record";
import { getShadowNote } from "../../src/db/shadow-notes";
import { getTurnById } from "../../src/db/turns";
import { checkTopicTag } from "../../src/shared/topic-tag";
import {
  checkStageOneLaneTag,
  createNoteSettlementStageOneDispatch,
  createNoteSettlementStageOneSdkQuery,
  evaluateStageOneTransitionGate,
  NOTE_SETTLEMENT_STAGE_ONE_ALLOWED_TOOLS,
} from "../../src/worker/note-settlement-stage1";
import { createTransitionOnlyStageOneDispatch } from "../../src/worker/note-settlement";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * STAGE 1 — THE TOPIC PASS (staged-settlement spec Rev 5, ticket 06), driven at
 * the tool-registration seam: every assertion below is about what the run
 * WROTE or REFUSED, never about prompt wording.
 *
 * The fixture is deliberately the diseased shape the redesign was written
 * about. `mapc-terrain-research` is a DECLARED, phase-sliced legacy lane
 * sitting on two of the window's turns — the vocabulary decoy. Nothing in the
 * machinery makes the pass reuse it; the test's decoy probe is that a run which
 * judges those turns to be about tile caching can name a fresh lane and have
 * the projection REMOVE the legacy word, with the removal reaching the
 * transition's own debt list rather than being lost.
 */

const NOW = 1_800_000_000;

interface Fixture {
  db: Database;
  sessionDbId: number;
  segmentId: number;
  job: NoteSettlementJob;
  /** T1..T4 are the window; T5 is an out-of-window citer of T2. */
  t1: number;
  t2: number;
  t3: number;
  t4: number;
  t5: number;
}

function insertTurn(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
  options: { type?: string[]; tags?: string[]; titled?: boolean } = {},
): number {
  const id = db
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
      JSON.stringify(options.type ?? ["design"]),
      JSON.stringify(options.tags ?? []),
    )!.id;
  if (options.titled !== false) {
    db.query<unknown, [string, string, number]>(
      "UPDATE turns SET title = ?, content = ? WHERE id = ?",
    ).run(`turn ${promptNumber} title`, `turn ${promptNumber} body`, id);
  }
  return id;
}

function seed(): Fixture {
  const db = createDatabase(":memory:");
  initializeSchema(db);
  const sessionDbId = upsertSession(db, {
    contentSessionId: "stage-one-session",
    project: "/tmp/project-stage-one",
    title: "stage one fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;

  const segmentId = createSegment(db, {
    title: "map extraction",
    tags: ["mapc"],
    nowEpoch: NOW,
  }).id;

  // T1 already sits in a legitimate, subject-named lane. T2/T3 carry the
  // PHASE-SLICED legacy lane — the decoy. T3 additionally has no type and no
  // note at all: the turn-scope duty this pass owes. T4 belongs to no task.
  const t1 = insertTurn(db, sessionDbId, 1, { tags: ["mapc", "terrain-model"] });
  const t2 = insertTurn(db, sessionDbId, 2, { tags: ["mapc", "mapc-terrain-research"] });
  const t3 = insertTurn(db, sessionDbId, 3, {
    tags: ["mapc", "mapc-terrain-research"],
    type: [],
    titled: false,
  });
  const t4 = insertTurn(db, sessionDbId, 4, { tags: [] });
  const t5 = insertTurn(db, sessionDbId, 5, { tags: ["mapc", "mapc-terrain-research"] });

  addSegmentMembers(db, segmentId, [t1, t2, t3, t5], NOW);
  insertLane(db, segmentId, "terrain-model", NOW);
  insertLane(db, segmentId, "mapc-terrain-research", NOW);

  writeMemoryEdges(
    db,
    [
      // A PRE-EXISTING BARE DRAFT inside the window — neither side placed.
      // Stage 1's gate must not block on it (acceptance 5).
      {
        citing: { kind: "turn", id: t2 },
        cited: { kind: "turn", id: t1 },
        relation: "extends",
        provenance: "asserted",
        ...deriveSideTags([]),
      },
      // An out-of-window citer whose HEAD side names the legacy lane on T2.
      // Removing that word from T2 is what creates a removed-side debt.
      {
        citing: { kind: "turn", id: t5 },
        cited: { kind: "turn", id: t2 },
        relation: "grounds",
        provenance: "asserted",
        ...deriveSideTags(["mapc-terrain-research"]),
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
  return { db, sessionDbId, segmentId, job, t1, t2, t3, t4, t5 };
}

/** Capture every registered tool's name/description/shape/handler — the sdk-query suite's own pattern. */
function captureToolImpl() {
  const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const descriptions = new Map<string, string>();
  const toolImpl = mock(
    (
      name: string,
      description: string,
      _shape: unknown,
      handler: (args: Record<string, unknown>) => unknown,
    ) => {
      handlers.set(name, handler);
      descriptions.set(name, description);
      return { name };
    },
  );
  return { toolImpl, handlers, descriptions };
}

function resultText(result: unknown): string {
  return (
    (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""
  );
}

/**
 * Run one stage-1 request through the real registration seam and hand back its
 * live tool handlers. The model itself does nothing — the caller scripts the
 * tool calls, which is what makes every assertion below one about the tools'
 * own effects.
 */
async function openStageOneRun(fixture: Fixture) {
  const { toolImpl, handlers, descriptions } = captureToolImpl();
  const queryImpl = mock(() =>
    (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })(),
  );
  const runQuery = createNoteSettlementStageOneSdkQuery({
    db: fixture.db,
    dataRoot: "/tmp/claude-mnemo-stage-one",
    queryImpl: queryImpl as never,
    createSdkMcpServerImpl: ((definition: unknown) => definition) as never,
    toolImpl: toolImpl as never,
    now: () => NOW,
  });

  const writableTurnIds = new Set([fixture.t1, fixture.t2, fixture.t3, fixture.t4]);
  await runQuery({
    prompt: "topic pass",
    systemPrompt: "system",
    model: "claude-sonnet-5",
    jobId: fixture.job.id,
    claimGeneration: fixture.job.claimGeneration,
    stage: fixture.job.stage,
    sessionId: fixture.sessionDbId,
    writableTurnIds,
    scopeProvenance: {
      window: writableTurnIds,
      baseLookback: new Set<number>(),
      closureOnly: new Set<number>(),
    },
    contextBuiltAtEpoch: NOW,
    windowStart: 1,
    windowEnd: 4,
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
    resultText(await handlers.get(name)!(args));

  return { handlers, descriptions, call };
}

/** Duties 1-2 and 7, scripted: the whole projection this fixture's window deserves. */
async function writeTheProjection(
  fixture: Fixture,
  call: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<void> {
  // Duty 1+2 on T1: a topic word onto a turn that has none.
  await call("note", {
    turn: "S1/T1",
    tags: ["mapc", "terrain-model", "topic:terrain-model"],
    mode: { tags: "write" },
  });
  // Duty 1: T3 has no type and no note at all — re-typed and re-noted.
  await call("note", {
    turn: "S1/T3",
    title: "tile cache sizing",
    content: "Chose a 512-tile LRU; rejected an unbounded map.",
    type: ["design"],
  });
  // Duty 5: the line these two turns are really about gets its OWN lane, and
  // the legacy phase-sliced word is not reused.
  await call("remember", { action: "create", id: "E1", tag: "tile-cache" });
  // Duty 7: REPLACEMENT SEMANTICS — `mapc-terrain-research` is not assigned,
  // so it is removed from both members.
  await call("note", {
    turn: "S1/T2",
    tags: ["mapc", "tile-cache", "topic:tile-cache"],
    mode: { tags: "write" },
  });
  await call("note", {
    turn: "S1/T3",
    tags: ["mapc", "tile-cache", "topic:tile-cache"],
    mode: { tags: "write" },
  });
  // T4 belongs to no task — a topic word, and nothing else it could carry.
  await call("note", { turn: "S1/T4", tags: ["topic:build-scripts"] });
}

describe("stage 1's tool surface cannot reach commit (ticket 03's accepted deviation)", () => {
  test("exactly recall/timeline/note/remember/finalize are registered — commit is not among them", async () => {
    const fixture = seed();
    try {
      const { handlers } = await openStageOneRun(fixture);
      expect([...handlers.keys()].sort()).toEqual([
        "finalize",
        "note",
        "recall",
        "remember",
        "timeline",
      ]);
      expect(handlers.has("commit")).toBe(false);
      expect(handlers.has("lane_check")).toBe(false);
    } finally {
      fixture.db.close();
    }
  });

  test("the allowlist handed to the SDK carries no commit tool either", () => {
    expect([...NOTE_SETTLEMENT_STAGE_ONE_ALLOWED_TOOLS]).not.toContain("mcp__mnemo__commit");
    expect([...NOTE_SETTLEMENT_STAGE_ONE_ALLOWED_TOOLS]).toContain("mcp__mnemo__finalize");
  });
});

describe("the phase-token predicate has ONE implementation and two faces (reviewer guardrail 3)", () => {
  // The spec's own canonical refused example.
  const TOKEN_BEARING = "s11bin-editor-verification";

  test("both faces refuse the same token, each naming it", () => {
    const topicVerdict = checkTopicTag(`topic:${TOKEN_BEARING}`);
    expect(topicVerdict.ok).toBe(false);
    expect(topicVerdict.ok === false && topicVerdict.violation).toBe("phase-token");
    expect(topicVerdict.ok === false && topicVerdict.message).toContain('"verification"');

    const laneRefusal = checkStageOneLaneTag(TOKEN_BEARING);
    expect(laneRefusal).not.toBeNull();
    expect(laneRefusal).toContain('"verification"');
  });

  test("a subject-only name passes both faces", () => {
    expect(checkTopicTag("topic:tile-cache").ok).toBe(true);
    expect(checkStageOneLaneTag("tile-cache")).toBeNull();
  });

  test("the lane create tool itself refuses it, and mints nothing", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      const refusal = await call("remember", {
        action: "create",
        id: "E1",
        tag: TOKEN_BEARING,
      });
      expect(refusal).toContain('"verification"');
      expect(listLanesForSegment(fixture.db, fixture.segmentId).map((lane) => lane.tag)).toEqual([
        "mapc-terrain-research",
        "terrain-model",
      ]);
    } finally {
      fixture.db.close();
    }
  });

  test("an EXISTING phase-bearing lane stays grandfathered — the predicate governs new writes", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      // The decoy lane is already declared and keeps its members; nothing in
      // this pass renames or refuses it.
      expect(
        listLanesForSegment(fixture.db, fixture.segmentId).map((lane) => lane.tag),
      ).toContain("mapc-terrain-research");
      const refusal = await call("remember", {
        action: "create",
        id: "E1",
        tag: "mapc-terrain-research",
      });
      // Refused for its phase word, not for being a duplicate — the predicate
      // runs before the registry is consulted at all.
      expect(refusal).toContain('"research"');
    } finally {
      fixture.db.close();
    }
  });
});

describe("stage 1 can CORRECT a topic word, not only add one (handoff b)", () => {
  test("a whole-set tags write that silently drops a topic word is refused", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      await call("note", {
        turn: "S1/T1",
        tags: ["mapc", "terrain-model", "topic:map-extraction"],
        mode: { tags: "write" },
      });
      const refusal = await call("note", {
        turn: "S1/T1",
        tags: ["mapc", "terrain-model", "topic:terrain-model"],
        mode: { tags: "write" },
      });
      expect(refusal).toContain("permanent");
      expect(getTurnById(fixture.db, fixture.t1)!.tags).toContain("topic:map-extraction");
    } finally {
      fixture.db.close();
    }
  });

  test("the explicit correction form retires the old word and lands the new one", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      await call("note", {
        turn: "S1/T1",
        tags: ["mapc", "terrain-model", "topic:map-extraction"],
        mode: { tags: "write" },
      });
      const corrected = await call("note", {
        turn: "S1/T1",
        tags: ["mapc", "terrain-model", "topic:terrain-model"],
        mode: { tags: "write" },
        retireTopic: "topic:map-extraction",
      });
      expect(corrected).toContain("Landed");
      const tags = getTurnById(fixture.db, fixture.t1)!.tags;
      expect(tags).toContain("topic:terrain-model");
      expect(tags).not.toContain("topic:map-extraction");
    } finally {
      fixture.db.close();
    }
  });
});

describe("stage 1 writes no edges and merges no lanes", () => {
  test("a relation field on `note` is refused, naming stage 2", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      const refusal = await call("note", {
        turn: "S1/T2",
        grounds: [{ turn: "S1/T1" }],
      });
      expect(refusal).toContain("grounds");
      expect(refusal).toContain("stage 2");
    } finally {
      fixture.db.close();
    }
  });

  test("a retraction mirror is refused too", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      const refusal = await call("note", {
        turn: "S1/T2",
        retractExtends: [{ turn: "S1/T1" }],
      });
      expect(refusal).toContain("retractExtends");
    } finally {
      fixture.db.close();
    }
  });

  test("merge and justify are refused — consolidation is the user's later call", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      expect(
        await call("remember", {
          action: "merge",
          id: "E1",
          tag: "mapc-terrain-research",
          into: "terrain-model",
        }),
      ).toContain("user's own explicit call");
      expect(
        await call("remember", { action: "justify", id: "E1", tag: "terrain-model" }),
      ).toContain("commit gate");
      // Both lanes survive.
      expect(listLanesForSegment(fixture.db, fixture.segmentId)).toHaveLength(2);
    } finally {
      fixture.db.close();
    }
  });
});

describe("the stage-1 gate judges field shape and vocabulary, and nothing else", () => {
  test("an unfinished type and a missing topic word both block, and the refusal names each", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      const refusal = await call("finalize", { summary: "too early" });
      // T3 carries no type at all; every window turn is still wordless.
      expect(refusal).toContain("finalize refused");
      expect(refusal).toContain("TYPE (1)");
      expect(refusal).toContain("S1/T3");
      expect(refusal).toContain("TOPIC WORD (4)");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("topics");
    } finally {
      fixture.db.close();
    }
  });

  test("a refusal costs no attempt and the run may repair and call again", async () => {
    const fixture = seed();
    try {
      const before = getNoteSettlementJob(fixture.db, fixture.job.id)!;
      const { call } = await openStageOneRun(fixture);
      await call("finalize", { summary: "too early" });
      const after = getNoteSettlementJob(fixture.db, fixture.job.id)!;
      expect(after.attempts).toBe(before.attempts);
      expect(after.status).toBe("claimed");
      expect(after.claimGeneration).toBe(before.claimGeneration);
    } finally {
      fixture.db.close();
    }
  });

  // FINAL REVIEW, FINDING 5: the projection is EXACT, and the transition is
  // where that is enforced. A member's final `tags` are its task tag + the
  // lanes assigned + its `topic:` words, and replacement semantics mean a word
  // the projection does not assign is removed — but nothing checked, so a
  // legacy free-form word could ride out of stage 1 untouched: not a lane, so
  // no snapshot lists it and no debt is raised; not a topic word, so nothing
  // preserves it on purpose; and sitting in `tags` as a decoy for every later
  // reader, which is the disease this redesign exists to end.
  test("a stray legacy word refuses the transition, naming the word and the turn", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      await writeTheProjection(fixture, call);
      // A LEGACY word, written the only way one can exist: straight onto the
      // row, the way history left it. The live write gate refuses such a tag
      // outright, which is precisely why the transition needs its own check —
      // the gate governs new writes, and this word predates it.
      fixture.db
        .query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?")
        .run(
          JSON.stringify(["mapc", "terrain-model", "topic:terrain-model", "san11-live-demo-ops"]),
          fixture.t1,
        );

      const refusal = await call("finalize", { summary: "two lines" });

      expect(refusal).toContain("finalize refused");
      expect(refusal).toContain("TAGS (1)");
      expect(refusal).toContain("S1/T1");
      expect(refusal).toContain('"san11-live-demo-ops"');
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("topics");

      // The repair is an ordinary tags write, and it costs no attempt.
      await call("note", {
        turn: "S1/T1",
        tags: ["mapc", "terrain-model", "topic:terrain-model"],
        mode: { tags: "write" },
      });
      expect(await call("finalize", { summary: "two lines" })).toContain("Finalized");
    } finally {
      fixture.db.close();
    }
  });

  test("a PRE-EXISTING BARE EDGE does not block the transition", async () => {
    const fixture = seed();
    try {
      // The fixture's T2 -> T1 `extends` row has neither side placed (E6), and
      // it is still there when the gate runs.
      const gateBefore = evaluateStageOneTransitionGate(fixture.db, {
        writableTurnIds: new Set([fixture.t1, fixture.t2, fixture.t3, fixture.t4]),
        windowTurnIds: new Set([fixture.t1, fixture.t2, fixture.t3, fixture.t4]),
      });
      expect(gateBefore).not.toBeNull();
      expect(gateBefore).not.toContain("E6");

      const { call } = await openStageOneRun(fixture);
      await writeTheProjection(fixture, call);
      const landed = await call("finalize", { summary: "two lines: terrain model, tile cache" });
      expect(landed).toContain("Finalized");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("edges");
    } finally {
      fixture.db.close();
    }
  });
});

describe("a seam-driven stage-1 run over a window (acceptance 1)", () => {
  test("re-types, re-notes, backfills topic words, lanes the lines, and lands the transition", async () => {
    const fixture = seed();
    const { db } = fixture;
    try {
      const { call } = await openStageOneRun(fixture);
      await writeTheProjection(fixture, call);
      const receipt = await call("finalize", {
        summary: "terrain-model continues; tile-cache is new; T4 has no task.",
        homeless: [
          {
            label: "build-scripts",
            reason: "no task on this session covers the build scripts these turns are about",
            turns: ["S1/T4"],
          },
        ],
      });
      expect(receipt).toContain("Finalized");

      // TURN SCOPE — re-typed and re-noted.
      const t3 = getTurnById(db, fixture.t3)!;
      expect(t3.type).toEqual(["design"]);
      // Prose lands as this run's shadow note (settlement's own write path),
      // not straight onto the turn row.
      expect(getShadowNote(db, fixture.t3)?.title).toBe("tile cache sizing");

      // TURN SCOPE — a topic word on every window turn, wordless before.
      for (const id of [fixture.t1, fixture.t2, fixture.t3, fixture.t4]) {
        expect(getTurnById(db, id)!.tags.some((tag) => tag.startsWith("topic:"))).toBe(true);
      }

      // WINDOW SCOPE — one lane created, one reused as it stood.
      expect(listLanesForSegment(db, fixture.segmentId).map((lane) => lane.tag).sort()).toEqual([
        "mapc-terrain-research",
        "terrain-model",
        "tile-cache",
      ]);

      // REPLACEMENT SEMANTICS — the unassigned lane word is gone from both.
      expect(getTurnById(db, fixture.t2)!.tags).not.toContain("mapc-terrain-research");
      expect(getTurnById(db, fixture.t3)!.tags).not.toContain("mapc-terrain-research");
      expect(getTurnById(db, fixture.t1)!.tags).toContain("terrain-model");

      // THE TRANSITION — non-terminal, sequenced, with stage-1's own metrics.
      const job = getNoteSettlementJob(db, fixture.job.id)!;
      expect(job.stage).toBe("edges");
      expect(job.status).toBe("claimed");
      expect(job.claimGeneration).toBe(fixture.job.claimGeneration);
      expect(job.transitionSeq).not.toBeNull();
      const metrics = JSON.parse(job.stage1Metrics ?? "{}") as Record<string, unknown>;
      expect(metrics.worklistLanes).toBe(2);
      expect(metrics.removedLanes).toBe(2);
      expect(metrics.homelessGroups).toBe(1);

      // SNAPSHOT 1 — the writable set with its provenance classes, including
      // the removed-side citer the projection's own removal created.
      const writable = readNoteSettlementWritableSnapshot(db, fixture.job.id);
      expect([...writable.get(fixture.t1)!]).toEqual(["window"]);
      expect([...writable.get(fixture.t5)!]).toEqual(["removed-side-citer"]);

      // SNAPSHOT 2 — the worklist, plus the debts the removals created. The
      // removedLanes contract is what makes this list non-empty: the
      // post-projection database no longer holds the word anywhere.
      const worklist = readNoteSettlementWorklistSnapshot(db, fixture.job.id);
      expect(worklist.lanes.map((lane) => lane.laneTag).sort()).toEqual([
        "terrain-model",
        "tile-cache",
      ]);
      expect(worklist.debts).toHaveLength(1);
      expect(worklist.debts[0]!.removedLaneTag).toBe("mapc-terrain-research");
      expect(worklist.debts[0]!.citingTurnId).toBe(fixture.t5);

      // SNAPSHOT 3 — per-lane member sets.
      const members = readNoteSettlementLaneMemberSnapshot(db, fixture.job.id);
      expect(members.get(laneSnapshotKey(fixture.segmentId, "terrain-model"))).toEqual([
        fixture.t1,
      ]);
      expect(members.get(laneSnapshotKey(fixture.segmentId, "tile-cache"))).toEqual(
        [fixture.t2, fixture.t3].sort((a, b) => a - b),
      );
    } finally {
      db.close();
    }
  });

  test("the decoy word is input data, not gravity: it neither pulls the grouping nor survives it", async () => {
    const fixture = seed();
    const { db } = fixture;
    try {
      const { call } = await openStageOneRun(fixture);
      await writeTheProjection(fixture, call);
      await call("finalize", { summary: "tile-cache is its own line" });

      // The legacy lane is still DECLARED (grandfathered) and now has no
      // member in this window at all — the grouping went to the fresh lane.
      expect(
        listLanesForSegment(db, fixture.segmentId).map((lane) => lane.tag),
      ).toContain("mapc-terrain-research");
      const worklist = readNoteSettlementWorklistSnapshot(db, fixture.job.id);
      expect(worklist.lanes.map((lane) => lane.laneTag)).not.toContain(
        "mapc-terrain-research",
      );
    } finally {
      db.close();
    }
  });
});

describe("homeless disposition (acceptance 4)", () => {
  test("recorded per member through the layer's sole entry, with no lane invented for it", async () => {
    const fixture = seed();
    const { db } = fixture;
    try {
      const lanesBefore = listLanesForSegment(db, fixture.segmentId).length;
      const { call } = await openStageOneRun(fixture);
      await writeTheProjection(fixture, call);
      await call("finalize", {
        summary: "T4 has no task",
        homeless: [
          {
            label: "build-scripts",
            reason: "no attached task covers it",
            turns: ["S1/T4"],
          },
        ],
      });

      const disposition = resolveActiveHomelessDisposition(db, fixture.t4);
      expect(disposition).not.toBeNull();
      expect(disposition!.canonicalLabel).toBe("build-scripts");
      // Taskless is 0, never NULL — the layer's own sentinel.
      expect(disposition!.taskScopeId).toBe(0);
      // The group's transition_seq is the transition's own freshly-taken value.
      const job = getNoteSettlementJob(db, fixture.job.id)!;
      expect(loadHomelessGroup(db, disposition!.groupId)!.transitionSeq).toBe(
        job.transitionSeq,
      );
      expect(loadHomelessGroupMembers(db, disposition!.groupId)).toEqual([fixture.t4]);

      // NO LANE was invented to house it: only `tile-cache` was added, and
      // the homeless group's label is nowhere in the registry.
      const lanes = listLanesForSegment(db, fixture.segmentId).map((lane) => lane.tag);
      expect(lanes).toHaveLength(lanesBefore + 1);
      expect(lanes).not.toContain("build-scripts");
    } finally {
      db.close();
    }
  });

  test("a member outside the writable set is refused, and nothing transitions", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      await writeTheProjection(fixture, call);
      const refusal = await call("finalize", {
        summary: "reaching out of scope",
        homeless: [{ label: "elsewhere", reason: "nothing holds it", turns: ["S1/T5"] }],
      });
      expect(refusal).toContain("not in your writable set");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("topics");
    } finally {
      fixture.db.close();
    }
  });
});

describe("finalize is terminal for the pass, and advisory to the scheduler", () => {
  test("a second finalize is a no-op and says the window has moved on", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      await writeTheProjection(fixture, call);
      await call("finalize", { summary: "done" });
      expect(await call("finalize", { summary: "again" })).toContain("Already finalized");
    } finally {
      fixture.db.close();
    }
  });

  test("summary is required and capped, and a refusal transitions nothing", async () => {
    const fixture = seed();
    try {
      const { call } = await openStageOneRun(fixture);
      await writeTheProjection(fixture, call);
      expect(await call("finalize", { summary: "   " })).toContain("summary is required");
      expect(await call("finalize", { summary: "x".repeat(1001) })).toContain("1000-character cap");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("topics");
    } finally {
      fixture.db.close();
    }
  });

  test("the dispatch reports the transition verdict only when the ROW says so", async () => {
    const fixture = seed();
    try {
      const dispatch = createNoteSettlementStageOneDispatch({
        db: fixture.db,
        now: () => NOW,
        // A run that writes nothing: the row never advances, so the verdict is
        // a deterministic failure rather than a chain.
        runQuery: async () => ({ text: "did nothing", finalized: false }),
      });
      const outcome = await dispatch({ job: fixture.job });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain("without a transition");
      expect(getNoteSettlementJob(fixture.db, fixture.job.id)?.stage).toBe("topics");
    } finally {
      fixture.db.close();
    }
  });
});

describe("the no-model default survives the stub's replacement", () => {
  test("createTransitionOnlyStageOneDispatch still transitions and returns the chain verdict", async () => {
    const fixture = seed();
    try {
      const dispatch = createTransitionOnlyStageOneDispatch(fixture.db, () => NOW);
      const outcome = await dispatch({ job: fixture.job });
      expect(outcome).toEqual({ ok: true, transition: "edges" });
      const job = getNoteSettlementJob(fixture.db, fixture.job.id)!;
      expect(job.stage).toBe("edges");
      expect(job.status).toBe("claimed");
      // A pass that judged nothing declares no snapshot at all — an empty one
      // would say "this job settled nothing into any lane" rather than "this
      // job never judged".
      expect(readNoteSettlementWritableSnapshot(fixture.db, fixture.job.id).size).toBe(0);
    } finally {
      fixture.db.close();
    }
  });
});
