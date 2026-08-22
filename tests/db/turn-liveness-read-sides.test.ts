import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  computeSegmentMemberFacetCounts,
  createSegment,
} from "../../src/db/segments";
import { rankSegmentMembers } from "../../src/db/segment-rank";
import { upsertSession } from "../../src/db/sessions";
import { buildTimelineView, renderTimeline } from "../../src/mcp/timeline";

/**
 * Law 8 (indexes-rescope spec) says a deleted (`was_rolled_back`) turn is not
 * a node and a dormant (`status='skipped'`) turn is absent while skipped —
 * "never in the graph, its invariants, or the visualization". The original
 * implementation ticket named THREE read sides (flows, citations,
 * edge-signals) and each got its own filter and its own tests. That list was
 * incomplete, and the incompleteness was invisible: an adversarial review
 * found the `↳` antecedent rows and the segment card's member count/facets
 * still rendering dead and dormant turns, because nothing anywhere enumerated
 * the read sides as a SET.
 *
 * So this file is deliberately a CHECKLIST rather than a unit test of one
 * module: one fixture, one dead turn, one dormant turn, and an assertion per
 * user-visible surface. A new surface that reads turns belongs here, and the
 * cost of forgetting is a test file that no longer covers what its name
 * claims — which is at least a visible cost, unlike the silent one this file
 * exists to prevent.
 */
describe("law 8 read sides — every surface hides deleted and dormant turns", () => {
  let db: Database;
  let sessionId: number;
  let live: number;
  let dormant: number;
  let deleted: number;
  let segmentId: number;

  const insertTurn = (
    promptNumber: number,
    title: string,
    options: { status?: string; wasRolledBack?: boolean } = {},
  ): number =>
    db
      .query<{ id: number }, [number, number, string, string, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, type, was_rolled_back, title, content, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, 'body', 100)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "extracted",
        JSON.stringify(["design"]),
        options.wasRolledBack ? 1 : 0,
        title,
      )!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "law8-read-sides",
      project: "/tmp/law8",
      title: "law 8 fixture",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;

    live = insertTurn(1, "live turn");
    dormant = insertTurn(2, "dormant turn", { status: "skipped" });
    deleted = insertTurn(3, "deleted turn", { wasRolledBack: true });

    // The live turn cites BOTH — the shape a real session leaves behind when a
    // cited turn is later rewound or swept to skipped.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: live },
          cited: { kind: "turn", id: dormant },
          relation: "consume",
          provenance: "asserted",
        },
        {
          citing: { kind: "turn", id: live },
          cited: { kind: "turn", id: deleted },
          relation: "consume",
          provenance: "asserted",
        },
      ],
      500,
    );

    segmentId = createSegment(db, { title: "law 8 segment", nowEpoch: 100 }).id;
    addSegmentMembers(db, segmentId, [live, dormant, deleted], 100);
  });

  afterEach(() => {
    db.close();
  });

  test("timeline's ↳ antecedent rows name neither a dormant nor a deleted turn", () => {
    const rendered = renderTimeline(
      buildTimelineView(db, { id: `S${sessionId}`, view: "turns" }),
    );
    const indexRows = rendered
      .split("\n")
      .filter((line) => line.includes("↳"))
      .join("\n");

    expect(rendered).toContain("live turn");
    // The whole point: the edges EXIST, so a `↳` row would render without the
    // filter. Either both antecedents are hidden or the row itself is gone.
    expect(indexRows).not.toContain("T2");
    expect(indexRows).not.toContain("T3");
  });

  // The boundary, pinned from the other side. An adversarial review called the
  // segment card's member listing a law-8 leak; applying the filter there broke
  // the golden sample, which encodes the OPPOSITE ruling: [S15069/T915] says a
  // rewound member renders WITH a marker, because a reader who cannot see it
  // cannot distinguish a withdrawn branch from a turn that never existed.
  // Both rules stand because they govern different surfaces — law 8 the GRAPH,
  // T915 the CONTENT INDEX — and the only way to keep that distinction from
  // eroding in either direction is to assert it here, next to law 8's own
  // cases, rather than to leave it as an absence.
  test("the content index keeps showing dead and dormant members — law 8 does not reach it", () => {
    const ranked = rankSegmentMembers(db, segmentId);
    expect(ranked.map((member) => member.turnId).sort()).toEqual(
      [live, dormant, deleted].sort(),
    );

    const facets = computeSegmentMemberFacetCounts(db, segmentId);
    expect(facets.type).toEqual([{ word: "design", count: 3 }]);
  });

  test("membership rows survive: dormancy hides a member, it does not evict it", () => {
    // The restoration guarantee's storage half — a late note promoting the
    // dormant turn must find its membership still there to restore.
    const stored = db
      .query<{ count: number }, [number]>(
        `SELECT COUNT(*) AS count FROM segment_members WHERE segment_id = ?`,
      )
      .get(segmentId)!.count;
    expect(stored).toBe(3);
  });
});
