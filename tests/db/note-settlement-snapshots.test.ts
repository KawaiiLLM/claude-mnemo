import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { ensureRecordedEraCutoff } from "../../src/db/era";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  transitionNoteSettlementJobToEdges,
} from "../../src/db/note-settlement";
import {
  laneSnapshotKey,
  readNoteSettlementLaneMemberSnapshot,
  readNoteSettlementWorklistSnapshot,
  readNoteSettlementWritableSnapshot,
  readNoteSettlementWritableTurnIds,
  settlementWritePermissions,
} from "../../src/db/note-settlement-snapshots";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";
import { ERA_GRANT_COLUMN } from "../../src/segment-era";

/**
 * THE THREE TRANSITION SNAPSHOTS (staged-settlement spec Rev 5, §Persisted
 * snapshots; ticket 04).
 *
 * Every test here asserts what the transition WROTE and what a later reader
 * SEES — never a prompt, never an internal call order. The load-bearing claim
 * is that stage 2 re-derives nothing: what stage 1 judged is frozen at the
 * transition, so a retry landing after arbitrary concurrent writes works the
 * same graph its own commit will report numbers for.
 */

const NOW = 1_800_000_000;
const ERA_CUTOFF = NOW - 100_000;

let db: Database;
let sessionDbId: number;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  ensureRecordedEraCutoff(db, ERA_CUTOFF, NOW);
  sessionDbId = upsertSession(db, {
    contentSessionId: "settlement-snapshots-session",
    project: "/tmp/project-settlement-snapshots",
    title: "settlement snapshot fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 200_000,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;
});

afterEach(() => {
  db.close();
});

function seedTurn(
  promptNumber: number,
  options: { createdAtEpoch?: number; tags?: string[] } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, number, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags, was_rolled_back
       ) VALUES (?, ?, 'active', ?, ?, 1, ?, '["design"]', ?, 0)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      options.createdAtEpoch ?? NOW - 900 + promptNumber,
      JSON.stringify(options.tags ?? []),
    )!.id;
}

function setTags(turnId: number, tags: string[]): void {
  db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(
    JSON.stringify(tags),
    turnId,
  );
}

function edge(
  citingId: number,
  citedId: number,
  relation: string,
  laneTag?: string,
): number {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        relation,
        provenance: "asserted",
        ...deriveSideTags(laneTag ? [laneTag] : []),
      },
    ],
    NOW,
  );
  return db
    .query<{ id: number }, [number, number]>(
      "SELECT id FROM memory_edges WHERE citing_id = ? AND cited_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(citingId, citedId)!.id;
}

/** A real task (segment) with one declared lane, and the turns it owns. */
function seedTask(laneTags: string[], memberTurnIds: number[]): number {
  const segment = createSegment(db, {
    title: "snapshot fixture task",
    nowEpoch: NOW - 200_000,
  });
  addSegmentMembers(db, segment.id, memberTurnIds, NOW);
  for (const tag of laneTags) {
    insertLane(db, segment.id, tag, NOW);
  }
  return segment.id;
}

/** A claimed job whose window sits entirely on the era side of the floor. */
function claimJob(windowStart: number, windowEnd: number): { id: number; claimGeneration: number } {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart, windowEnd, triggerType: "consecutive" }],
    NOW,
    ERA_CUTOFF,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { id: job.id, claimGeneration: job.claimGeneration };
}

