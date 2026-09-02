import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { recoverStrandedTurns } from "../../src/db/recover-stranded";
import { initializeSchema } from "../../src/db/schema";
import {
  listOrphanAnchorTurns,
  listSegmentSpineForSession,
  rankSegmentMembers,
} from "../../src/db/segment-rank";
import {
  addSegmentMembers,
  computeSegmentMemberFacetCounts,
  createSegment,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { completionFloorStatus } from "../../src/db/turn-completion";
import { getTurnById } from "../../src/db/turns";
import { chronologicalSegmentMembers } from "../../src/mcp/segment-card";
import { isNoteSuccess, noteTool } from "../../src/mcp/note";
import {
  ERA_GRANT_COLUMN,
  eraVisibleMemberSqlClause,
  isEraVisibleMember,
  isSegmentEra,
} from "../../src/segment-era";

/**
 * era-grant-by-settlement, ticket 01.
 *
 * The observable under test is WHICH TURNS A MEMBER READ RETURNS — not the
 * shape of any predicate. That seam is the highest useful one here because the
 * milestone view, the segment card and recall all funnel through it, so one
 * fixture covers three surfaces.
 *
 * The second half of this file is the guard the ticket exists for: `isSegmentEra`
 * must keep answering exactly as it does today at its other ten call sites.
 * Widening the shared predicate instead of adding a narrow one would flip note
 * promotion and extraction liveness for every granted turn — 1090 of them in the
 * live database — as an unannounced side effect.
 */

const CUTOFF = 2_000;
const LEGACY_EPOCH = 1_000;
const ERA_EPOCH = 3_000;

describe("era grant — member visibility", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  let eraTurnId: number;
  let grantedTurnId: number;
  let ungrantedTurnId: number;

  function makeTurn(
    promptNumber: number,
    createdAtEpoch: number,
    type: string,
    tag: string,
  ): number {
    return db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, type, tags, created_at_epoch
         ) VALUES (?, ?, 'extracted', 'prompt', 'response', 'title', 'content', ?, ?, ?)
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        JSON.stringify([type]) as never,
        JSON.stringify([tag]) as never,
        createdAtEpoch as never,
      )!.id;
  }

  function grant(turnId: number, epoch: number | null): void {
    db.query<unknown, [number | null, number]>(
      `UPDATE turns SET ${ERA_GRANT_COLUMN} = ? WHERE id = ?`,
    ).run(epoch, turnId);
  }

  function memberIds(): number[] {
    return rankSegmentMembers(db, segmentId, undefined, CUTOFF).map(
      (member) => member.turnId,
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "era-grant-members",
      project: "/tmp/era-grant",
      title: null,
      insight: null,
      createdAtEpoch: LEGACY_EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // The tag words have to be mintable before a member may carry them.
    createSegment(db, { title: "granted work", tags: ["granted"], nowEpoch: 100 });
    createSegment(db, { title: "ungranted work", tags: ["ungranted"], nowEpoch: 100 });
    createSegment(db, { title: "era work", tags: ["era-side"], nowEpoch: 100 });

    eraTurnId = makeTurn(30, ERA_EPOCH, "implement", "era-side");
    grantedTurnId = makeTurn(10, LEGACY_EPOCH, "research", "granted");
    ungrantedTurnId = makeTurn(11, LEGACY_EPOCH, "design", "ungranted");

    const segment = createSegment(db, {
      title: "a task whose work predates the era",
      nowEpoch: LEGACY_EPOCH,
    });
    segmentId = segment.id;
    addSegmentMembers(
      db,
      segmentId,
      [eraTurnId, grantedTurnId, ungrantedTurnId],
      LEGACY_EPOCH,
    );
  });

  afterEach(() => {
    db.close();
  });

  test("a pre-era member WITHOUT a grant is absent from every member read", () => {
    expect(memberIds()).toEqual([eraTurnId]);
    expect(
      chronologicalSegmentMembers(db, { id: segmentId }, CUTOFF).map((m) => m.turnId),
    ).toEqual([eraTurnId]);
    expect(
      computeSegmentMemberFacetCounts(db, segmentId, CUTOFF).type.map((f) => f.word),
    ).toEqual(["implement"]);
    expect(
      computeSegmentMemberFacetCounts(db, segmentId, CUTOFF).tags.map((f) => f.word),
    ).toEqual(["era-side"]);
  });

  test("the SAME pre-era member WITH a grant is present in every member read", () => {
    grant(grantedTurnId, LEGACY_EPOCH + 500);

    // Both directions in one fixture: the granted turn joins, the ungranted one
    // beside it — identical in every other respect — still does not.
    expect(memberIds().sort()).toEqual([eraTurnId, grantedTurnId].sort());
    expect(memberIds()).not.toContain(ungrantedTurnId);

    expect(
      chronologicalSegmentMembers(db, { id: segmentId }, CUTOFF).map((m) => m.turnId),
    ).toEqual([grantedTurnId, eraTurnId]);

    const facets = computeSegmentMemberFacetCounts(db, segmentId, CUTOFF);
    expect(facets.type.map((f) => f.word).sort()).toEqual(["implement", "research"]);
    expect(facets.tags.map((f) => f.word).sort()).toEqual(["era-side", "granted"]);
    expect(facets.tags.map((f) => f.word)).not.toContain("ungranted");
  });

  test("a grant of NULL or 0 is not a grant", () => {
    grant(grantedTurnId, null);
    expect(memberIds()).toEqual([eraTurnId]);
    grant(grantedTurnId, 0);
    expect(memberIds()).toEqual([eraTurnId]);
    grant(grantedTurnId, 1);
    expect(memberIds()).toContain(grantedTurnId);
  });

  test("the session spine seats a segment whose only session-side member is granted", () => {
    // A segment holding NOTHING but pre-era turns. Before the grant it is off
    // the spine entirely (the pre-existing rule); with a grant it seats, and
    // its counts include the granted turn — which is what makes the outer
    // half and the segment-selection subquery have to agree.
    const legacyOnly = createSegment(db, {
      title: "pre-era only",
      nowEpoch: LEGACY_EPOCH,
    });
    const legacyMember = makeTurn(50, LEGACY_EPOCH, "fix", "granted");
    addSegmentMembers(db, legacyOnly.id, [legacyMember], LEGACY_EPOCH);

    expect(
      listSegmentSpineForSession(db, sessionId, CUTOFF).map((row) => row.segment.id),
    ).not.toContain(legacyOnly.id);

    grant(legacyMember, LEGACY_EPOCH + 500);

    const spine = listSegmentSpineForSession(db, sessionId, CUTOFF);
    const row = spine.find((entry) => entry.segment.id === legacyOnly.id);
    expect(row).toBeDefined();
    expect(row?.memberCount).toBe(1);
    expect(row?.sessionMemberCount).toBe(1);
    expect(row?.firstPromptNumber).toBe(50);
  });

  test("with no cutoff every member still renders, granted or not", () => {
    // The member reads' own pre-existing rule: no boundary recorded means no
    // boundary to respect. The grant changes nothing here in either direction.
    const all = rankSegmentMembers(db, segmentId, undefined, null).map((m) => m.turnId);
    expect(all.sort()).toEqual([eraTurnId, grantedTurnId, ungrantedTurnId].sort());

    grant(grantedTurnId, LEGACY_EPOCH + 500);
    expect(
      rankSegmentMembers(db, segmentId, undefined, null)
        .map((m) => m.turnId)
        .sort(),
    ).toEqual([eraTurnId, grantedTurnId, ungrantedTurnId].sort());
    expect(computeSegmentMemberFacetCounts(db, segmentId, null).type).toHaveLength(3);
  });

  test("the predicate and its SQL sibling answer identically over the same rows", () => {
    // The two forms exist so the query sites and any future TypeScript reader
    // cannot drift. This is the assertion that would catch the drift.
    grant(grantedTurnId, LEGACY_EPOCH + 500);
    grant(eraTurnId, 0);

    const era = eraVisibleMemberSqlClause("t", CUTOFF);
    const sqlVisible = new Set(
      db
        .query<{ id: number }, number[]>(
          `SELECT t.id AS id FROM turns t WHERE ${era.clause}`,
        )
        .all(...era.params)
        .map((row) => row.id),
    );

    for (const turnId of [eraTurnId, grantedTurnId, ungrantedTurnId]) {
      const row = db
        .query<{ createdAtEpoch: number; grantEpoch: number | null }, [number]>(
          `SELECT created_at_epoch AS createdAtEpoch,
                  ${ERA_GRANT_COLUMN} AS grantEpoch
             FROM turns WHERE id = ?`,
        )
        .get(turnId)!;
      expect(
        isEraVisibleMember(row.createdAtEpoch, row.grantEpoch, CUTOFF),
      ).toBe(sqlVisible.has(turnId));
    }
  });

  test("the orphan-anchor query is NOT widened by a grant", () => {
    // Its subject is turns with no membership at all, so the grant has no
    // bearing on it — pinned so a later "make the era gate consistent" sweep
    // has to argue with a test rather than a comment.
    const orphan = makeTurn(60, LEGACY_EPOCH, "fix", "granted");
    const citer = makeTurn(61, ERA_EPOCH, "fix", "era-side");
    db.query<unknown, [number, number, number]>(
      `INSERT INTO memory_edges (
         citing_kind, citing_id, cited_kind, cited_id, relation_class, provenance,
         created_at_epoch
       ) VALUES ('turn', ?, 'turn', ?, 'use', 'judged', ?)`,
    ).run(citer, orphan, ERA_EPOCH);
    grant(orphan, LEGACY_EPOCH + 500);

    expect(
      listOrphanAnchorTurns(db, sessionId, CUTOFF).map((row) => row.facts.turnId),
    ).not.toContain(orphan);
  });
});

