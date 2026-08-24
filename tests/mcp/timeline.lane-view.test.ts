import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { timelineInputSchema } from "../../src/mcp/definitions";
import {
  buildSegmentLaneListView,
  DEFAULT_LANE_CHAIN_ITEM_BUDGET,
  parseSegmentLaneId,
  renderSegmentLaneView,
  selectLaneChainPath,
  timelineQuery,
} from "../../src/mcp/timeline";

/**
 * Ticket 07 (lane-declaration spec D8): `timeline(id="E<n>/L*")` (list) and
 * `timeline(id="E<n>/L<n>")` (one lane) — a segment's declared lanes as one
 * header line plus one representative chain each.
 */

const NOW = 1_755_000_000; // 2025-08-12ish — real epoch so MM-DD HH:mm renders sane

let db: Database;

function seedSession(label = "lane-view"): number {
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

/** `createdAtEpoch` tracks `promptNumber` (later prompt = later epoch), matching `tests/db/lane-checker-load.test.ts`'s own convention. */
function insertTurn(
  sessionId: number,
  promptNumber: number,
  options: { type?: string[] } = {},
): number {
  return db
    .query<{ id: number }, [number, number, number, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', 'p', 'r', 1, ?, ?, '[]')
       RETURNING id`,
    )
    .get(sessionId, promptNumber, NOW + promptNumber, JSON.stringify(options.type ?? ["design"]))!.id;
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
        tags,
      },
    ],
    NOW,
  );
}

beforeEach(() => {
  process.env.TZ = "UTC";
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe("parseSegmentLaneId", () => {
  test("matches E<n>/L* and E<n>/L<n>, case-insensitively", () => {
    expect(parseSegmentLaneId("E60/L*")).toEqual({ segmentId: 60, laneIndex: "all" });
    expect(parseSegmentLaneId("e60/l*")).toEqual({ segmentId: 60, laneIndex: "all" });
    expect(parseSegmentLaneId("E60/L3")).toEqual({ segmentId: 60, laneIndex: 3 });
    expect(parseSegmentLaneId("e60/l3")).toEqual({ segmentId: 60, laneIndex: 3 });
  });

  test("rejects everything that is not the E<n>/L form", () => {
    expect(parseSegmentLaneId("E60")).toBeNull();
    expect(parseSegmentLaneId("E60/T3")).toBeNull();
    expect(parseSegmentLaneId("S60")).toBeNull();
    expect(parseSegmentLaneId("S60/L3")).toBeNull();
    expect(parseSegmentLaneId("E60/L")).toBeNull();
  });
});

describe("timelineInputSchema accepts the spec's own literal call", () => {
  test('view: "lane" parses', () => {
    const parsed = timelineInputSchema.parse({ id: "E60/L*", view: "lane" });
    expect(parsed.view).toBe("lane");
  });
});

describe("header composition", () => {
  test("modal type emoji ties break by the rubric's own type order, and the trailing (N) is the member count", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    // MEMORY_TYPES order: discuss, research, design, implement, ... — "design"
    // (rank 2) must beat "implement" (rank 3) under an exact count tie.
    const t1 = insertTurn(sessionId, 1, { type: ["implement"] });
    const t2 = insertTurn(sessionId, 2, { type: ["design"] });
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "tie-tag", NOW);
    tagEdge(t2, t1, "extends", ["tie-tag"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    expect(view.lanes).toHaveLength(1);
    expect(view.lanes[0]!.headerEmoji).toBe("⚖️"); // design's glyph, per shared/type-vocabulary.ts
    expect(view.lanes[0]!.memberCount).toBe(2);

    const rendered = renderSegmentLaneView(view);
    expect(rendered).toContain("[L1]");
    expect(rendered).toContain("⚖️ tie-tag");
    expect(rendered).toContain(`(2)`);
  });

  test("header time is the lane's NEWEST member's time, not the oldest or the declaration time", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 50); // far newer
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "time-tag", NOW);
    tagEdge(t2, t1, "extends", ["time-tag"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    expect(view.lanes[0]!.headerEpoch).toBe(NOW + 50);
  });
});

describe("path selection is NOT greedy (peer finding P2-7)", () => {
  test("a diamond where the two-hop branch is newer loses to the five-hop branch on total coverage", () => {
    // Pure unit test of the DP itself, isolated from any DB/rendering
    // concern: N0's two children are BOTH `extends` (tied relation rank),
    // but branch B reaches 5 more nodes than branch A's dead end.
    const edgesByCitingId = new Map<number, Array<{ citedId: number; relation: string }>>([
      [0, [{ citedId: 1, relation: "extends" }, { citedId: 2, relation: "extends" }]], // N0 -> N1(short) / N2(long)
      [2, [{ citedId: 3, relation: "extends" }]],
      [3, [{ citedId: 4, relation: "extends" }]],
      [4, [{ citedId: 5, relation: "extends" }]],
      [5, [{ citedId: 6, relation: "extends" }]],
    ]);
    // Recency (order) favors the SHORT branch (node 1 is newer than node 2) —
    // a greedy "relation-then-recency" walker would follow node 1 and stop.
    const turnsById = new Map<number, { id: number; type: string[]; order: readonly [number, number]; createdAtEpoch: number }>([
      [0, { id: 0, type: [], order: [0, 10], createdAtEpoch: NOW + 10 }],
      [1, { id: 1, type: [], order: [0, 9], createdAtEpoch: NOW + 9 }], // newer than node 2
      [2, { id: 2, type: [], order: [0, 5], createdAtEpoch: NOW + 5 }],
      [3, { id: 3, type: [], order: [0, 4], createdAtEpoch: NOW + 4 }],
      [4, { id: 4, type: [], order: [0, 3], createdAtEpoch: NOW + 3 }],
      [5, { id: 5, type: [], order: [0, 2], createdAtEpoch: NOW + 2 }],
      [6, { id: 6, type: [], order: [0, 1], createdAtEpoch: NOW + 1 }],
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = selectLaneChainPath(0, edgesByCitingId, turnsById as any);
    expect(path.map((step) => step.turnId)).toEqual([0, 2, 3, 4, 5, 6]);
  });

  test("a greedy relation-then-recency walk (the rejected design) would have shown the SHORT branch — pinning the failure this ticket fixes", () => {
    // Same fixture, hand-rolled greedy walk: at each fork, pick the best
    // relation rank, tie-broken by recency alone (no downstream coverage) —
    // exactly the design the peer review killed.
    function greedyWalk(
      start: number,
      edgesByCitingId: ReadonlyMap<number, Array<{ citedId: number; relation: string; order: number }>>,
    ): number[] {
      const path = [start];
      let current = start;
      for (;;) {
        const children = edgesByCitingId.get(current);
        if (!children || children.length === 0) break;
        const best = [...children].sort((a, b) => b.order - a.order)[0]!; // newest wins a relation tie
        path.push(best.citedId);
        current = best.citedId;
      }
      return path;
    }
    const edgesByCitingId = new Map([
      [0, [{ citedId: 1, relation: "extends", order: 9 }, { citedId: 2, relation: "extends", order: 5 }]],
    ]);
    expect(greedyWalk(0, edgesByCitingId)).toEqual([0, 1]); // hides the 5-node branch — the failure figure
  });

  test("end-to-end over a real DB fixture: the rendered chain follows the longer branch, and the total member count still names the whole lane (7)", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const n0 = insertTurn(sessionId, 10); // newest
    const n1a = insertTurn(sessionId, 9); // short branch, NEWER than the long branch's own start
    const n1b = insertTurn(sessionId, 5);
    const n2b = insertTurn(sessionId, 4);
    const n3b = insertTurn(sessionId, 3);
    const n4b = insertTurn(sessionId, 2);
    const n5b = insertTurn(sessionId, 1);
    addSegmentMembers(db, segment.id, [n0, n1a, n1b, n2b, n3b, n4b, n5b], NOW);
    insertLane(db, segment.id, "diamond", NOW);
    tagEdge(n0, n1a, "extends", ["diamond"]);
    tagEdge(n0, n1b, "extends", ["diamond"]);
    tagEdge(n1b, n2b, "extends", ["diamond"]);
    tagEdge(n2b, n3b, "extends", ["diamond"]);
    tagEdge(n3b, n4b, "extends", ["diamond"]);
    tagEdge(n4b, n5b, "extends", ["diamond"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    expect(view.lanes).toHaveLength(1);
    const lane = view.lanes[0]!;
    expect(lane.memberCount).toBe(7);
    expect(lane.nodes.map((node) => node.turnId)).toEqual([n0, n1b, n2b, n3b, n4b, n5b]);
    expect(lane.nodes.some((node) => node.turnId === n1a)).toBe(false);
    expect(lane.truncated).toBe(false); // 6 nodes fit the default budget (8)

    const rendered = renderSegmentLaneView(view);
    expect(rendered).toContain(`T${n0} -> T${n1b} -> T${n2b} -> T${n3b} -> T${n4b} -> T${n5b}(7)`);
    expect(rendered).not.toContain(`T${n1a}`);
  });
});

describe("=> vs -> and the ◎ terminus marker", () => {
  test("=> marks the edge into an indexed node; ◎ marks the current terminus", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2); // terminus: t2 --indexes--> t1
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "arc", NOW);
    tagEdge(t2, t1, "indexes", ["arc"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    const rendered = renderSegmentLaneView(view);
    expect(rendered).toContain(`◎T${t2} => T${t1}(2)`);
  });
});

describe("addresses: bare / E<seg>/ / S<session>/", () => {
  // The lane model's own domain (lane-checker.ts's D5 doc: "A lane's DAG is
  // every live edge carrying that tag with an endpoint in that segment") means
  // a homeless member three hops away through ANOTHER segment never joins the
  // VIEWED segment's own lane copy at all — only an edge with an endpoint
  // directly in the viewed segment does. So each prefix case gets its own
  // isolated two-node lane rather than one combined diamond.
  test("a turn inside the viewed segment renders bare", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "viewed", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "in-seg", NOW);
    tagEdge(t2, t1, "extends", ["in-seg"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    const lane = view.lanes.find((entry) => entry.key.tag === "in-seg")!;
    const byId = new Map(lane.nodes.map((node) => [node.turnId, node]));
    expect(byId.get(t1)!.addressPrefix).toBe("");
    expect(byId.get(t2)!.addressPrefix).toBe("");
    expect(renderSegmentLaneView(view)).toContain(`T${t2} -> T${t1}(2)`);
  });

  test("a turn owned by another (declared) segment carries E<seg>/", () => {
    const sessionId = seedSession();
    const otherSessionId = seedSession("other");
    const viewedSegment = createSegment(db, { title: "viewed", nowEpoch: NOW });
    const otherSegment = createSegment(db, { title: "other", nowEpoch: NOW });
    const inViewed = insertTurn(sessionId, 10);
    const inOther = insertTurn(otherSessionId, 1);
    addSegmentMembers(db, viewedSegment.id, [inViewed], NOW);
    addSegmentMembers(db, otherSegment.id, [inOther], NOW);
    insertLane(db, viewedSegment.id, "cross", NOW);
    insertLane(db, otherSegment.id, "cross", NOW); // D2: both sides must declare
    tagEdge(inViewed, inOther, "consume", ["cross"]);

    const view = buildSegmentLaneListView(db, viewedSegment.id, "all");
    const lane = view.lanes.find((entry) => entry.key.tag === "cross")!;
    const byId = new Map(lane.nodes.map((node) => [node.turnId, node]));
    expect(byId.get(inViewed)!.addressPrefix).toBe("");
    expect(byId.get(inOther)!.addressPrefix).toBe(`E${otherSegment.id}/`);
    expect(renderSegmentLaneView(view)).toContain(`T${inViewed} -> E${otherSegment.id}/T${inOther}(2)`);
  });

  test("a homeless turn (no owning segment) carries S<session>/", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "viewed", nowEpoch: NOW });
    const inViewed = insertTurn(sessionId, 10);
    const homeless = insertTurn(sessionId, 1); // never added to any segment
    addSegmentMembers(db, segment.id, [inViewed], NOW);
    insertLane(db, segment.id, "homeless-case", NOW);
    tagEdge(inViewed, homeless, "consume", ["homeless-case"]);

    const view = buildSegmentLaneListView(db, segment.id, "all");
    const lane = view.lanes.find((entry) => entry.key.tag === "homeless-case")!;
    const byId = new Map(lane.nodes.map((node) => [node.turnId, node]));
    expect(byId.get(inViewed)!.addressPrefix).toBe("");
    expect(byId.get(homeless)!.addressPrefix).toBe(`S${sessionId}/`);
    expect(renderSegmentLaneView(view)).toContain(`T${inViewed} -> S${sessionId}/T${homeless}(2)`);
  });
});

describe("budget truncation", () => {
  test("a chain longer than the item budget shows exactly the budget's worth of nodes, then -> ...(N)", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const total = DEFAULT_LANE_CHAIN_ITEM_BUDGET + 3;
    const ids: number[] = [];
    for (let i = total; i >= 1; i -= 1) {
      ids.push(insertTurn(sessionId, i));
    }
    addSegmentMembers(db, segment.id, ids, NOW);
    insertLane(db, segment.id, "long", NOW);
    for (let i = 0; i < ids.length - 1; i += 1) {
      tagEdge(ids[i]!, ids[i + 1]!, "extends", ["long"]);
    }

    const view = buildSegmentLaneListView(db, segment.id, "all");
    const lane = view.lanes[0]!;
    expect(lane.memberCount).toBe(total);
    expect(lane.nodes).toHaveLength(DEFAULT_LANE_CHAIN_ITEM_BUDGET);
    expect(lane.truncated).toBe(true);

    const rendered = renderSegmentLaneView(view);
    expect(rendered).toContain(`-> ...(${total})`);
    // The node just past the budget must NOT appear.
    expect(rendered).not.toContain(`T${ids[DEFAULT_LANE_CHAIN_ITEM_BUDGET]}`);
  });

  test("a chain that fits within budget renders with no ellipsis, just the direct (N) tail", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "short", NOW);
    tagEdge(t2, t1, "extends", ["short"]);

    const rendered = renderSegmentLaneView(buildSegmentLaneListView(db, segment.id, "all"));
    expect(rendered).not.toContain("...");
    expect(rendered).toContain(`T${t2} -> T${t1}(2)`);
  });
});

describe("list ordering and single-lane addressing (E<n>/L<n>)", () => {
  test("lanes render newest-first, and E<n>/L<n> keeps the SAME [L<n>] label as the full list", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const older1 = insertTurn(sessionId, 1);
    const older2 = insertTurn(sessionId, 2);
    const newer1 = insertTurn(sessionId, 20);
    const newer2 = insertTurn(sessionId, 21);
    addSegmentMembers(db, segment.id, [older1, older2, newer1, newer2], NOW);
    insertLane(db, segment.id, "old-lane", NOW);
    insertLane(db, segment.id, "new-lane", NOW);
    tagEdge(older2, older1, "extends", ["old-lane"]);
    tagEdge(newer2, newer1, "extends", ["new-lane"]);

    const listed = buildSegmentLaneListView(db, segment.id, "all");
    expect(listed.lanes.map((lane) => lane.key.tag)).toEqual(["new-lane", "old-lane"]);
    expect(listed.lanes[0]!.laneIndex).toBe(1);
    expect(listed.lanes[1]!.laneIndex).toBe(2);

    const single = buildSegmentLaneListView(db, segment.id, 2);
    expect(single.lanes).toHaveLength(1);
    expect(single.lanes[0]!.key.tag).toBe("old-lane");
    expect(single.lanes[0]!.laneIndex).toBe(2); // NOT renumbered to 1

    const renderedList = renderSegmentLaneView(listed);
    const renderedSingle = renderSegmentLaneView(single);
    expect(renderedList).toContain("[L2] ");
    expect(renderedSingle.split("\n")[0]).toBe(renderedList.split("\n")[2]); // same header line, byte for byte
  });

  test("an out-of-range ordinal is a clear error via timelineQuery", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const output = timelineQuery(db, { id: `E${segment.id}/L1` });
    expect(output).toContain("timeline error");
    expect(output).toContain("out of range");
  });

  test("a segment with zero declared lanes renders a friendly empty message, not an error", () => {
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const output = timelineQuery(db, { id: `E${segment.id}/L*` });
    expect(output).not.toContain("timeline error");
    expect(output).toContain("no lanes declared");
  });
});

describe("timelineQuery end-to-end wiring", () => {
  test("E<n>/L* and E<n>/L<n> route through timelineQuery and record read grants", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "seg", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1);
    const t2 = insertTurn(sessionId, 2);
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "wired", NOW);
    tagEdge(t2, t1, "extends", ["wired"]);

    const listOutput = timelineQuery(db, { id: `E${segment.id}/L*`, view: "lane" });
    expect(listOutput).toContain("[L1]");
    expect(listOutput).toContain("wired");

    const singleOutput = timelineQuery(db, { id: `E${segment.id}/L1` });
    expect(singleOutput).toContain("[L1]");
    expect(singleOutput).toContain("wired");
    // Same lane, same two rendered lines, whether reached via the list or
    // the single-lane address.
    const [listHeader, listChain] = listOutput.split("\n");
    const [singleHeader, singleChain] = singleOutput.split("\n");
    expect(singleHeader).toBe(listHeader);
    expect(singleChain).toBe(listChain);
  });

  // `view: "lane"` on a bare `E<n>` is the same request spelled the other way,
  // not an inert parameter: silently handing back the turns view is the shape
  // the user ruled against, since the caller then reads a view they did not
  // ask for with nothing saying so.
  test("a bare E<n> id with view=\"lane\" renders the lane list, exactly as the /L* suffix would", () => {
    const sessionId = seedSession();
    const segment = createSegment(db, { title: "bare-e-with-lane-view", nowEpoch: NOW });
    const t1 = insertTurn(sessionId, 1, { type: ["design"] });
    const t2 = insertTurn(sessionId, 2, { type: ["design"] });
    addSegmentMembers(db, segment.id, [t1, t2], NOW);
    insertLane(db, segment.id, "bare-view-lane", NOW);
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t2 },
          cited: { kind: "turn", id: t1 },
          relation: "extends",
          provenance: "asserted",
          tags: ["bare-view-lane"],
        },
      ],
      NOW,
    );

    const viaView = timelineQuery(db, { id: `E${segment.id}`, view: "lane" as never });
    const viaSuffix = timelineQuery(db, { id: `E${segment.id}/L*` });
    expect(viaView).not.toContain("timeline error");
    expect(viaView).toContain("bare-view-lane");
    expect(viaView).toBe(viaSuffix);
  });
});