describe("snapshot 1 — the writable set with its provenance classes", () => {
  test("every ordinary class is stored per id, under window > lookback > closure precedence", () => {
    const windowTurn = seedTurn(10);
    const lookbackTurn = seedTurn(11);
    const closureTurn = seedTurn(12);
    const job = claimJob(10, 12);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        // `lookbackTurn` is offered TWICE — the precedence rule is what keeps
        // it from being filed as a closure endpoint as well.
        window: [windowTurn],
        lookback: [lookbackTurn],
        closure: [closureTurn, lookbackTurn],
        worklist: [],
      },
    });

    const writable = readNoteSettlementWritableSnapshot(db, job.id);
    expect([...(writable.get(windowTurn) ?? [])]).toEqual(["window"]);
    expect([...(writable.get(lookbackTurn) ?? [])]).toEqual(["lookback"]);
    expect([...(writable.get(closureTurn) ?? [])]).toEqual(["closure"]);
    expect(readNoteSettlementWritableTurnIds(db, job.id)).toEqual(
      [windowTurn, lookbackTurn, closureTurn].sort((a, b) => a - b),
    );
  });

  test("a removed-side citer joins the set, and a turn holding BOTH classes takes the union of authorities", () => {
    const citedInWindow = seedTurn(10, { tags: [] });
    const outsideCiter = seedTurn(11);
    const insideCiter = seedTurn(12);
    seedTask(["deleted-lane"], [citedInWindow, outsideCiter, insideCiter]);
    const outsideEdge = edge(outsideCiter, citedInWindow, "extends", "deleted-lane");
    const insideEdge = edge(insideCiter, citedInWindow, "narrows", "deleted-lane");
    const job = claimJob(10, 12);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        // `insideCiter` is a window member in its own right; `outsideCiter` is
        // reachable ONLY through the debt its own edge now carries.
        window: [citedInWindow, insideCiter],
        lookback: [],
        closure: [],
        worklist: [],
        removedLanes: [{ turnId: citedInWindow, laneTag: "deleted-lane" }],
      },
    });

    const writable = readNoteSettlementWritableSnapshot(db, job.id);
    expect([...(writable.get(outsideCiter) ?? [])]).toEqual(["removed-side-citer"]);
    expect([...(writable.get(insideCiter) ?? [])].sort()).toEqual([
      "removed-side-citer",
      "window",
    ]);

    // The union, stated once and consumed by the terminal gate's per-provenance
    // filter: relation-only for the debt alone, full authority the moment an
    // ordinary class is also present.
    expect(settlementWritePermissions(writable.get(outsideCiter)!)).toEqual({
      fields: false,
      relations: true,
    });
    expect(settlementWritePermissions(writable.get(insideCiter)!)).toEqual({
      fields: true,
      relations: true,
    });

    const { debts } = readNoteSettlementWorklistSnapshot(db, job.id);
    expect(debts).toEqual(
      [
        { edgeId: outsideEdge, removedLaneTag: "deleted-lane", citingTurnId: outsideCiter },
        { edgeId: insideEdge, removedLaneTag: "deleted-lane", citingTurnId: insideCiter },
      ].sort((a, b) => a.edgeId - b.edgeId),
    );
  });

  test("a removal on a turn that is only a CITING side owes no debt — its own turn was already writable", () => {
    const citing = seedTurn(10);
    const cited = seedTurn(11);
    seedTask(["deleted-lane"], [citing, cited]);
    edge(citing, cited, "extends", "deleted-lane");
    const job = claimJob(10, 11);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        window: [citing, cited],
        lookback: [],
        closure: [],
        worklist: [],
        // The lane came off the CITING turn. The tail side is stale, but the
        // turn that owns the repair is in the window already.
        removedLanes: [{ turnId: citing, laneTag: "deleted-lane" }],
      },
    });

    expect(readNoteSettlementWorklistSnapshot(db, job.id).debts).toEqual([]);
    const writable = readNoteSettlementWritableSnapshot(db, job.id);
    expect([...(writable.get(citing) ?? [])]).toEqual(["window"]);
  });

  test("a rolled-back citer is never a node, so it is never granted a debt's authority", () => {
    const cited = seedTurn(10);
    const deadCiter = seedTurn(11);
    seedTask(["deleted-lane"], [cited, deadCiter]);
    edge(deadCiter, cited, "extends", "deleted-lane");
    db.query<unknown, [number]>("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(
      deadCiter,
    );
    const job = claimJob(10, 11);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        window: [cited],
        lookback: [],
        closure: [],
        worklist: [],
        removedLanes: [{ turnId: cited, laneTag: "deleted-lane" }],
      },
    });

    expect(readNoteSettlementWorklistSnapshot(db, job.id).debts).toEqual([]);
    expect(readNoteSettlementWritableSnapshot(db, job.id).has(deadCiter)).toBe(false);
  });
});

