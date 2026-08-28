import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { buildTurnRelationLines } from "../../src/mcp/relations-view";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import {
  buildSegmentLaneListView,
  DEFAULT_LANE_CHAIN_ITEM_BUDGET,
  timelineQuery,
} from "../../src/mcp/timeline";

/**
 * Island-view spec (ticket 13): the lane view's single representative chain
 * becomes one tree per connected component, and `timeline` learns a node
 * selector. `tests/mcp/timeline.lane-view.test.ts` still carries the header/
 * pagination/crossing-edge coverage this ticket did not touch; this file
 * targets ticket 13's own acceptance criteria directly.
 */

const NOW = 1_755_000_000;

let db: Database;

function seedSession(label = "island-view"): number {
  return upsertSession(db, {
    contentSessionId: `${label}-${Math.random()}`,
    project: `/tmp/${label}`,
    title: label,
    content: null,
    insight: null,
    createdAtEpoch: NOW,
    updatedAtEpoch: NOW,
    completedAtEpoch: null,
  }).id;
}

function insertTurn(sessionId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', 'p', 'r', 1, ?, '["design"]', '[]')
       RETURNING id`,
    )
    .get(sessionId, promptNumber, NOW + promptNumber)!.id;
}

function claimLaneTags(turnId: number, tags: readonly string[]): void {
  const next = JSON.stringify(tags);
  db.query<unknown, [string, number]>("UPDATE turns SET tags = ? WHERE id = ?").run(next, turnId);
}

function tagEdge(citingId: number, citedId: number, relation: string, tags: readonly string[]): void {
  writeMemoryEdges(
    db,
    [
      {
        citing: { kind: "turn", id: citingId },
        cited: { kind: "turn", id: citedId },
        relation: relation as never,
        provenance: "asserted",
        ...deriveSideTags(tags),
      },
    ],
    NOW,
  );
  claimLaneTags(citingId, tags);
  claimLaneTags(citedId, tags);
}

beforeEach(() => {
  process.env.TZ = "UTC";
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe("per-island trees (ticket 13 decision 1)", () => {
  test("a two-island fixture renders two trees, blank-line separated, each rooted at its own island's newest member, (k) = island size", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    // Island A: two members, older overall.
    const a1 = insertTurn(sessionId, 1);
    const a2 = insertTurn(sessionId, 2);
    // Island B: three members, newer overall (so it sorts first).
    const b1 = insertTurn(sessionId, 10);
    const b2 = insertTurn(sessionId, 11);
    const b3 = insertTurn(sessionId, 12);
    addSegmentMembers(db, segment.id, [a1, a2, b1, b2, b3], NOW);
    insertLane(db, segment.id, "two-islands", NOW);
    tagEdge(a2, a1, "extends", ["two-islands"]);
    tagEdge(b2, b1, "extends", ["two-islands"]);
    tagEdge(b3, b2, "narrows", ["two-islands"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    const lane = view.lanes.find((entry) => entry.key.tag === "two-islands")!;
    expect(lane.islands).toHaveLength(2);
    // Ticket 15 ([S15069/T1925] "timeline应该都是时间升序"): islands ASCEND —
    // island A (root a2, prompt 2) before island B (root b3, prompt 12).
    expect(lane.islands[0]!.memberIds).toEqual([a1, a2]);
    expect(lane.islands[0]!.lines).toEqual([`S${sessionId}/T2 -extends-> T1(2)`]);
    expect(lane.islands[1]!.memberIds).toEqual([b1, b2, b3]);
    expect(lane.islands[1]!.lines).toEqual([`S${sessionId}/T12 -narrows-> T11 -extends-> T10(3)`]);

    const rendered = timelineQuery(db, { id: `E${segment.id}/L*` });
    // Both trees present, blank line between them, island A's block first.
    const laneAStart = rendered.indexOf(`S${sessionId}/T2 -extends-> T1(2)`);
    const laneBStart = rendered.indexOf(`S${sessionId}/T12`);
    expect(laneAStart).toBeGreaterThan(-1);
    expect(laneBStart).toBeGreaterThan(laneAStart);
    expect(rendered).toContain("\n\n"); // the blank-line island separator
  });

  // The structural gap island trees fix (settled [S15069/T1915]): an
  // out-only walk from the newest member reaches C via A but has no reason
  // to ever visit B, even though B->C makes B structurally part of the same
  // island. Bidirectional expansion (decision 3) is what recovers it.
  test("the A->C<-B shape renders ALL THREE nodes in one tree (B reached via an in-edge)", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const a = insertTurn(sessionId, 3); // newest -> root
    const c = insertTurn(sessionId, 2);
    const b = insertTurn(sessionId, 1);
    addSegmentMembers(db, segment.id, [a, b, c], NOW);
    insertLane(db, segment.id, "fan-in", NOW);
    tagEdge(a, c, "extends", ["fan-in"]);
    tagEdge(b, c, "indexes", ["fan-in"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    const lane = view.lanes.find((entry) => entry.key.tag === "fan-in")!;
    // One island, not two — buildComponentReport's own undirected union
    // already agrees they are connected; the OLD out-only chain would still
    // have missed rendering B even though the partition was already right.
    expect(lane.islands).toHaveLength(1);
    expect(lane.islands[0]!.memberIds.slice().sort((p, q) => p - q)).toEqual([a, b, c].sort((p, q) => p - q));
    const text = lane.islands[0]!.lines.join("\n");
    expect(text).toContain(`S${sessionId}/T3`);
    expect(text).toContain("T2");
    expect(text).toContain("T1");
    expect(text).toContain("-extends-> T2");
    expect(text).toContain("<-indexes- T1");
  });

  test("^ dedupe works across the whole island tree, not just within one branch", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const root = insertTurn(sessionId, 3); // newest
    const x = insertTurn(sessionId, 2);
    const y = insertTurn(sessionId, 1);
    addSegmentMembers(db, segment.id, [root, x, y], NOW);
    insertLane(db, segment.id, "reconverge", NOW);
    // Root forks: extends beats indexes on rank, so X leads the main chain;
    // Y is root's OTHER branch. But X's own edge already reaches Y first
    // (bidirectional expansion sweeps it into the main chain), so Y's own
    // queued branch finds itself already rendered.
    tagEdge(root, x, "extends", ["reconverge"]);
    tagEdge(root, y, "indexes", ["reconverge"]);
    tagEdge(y, x, "narrows", ["reconverge"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    const lane = view.lanes.find((entry) => entry.key.tag === "reconverge")!;
    expect(lane.islands).toHaveLength(1);
    const island = lane.islands[0]!;
    expect(island.memberIds.slice().sort((p, q) => p - q)).toEqual([root, x, y].sort((p, q) => p - q));
    const text = island.lines.join("\n");
    // Y appears exactly once as a real node (main chain, reached via X's own
    // in-edge) and once more marked `^` (the branch that reconverges on it).
    expect((text.match(/T1/g) ?? []).length).toBe(2);
    expect(text).toContain("T1 ^");
    expect(island.lines[island.lines.length - 1]).toContain(`(${island.memberIds.length})`);
  });

  test("a truncated island ends -> ..(k) with k the FULL island size", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const total = DEFAULT_LANE_CHAIN_ITEM_BUDGET + 4;
    const ids: number[] = [];
    for (let i = total; i >= 1; i -= 1) {
      ids.push(insertTurn(sessionId, i));
    }
    addSegmentMembers(db, segment.id, ids, NOW);
    insertLane(db, segment.id, "long-island", NOW);
    for (let i = 0; i < ids.length - 1; i += 1) {
      tagEdge(ids[i]!, ids[i + 1]!, "extends", ["long-island"]);
    }

    const view = buildSegmentLaneListView(db, segment.id, "all");
    const lane = view.lanes.find((entry) => entry.key.tag === "long-island")!;
    expect(lane.islands).toHaveLength(1);
    const island = lane.islands[0]!;
    expect(island.memberIds).toHaveLength(total);
    expect(island.truncated).toBe(true);
    expect(island.renderedTurnIds).toHaveLength(DEFAULT_LANE_CHAIN_ITEM_BUDGET);
    const lastLine = island.lines[island.lines.length - 1]!;
    expect(lastLine).toContain(`-> ..(${total})`);
  });
});

describe("timeline node selector (ticket 13 decision 5)", () => {
  test('timeline(id="S<n>/T<m>") renders the header row plus the SAME tree bytes recall\'s relations field produces', () => {
    const sessionId = seedSession();
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    const t3 = insertTurn(sessionId, 3);
    db.query<unknown, [string, number]>("UPDATE turns SET title = ? WHERE id = ?").run("root turn", t3);
    tagEdge(t3, t2, "extends", []);
    tagEdge(t2, t1, "narrows", []);

    const turn = getTurn(db, sessionId, 3)!;
    const expectedTreeLines = buildTurnRelationLines(db, { id: turn.id, sessionId, promptNumber: 3 });

    const nodeOutput = timelineQuery(db, { id: `S${sessionId}/T3` });
    const bodyLines = nodeOutput.split("\n");
    // Header row: `[S<n>/T<m>] MM-DD <emoji> <title>`.
    expect(bodyLines[0]).toMatch(new RegExp(`^\\[S${sessionId}/T3\\] \\d{2}-\\d{2} .+ root turn$`));
    // Everything after the header is exactly the tree recall's own relations
    // field renders for the same turn — modulo the header, byte-identical.
    const treeBody = bodyLines.slice(1).join("\n");
    expect(treeBody).toBe(expectedTreeLines.join("\n"));
    expect(treeBody).toContain("-extends-> T2");
  });

  test("an invalid turn address still errors with the existing id-grammar message shape", () => {
    const sessionId = seedSession();
    insertTurn(sessionId, 1);
    // Malformed grammar (not the clean `S<n>/T<m>` the node selector matches)
    // falls through to the pre-existing route and its established error.
    const malformed = timelineQuery(db, { id: `S${sessionId}/Tabc` });
    expect(malformed).toContain("timeline error:");
    expect(malformed).toContain("range syntax not recognized");
  });

  test("a syntactically legal but nonexistent turn address errors clearly, not silently", () => {
    const sessionId = seedSession();
    insertTurn(sessionId, 1);
    const missing = timelineQuery(db, { id: `S${sessionId}/T999` });
    expect(missing).toContain("timeline error:");
    expect(missing).toContain("not found");
  });
});
