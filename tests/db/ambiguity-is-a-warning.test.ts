import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { normalizeIncidentAttribution } from "../../src/db/normalize-incident-attribution";
import {
  claimNextNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementJob,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import {
  readNoteSettlementWritableSnapshot,
  settlementWritePermissions,
  writeNoteSettlementTransitionSnapshots,
} from "../../src/db/note-settlement-snapshots";
import { resolveEdgeSide, loadEndpointLaneFacts } from "../../src/db/edge-side-resolution";
import { initializeSchema } from "../../src/db/schema";
import {
  addSegmentMembers,
  createSegment,
  mergeSegments,
  writeMembershipTags,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";

/**
 * AMBIGUITY IS A WARNING (user ruling S15069/T2465-T2466, main-agent-edges
 * ticket 14). The file this replaces —
 * `tests/db/settlement-derived-side-closure.test.ts` — pinned the opposite
 * rule: a side that resolved `ambiguous` either invalidated a live settlement
 * job (sending it back to stage 1) or had its edge DELETED, and either way the
 * citing turn was granted a relations-only repair authority.
 *
 * Every test below pins the subtraction, one behaviour per test, so that
 * re-adding any single half of the old mechanism turns exactly one of them red:
 *
 *   - the edge is KEPT;
 *   - the job's status, generation, stage and snapshots are UNTOUCHED;
 *   - the read renders the side `ambiguous`;
 *   - no writable-set membership is minted for the citer;
 *   - the two clears the seam still performs are unchanged.
 */

const NOW = 1_800_000_000;
const ERA = 1;

describe("a side made ambiguous under a LIVE CLAIMED job", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  let job: NoteSettlementJob;

  const addTurn = (promptNumber: number, tags: string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '["design"]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, NOW - 100 + promptNumber, JSON.stringify(tags))!.id;

  const addEdge = (citingId: number, citedId: number, tailTag = "", headTag = ""): number =>
    db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, provenance,
            tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'judged', ?, ?, 'use', '', ?)
         RETURNING id`,
      )
      .get(citingId, citedId, tailTag, headTag, NOW)!.id;

  const edgeCount = (edgeId: number): number =>
    db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM memory_edges WHERE id = ?")
      .get(edgeId)!.n;

  const sideOutcome = (edgeId: number, side: "tail" | "head"): string => {
    const row = db
      .query<
        {
          id: number;
          citingId: number;
          citedId: number;
          tailTag: string;
          headTag: string;
        },
        [number]
      >(
        `SELECT id, citing_id AS citingId, cited_id AS citedId,
                tail_tag AS tailTag, head_tag AS headTag
           FROM memory_edges WHERE id = ?`,
      )
      .get(edgeId)!;
    const facts = loadEndpointLaneFacts(db, [row.citingId, row.citedId]);
    return resolveEdgeSide(row, side, facts).outcome;
  };

  /** The projection, through the SAME primitive stage 1's batch tag write uses. */
  const project = (turnId: number, tags: string[]) =>
    writeMembershipTags(db, {
      operation: "normal",
      writes: [{ turnId, tags }],
      writer: "settlement",
      nowEpoch: NOW,
    });

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "ambiguity-is-a-warning",
      project: "ambiguity-is-a-warning",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: ["the-task"], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId, windowStart: 1, windowEnd: 9, triggerType: "consecutive" }],
      NOW,
      ERA,
    );
    job = claimNextNoteSettlementJob(db, sessionId, NOW, NOW * 1000)!;
  });
  afterEach(() => db.close());

  /**
   * THE ACCEPTANCE CASE. A membership write puts a SECOND lane on an endpoint
   * whose blank side was deriving through its single lane. Under ticket 04 this
   * reset the claimed job (status `pending`, generation + 1, stage `topics`,
   * snapshots cleared) or deleted the edge. Now it does neither.
   *
   * The job is CLAIMED and does not name itself as the writer, so the old
   * self-exemption cannot be what keeps the edge: only the ruling can.
   */
  test("the edge is KEPT, the job is UNTOUCHED, and the side reads ambiguous", () => {
    const citing = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited);
    expect(sideOutcome(edgeId, "tail")).toBe("derived");

    // The job froze a stage-1 transition, so there IS scratch an invalidation
    // would have deleted.
    writeNoteSettlementTransitionSnapshots(db, {
      jobId: job.id,
      window: [citing],
      lookback: [],
      closure: [],
      worklist: [],
      eraCutoffEpoch: null,
    });
    const before = getNoteSettlementJob(db, job.id)!;
    expect(before.status).toBe("claimed");

    project(citing, ["the-task", "alpha", "beta"]);

    // 1. THE EDGE IS KEPT.
    expect(edgeCount(edgeId)).toBe(1);
    // 2. THE READ RENDERS `ambiguous` — nothing was cleared, nothing declared.
    expect(sideOutcome(edgeId, "tail")).toBe("ambiguous");
    // 3. THE JOB IS UNTOUCHED, field by field.
    const after = getNoteSettlementJob(db, job.id)!;
    expect(after.status).toBe("claimed");
    expect(after.claimGeneration).toBe(before.claimGeneration);
    expect(after.stage).toBe(before.stage);
    expect(after.transitionSeq).toBe(before.transitionSeq);
    // 4. AND ITS SNAPSHOTS STAND — an invalidation deleted every one of them.
    expect([...readNoteSettlementWritableSnapshot(db, job.id).keys()]).toEqual([citing]);
  });

  test("no repair authority is minted: the citer joins no writable set over an ambiguous side", () => {
    const remote = addTurn(1, ["the-task", "alpha"]);
    const windowTurn = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [remote, windowTurn], 10);
    const edgeId = addEdge(remote, windowTurn);

    // The remote turn's HEAD side derives through the window turn's single
    // lane; the projection gives that endpoint a second lane. Under ticket 04
    // the remote citer entered the transition snapshot as a `derived-side-citer`
    // with relations-only authority.
    project(windowTurn, ["the-task", "alpha", "beta"]);
    expect(sideOutcome(edgeId, "head")).toBe("ambiguous");

    const snapshot = writeNoteSettlementTransitionSnapshots(db, {
      jobId: job.id,
      window: [],
      lookback: [],
      closure: [],
      worklist: [],
      eraCutoffEpoch: null,
    });
    expect(snapshot.writable.size).toBe(0);
    expect([...readNoteSettlementWritableSnapshot(db, job.id).keys()]).toEqual([]);
  });

  test("every surviving provenance carries BOTH authorities — there is no relations-only class left", () => {
    expect(settlementWritePermissions(["window"])).toEqual({ fields: true, relations: true });
    expect(settlementWritePermissions(["lookback"])).toEqual({ fields: true, relations: true });
    expect(settlementWritePermissions(["closure"])).toEqual({ fields: true, relations: true });
    expect(settlementWritePermissions([])).toEqual({ fields: false, relations: false });
  });

  test("the writable-turns CHECK admits the three ordinary classes and refuses a retired one", () => {
    // The snapshot tables are created lazily by the seam every production
    // caller reaches them through.
    readNoteSettlementWritableSnapshot(db, job.id);
    const ddl = db
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'note_settlement_writable_turns'`,
      )
      .get()!.sql;
    expect(ddl).toContain("'window', 'lookback', 'closure'");
    expect(ddl).not.toContain("side-citer");
    expect(() =>
      db
        .query(
          `INSERT INTO note_settlement_writable_turns (job_id, turn_id, provenance)
           VALUES (?, 1, 'derived-side-citer')`,
        )
        .run(job.id),
    ).toThrow();
  });

  test("the two retired scratch tables are DROPPED, not merely unread", () => {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('note_settlement_removed_side_debts',
                        'note_settlement_pre_side_resolutions',
                        'note_settlement_claim_scope')`,
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([]);
  });

  /**
   * A DATABASE THAT STILL CARRIES THE FIVE-VALUE CHECK is rebuilt on open, the
   * way ticket 04 built it up: copy, drop, rename. The copy is FILTERED, so a
   * turn whose only authority was the retired repair channel loses its place in
   * the writable set — which IS the ruling — while a turn that also held an
   * ordinary class keeps its row.
   */
  test("the CHECK migration rebuilds an old snapshot table and drops the retired rows", () => {
    const legacy = createDatabase(":memory:");
    legacy.exec(`
      CREATE TABLE note_settlement_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT);
      INSERT INTO note_settlement_jobs (id) VALUES (7);
      CREATE TABLE note_settlement_writable_turns (
        job_id INTEGER NOT NULL REFERENCES note_settlement_jobs(id) ON DELETE CASCADE,
        turn_id INTEGER NOT NULL,
        provenance TEXT NOT NULL CHECK (
          provenance IN ('window', 'lookback', 'closure', 'removed-side-citer',
                         'derived-side-citer')
        ),
        PRIMARY KEY (job_id, turn_id, provenance)
      );
      INSERT INTO note_settlement_writable_turns VALUES
        (7, 100, 'window'),
        (7, 100, 'removed-side-citer'),
        (7, 200, 'derived-side-citer');
    `);

    // `ensureNoteSettlementSnapshotTables` runs the migration; the read below is
    // the seam every production caller reaches it through.
    expect([...readNoteSettlementWritableSnapshot(legacy, 7).entries()].sort()).toEqual([
      [100, new Set(["window"])],
    ]);
    expect(
      legacy
        .query<{ sql: string }, []>(
          `SELECT sql FROM sqlite_master
            WHERE type = 'table' AND name = 'note_settlement_writable_turns'`,
        )
        .get()!.sql,
    ).not.toContain("side-citer");
    legacy.close();
  });
});

describe("the seam still clears — the subtraction removed one arm, not three", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;

  const addTurn = (promptNumber: number, tags: string[]): number =>
    db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '["design"]', ?)
         RETURNING id`,
      )
      .get(sessionId, promptNumber, NOW - 100 + promptNumber, JSON.stringify(tags))!.id;

  const addEdge = (citingId: number, citedId: number, tailTag = "", headTag = ""): number =>
    db
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO memory_edges
           (citing_kind, citing_id, cited_kind, cited_id, provenance,
            tail_tag, head_tag, relation_class, relation_coverage, created_at_epoch)
         VALUES ('turn', ?, 'turn', ?, 'judged', ?, ?, 'use', '', ?)
         RETURNING id`,
      )
      .get(citingId, citedId, tailTag, headTag, NOW)!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "ambiguity-warning-clears",
      project: "ambiguity-warning-clears",
      title: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, { title: "Task", tags: ["the-task"], nowEpoch: 10 }).id;
    insertLane(db, segmentId, "alpha", 10);
    insertLane(db, segmentId, "beta", 10);
  });
  afterEach(() => db.close());

  test("a REDUNDANT declaration is still cleared when the endpoint drops to one lane", () => {
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "alpha", "");

    writeMembershipTags(db, {
      operation: "normal",
      writes: [{ turnId: citing, tags: ["the-task", "alpha"] }],
      writer: "settlement",
      nowEpoch: NOW,
    });

    expect(
      db
        .query<{ tailTag: string }, [number]>(
          "SELECT tail_tag AS tailTag FROM memory_edges WHERE id = ?",
        )
        .get(edgeId)!.tailTag,
    ).toBe("");
    expect(edgeCountAll(db)).toBe(1);
  });

  test("an INVALID declaration is still cleared, and the seam reports no invalidated jobs field at all", () => {
    const citing = addTurn(1, ["the-task", "alpha", "beta"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [citing, cited], 10);
    const edgeId = addEdge(citing, cited, "beta", "");

    // `beta` leaves the citer's own tags: the declaration is now a claim its
    // endpoint contradicts.
    const result = normalizeIncidentAttribution(
      db,
      [citing],
      { writer: "lane:clear", nowEpoch: NOW },
    );
    expect(result.clearedDeclarations).toEqual([]);

    writeMembershipTags(db, {
      operation: "normal",
      writes: [{ turnId: citing, tags: ["the-task", "alpha"] }],
      writer: "settlement",
      nowEpoch: NOW,
    });
    expect(
      db
        .query<{ tailTag: string }, [number]>(
          "SELECT tail_tag AS tailTag FROM memory_edges WHERE id = ?",
        )
        .get(edgeId)!.tailTag,
    ).toBe("");
    expect(edgeCountAll(db)).toBe(1);
  });

  /**
   * The merge receipt lost `invalidatedJobIds` with the mechanism; the three
   * attribution counts ticket 04 added SURVIVE, and `edgesDeleted` now counts
   * only the collision fold.
   */
  test("a task move's merge receipt keeps its three counts and carries no job list", () => {
    const moved = addTurn(1, ["the-task", "alpha"]);
    const cited = addTurn(2, ["the-task", "alpha"]);
    addSegmentMembers(db, segmentId, [moved, cited], 10);
    addEdge(moved, cited, "alpha", "");

    const into = createSegment(db, { title: "Into", tags: ["into-task"], nowEpoch: 10 }).id;
    const outcome = mergeSegments(db, segmentId, into, NOW);
    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") return;
    expect(outcome.receipt).not.toHaveProperty("invalidatedJobIds");
    expect(typeof outcome.receipt.declarationsCleared).toBe("number");
    expect(typeof outcome.receipt.edgesDeleted).toBe("number");
    expect(typeof outcome.receipt.citersStamped).toBe("number");
  });
});

function edgeCountAll(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_edges").get()!.n;
}
