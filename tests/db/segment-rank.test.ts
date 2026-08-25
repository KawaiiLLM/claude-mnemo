import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import {
  listOrphanAnchorTurns,
  listSegmentSpineForSession,
  rankSegmentMembers,
  resolveSegmentAnchorTurnIds,
} from "../../src/db/segment-rank";
import {
  addSegmentMembers,
  applySegmentWrites,
  createSegment,
  getSegment,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * Spec D8. Every assertion here is a FULL ordering, not a spot check: the point
 * of a zero-score design is that the whole permutation follows from the fact
 * columns, so a test that only pins the head would not distinguish it from a
 * weighted sum that happens to agree at the top.
 */
describe("segment member derived rank (spec D8)", () => {
  let db: Database;
  let sessionId: number;
  const ERA = 1_000_000;

  interface TurnSpec {
    promptNumber: number;
    type?: string | null;
    filesModified?: string[];
    createdAtEpoch?: number;
    status?: string;
    title?: string | null;
  }

  function makeTurn(spec: TurnSpec): number {
    return db
      .query<{ id: number }, [number, number, string, string, string, number, string | null]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, files_modified,
           created_at_epoch, title, user_prompt, content
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prompt', 'content')
         RETURNING id`,
      )
      .get(
        sessionId,
        spec.promptNumber,
        spec.status ?? "extracted",
        spec.type ? JSON.stringify([spec.type]) : "[]",
        JSON.stringify(spec.filesModified ?? []),
        spec.createdAtEpoch ?? ERA + spec.promptNumber,
        spec.title ?? `T${spec.promptNumber} title`,
      )!.id;
  }

  /** `citerCount` distinct turns cite `turnId`, each with one `consume` edge. */
  function citeFrom(turnId: number, citerIds: readonly number[], relation: "consume" | "narrows" = "consume"): void {
    writeMemoryEdges(
      db,
      citerIds.map((citingId) => ({
        citing: { kind: "turn" as const, id: citingId },
        cited: { kind: "turn" as const, id: turnId },
        relation,
        provenance: "judged" as const,
      })),
      ERA,
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-rank",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: ERA,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  /**
   * One fixture that separates every key: each member differs from the next by
   * exactly the key under test, so the expected permutation is readable off the
   * ORDER BY.
   */
  function buildRankFixture(): {
    segmentId: number;
    ids: Record<string, number>;
  } {
    // Two keys this fixture used to separate are GONE (lane-model-v12 ticket
    // 03): "is a corrector" and "was superseded" both read the `supersedes`
    // word, which no longer exists in the vocabulary or in the table's CHECK.
    // These two rows keep their names because their OTHER properties still
    // matter — `uncited` has nothing at all (last), `citedThrice` has the
    // fixture's highest in-degree (first, where key ② used to sink it).
    const uncited = makeTurn({ promptNumber: 1 });
    // Still carries the stale `type: "rolled-back"` value: it proved nothing
    // before (spec B4 — a reversal was an edge fact, never a stated type) and
    // proves nothing now.
    const citedThrice = makeTurn({ promptNumber: 2, type: "rolled-back" });
    const citedTwice = makeTurn({ promptNumber: 3 });
    const citedOnceShipped = makeTurn({ promptNumber: 4 });
    const citedOnce = makeTurn({ promptNumber: 5 });
    const manyFiles = makeTurn({ promptNumber: 6, filesModified: ["a.ts", "b.ts", "c.ts"] });
    const newerOneFile = makeTurn({
      promptNumber: 7,
      filesModified: ["d.ts"],
      createdAtEpoch: ERA + 700,
    });
    const olderOneFile = makeTurn({
      promptNumber: 8,
      filesModified: ["e.ts"],
      createdAtEpoch: ERA + 600,
    });

    // Citers live OUTSIDE the segment so they cannot perturb the member list.
    const citerA = makeTurn({ promptNumber: 90 });
    const citerB = makeTurn({ promptNumber: 91 });

    citeFrom(citedTwice, [citerA, citerB]);
    citeFrom(citedOnceShipped, [citerA]);
    citeFrom(citedOnce, [citerA]);
    // The HIGHEST in-degree in the fixture.
    citeFrom(citedThrice, [citerA, citerB, uncited]);

    const segment = createSegment(db, {
      title: "implement the spine",
      type: ["implement"],
      nowEpoch: ERA,
    });
    addSegmentMembers(
      db,
      segment.id,
      [
        uncited,
        citedThrice,
        citedTwice,
        citedOnceShipped,
        citedOnce,
        manyFiles,
        newerOneFile,
        olderOneFile,
      ],
      ERA,
    );

    // A second, DELIVERED segment is what makes `isDeliveryMember` vary inside
    // the open one under test.
    const shipped = createSegment(db, {
      title: "ops release 1.0",
      type: ["ops"],
      status: "delivered",
      nowEpoch: ERA,
    });
    addSegmentMembers(db, shipped.id, [citedOnceShipped], ERA);

    return {
      segmentId: segment.id,
      ids: {
        uncited,
        citedThrice,
        citedTwice,
        citedOnceShipped,
        citedOnce,
        manyFiles,
        newerOneFile,
        olderOneFile,
      },
    };
  }

  test("the full member permutation follows from the fact columns", () => {
    const { segmentId, ids } = buildRankFixture();

    const ranked = rankSegmentMembers(db, segmentId);

    expect(ranked.map((member) => member.turnId)).toEqual([
      ids.citedThrice, //        ① in-degree 3
      ids.citedTwice, //         ① in-degree 2
      ids.citedOnceShipped, //   ① in-degree 1, ② shipped
      ids.citedOnce, //          ① in-degree 1, not shipped
      ids.manyFiles, //          ③ 3 files
      ids.newerOneFile, //       ③ 1 file, ④ newer
      ids.olderOneFile, //       ③ 1 file, ④ older
      ids.uncited, //            nothing at all
    ]);
  });

  test("every position is explainable from the row's own facts", () => {
    const { segmentId, ids } = buildRankFixture();
    const byTurnId = new Map(
      rankSegmentMembers(db, segmentId).map((member) => [member.turnId, member]),
    );

    expect(byTurnId.get(ids.uncited!)).toMatchObject({
      citedBy: 0,
      isDeliveryMember: 0,
      filesModifiedCount: 0,
    });
    expect(byTurnId.get(ids.citedThrice!)).toMatchObject({
      citedBy: 3,
    });
    expect(byTurnId.get(ids.citedOnceShipped!)).toMatchObject({
      citedBy: 1,
      isDeliveryMember: 1,
    });
    expect(byTurnId.get(ids.citedOnce!)).toMatchObject({
      citedBy: 1,
      isDeliveryMember: 0,
    });
    expect(byTurnId.get(ids.manyFiles!)).toMatchObject({ filesModifiedCount: 3 });
  });

  test("a (citing, cited) pair counts once across provenances (spec C5: relation is no longer part of the key)", () => {
    const cited = makeTurn({ promptNumber: 1 });
    const citerA = makeTurn({ promptNumber: 2 });
    const citerB = makeTurn({ promptNumber: 3 });

    // Same pair re-learned through a second provenance (spec D8: that is ONE
    // consumer, not two), plus a second, distinct citer under a different
    // relation.
    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: citerA }, cited: { kind: "turn", id: cited }, relation: "consume", provenance: "retrieval" },
        { citing: { kind: "turn", id: citerA }, cited: { kind: "turn", id: cited }, relation: "consume", provenance: "judged" },
        { citing: { kind: "turn", id: citerB }, cited: { kind: "turn", id: cited }, relation: "verifies", provenance: "judged" },
      ],
      ERA,
    );

    const segment = createSegment(db, { title: "measure dedup", nowEpoch: ERA });
    addSegmentMembers(db, segment.id, [cited], ERA);

    expect(rankSegmentMembers(db, segment.id)[0]?.citedBy).toBe(2);
  });

  test("deleting a citer removes it from the cited-by count instead of leaving a ghost (spec C15)", () => {
    const cited = makeTurn({ promptNumber: 1 });
    const citerA = makeTurn({ promptNumber: 2 });
    const citerB = makeTurn({ promptNumber: 3 });

    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citerA },
          cited: { kind: "turn", id: cited },
          relation: "consume",
          provenance: "judged",
        },
        {
          citing: { kind: "turn", id: citerB },
          cited: { kind: "turn", id: cited },
          relation: "consume",
          provenance: "judged",
        },
      ],
      ERA,
    );

    const segment = createSegment(db, {
      title: "check the delete trigger cleans up",
      nowEpoch: ERA,
    });
    addSegmentMembers(db, segment.id, [cited], ERA);

    expect(rankSegmentMembers(db, segment.id)[0]?.citedBy).toBe(2);

    // The retired turn_citations table cascaded this away for free;
    // memory_edges cannot carry the FK (spec C15: one INTEGER column spans
    // three id spaces), so the kind-aware AFTER DELETE trigger is what has to
    // catch it instead — this is the exact surface the deleted citer used to
    // inflate.
    db.query("DELETE FROM turns WHERE id = ?").run(citerA);

    expect(rankSegmentMembers(db, segment.id)[0]?.citedBy).toBe(1);
  });

  test("anchors take their slots before the derived order is consulted", () => {
    const { segmentId, ids } = buildRankFixture();
    const segment = getSegment(db, segmentId)!;

    // The settlement pass's body cites two members — one of which the derived
    // order ranks near the bottom.
    applySegmentWrites(
      db,
      [
        {
          segmentId,
          expectedRevision: segment.revision,
          content: `Conclusion first. Load-bearing: [S${sessionId}/T8 the older one] and [S${sessionId}/T5].`,
        },
      ],
      { nowEpoch: ERA },
    );

    const ranked = rankSegmentMembers(db, segmentId);

    expect(ranked.map((member) => member.turnId)).toEqual([
      ids.olderOneFile, //  ⚓1, body order, despite ranking near the bottom
      ids.citedOnce, //     ⚓2
      ids.citedThrice,
      ids.citedTwice,
      ids.citedOnceShipped,
      ids.manyFiles,
      ids.newerOneFile,
      ids.uncited, //       no signal at all — last even with anchors pulled ahead
    ]);
    expect(ranked.slice(0, 2).map((member) => member.anchorPosition)).toEqual([1, 2]);
    expect(ranked.slice(2).every((member) => member.anchorPosition === null)).toBe(true);
  });

  test("the render budget truncates AFTER anchors have taken their slots", () => {
    const { segmentId, ids } = buildRankFixture();
    const segment = getSegment(db, segmentId)!;
    applySegmentWrites(
      db,
      [
        {
          segmentId,
          expectedRevision: segment.revision,
          content: `Load-bearing: [S${sessionId}/T8].`,
        },
      ],
      { nowEpoch: ERA },
    );

    expect(rankSegmentMembers(db, segmentId, 2).map((member) => member.turnId)).toEqual([
      ids.olderOneFile,
      ids.citedThrice,
    ]);
  });

  test("a body citation that is not a member is not an anchor", () => {
    const member = makeTurn({ promptNumber: 1 });
    const neighbour = makeTurn({ promptNumber: 2 });
    const segment = createSegment(db, { title: "design something", nowEpoch: ERA });
    addSegmentMembers(db, segment.id, [member], ERA);
    applySegmentWrites(
      db,
      [
        {
          segmentId: segment.id,
          expectedRevision: segment.revision,
          // A neighbour turn, a sibling segment, and a bare relative id: none is
          // an anchor of THIS segment.
          content: `See [S${sessionId}/T2], [E999] and [T1].`,
        },
      ],
      { nowEpoch: ERA },
    );

    expect(resolveSegmentAnchorTurnIds(db, getSegment(db, segment.id)!)).toEqual([]);
    expect(rankSegmentMembers(db, segment.id).map((m) => m.turnId)).toEqual([member]);
    expect(neighbour).toBeGreaterThan(0);
  });

  // The corrector/rolled-back pair of rank facts is DELETED (lane-model-v12
  // ticket 03): both read the `supersedes` word, and the migration leaves no
  // row that word can be true of. Pinned on the emitted row shape rather than
  // on the SQL text, so re-adding either key under any spelling reddens this.
  test("no rank fact reads a corrector or rolled-back signal any more", () => {
    const citer = makeTurn({ promptNumber: 1 });
    const cited = makeTurn({ promptNumber: 2 });
    const staleTyped = makeTurn({ promptNumber: 3, type: "rolled-back" });

    citeFrom(cited, [citer], "narrows");

    const segment = createSegment(db, { title: "rank fact shape", nowEpoch: ERA });
    addSegmentMembers(db, segment.id, [citer, cited, staleTyped], ERA);

    const members = rankSegmentMembers(db, segment.id);
    expect(members).toHaveLength(3);
    for (const member of members) {
      expect(Object.keys(member)).not.toContain("isCorrector");
      expect(Object.keys(member)).not.toContain("isRolledBack");
    }
    // The one edge-derived fact that survives still works.
    expect(members.find((m) => m.turnId === cited)?.citedBy).toBe(1);
  });
});

describe("segment spine and orphan anchors (spec D11)", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 2_000_000;

  function makeTurn(
    promptNumber: number,
    options: { type?: string | null; createdAtEpoch?: number; status?: string } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, created_at_epoch,
           user_prompt, title, files_modified
         ) VALUES (?, ?, ?, ?, ?, 'prompt', 'title', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.status ?? "extracted",
        options.type ? JSON.stringify([options.type]) : "[]",
        options.createdAtEpoch ?? CUTOFF + promptNumber,
      )!.id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-spine",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a null cutoff yields no spine at all", () => {
    const turn = makeTurn(1, { type: "implement" });
    const segment = createSegment(db, { title: "implement it", nowEpoch: CUTOFF });
    addSegmentMembers(db, segment.id, [turn], CUTOFF);

    expect(listSegmentSpineForSession(db, sessionId, null)).toEqual([]);
    expect(listOrphanAnchorTurns(db, sessionId, null)).toEqual([]);
  });

  test("the dominant type is the member mode and the trace collapses runs", () => {
    const turns = [
      makeTurn(1, { type: "research" }),
      makeTurn(2, { type: "design" }),
      makeTurn(3, { type: "implement" }),
      makeTurn(4, { type: "implement" }),
      makeTurn(5, { type: "research" }),
    ];
    const segment = createSegment(db, {
      title: "research then build",
      type: ["research", "design", "implement"],
      nowEpoch: CUTOFF,
    });
    addSegmentMembers(db, segment.id, turns, CUTOFF);

    const [row] = listSegmentSpineForSession(db, sessionId, CUTOFF);

    expect(row?.dominantType).toBe("research");
    expect(row?.phaseTrace).toEqual([["research"], ["design"], ["implement"], ["research"]]);
    expect(row?.memberCount).toBe(5);
    expect(row?.firstPromptNumber).toBe(1);
    expect(row?.lastPromptNumber).toBe(5);
  });

  test("a pre-cutoff member does not put its segment on the era spine", () => {
    const legacyTurn = makeTurn(1, { type: "fix", createdAtEpoch: CUTOFF - 100 });
    const segment = createSegment(db, { title: "fix the old thing", nowEpoch: CUTOFF });
    addSegmentMembers(db, segment.id, [legacyTurn], CUTOFF);

    expect(listSegmentSpineForSession(db, sessionId, CUTOFF)).toEqual([]);
  });

  test("an orphan anchor needs a signal another record vouches for", () => {
    const cited = makeTurn(1);
    const citer = makeTurn(2);
    const corrector = makeTurn(3);
    const victim = makeTurn(4);
    const reversed = makeTurn(5, { type: "rolled-back" });
    const quiet = makeTurn(6);
    const skipped = makeTurn(7, { status: "skipped" });
    const claimed = makeTurn(8);

    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: citer }, cited: { kind: "turn", id: cited }, relation: "consume", provenance: "judged" },
        { citing: { kind: "turn", id: corrector }, cited: { kind: "turn", id: victim }, relation: "narrows", provenance: "judged" },
        { citing: { kind: "turn", id: citer }, cited: { kind: "turn", id: skipped }, relation: "consume", provenance: "judged" },
      ],
      CUTOFF,
    );

    const segment = createSegment(db, { title: "implement the claimed one", nowEpoch: CUTOFF });
    addSegmentMembers(db, segment.id, [claimed], CUTOFF);

    const orphans = listOrphanAnchorTurns(db, sessionId, CUTOFF);
    const orphanIds = orphans.map((row) => row.facts.turnId);

    // ONE signal survives (lane-model-v12 ticket 03): "something cites it".
    // The corrector and rolled-back signals read the `supersedes` word and went
    // with it, so `corrector` — which cites but is never cited — no longer
    // qualifies at all, while `victim` still does on its in-degree alone.
    expect(orphanIds).not.toContain(corrector);
    expect(orphanIds).toContain(cited);
    expect(orphanIds).toContain(victim);
    // `rolled-back` left the type vocabulary (ticket 02, spec B4) and carries
    // no edge here — a stale type value alone proves nothing anymore (ticket
    // 13), so this legacy-typed turn has no signal at all, same as `quiet`.
    expect(orphanIds).not.toContain(reversed);
    // No signal, already in a segment, or not renderable at all.
    expect(orphanIds).not.toContain(quiet);
    expect(orphanIds).not.toContain(claimed);
    expect(orphanIds).not.toContain(skipped);
    expect(orphanIds).not.toContain(citer);

    expect(orphans.find((row) => row.facts.turnId === cited)?.signals).toEqual([
      "cited 1",
    ]);
    expect(orphans.find((row) => row.facts.turnId === victim)?.signals).toEqual([
      "cited 1",
    ]);
    // The two rows tie on the only surviving key, so the recency backstop
    // decides: `victim` (prompt 4) is newer than `cited` (prompt 1).
    expect(orphanIds).toEqual([victim, cited]);
  });
});
