import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { loadEndpointLaneFacts, resolveEdgeSide } from "../../src/db/edge-side-resolution";
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
import { wordEdgeClass } from "../support/edge-row-fixtures";

/**
 * The settlement LANE facade's DECISION function,
 * `evaluateSettlementMembershipWrite`.
 *
 * LANE-MODEL-V12 TICKET 15 (spec D3d): `propose`, `reassign` and `create`
 * (the SEGMENT sense — this facade never had a title/goal parameter) retired
 * together, so every describe block that exercised them is GONE — because
 * the ACTIONS are gone, not because the facade grew stricter about them.
 * What is left is the lane registry.
 *
 * CONTAINER-UNIFICATION TICKET 05 (spec D3): `declare` retired into `create`
 * — same id+tag shape, same refusals, only the accepted word changed, so the
 * word `create` is free again to mean "mint a lane" (it never meant anything
 * else here). CONTAINER-UNIFICATION TICKET 06 (spec D4) does the same thing
 * one word over: `undeclare` retires into `delete`, same id+tag shape, same
 * guard. `merge` (ticket 15) is unaffected by either.
 * The retirement is pinned two ways below — zod's own enum rejection at the
 * schema layer, and the replacement sentence on the hand-rolled path —
 * because a silently-accepted no-op and a refusal that names the replacement
 * look identical from a caller that never checks.
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
    stage: job.stage,
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
  test("accepts create/delete with id+tag, and merge with id+tag+into", () => {
    for (const input of [
      { action: "create", id: "E7", tag: "write-gate" },
      { action: "delete", id: "E7", tag: "write-gate" },
      { action: "merge", id: "E7", tag: "write-gate", into: "gate" },
    ]) {
      expect(settlementMembershipWriteInputSchema.safeParse(input).success).toBe(true);
    }
  });

  // Ticket 15 (spec D3d) retired `propose`/`reassign`/segment-`create`;
  // container-unification ticket 05 retired `declare` the same way, and
  // ticket 06 retires `undeclare` the same way again — kept OUT of the enum
  // entirely, not merely refused downstream, so a stale caller gets zod's
  // own "invalid enum value" naming the three legal verbs — the same
  // treatment `assign` got when it retired.
  test.each(["propose", "reassign", "declare", "undeclare", "assign"])(
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
      expect(message).toContain("create");
      expect(message).toContain("delete");
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
    ["propose", "tasks attach automatically"],
    ["reassign", "derived from a turn's tags"],
    ["declare", 'use "create" instead'],
    ["undeclare", 'use "delete" instead'],
    // Settlement-gate-taxonomy ticket 06: the one retirement here where the
    // capability went with the verb, so the sentence names no replacement call
    // — it names the obligation that no longer exists.
    ["justify", "a severed lane no longer owes anything"],
  ])("the retired action %p names its replacement on the hand-rolled path", (action, fragment) => {
    const result = evaluateSettlementMembershipWrite(
      db,
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
      { action: "create", id: "E7", tag: "x", addresses: ["S1/T1"] },
      { action: "create", id: "E7", tag: "x", turns: ["S1/T1"] },
      { action: "create", id: "E7", tag: "x", title: "a segment" },
    ]) {
      expect(settlementMembershipWriteInputSchema.safeParse(stale).success).toBe(false);
    }
  });

  test("rejects an unknown field (strict schema)", () => {
    expect(
      settlementMembershipWriteInputSchema.safeParse({
        action: "create",
        id: "E7",
        tag: "x",
        segment: "E1",
      }).success,
    ).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// create (lane tier) / delete (lane-declaration spec D1/D4, ticket 02;
// `declare` renamed to `create` by container-unification ticket 05, and
// `undeclare` renamed to `delete` by ticket 06)
// ---------------------------------------------------------------------------

/**
 * Settlement owns lane declaration outright ([S15069/T1547]), and the
 * settlement prompt's Block B step 2 tells a run to declare a fresh tag when
 * no existing one fits. Before ticket 02 the facade's action enum was
 * `["propose", "reassign", "create"]` (the SEGMENT sense), so that
 * instruction was a hard schema rejection rather than a refusal a run could
 * read and act on. Ticket 05 then retired the dedicated `declare` word itself
 * — same shape, same refusals — freeing `create` (never a segment-minting
 * verb on THIS facade) to mean "mint a lane" instead, the same word the main
 * `remember` tool's own lane-tier `create` uses.
 *
 * Asserted at the FACADE boundary, never against `db/lanes.ts` — the point is
 * that settlement reaches the same rules the main agent's `remember` enforces,
 * not that the primitives underneath still work.
 *
 * The OUTCOME's own `action` field and the receipt text stay the internal
 * literal `"declare"` — `evaluateSettlementMembershipWrite` remaps at the
 * write boundary only, so what changes below is the `action` a CALL sends,
 * never what a result or a receipt reports back.
 */