describe("snapshot 2 — the ordered worklist", () => {
  test("a synonym-reused lane with ZERO stage-1 mutations is on the worklist, in the order stage 1 gave", () => {
    const windowTurn = seedTurn(10, { tags: ["fresh-lane"] });
    const oldMember = seedTurn(11, { tags: ["legacy-lane"] });
    const segmentId = seedTask(["fresh-lane", "legacy-lane"], [windowTurn, oldMember]);
    const job = claimJob(10, 11);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        window: [windowTurn],
        lookback: [],
        closure: [],
        // `legacy-lane` is the synonym reuse: stage 1 wrote NOTHING onto it —
        // no member gained the tag, no member lost one — and it is on the
        // worklist all the same, because stage 2 must still link within it.
        worklist: [
          { segmentId, laneTag: "fresh-lane" },
          { segmentId, laneTag: "legacy-lane" },
        ],
      },
    });

    const { lanes } = readNoteSettlementWorklistSnapshot(db, job.id);
    expect(lanes).toEqual([
      { segmentId, laneTag: "fresh-lane" },
      { segmentId, laneTag: "legacy-lane" },
    ]);
    // And it is not an empty entry: the untouched lane's own membership is
    // frozen beside the touched one's.
    const members = readNoteSettlementLaneMemberSnapshot(db, job.id);
    expect(members.get(laneSnapshotKey(segmentId, "legacy-lane"))).toEqual([oldMember]);
    expect(members.get(laneSnapshotKey(segmentId, "fresh-lane"))).toEqual([windowTurn]);
  });
});

describe("snapshot 3 — per-lane member snapshots, era-INCLUSIVE for this job's own members", () => {
  test("an allow_pre_era window's freshly-laned pre-era members are in the snapshot, while ordinary lane recall still hides them (the T1964 shape)", () => {
    // A pre-era turn: born before the cutoff, holding no grant. Stage 1 has
    // just laned it; the grant is stage 2's terminal commit's to write.
    const preEraTurn = seedTurn(1, {
      createdAtEpoch: ERA_CUTOFF - 5_000,
      tags: ["carried-lane"],
    });
    const eraTurn = seedTurn(10, {
      createdAtEpoch: ERA_CUTOFF + 5_000,
      tags: ["carried-lane"],
    });
    const segmentId = seedTask(["carried-lane"], [preEraTurn, eraTurn]);
    const job = claimJob(10, 11);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        window: [preEraTurn],
        lookback: [],
        closure: [],
        worklist: [{ segmentId, laneTag: "carried-lane" }],
      },
    });

    // HALF A ∪ HALF B: the job's own freshly-laned member REGARDLESS of era,
    // plus the historical member already era-visible.
    expect(
      readNoteSettlementLaneMemberSnapshot(db, job.id).get(
        laneSnapshotKey(segmentId, "carried-lane"),
      ),
    ).toEqual([preEraTurn, eraTurn].sort((a, b) => a - b));

    // Ordinary lane recall is era-filtered and must NOT show the pre-era member
    // yet — global visibility is the terminal commit's to grant.
    const before = recallMemory(db, {
      id: `E${segmentId}/#carried-lane`,
      eraCutoffEpoch: ERA_CUTOFF,
    });
    // `[T1] ` and `[T10] ` are distinguishable prefixes — the trailing space is
    // what keeps the pre-era turn's absence from being read off T10's row.
    expect(before).toContain("[T10] ");
    expect(before).not.toContain("[T1] ");

    // The terminal commit's era grant, and nothing else, is what publishes it.
    db.query<unknown, [number, number]>(
      `UPDATE turns SET ${ERA_GRANT_COLUMN} = ? WHERE id = ?`,
    ).run(NOW, preEraTurn);

    const after = recallMemory(db, {
      id: `E${segmentId}/#carried-lane`,
      eraCutoffEpoch: ERA_CUTOFF,
    });
    expect(after).toContain("[T1] ");
    expect(after).toContain("[T10] ");
  });

  test("a turn carrying the word but owned by ANOTHER task is not a member — membership is scoped to the owning task", () => {
    const ourMember = seedTurn(10, { tags: ["shared-word"] });
    const foreign = seedTurn(11, { tags: ["shared-word"] });
    const segmentId = seedTask(["shared-word"], [ourMember]);
    const otherSegment = createSegment(db, {
      title: "another task",
      nowEpoch: NOW - 200_000,
    });
    addSegmentMembers(db, otherSegment.id, [foreign], NOW);
    const job = claimJob(10, 11);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        window: [ourMember, foreign],
        lookback: [],
        closure: [],
        worklist: [{ segmentId, laneTag: "shared-word" }],
      },
    });

    expect(
      readNoteSettlementLaneMemberSnapshot(db, job.id).get(
        laneSnapshotKey(segmentId, "shared-word"),
      ),
    ).toEqual([ourMember]);
  });
});