describe("era grant — isSegmentEra is unchanged", () => {
  /**
   * The narrow predicate must not become the wide one. Two pins: the truth
   * table of `isSegmentEra` itself, and the three questions it answers away
   * from member visibility, each asserted on a turn that DOES carry a grant.
   */
  test("isSegmentEra's truth table is exactly what it was", () => {
    expect(isSegmentEra(CUTOFF, CUTOFF)).toBe(true);
    expect(isSegmentEra(CUTOFF + 1, CUTOFF)).toBe(true);
    expect(isSegmentEra(CUTOFF - 1, CUTOFF)).toBe(false);
    expect(isSegmentEra(LEGACY_EPOCH, null)).toBe(false);
    expect(isSegmentEra(ERA_EPOCH, null)).toBe(false);
    expect(isSegmentEra(LEGACY_EPOCH, undefined)).toBe(false);
    expect(isSegmentEra(ERA_EPOCH, undefined)).toBe(false);
    // Two parameters. A third would mean it had learned to read the grant.
    expect(isSegmentEra.length).toBe(2);
  });

  describe("a granted pre-era turn", () => {
    let db: Database;
    let sessionId: number;
    let grantedTurnId: number;

    beforeEach(() => {
      db = createDatabase(":memory:");
      initializeSchema(db);
      sessionId = upsertSession(db, {
        contentSessionId: "era-grant-unchanged",
        project: "/tmp/era-grant",
        title: null,
        insight: null,
        createdAtEpoch: LEGACY_EPOCH,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      }).id;
      grantedTurnId = db
        .query<{ id: number }, [number]>(
          `INSERT INTO turns (session_id, prompt_number, status, user_prompt,
                              assistant_response, created_at_epoch)
           VALUES (?, 10, 'active', 'prompt', 'a real response', ${LEGACY_EPOCH})
           RETURNING id`,
        )
        .get(sessionId)!.id;
      db.query<unknown, [number]>(
        `UPDATE turns SET ${ERA_GRANT_COLUMN} = ${LEGACY_EPOCH + 500} WHERE id = ?`,
      ).run(grantedTurnId);
      // The turn under test really does read as an era-side MEMBER now — so
      // every assertion below is about the questions that did NOT move.
      expect(isEraVisibleMember(LEGACY_EPOCH, LEGACY_EPOCH + 500, CUTOFF)).toBe(true);
    });

    afterEach(() => {
      db.close();
    });

    test("still refuses a promoted note record (mcp/note.ts)", () => {
      const result = noteTool(
        db,
        { turn: `S${sessionId}/T10`, title: "a title", content: "some prose" },
        { now: () => 3_500, env: {}, eraCutoffEpoch: CUTOFF },
      );
      expect(isNoteSuccess(result)).toBe(false);
      expect(JSON.stringify(result)).toContain("pre-cutoff turn");
      const turn = getTurnById(db, grantedTurnId);
      expect(turn?.title).toBeNull();
      expect(turn?.content).toBeNull();
    });

    test("still floors to `failed`, not `skipped` (db/turn-completion.ts)", () => {
      const turn = getTurnById(db, grantedTurnId)!;
      expect(completionFloorStatus(turn, CUTOFF)).toBe("failed");
    });

    test("still has its extraction fields reset on stranded recovery (db/recover-stranded.ts)", () => {
      db.query<unknown, [number]>(
        "UPDATE turns SET title = 'stale', content = 'stale' WHERE id = ?",
      ).run(grantedTurnId);

      expect(recoverStrandedTurns(db, sessionId, 4_000, CUTOFF)).toBe(1);

      const turn = getTurnById(db, grantedTurnId);
      expect(turn?.title).toBeNull();
      expect(turn?.content).toBeNull();
    });
  });
});