describe("create (lane tier) / delete — settlement's half of the lane registry (ticket 02)", () => {
  // TICKET 06: no claimed window and no context. `justify` was the only
  // action this evaluator ever needed one for (the read-receipt reader id and
  // the ledger row's job scope), and it retired; the lane registry verbs take
  // a database, an input and a clock.
  const evaluate = (input: SettlementMembershipWriteInput) =>
    evaluateSettlementMembershipWrite(db, input, NOW);

  function openSegment(title = "a lane home"): number {
    return createSegment(db, { title, nowEpoch: NOW }).id;
  }

  test("create mints the lane and the receipt names it", () => {
    const segmentId = openSegment();
    const result = evaluate({ action: "create", id: `E${segmentId}`, tag: "write-gate" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.lane).toEqual({
      action: "create",
      segmentId,
      tag: "write-gate",
      laneId: getLane(db, segmentId, "write-gate")!.id,
    });
    expect(renderSettlementMembershipWriteReceipt(result.outcome)).toContain(
      'Landed create: lane "write-gate"',
    );
    expect(listLanesForSegment(db, segmentId).map((lane) => lane.tag)).toEqual(["write-gate"]);
  });

  // main-agent-edges ticket 13 (P1-6): this facade's own caller of
  // `insertLane` bypassed the seam entirely — the same finding as
  // `mcp/remember.ts`'s `create`. User ruling S15069/T2465 (mid-batch): an
  // ambiguous side is a WARNING ONLY now, so the newly-ambiguous edge is KEPT,
  // unreceipted — this is settlement's own dispatch, so there IS a live job in
  // play, and it must not be invalidated over a mere warning either.
  test("conscripting a turn into a new lane re-resolves EVERY incident side, clearing a stale invalid declaration, and leaves the newly-ambiguous side kept, unreceipted", () => {
    const segmentId = createSegment(db, { title: "conscription", tags: ["home"], nowEpoch: NOW })
      .id;
    expect(evaluate({ action: "create", id: `E${segmentId}`, tag: "alpha" }).ok).toBe(true);
    const sessionId = seedSession();
    const t1 = seedTurn(sessionId, 1, { tags: ["home", "alpha", "legacy-word"] });
    const t2 = seedTurn(sessionId, 2, { tags: ["home", "alpha"] });
    const t3 = seedTurn(sessionId, 3, { tags: ["home", "alpha"] });
    addSegmentMembers(db, segmentId, [t1, t2, t3], NOW);

    const written = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t1 },
          cited: { kind: "turn", id: t2 },
          ...wordEdgeClass("extends"),
          provenance: "asserted",
        },
      ],
      NOW,
    );
    const edgeId = written.written[0]!.id;
    const edgeRow = { citingId: t1, citedId: t2, tailTag: "", headTag: "" };
    expect(
      resolveEdgeSide(edgeRow, "tail", loadEndpointLaneFacts(db, [t1, t2])).outcome,
    ).toBe("derived");

    // A SEPARATE, unrelated edge already carries a STALE declaration on t1's
    // citing side — `stray-lane` is not, and never was, among t1's tags. This
    // is the LOAD-BEARING half of the probe: minting a lane only ever ADDS a
    // possible attribution, so it can never by itself make an existing
    // declaration `redundant` or `invalid` — the earlier edge's `ambiguous`
    // outcome is a pure read and cannot tell "the seam ran" from "it didn't".
    // A stray invalid declaration getting cleared as a SIDE EFFECT of the
    // conscription's own re-resolution can: it proves
    // `normalizeIncidentAttribution` ran over every incident side of t1.
    const strayWritten = writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t1 },
          cited: { kind: "turn", id: t3 },
          ...wordEdgeClass("extends"),
          provenance: "asserted",
          tailTag: "stray-lane",
        },
      ],
      NOW,
    );
    const strayEdgeId = strayWritten.written[0]!.id;

    const result = evaluate({ action: "create", id: `E${segmentId}`, tag: "legacy-word" });
    expect(result.ok).toBe(true);

    const resolved = resolveEdgeSide(edgeRow, "tail", loadEndpointLaneFacts(db, [t1, t2]));
    expect(resolved.outcome).toBe("ambiguous");

    expect(
      db.query<{ id: number }, [number]>("SELECT id FROM memory_edges WHERE id = ?").get(edgeId),
    ).not.toBeNull();
    const deleteReceipts = db
      .query<{ n: number }, [number]>(
        `SELECT COUNT(*) AS n FROM edge_attribution_receipts
          WHERE edge_row_id = ? AND action = 'delete-edge'`,
      )
      .get(edgeId)!.n;
    expect(deleteReceipts).toBe(0);

    // The stray invalid declaration is gone — the seam ran.
    const strayTail = db
      .query<{ tailTag: string }, [number]>(
        "SELECT tail_tag AS tailTag FROM memory_edges WHERE id = ?",
      )
      .get(strayEdgeId)!.tailTag;
    expect(strayTail).toBe("");
  });

  test("a NON-CANONICAL tag is refused naming the exact problem, never normalized", () => {
    const segmentId = openSegment();
    for (const [tag, fragment] of [
      ["Write-Gate", "not lowercase"],
      ["write gate", "interior whitespace"],
      [" write-gate", "leading or trailing whitespace"],
    ] as const) {
      const result = evaluate({ action: "create", id: `E${segmentId}`, tag });
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
    const result = evaluate({ action: "create", id: `E${segmentId}`, tag: "release" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("already one of");
      expect(result.message).toContain("curated tags");
    }
    expect(listLanesForSegment(db, segmentId)).toEqual([]);
  });

  test("creating the same lane twice is refused, naming the existing row", () => {
    const segmentId = openSegment();
    expect(evaluate({ action: "create", id: `E${segmentId}`, tag: "write-gate" }).ok).toBe(true);
    const second = evaluate({ action: "create", id: `E${segmentId}`, tag: "write-gate" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.message).toContain("already declares");
    }
  });

  test("a missing id, a missing tag, a nonexistent segment and a CLOSED segment each refuse by name", () => {
    const segmentId = openSegment();
    const closedId = openSegment("closed");
    toggleSegmentStatus(db, closedId, NOW);

    expect(evaluate({ action: "create", tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("requires id"),
    });
    expect(evaluate({ action: "create", id: `E${segmentId}` })).toMatchObject({
      ok: false,
      message: expect.stringContaining("requires tag"),
    });
    expect(evaluate({ action: "create", id: "E99999", tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("does not exist"),
    });
    expect(evaluate({ action: "create", id: `E${closedId}`, tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("is closed"),
    });
  });

  // The refusal MESSAGE names the word the caller actually sent ("create"),
  // never the internal "declare" the facade remaps to — a mutation dropping
  // that remap (using the internal `action` in the message instead of
  // `rawInput.action`) would still pass every OTHER test in this block, since
  // "requires id"/"requires tag" etc. do not name the verb; this is the one
  // assertion that catches it.
  test("the missing-id/missing-tag refusals name \"create\", not the internal \"declare\"", () => {
    const segmentId = openSegment();
    expect(evaluate({ action: "create", tag: "x" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("create requires id"),
    });
    expect(evaluate({ action: "create", id: `E${segmentId}` })).toMatchObject({
      ok: false,
      message: expect.stringContaining("create requires tag"),
    });
  });

  test("delete removes an unused lane, and refuses while a MEMBER TURN still carries the tag (ticket 10)", () => {
    const sessionDbId = seedSession();
    const segmentId = openSegment();
    const cited = seedTurn(sessionDbId, 1, { type: ["design"], tags: ["write-gate"] });
    const citing = seedTurn(sessionDbId, 2, { type: ["design"], tags: ["write-gate"] });
    // FROZEN legacy ownership on purpose (settlement-read-once D5): this
    // fixture's task is UNNAMED, so no tag write could place these turns —
    // `addSegmentMembers` is the shape production's 185 legacy rows have.
    addSegmentMembers(db, segmentId, [cited, citing], NOW);
    expect(evaluate({ action: "create", id: `E${segmentId}`, tag: "write-gate" }).ok).toBe(true);

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          ...wordEdgeClass("extends"),
          provenance: "judged",
          ...deriveSideTags(["write-gate"]),
        },
      ],
      NOW,
    );

    const inUse = evaluate({ action: "delete", id: `E${segmentId}`, tag: "write-gate" });
    expect(inUse.ok).toBe(false);
    if (!inUse.ok) {
      // Two member turns carry the word; the edge between them is beside the
      // point since ticket 10 (it is the TURNS that make the lane exist).
      expect(inUse.message).toContain("still has 2 member turn(s) carrying it");
    }
    expect(getLane(db, segmentId, "write-gate")).not.toBeNull();

    // A lane nothing carries goes.
    expect(evaluate({ action: "create", id: `E${segmentId}`, tag: "unused" }).ok).toBe(true);
    const removed = evaluate({ action: "delete", id: `E${segmentId}`, tag: "unused" });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(renderSettlementMembershipWriteReceipt(removed.outcome)).toContain(
        'Landed delete: lane "unused"',
      );
    }
    expect(getLane(db, segmentId, "unused")).toBeNull();
  });

  test("deleting a lane that was never declared refuses by name", () => {
    const segmentId = openSegment();
    const result = evaluate({ action: "delete", id: `E${segmentId}`, tag: "never-declared" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("has no declared lane");
    }
  });

  // MUTATION TARGET (container-unification ticket 06 acceptance): the same
  // shape as the `declare` pin below, one word over. If `undeclare` were
  // still wired to remove a lane, this would observe a SUCCESSFUL removal
  // instead of a named refusal.
  test("undeclare no longer works — it refuses, naming delete, and removes nothing", () => {
    const segmentId = openSegment();
    expect(evaluate({ action: "create", id: `E${segmentId}`, tag: "still-declared" }).ok).toBe(
      true,
    );
    // The literal `"undeclare"` here is DELIBERATE and must not be swept by a
    // rename: this test's whole subject is the retired word being sent.
    const result = evaluate({
      action: "undeclare",
      id: `E${segmentId}`,
      tag: "still-declared",
    } as unknown as SettlementMembershipWriteInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('action "undeclare" has retired');
      expect(result.message).toContain('use "delete" instead');
    }
    expect(getLane(db, segmentId, "still-declared")).not.toBeNull();
  });

  // MUTATION TARGET (ticket 05 acceptance: "declare 继续工作 must redden a
  // test"). If `declare` were still wired to mint a lane (the retirement
  // check bypassed, or the enum still accepting it), this would observe a
  // SUCCESSFUL mint instead of a named refusal — the observable that
  // distinguishes "still works" from "refuses naming create" is `result.ok`
  // plus the absence of the lane row.
  test("declare no longer works — it refuses, naming create, and mints nothing", () => {
    const segmentId = openSegment();
    // The literal `"declare"` here is DELIBERATE and must not be swept by a
    // rename: this test's whole subject is the retired word being sent.
    const result = evaluate({ action: "declare", id: `E${segmentId}`, tag: "still-alive" } as unknown as SettlementMembershipWriteInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('action "declare" has retired');
      expect(result.message).toContain('use "create" instead');
    }
    expect(getLane(db, segmentId, "still-alive")).toBeNull();
  });
});
// ---------------------------------------------------------------------------
// merge (lane-model-v12 spec D3d, ticket 15) — two declared lanes turn out to
// be one task. Asserted at the FACADE boundary; `tests/db/lanes.merge.test.ts`
// pins the primitive's own moving parts (collision folding, cross-segment
// isolation, atomicity under a failpoint).
// ---------------------------------------------------------------------------

describe("merge — folding one declared lane into another (ticket 15)", () => {
  const evaluate = (input: SettlementMembershipWriteInput) =>
    evaluateSettlementMembershipWrite(db, input, NOW);

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

  test("a merge on a CLOSED segment is refused, the same way create and delete are", () => {
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
        lane: { action: "create", segmentId: 7, tag: "write-gate", laneId: 42 },
      }),
    ).toBe('Landed create: lane "write-gate" on E7 (lane #42).');
  });

  test("a delete receipt says the lane is gone, not that one was minted", () => {
    expect(
      renderSettlementMembershipWriteReceipt({
        lane: { action: "delete", segmentId: 7, tag: "write-gate", laneId: null },
      }),
    ).toBe('Landed delete: lane "write-gate" removed from E7.');
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
            stillCarrying: [],
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
              ...wordEdgeClass("extends"),
              tailTag: "lane-b",
              headTag: "lane-b",
              keptEdgeId: 10,
              keptProvenance: "asserted",
              keptCreatedAtEpoch: 100,
              droppedEdgeId: 11,
              droppedProvenance: "judged",
              droppedCreatedAtEpoch: 90,
              // main-agent-edges ticket 13 (P1-3): the collision rule is
              // `selectLogicalEdgeRow`'s now — same class, so this receipt's
              // OWN example ties on the lowest row id, not provenance.
              rule: "lowest-id",
            },
          ],
          stillCarrying: [],
        },
      },
    });
    expect(rendered).toContain("5 member turn(s) retagged (2 already carried it)");
    expect(rendered).toContain("1 duplicate edge(s) merged");
  });
});