describe("the snapshots are frozen — stage 2 and its retries re-derive nothing", () => {
  test("a retry after concurrent external edge and membership writes reads byte-identical snapshots", () => {
    const windowTurn = seedTurn(10, { tags: ["frozen-lane"] });
    const cited = seedTurn(11);
    const segmentId = seedTask(["frozen-lane"], [windowTurn, cited]);
    edge(windowTurn, cited, "extends", "frozen-lane");
    const job = claimJob(10, 11);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: {
        window: [windowTurn],
        lookback: [cited],
        closure: [],
        worklist: [{ segmentId, laneTag: "frozen-lane" }],
      },
    });

    const firstRead = {
      writable: readNoteSettlementWritableTurnIds(db, job.id),
      worklist: readNoteSettlementWorklistSnapshot(db, job.id),
      members: [...readNoteSettlementLaneMemberSnapshot(db, job.id)],
    };

    // Everything a stage-2 retry could otherwise pick up if it re-derived:
    // a new edge, a new lane member, a new segment member.
    const latecomer = seedTurn(12, { tags: ["frozen-lane"] });
    addSegmentMembers(db, segmentId, [latecomer], NOW + 10);
    edge(latecomer, windowTurn, "narrows", "frozen-lane");
    setTags(cited, ["frozen-lane"]);

    expect({
      writable: readNoteSettlementWritableTurnIds(db, job.id),
      worklist: readNoteSettlementWorklistSnapshot(db, job.id),
      members: [...readNoteSettlementLaneMemberSnapshot(db, job.id)],
    }).toEqual(firstRead);
    expect(firstRead.members[0]![1]).not.toContain(latecomer);
  });

  test("a REFUSED transition writes no snapshot at all — the whole thing is one fenced transaction", () => {
    const windowTurn = seedTurn(10, { tags: ["frozen-lane"] });
    const segmentId = seedTask(["frozen-lane"], [windowTurn]);
    const job = claimJob(10, 10);

    const refused = transitionNoteSettlementJobToEdges(
      db,
      job.id,
      job.claimGeneration + 1,
      NOW,
      {
        snapshots: {
          window: [windowTurn],
          lookback: [],
          closure: [],
          worklist: [{ segmentId, laneTag: "frozen-lane" }],
        },
      },
    );

    expect(refused).toBeNull();
    expect(readNoteSettlementWritableTurnIds(db, job.id)).toEqual([]);
    expect(readNoteSettlementWorklistSnapshot(db, job.id).lanes).toEqual([]);
    expect(readNoteSettlementLaneMemberSnapshot(db, job.id).size).toBe(0);
    expect(getNoteSettlementJob(db, job.id)!.stage).toBe("topics");
  });

  test("the transition's own sequence value is read OFF THE ROW, never re-derived", () => {
    const windowTurn = seedTurn(10);
    const job = claimJob(10, 10);

    transitionNoteSettlementJobToEdges(db, job.id, job.claimGeneration, NOW, {
      snapshots: { window: [windowTurn], lookback: [], closure: [], worklist: [] },
      homelessGroups: [
        {
          taskScopeId: 0,
          canonicalLabel: "a group with no legal container",
          memberFingerprint: `fp-${windowTurn}`,
          reason: "no legal task container",
          turnIds: [windowTurn],
        },
      ],
    });

    const row = getNoteSettlementJob(db, job.id)!;
    expect(row.stage).toBe("edges");
    expect(row.transitionSeq).not.toBeNull();
    // The homeless record the SAME transaction wrote carries exactly the value
    // the row reports — never a MAX() re-derivation, which a deleted job row
    // would let repeat.
    expect(
      db
        .query<{ transitionSeq: number }, [number]>(
          "SELECT transition_seq AS transitionSeq FROM homeless_groups WHERE job_id = ?",
        )
        .get(job.id)!.transitionSeq,
    ).toBe(row.transitionSeq);
  });
});
