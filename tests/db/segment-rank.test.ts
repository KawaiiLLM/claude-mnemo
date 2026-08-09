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
      .query<{ id: number }, [number, number, string, string | null, string, number, string | null]>(
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
        spec.type ?? null,
        JSON.stringify(spec.filesModified ?? []),
        spec.createdAtEpoch ?? ERA + spec.promptNumber,
        spec.title ?? `T${spec.promptNumber} title`,
      )!.id;
  }

  /** `citerCount` distinct turns cite `turnId`, each with one `builds-on` edge. */
  function citeFrom(turnId: number, citerIds: readonly number[], relation: "builds-on" | "supersedes" = "builds-on"): void {
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
    const corrector = makeTurn({ promptNumber: 1 });
    const rolledBack = makeTurn({ promptNumber: 2, type: "rolled-back" });
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
    const victim = makeTurn({ promptNumber: 92 });

    citeFrom(victim, [corrector], "supersedes");
    citeFrom(citedTwice, [citerA, citerB]);
    citeFrom(citedOnceShipped, [citerA]);
    citeFrom(citedOnce, [citerA]);
    // A rolled-back turn with the HIGHEST in-degree in the fixture: key ② has to
    // sink it below everything anyway.
    citeFrom(rolledBack, [citerA, citerB, corrector]);

    const segment = createSegment(db, {
      title: "implement the spine",
      type: ["implement"],
      nowEpoch: ERA,
    });
    addSegmentMembers(
      db,
      segment.id,
      [
        corrector,
        rolledBack,
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
        corrector,
        rolledBack,
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
      ids.corrector, //          ① corrector
      ids.citedTwice, //         ③ in-degree 2
      ids.citedOnceShipped, //   ③ in-degree 1, ④ shipped
      ids.citedOnce, //          ③ in-degree 1, not shipped
      ids.manyFiles, //          ⑤ 3 files
      ids.newerOneFile, //       ⑤ 1 file, ⑥ newer
      ids.olderOneFile, //       ⑤ 1 file, ⑥ older
      ids.rolledBack, //         ② sinks despite in-degree 3
    ]);
  });

  test("every position is explainable from the row's own facts", () => {
    const { segmentId, ids } = buildRankFixture();
    const byTurnId = new Map(
      rankSegmentMembers(db, segmentId).map((member) => [member.turnId, member]),
    );

    expect(byTurnId.get(ids.corrector!)).toMatchObject({
      isCorrector: 1,
      isRolledBack: 0,
      citedBy: 0,
    });
    expect(byTurnId.get(ids.rolledBack!)).toMatchObject({
      isCorrector: 0,
      isRolledBack: 1,
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

  test("a (citing, cited) pair counts once across relations and provenances", () => {
    const cited = makeTurn({ promptNumber: 1 });
    const citerA = makeTurn({ promptNumber: 2 });
    const citerB = makeTurn({ promptNumber: 3 });

    // Same pair, two relations, and one of them re-learned through a second
    // provenance — spec D8 says that is ONE consumer, not three.
    writeMemoryEdges(
      db,
      [
        { citing: { kind: "turn", id: citerA }, cited: { kind: "turn", id: cited }, relation: "builds-on", provenance: "retrieval" },
        { citing: { kind: "turn", id: citerA }, cited: { kind: "turn", id: cited }, relation: "builds-on", provenance: "judged" },
        { citing: { kind: "turn", id: citerA }, cited: { kind: "turn", id: cited }, relation: "evidence-for", provenance: "text-ref" },
        { citing: { kind: "turn", id: citerB }, cited: { kind: "turn", id: cited }, relation: "builds-on", provenance: "judged" },
      ],
      ERA,
    );

    const segment = createSegment(db, { title: "measure dedup", nowEpoch: ERA });
    addSegmentMembers(db, segment.id, [cited], ERA);

    expect(rankSegmentMembers(db, segment.id)[0]?.citedBy).toBe(2);
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
      ids.olderOneFile, //  ⚓1, body order, despite ranking last but one
      ids.citedOnce, //     ⚓2
      ids.corrector,
      ids.citedTwice,
      ids.citedOnceShipped,
      ids.manyFiles,
      ids.newerOneFile,
      ids.rolledBack,
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
      ids.corrector,
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
      .query<{ id: number }, [number, number, string, string | null, number]>(
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
        options.type ?? null,
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
    expect(row?.phaseTrace).toEqual(["research", "design", "implement", "research"]);
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
        { citing: { kind: "turn", id: citer }, cited: { kind: "turn", id: cited }, relation: "builds-on", provenance: "judged" },
        { citing: { kind: "turn", id: corrector }, cited: { kind: "turn", id: victim }, relation: "supersedes", provenance: "judged" },
        { citing: { kind: "turn", id: citer }, cited: { kind: "turn", id: skipped }, relation: "builds-on", provenance: "judged" },
      ],
      CUTOFF,
    );

    const segment = createSegment(db, { title: "implement the claimed one", nowEpoch: CUTOFF });
    addSegmentMembers(db, segment.id, [claimed], CUTOFF);

    const orphans = listOrphanAnchorTurns(db, sessionId, CUTOFF);
    const orphanIds = orphans.map((row) => row.facts.turnId);

    // corrector first (key ①), then the cited rows; `victim` is cited by the
    // corrector's supersedes edge, so it too has an in-degree.
    expect(orphanIds).toContain(corrector);
    expect(orphanIds).toContain(cited);
    expect(orphanIds).toContain(victim);
    expect(orphanIds).toContain(reversed);
    // No signal, already in a segment, or not renderable at all.
    expect(orphanIds).not.toContain(quiet);
    expect(orphanIds).not.toContain(claimed);
    expect(orphanIds).not.toContain(skipped);
    expect(orphanIds).not.toContain(citer);

    expect(orphans[0]?.facts.turnId).toBe(corrector);
    expect(orphans[0]?.signals).toEqual(["corrector"]);
    expect(orphans.find((row) => row.facts.turnId === cited)?.signals).toEqual([
      "cited 1",
    ]);
    // Rolled-back sinks to the bottom even though it renders.
    expect(orphanIds[orphanIds.length - 1]).toBe(reversed);
  });
});
