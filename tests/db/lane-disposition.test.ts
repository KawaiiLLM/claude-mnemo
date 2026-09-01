import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { claimNextNoteSettlementJob, enqueueNoteSettlementWindows } from "../../src/db/note-settlement";
import { createSegment } from "../../src/db/segments";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import type { LaneComponentReport } from "../../src/shared/lane-checker";
import {
  computeComponentFingerprint,
  computeLaneFractures,
  laneTouchSegmentTagKey,
  laneTouchTurnTagKey,
  loadRunLaneTouches,
  recordLaneReadReceipt,
  recordLaneTouch,
} from "../../src/db/lane-disposition";

const NOW = 1_800_000_000;
const ERA_CUTOFF = NOW - 100_000;

function db(): Database {
  const database = createDatabase(":memory:");
  initializeSchema(database);
  return database;
}

/** A real, FK-satisfiable job id + two real turn ids — the ledger's own tables carry real FKs on purpose (no dummy scalar rows). */
function seedJobAndTurns(conn: Database): { jobId: number; turnA: number; turnB: number } {
  const sessionId = upsertSession(conn, {
    contentSessionId: `lane-disposition-${Math.random()}`,
    project: "/tmp/project-lane-disposition",
    title: "lane-disposition fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
  const insertTurn = (promptNumber: number): number =>
    conn
      .query<{ id: number }, [number, number, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           tool_call_count, created_at_epoch, type
         ) VALUES (?, ?, 'active', ?, ?, 1, ?, '["design"]')
         RETURNING id`,
      )
      .get(sessionId, promptNumber, `prompt ${promptNumber}`, `response ${promptNumber}`, NOW - 900 + promptNumber)!
      .id;
  const turnA = insertTurn(1);
  const turnB = insertTurn(2);
  enqueueNoteSettlementWindows(
    conn,
    [{ sessionId, windowStart: 1, windowEnd: 2, triggerType: "consecutive" }],
    NOW,
    ERA_CUTOFF,
  );
  const job = claimNextNoteSettlementJob(conn, sessionId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return { jobId: job.id, turnA, turnB };
}

function component(islands: readonly number[][]): LaneComponentReport {
  return {
    key: { segment: "3", tag: "some-lane" },
    componentCount: islands.length,
    islands: islands.map((memberIds) => ({ representative: memberIds[0]!, memberIds })),
  };
}

describe("computeComponentFingerprint — order-independent, deterministic", () => {
  test("the two representatives in either order fingerprint identically", () => {
    expect(computeComponentFingerprint(3, "lane", 1, 5)).toBe(computeComponentFingerprint(3, "lane", 5, 1));
  });

  test("a different segment, tag or representative pair fingerprints differently", () => {
    const base = computeComponentFingerprint(3, "lane", 1, 5);
    expect(computeComponentFingerprint(4, "lane", 1, 5)).not.toBe(base);
    expect(computeComponentFingerprint(3, "other-lane", 1, 5)).not.toBe(base);
    expect(computeComponentFingerprint(3, "lane", 1, 6)).not.toBe(base);
  });
});

describe("computeLaneFractures — N-1 consecutive-pair fractures for N islands", () => {
  test("a whole lane (1 island) owes no fracture", () => {
    expect(computeLaneFractures(3, component([[1, 2]]))).toEqual([]);
  });

  test("a severed lane (2 islands) owes exactly ONE fracture, between the two representatives", () => {
    const fractures = computeLaneFractures(3, component([[1, 2], [5, 6]]));
    expect(fractures).toHaveLength(1);
    expect(fractures[0]!.representativeA).toBe(1);
    expect(fractures[0]!.representativeB).toBe(5);
    expect(fractures[0]!.fingerprint).toBe(computeComponentFingerprint(3, "some-lane", 1, 5));
  });

  test("a lane split into 3 islands owes exactly TWO fractures — the spanning-tree minimum", () => {
    const fractures = computeLaneFractures(3, component([[1], [5], [9]]));
    expect(fractures).toHaveLength(2);
    expect(fractures.map((f) => [f.representativeA, f.representativeB])).toEqual([[1, 5], [5, 9]]);
  });

  test("a stitch that merges the two islands changes the representative pair, so the OLD fingerprint no longer matches any current fracture", () => {
    const before = computeLaneFractures(3, component([[1, 2], [5, 6]]))[0]!.fingerprint;
    // Merged: one island now, {1,2,5,6} — representative 1, no fracture at all.
    const after = computeLaneFractures(3, component([[1, 2, 5, 6]]));
    expect(after).toEqual([]);
    // And a lane that split differently afterwards (e.g. {1,5} vs {2,6})
    // fingerprints to a pair the old one never named.
    const reshaped = computeLaneFractures(3, component([[1, 5], [2, 6]]))[0]!.fingerprint;
    expect(reshaped).not.toBe(before);
  });
});

/**
 * SETTLEMENT-GATE-TAXONOMY TICKET 06 REMOVED FIVE DESCRIBE BLOCKS FROM HERE,
 * and this note is the record of what went with them rather than a claim that
 * the coverage moved somewhere else:
 *
 *   - "the justify ledger — presence and binding, never truth"
 *   - "a justification carries the evidence it was granted on (ticket 08)"
 *   - "computeDuplicateReasonRate — anomaly signal, never a machine truth check"
 *   - "lane-read receipts — coverage is over MEMBER IDS, and accumulates call
 *      over call"
 *   - "lane-read receipts — grant-principal widening across a claim's own
 *      stages (ticket 05)"
 *
 * The first three pinned `recordLaneDispositionJustification`,
 * `checkLaneDispositionJustification`, `laneRepresentativeContentSequence` and
 * `computeDuplicateReasonRate`, which are deleted: the ledger retired with the
 * commit gate that was its only consumer (user ruling S15069/T2278). The last
 * two pinned `unreadLaneMembers`/`hasAnyLaneReadReceipt`, whose only caller was
 * `justify`'s read obligation; the receipts are still WRITTEN by `recall`'s
 * lane route and the table's migrations are still pinned below.
 *
 * ONE THING GENUINELY LOST, stated because nothing replaces it here:
 * `grantPrincipalCandidates`' stage-sibling widening was exercised through
 * those receipt readers. `db/write-gate.ts` is its remaining caller and has its
 * own tests; no assertion in this file covers it any more.
 */


describe("the durable touch ledger (phase-connectivity ticket 04)", () => {
  test("both key shapes round-trip, repeats collapse, and rows are keyed by JOB alone", () => {
    const conn = db();
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    const { jobId, turnA } = seedJobAndTurns(conn);

    expect(loadRunLaneTouches(conn, jobId).turnTagPairs.size).toBe(0);

    recordLaneTouch(conn, {
      jobId,
      kind: "turn-tag",
      entityId: turnA,
      laneTag: "lane",
      createdAtEpoch: NOW,
    });
    // The SAME touch again — a restated edge side, a re-asserted tag. One row.
    recordLaneTouch(conn, {
      jobId,
      kind: "turn-tag",
      entityId: turnA,
      laneTag: "lane",
      createdAtEpoch: NOW + 1,
    });
    recordLaneTouch(conn, {
      jobId,
      kind: "lane",
      entityId: segment,
      laneTag: "lane",
      createdAtEpoch: NOW,
    });

    expect(conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lane_run_touches").get()!.n).toBe(2);

    const touches = loadRunLaneTouches(conn, jobId);
    expect([...touches.turnTagPairs]).toEqual([laneTouchTurnTagKey(turnA, "lane")]);
    expect([...touches.laneKeys]).toEqual([laneTouchSegmentTagKey(segment, "lane")]);

    // A DIFFERENT job sees none of it — the ledger is scoped to the job, and
    // to nothing narrower: `loadRunLaneTouches` takes no claim generation at
    // all, so a reclaimed claimant inherits its predecessor's obligation by
    // construction rather than by a comparison someone could get wrong.
    const other = loadRunLaneTouches(conn, jobId + 1_000);
    expect(other.turnTagPairs.size).toBe(0);
    expect(other.laneKeys.size).toBe(0);
    conn.close();
  });
});

describe("the lane_read_receipts page-coverage migration (phase-connectivity ticket 05)", () => {
  test("a legacy page_coverage-shaped table is rebuilt on the member-id shape, and its rows go with it", () => {
    const conn = db();
    // Put the PREDECESSOR shape back, rows and all — a database created by
    // the unreleased severed-lane ticket 02 build.
    conn.exec("DROP TABLE lane_read_receipts");
    conn.exec(`
      CREATE TABLE lane_read_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reader_id TEXT NOT NULL,
        segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        lane_tag TEXT NOT NULL,
        membership_snapshot TEXT NOT NULL CHECK (json_valid(membership_snapshot)),
        page_coverage TEXT NOT NULL CHECK (json_valid(page_coverage)),
        sequence INTEGER NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )`);
    const segment = createSegment(conn, { title: "seg", nowEpoch: NOW }).id;
    conn
      .query<unknown, [number]>(
        `INSERT INTO lane_read_receipts
           (reader_id, segment_id, lane_tag, membership_snapshot, page_coverage, sequence, created_at_epoch)
         VALUES ('claim:1:1', ?, 'lane', '[11,12,13]', '[1]', 1, 1)`,
      )
      .run(segment);

    initializeSchema(conn);

    const columns = conn
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('lane_read_receipts')")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("rendered_member_ids");
    expect(columns).not.toContain("page_coverage");
    // The legacy row is GONE rather than translated: a page number cannot be
    // turned into the ids that page showed, because the page SIZE that
    // produced it was never recorded — which is the defect itself.
    expect(
      conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lane_read_receipts").get()!.n,
    ).toBe(0);
    // And the new shape is writable, which a half-applied migration would not be.
    recordLaneReadReceipt(conn, {
      readerId: "claim:1:1",
      segmentId: segment,
      laneTag: "lane",
      membershipTurnIds: [11, 12, 13],
      renderedTurnIds: [11],
      sequence: 1,
      createdAtEpoch: NOW,
    });
    // TICKET 06 replaced an `unreadLaneMembers` read here — the reader retired
    // with `justify` — with the row itself. It is the stronger assertion for a
    // MIGRATION test anyway: it names the column the migration created.
    expect(
      conn
        .query<{ renderedMemberIds: string }, []>(
          "SELECT rendered_member_ids AS renderedMemberIds FROM lane_read_receipts",
        )
        .get()!.renderedMemberIds,
    ).toBe("[11]");
    conn.close();
  });
});

/**
 * PHASE-CONNECTIVITY TICKET 08, decision 4. The migration above ran
 * check-shape-then-unconditional-`DROP TABLE`, with nothing serializing the
 * two. `initializeSchema` runs from every entry point and Claude Code starts
 * two hook processes in parallel for a single event (the model documented at
 * `addColumnIfMissing` in db/schema.ts), so both could read the legacy shape:
 * one dropped and the other threw `no such table`, or the late one dropped a
 * table the early one had already recreated and was writing into.
 *
 * The fixture is two REAL PROCESSES contending for one SQLite write lock —
 * the ticket's own requirement, and the reason the test above (a single
 * connection, statements in the order the test body writes them) cannot
 * speak to this at all. The lock is what pins the interleaving: the parent
 * holds it while the racer's pre-check reads the legacy shape, so the racer
 * resumes with a belief that is exactly one commit out of date, which is the
 * losing side of the race in its worst form.
 */
describe("the lane_read_receipts migration under two concurrent initializations (ticket 08)", () => {
  test("the process that loses the race neither throws nor drops the winner's table", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-lane-receipt-race-"));
    const databasePath = join(directory, "memory.db");
    const readyMarkerPath = join(directory, "racer-ready");

    const setup = createDatabase(databasePath);
    initializeSchema(setup);
    const segment = createSegment(setup, { title: "seg", nowEpoch: NOW }).id;
    // The PREDECESSOR shape, as a database built by the unreleased
    // severed-lane ticket 02 carries it.
    setup.exec("DROP TABLE lane_read_receipts");
    setup.exec(`
      CREATE TABLE lane_read_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reader_id TEXT NOT NULL,
        segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        lane_tag TEXT NOT NULL,
        membership_snapshot TEXT NOT NULL CHECK (json_valid(membership_snapshot)),
        page_coverage TEXT NOT NULL CHECK (json_valid(page_coverage)),
        sequence INTEGER NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )`);
    setup.close();

    // The lock is taken BEFORE the racer exists, so the racer's shape
    // pre-check is guaranteed to run against the legacy table and its drop is
    // guaranteed to wait. Taking it afterwards would let the racer finish
    // first, which is a race nobody loses and therefore proves nothing.
    const winner = createDatabase(databasePath);
    winner.exec("BEGIN IMMEDIATE");

    const racer = Bun.spawn({
      cmd: [
        "bun",
        "run",
        join(import.meta.dir, "..", "support", "lane-receipt-migration-racer.ts"),
        databasePath,
        readyMarkerPath,
        String(segment),
      ],
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // The racer opens its connection and announces itself; the slack after
      // that is what puts it inside the migration, blocked on the lock this
      // process is about to take.
      const deadline = Date.now() + 20_000;
      while (!existsSync(readyMarkerPath)) {
        if (Date.now() > deadline) {
          throw new Error("the racer never announced itself");
        }
        await Bun.sleep(20);
      }

      await Bun.sleep(500);
      // The WINNER's own migration, inside the lock the racer is waiting on.
      winner.exec("DROP TABLE lane_read_receipts");
      winner.exec(`
        CREATE TABLE lane_read_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reader_id TEXT NOT NULL,
          segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
          lane_tag TEXT NOT NULL,
          membership_snapshot TEXT NOT NULL CHECK (json_valid(membership_snapshot)),
          rendered_member_ids TEXT NOT NULL CHECK (json_valid(rendered_member_ids)),
          sequence INTEGER NOT NULL,
          created_at_epoch INTEGER NOT NULL
        )`);
      winner
        .query<unknown, [number]>(
          `INSERT INTO lane_read_receipts
             (reader_id, segment_id, lane_tag, membership_snapshot, rendered_member_ids, sequence, created_at_epoch)
           VALUES ('claim:winner:1', ?, 'lane', '[7]', '[7]', 1, 1)`,
        )
        .run(segment);
      winner.exec("COMMIT");

      const exitCode = await racer.exited;
      const stderr = await new Response(racer.stderr).text();
      // NO THROW: a schema-init failure propagates out and takes the caller's
      // real work with it.
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      const rows = winner
        .query<{ readerId: string }, []>(
          "SELECT reader_id AS readerId FROM lane_read_receipts ORDER BY reader_id",
        )
        .all()
        .map((row) => row.readerId);
      // NO DROP OF A LIVE TABLE: the winner's row is still there, beside the
      // one the loser went on to write into the same table.
      expect(rows).toEqual(["claim:racer:1", "claim:winner:1"]);
      winner.close();
    } finally {
      racer.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
