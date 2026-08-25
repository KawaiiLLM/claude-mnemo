import { afterEach, beforeEach, expect, describe, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { countEdgesCarryingTagInSegment, deleteLane, getLane, insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * `undeclare`'s guard (spec D4), which is `countEdgesCarryingTagInSegment`.
 *
 * Ticket 14's third asymmetry: the guard used to count every row the tag
 * index named, with no liveness predicate, while the checker's own loader
 * (`db/lane-checker-load.ts`) filters BOTH endpoints of every edge by
 * `liveTurnSql`. A lane declared and used normally, whose turns were later
 * skipped, therefore refused `undeclare` forever — held open by an edge that
 * exists in no graph any reader can see, and unrepairable by any other route
 * (its edges are dormant, so nothing can retag them either). This is a
 * PERMANENT runtime path, not a migration-timing accident: it deadlocks at
 * any point after release, which is why it was the P1 half of that ticket.
 */
describe("undeclare's in-use guard — law 8 on both endpoints", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;

  const NOW = 1_800_000_000;

  function seedTurn(
    promptNumber: number,
    options: { status?: string; wasRolledBack?: boolean } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, number, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, was_rolled_back)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, options.status ?? "active", NOW, options.wasRolledBack ? 1 : 0)!
      .id;
  }

  function tagEdge(citingId: number, citedId: number, tags: readonly string[]): void {
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citingId },
          cited: { kind: "turn", id: citedId },
          relation: "extends" as never,
          provenance: "asserted",
          ...deriveSideTags(tags),
        },
      ],
      NOW,
    );
  }

  function kill(turnId: number, how: "skipped" | "rolled-back"): void {
    if (how === "skipped") {
      db.query<unknown, [number]>("UPDATE turns SET status = 'skipped' WHERE id = ?").run(turnId);
    } else {
      db.query<unknown, [number]>("UPDATE turns SET was_rolled_back = 1 WHERE id = ?").run(turnId);
    }
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "lanes-guard-session",
      project: "/tmp/project-lanes-guard",
      title: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Guard", nowEpoch: NOW }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a live tagged edge holds the lane open — the guard is not vacuous", () => {
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addSegmentMembers(db, segmentId, [t1, t2], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    tagEdge(t2, t1, ["write-gate"]);

    expect(countEdgesCarryingTagInSegment(db, segmentId, "write-gate")).toBe(1);
  });

  test("ticket 14: a lane whose members all died can be undeclared — a SKIPPED endpoint holds nothing open", () => {
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    addSegmentMembers(db, segmentId, [t1, t2], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    tagEdge(t2, t1, ["write-gate"]);
    expect(countEdgesCarryingTagInSegment(db, segmentId, "write-gate")).toBe(1);

    // The lane's whole membership is skipped afterwards — the shape the
    // ticket named: declared and used normally, then the turns go dormant.
    kill(t1, "skipped");
    kill(t2, "skipped");

    expect(countEdgesCarryingTagInSegment(db, segmentId, "write-gate")).toBe(0);
    // …and the `undeclare` that count gates now goes through.
    expect(deleteLane(db, segmentId, "write-gate")).toBe(true);
    expect(getLane(db, segmentId, "write-gate")).toBeNull();
  });

  test("ticket 14: ONE skipped endpoint is enough — an edge is not an edge unless BOTH ends are live", () => {
    const live = seedTurn(1);
    const skipped = seedTurn(2);
    addSegmentMembers(db, segmentId, [live, skipped], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    tagEdge(skipped, live, ["write-gate"]);
    kill(skipped, "skipped");

    expect(countEdgesCarryingTagInSegment(db, segmentId, "write-gate")).toBe(0);
  });

  test("ticket 14: a ROLLED-BACK endpoint holds nothing open either, on the CITED side", () => {
    const citing = seedTurn(1);
    const cited = seedTurn(2);
    addSegmentMembers(db, segmentId, [citing, cited], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    tagEdge(citing, cited, ["write-gate"]);
    kill(cited, "rolled-back");

    expect(countEdgesCarryingTagInSegment(db, segmentId, "write-gate")).toBe(0);
  });

  test("a dead edge does not mask a live one — the guard still refuses while any live edge carries the tag", () => {
    const t1 = seedTurn(1);
    const t2 = seedTurn(2);
    const doomed = seedTurn(3);
    addSegmentMembers(db, segmentId, [t1, t2, doomed], NOW);
    insertLane(db, segmentId, "write-gate", NOW);
    tagEdge(t2, t1, ["write-gate"]);
    tagEdge(doomed, t1, ["write-gate"]);
    kill(doomed, "skipped");

    expect(countEdgesCarryingTagInSegment(db, segmentId, "write-gate")).toBe(1);
  });

  test("a cross-segment live edge still counts for BOTH segments (D2's 'consulted once per endpoint'), unchanged by the liveness filter", () => {
    const otherSegmentId = createSegment(db, { title: "Other", nowEpoch: NOW }).id;
    const here = seedTurn(1);
    const there = seedTurn(2);
    addSegmentMembers(db, segmentId, [here], NOW);
    addSegmentMembers(db, otherSegmentId, [there], NOW);
    insertLane(db, segmentId, "shared-lane", NOW);
    insertLane(db, otherSegmentId, "shared-lane", NOW);
    tagEdge(there, here, ["shared-lane"]);

    expect(countEdgesCarryingTagInSegment(db, segmentId, "shared-lane")).toBe(1);
    expect(countEdgesCarryingTagInSegment(db, otherSegmentId, "shared-lane")).toBe(1);

    // One side goes dormant and the edge stops counting for EITHER segment —
    // the same "not an edge at all" verdict, read from both ends.
    kill(there, "skipped");
    expect(countEdgesCarryingTagInSegment(db, segmentId, "shared-lane")).toBe(0);
    expect(countEdgesCarryingTagInSegment(db, otherSegmentId, "shared-lane")).toBe(0);
  });
});
