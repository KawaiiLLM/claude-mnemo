import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { getLane, insertLane, listLanesForSegment } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  reassignSegmentMembers,
  setSegmentTags,
  toggleSegmentStatus,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import {
  evaluateSettlementMembershipWrite,
  renderSettlementMembershipWriteReceipt,
  settlementMembershipWriteInputSchema,
  type SettlementMembershipWriteInput,
} from "../../src/worker/note-settlement-membership-facade";
import type { SettlementTurnFacadeContext } from "../../src/worker/note-settlement-turn-facade";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * The settlement LANE facade's DECISION function,
 * `evaluateSettlementMembershipWrite`.
 *
 * LANE-MODEL-V12 TICKET 15 (spec D3d): `propose`, `reassign` and `create`
 * retired together, so every describe block that exercised them is GONE —
 * because the ACTIONS are gone, not because the facade grew stricter about
 * them. What is left is the lane registry: `declare`/`undeclare` (ticket 02)
 * and `merge` (this ticket). The retirement itself is pinned two ways below —
 * zod's own enum rejection at the schema layer, and the replacement sentence
 * on the hand-rolled path — because a silently-accepted no-op and a refusal
 * that names the replacement look identical from a caller that never checks.
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

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "settlement-membership-facade-session",
    project: "/tmp/project-settlement-membership-facade",
    title: "settlement membership facade fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  facets: { type?: string[]; tags?: string[] } = {},
): number {
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
      NOW - 1_000 + promptNumber,
      JSON.stringify(facets.type ?? []),
      JSON.stringify(facets.tags ?? []),
    )!.id;
}

/** A turn's stored `tags`, parsed — merge's whole visible effect on a member. */
function turnTags(turnId: number): string[] {
  return JSON.parse(
    db.query<{ tags: string }, [number]>("SELECT tags FROM turns WHERE id = ?").get(turnId)!.tags,
  ) as string[];
}

function claimWindow(sessionDbId: number, windowStart: number, windowEnd: number): NoteSettlementJob {
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

function baseContext(
  job: NoteSettlementJob,
  overrides: Partial<SettlementTurnFacadeContext> = {},
): SettlementTurnFacadeContext {
  return {
    jobId: job.id,
    claimGeneration: job.claimGeneration,
    sessionId: job.sessionId,
    reviewableTurnIds: new Set(),
    contextBuiltAtEpoch: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

describe("settlementMembershipWriteInputSchema", () => {
  test("accepts declare/undeclare with id+tag, and merge with id+tag+into", () => {
    for (const input of [
      { action: "declare", id: "E7", tag: "write-gate" },
      { action: "undeclare", id: "E7", tag: "write-gate" },
      { action: "merge", id: "E7", tag: "write-gate", into: "gate" },
    ]) {
      expect(settlementMembershipWriteInputSchema.safeParse(input).success).toBe(true);
    }
  });

  // Ticket 15 (spec D3d): the three retired verbs are kept OUT of the enum
  // entirely, not merely refused downstream, so a stale caller gets zod's own
  // "invalid enum value" naming the three legal verbs — the same treatment
  // `assign` got when it retired.
  test.each(["propose", "reassign", "create", "assign"])(
    "rejects the retired action %p at the SCHEMA layer, listing the legal verbs",
    (action) => {
      const parsed = settlementMembershipWriteInputSchema.safeParse({
        action,
        id: "E7",
        tag: "write-gate",
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const message = JSON.stringify(parsed.error.issues);
      expect(message).toContain("declare");
      expect(message).toContain("undeclare");
      expect(message).toContain("merge");
      expect(message).not.toContain(`"${action}"`);
    },
  );

  // The hand-rolled path (this facade's own evaluator, called directly) is
  // where the REPLACEMENT sentence lives — the same belt-and-braces pairing
  // `mcp/remember.ts`'s `RETIRED_REMEMBER_VERB_REPLACEMENT` has with
  // `definitions.ts`'s schema-layer superRefine. A silent no-op would be the
  // failure this pins against.
  test.each([
    ["propose", "segments attach automatically"],
    ["reassign", "derived from a turn's tags"],
    ["create", "does not open segments"],
  ])("the retired action %p names its replacement on the hand-rolled path", (action, fragment) => {
    const result = evaluateSettlementMembershipWrite(
      db,
      baseContext(claimWindow(seedSession(), 1, 1)),
      { action } as unknown as SettlementMembershipWriteInput,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`action "${action}" has retired`);
    expect(result.message).toContain(fragment);
  });

  test("the retired fields go with the verbs — a strict schema refuses them by name", () => {
    for (const stale of [
      { action: "declare", id: "E7", tag: "x", addresses: ["S1/T1"] },
      { action: "declare", id: "E7", tag: "x", turns: ["S1/T1"] },
      { action: "declare", id: "E7", tag: "x", title: "a segment" },
    ]) {
      expect(settlementMembershipWriteInputSchema.safeParse(stale).success).toBe(false);
    }
  });

  test("rejects an unknown field (strict schema)", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "declare",
        id: "E7",
        tag: "x",
        segment: "E1",
      }).success,
    ).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// declare / undeclare (lane-declaration spec D1/D4, ticket 02)
// ---------------------------------------------------------------------------

/**
 * Settlement owns lane declaration outright ([S15069/T1547]), and the
 * settlement prompt's Block B step 2 tells a run to `declare` a fresh tag when
 * no existing one fits. Before this ticket the facade's action enum was
 * `["propose", "reassign", "create"]`, so that instruction was a hard schema
 * rejection rather than a refusal a run could read and act on.
 *
 * Asserted at the FACADE boundary, never against `db/lanes.ts` — the point is
 * that settlement reaches the same rules the main agent's `remember` enforces,
 * not that the primitives underneath still work.
 */
describe("declare / undeclare — settlement's half of the lane registry (ticket 02)", () => {
  // ONE claimed window per test — `claimWindow` mints a job, and a helper that
  // re-claimed on every call would throw on the second refusal a test asserts.
  let context: SettlementTurnFacadeContext | null = null;
  beforeEach(() => {
    context = null;
  });
  const evaluate = (input: SettlementMembershipWriteInput) => {
    context ??= baseContext(claimWindow(seedSession(), 1, 1));
    return evaluateSettlementMembershipWrite(db, context, input, NOW);
  };

  function openSegment(title = "a lane home"): number {
    return createSegment(db, { title, nowEpoch: NOW }).id;
  }

  test("declare mints the lane and the receipt names it", () => {
    const segmentId = openSegment();
    const result = evaluate({ action: "declare", id: `E${segmentId}`, tag: "write-gate" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.lane).toEqual({
      action: "declare",
      segmentId,
      tag: "write-gate",
      laneId: getLane(db, segmentId, "write-gate")!.id,
    });
    expect(renderSettlementMembershipWriteReceipt(result.outcome)).toContain(
      'Landed declare: lane "write-gate"',
    );
    expect(listLanesForSegment(db, segmentId).map((lane) => lane.tag)).toEqual(["write-gate"]);
  });

  test("a NON-CANONICAL tag is refused naming the exact problem, never normalized", () => {
    const segmentId = openSegment();
    for (const [tag, fragment] of [
      ["Write-Gate", "not lowercase"],
      ["write gate", "interior whitespace"],
      [" write-gate", "leading or trailing whitespace"],
    ] as const) {
      const result = evaluate({ action: "declare", id: `E${segmentId}`, tag });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(fragment);
      }
    }
    // Nothing was silently canonicalized into existence.
    expect(listLanesForSegment(db, segmentId)).toEqual([]);
  });

  test("a tag already among the segment's CURATED tags is refused — the two vocabularies stay separate", () => {
    const segmentId = createSegment(db, { title: "curated", tags: ["release"], nowEpoch: NOW }).id;
    const result = evaluate({ action: "declare", id: `E${segmentId}`, tag: "release" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("already one of");
      expect(result.message).toContain("curated tags");
    }
    expect(listLanesForSegment(db, segmentId)).toEqual([]);
  });

  test("declaring the same lane twice is refused, naming the existing row", () => {
    const segmentId = openSegment();
    expect(evaluate({ action: "declare", id: `E${segmentId}`, tag: "write-gate" }).ok).toBe(true);
    const second = evaluate({ action: "declare", id: `E${segmentId}`, tag: "write-gate" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.message).toContain("already declares");
    }
  });

  test("a missing id, a missing tag, a nonexistent segment and a CLOSED segment each refuse by name", () => {
    const segmentId = openSegment();
    const closedId = openSegment("closed");
    toggleSegmentStatus(db, closedId, NOW);

    expect(evaluate({ action: "declare", tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("requires id"),
    });
    expect(evaluate({ action: "declare", id: `E${segmentId}` })).toMatchObject({
      ok: false,
      message: expect.stringContaining("requires tag"),
    });
    expect(evaluate({ action: "declare", id: "E99999", tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("does not exist"),
    });
    expect(evaluate({ action: "declare", id: `E${closedId}`, tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("is closed"),
    });
  });

  test("undeclare removes an unused lane, and refuses while a MEMBER TURN still carries the tag (ticket 10)", () => {
    const sessionDbId = seedSession();
    const segmentId = openSegment();
    const cited = seedTurn(sessionDbId, 1, { type: ["design"], tags: ["write-gate"] });
    const citing = seedTurn(sessionDbId, 2, { type: ["design"], tags: ["write-gate"] });
    expect(reassignSegmentMembers(db, [cited, citing], segmentId, NOW).ok).toBe(true);
    expect(evaluate({ action: "declare", id: `E${segmentId}`, tag: "write-gate" }).ok).toBe(true);

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "extends",
          provenance: "judged",
          ...deriveSideTags(["write-gate"]),
        },
      ],
      NOW,
    );

    const inUse = evaluate({ action: "undeclare", id: `E${segmentId}`, tag: "write-gate" });
    expect(inUse.ok).toBe(false);
    if (!inUse.ok) {
      // Two member turns carry the word; the edge between them is beside the
      // point since ticket 10 (it is the TURNS that make the lane exist).
      expect(inUse.message).toContain("still has 2 member turn(s) carrying it");
    }
    expect(getLane(db, segmentId, "write-gate")).not.toBeNull();

    // A lane nothing carries goes.
    expect(evaluate({ action: "declare", id: `E${segmentId}`, tag: "unused" }).ok).toBe(true);
    const removed = evaluate({ action: "undeclare", id: `E${segmentId}`, tag: "unused" });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(renderSettlementMembershipWriteReceipt(removed.outcome)).toContain(
        'Landed undeclare: lane "unused"',
      );
    }
    expect(getLane(db, segmentId, "unused")).toBeNull();
  });

  test("undeclaring a lane that was never declared refuses by name", () => {
    const segmentId = openSegment();
    const result = evaluate({ action: "undeclare", id: `E${segmentId}`, tag: "never-declared" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("has no declared lane");
    }
  });
});
// ---------------------------------------------------------------------------
// merge (lane-model-v12 spec D3d, ticket 15) — two declared lanes turn out to
// be one task. Asserted at the FACADE boundary; `tests/db/lanes.merge.test.ts`
// pins the primitive's own moving parts (collision folding, cross-segment
// isolation, atomicity under a failpoint).
// ---------------------------------------------------------------------------

describe("merge — folding one declared lane into another (ticket 15)", () => {
  let context: SettlementTurnFacadeContext | null = null;
  beforeEach(() => {
    context = null;
  });
  const evaluate = (input: SettlementMembershipWriteInput) => {
    context ??= baseContext(claimWindow(seedSession(), 1, 1));
    return evaluateSettlementMembershipWrite(db, context, input, NOW);
  };

  function segmentWithLanes(tags: string[], title = "a lane home"): number {
    const segmentId = createSegment(db, { title, nowEpoch: NOW }).id;
    for (const tag of tags) {
      insertLane(db, segmentId, tag, NOW);
    }
    return segmentId;
  }

  test("the members move, the folded lane is undeclared, and the receipt states what moved", () => {
    const sessionDbId = seedSession();
    const segmentId = segmentWithLanes(["lane-a", "lane-b"]);
    const t1 = seedTurn(sessionDbId, 1, { tags: ["lane-a"] });
    const t2 = seedTurn(sessionDbId, 2, { tags: ["lane-a", "lane-b"] });
    addSegmentMembers(db, segmentId, [t1, t2], NOW);

    const result = evaluate({
      action: "merge",
      id: `E${segmentId}`,
      tag: "lane-a",
      into: "lane-b",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.lane.action).toBe("merge");
    expect(result.outcome.lane.merge).toMatchObject({
      from: "lane-a",
      into: "lane-b",
      turnsRetagged: 2,
      turnsDeduplicated: 1,
    });
    expect(turnTags(t1)).toEqual(["lane-b"]);
    expect(turnTags(t2)).toEqual(["lane-b"]);
    expect(getLane(db, segmentId, "lane-a")).toBeNull();
    expect(getLane(db, segmentId, "lane-b")).not.toBeNull();
    expect(renderSettlementMembershipWriteReceipt(result.outcome)).toContain(
      'Landed merge: E' + segmentId + '\'s lane "lane-a" folded into "lane-b"',
    );
  });

  test("REFUSAL: the two lanes are in different segments, naming both containers", () => {
    const here = segmentWithLanes(["lane-a"], "here");
    const there = segmentWithLanes(["lane-a"], "there");
    const result = evaluate({
      action: "merge",
      id: `E${here}`,
      tag: "lane-a",
      into: `E${there}/lane-a`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`E${here}`);
    expect(result.message).toContain(`E${there}`);
    expect(result.message).toContain("two lanes in two");
    // Nothing moved: the other segment's identically-named lane is untouched.
    expect(getLane(db, here, "lane-a")).not.toBeNull();
    expect(getLane(db, there, "lane-a")).not.toBeNull();
  });

  test("REFUSAL: the lane being folded away is not declared", () => {
    const segmentId = segmentWithLanes(["lane-b"]);
    const result = evaluate({
      action: "merge",
      id: `E${segmentId}`,
      tag: "lane-a",
      into: "lane-b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('has no declared lane "lane-a"');
    expect(result.message).toContain("folds a DECLARED lane away");
  });

  test("REFUSAL: the surviving lane is not declared", () => {
    const segmentId = segmentWithLanes(["lane-a"]);
    const result = evaluate({
      action: "merge",
      id: `E${segmentId}`,
      tag: "lane-a",
      into: "lane-b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('has no declared lane "lane-b"');
    expect(result.message).toContain("folds INTO a declared lane");
    // The lane that WOULD have been folded away is still declared.
    expect(getLane(db, segmentId, "lane-a")).not.toBeNull();
  });

  test("REFUSAL: A and B are the same lane — folding a lane into itself would destroy it", () => {
    const segmentId = segmentWithLanes(["lane-a"]);
    const result = evaluate({
      action: "merge",
      id: `E${segmentId}`,
      tag: "lane-a",
      into: "lane-a",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("merge needs two different lanes");
    expect(getLane(db, segmentId, "lane-a")).not.toBeNull();
  });

  test("REFUSAL: a missing `into`, and a non-canonical one, each refuse by name", () => {
    const segmentId = segmentWithLanes(["lane-a", "lane-b"]);
    const missing = evaluate({ action: "merge", id: `E${segmentId}`, tag: "lane-a" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.message).toContain("merge requires into");
    }
    const shouty = evaluate({
      action: "merge",
      id: `E${segmentId}`,
      tag: "lane-a",
      into: "Lane-B",
    });
    expect(shouty.ok).toBe(false);
    if (!shouty.ok) {
      expect(shouty.message).toContain("not lowercase");
    }
    expect(getLane(db, segmentId, "lane-a")).not.toBeNull();
  });

  test("a merge on a CLOSED segment is refused, the same way declare and undeclare are", () => {
    const segmentId = segmentWithLanes(["lane-a", "lane-b"]);
    toggleSegmentStatus(db, segmentId, NOW);
    const result = evaluate({
      action: "merge",
      id: `E${segmentId}`,
      tag: "lane-a",
      into: "lane-b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("is closed");
  });
});
// ---------------------------------------------------------------------------
// Receipt rendering
// ---------------------------------------------------------------------------

describe("renderSettlementMembershipWriteReceipt", () => {
  test("a declare receipt names the lane and its row id", () => {
    expect(
      renderSettlementMembershipWriteReceipt({
        lane: { action: "declare", segmentId: 7, tag: "write-gate", laneId: 42 },
      }),
    ).toBe('Landed declare: lane "write-gate" on E7 (lane #42).');
  });

  test("an undeclare receipt says the lane is gone, not that one was minted", () => {
    expect(
      renderSettlementMembershipWriteReceipt({
        lane: { action: "undeclare", segmentId: 7, tag: "write-gate", laneId: null },
      }),
    ).toBe('Landed undeclare: lane "write-gate" removed from E7.');
  });

  // The collision count is stated even at ZERO. A merge that folded two edges
  // into one has destroyed a stored row, and a receipt mentioning that only
  // sometimes teaches a reader to skim past the line where it matters.
  test("a merge receipt states every count, including a zero collision count", () => {
    expect(
      renderSettlementMembershipWriteReceipt({
        lane: {
          action: "merge",
          segmentId: 7,
          tag: "lane-a",
          laneId: null,
          merge: {
            segmentId: 7,
            from: "lane-a",
            into: "lane-b",
            turnsRetagged: 3,
            turnsDeduplicated: 0,
            edgeSidesRewritten: 4,
            collisions: [],
          },
        },
      }),
    ).toBe(
      'Landed merge: E7\'s lane "lane-a" folded into "lane-b" — 3 member turn(s) retagged, ' +
        '4 edge side(s) rewritten, 0 duplicate edge(s) merged. "lane-a" is no longer declared.',
    );
  });

  test("a merge that deduplicated turns and folded edges says both", () => {
    const rendered = renderSettlementMembershipWriteReceipt({
      lane: {
        action: "merge",
        segmentId: 9,
        tag: "lane-a",
        laneId: null,
        merge: {
          segmentId: 9,
          from: "lane-a",
          into: "lane-b",
          turnsRetagged: 5,
          turnsDeduplicated: 2,
          edgeSidesRewritten: 6,
          collisions: [
            {
              citingAddress: "S1/T2",
              citedAddress: "S1/T1",
              relation: "extends",
              tailTag: "lane-b",
              headTag: "lane-b",
              keptEdgeId: 10,
              keptProvenance: "asserted",
              keptCreatedAtEpoch: 100,
              droppedEdgeId: 11,
              droppedProvenance: "judged",
              droppedCreatedAtEpoch: 90,
              rule: "provenance",
            },
          ],
        },
      },
    });
    expect(rendered).toContain("5 member turn(s) retagged (2 already carried it)");
    expect(rendered).toContain("1 duplicate edge(s) merged");
  });
});