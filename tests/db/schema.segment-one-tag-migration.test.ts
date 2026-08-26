import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { LANE_REGISTRY_PHASE_RECEIPTS } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import {
  runSegmentOneTagMigration,
  SEGMENT_ONE_TAG_RECEIPT,
  type SegmentOneTagReceipt,
} from "../../src/db/segment-one-tag-migration";

/**
 * The one-tag migration (lane-model-v12 ticket 14, spec D3e).
 *
 * Every fixture here is built the same way: let `initializeSchema` run the
 * migration once on an empty database, then UNDO its two artifacts (the
 * receipt row and the unique index) so a pre-v12 segment shape can be written
 * with raw SQL and the phase re-run against it. That is the only way to
 * observe the phase at all — on a live upgrade it runs before any caller can
 * get a handle on the database.
 */
describe("segment one-tag migration (ticket 14)", () => {
  let db: Database;

  function reopenPreMigration(): void {
    db.exec("DELETE FROM migration_receipts WHERE name = ?".replace("?", `'${SEGMENT_ONE_TAG_RECEIPT}'`));
    db.exec("DROP INDEX IF EXISTS idx_segments_tag_unique");
  }

  function insertSegment(id: number, status: string, tags: string[]): void {
    db.query<unknown, [number, string, string, string, number, number]>(
      `INSERT INTO segments (id, title, status, tags, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, `segment ${id}`, status, JSON.stringify(tags), 100, 100);
  }

  function receipt(): SegmentOneTagReceipt {
    const row = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM migration_receipts WHERE name = ?",
      )
      .get(SEGMENT_ONE_TAG_RECEIPT)!;
    return JSON.parse(row.payload) as SegmentOneTagReceipt;
  }

  function indexExists(): boolean {
    return (
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_segments_tag_unique'",
        )
        .get() !== null
    );
  }

  function storedTags(id: number): string[] {
    return JSON.parse(
      db.query<{ tags: string }, [number]>("SELECT tags FROM segments WHERE id = ?").get(id)!.tags,
    ) as string[];
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    reopenPreMigration();
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // The receipt's own name (spec D4 / this ticket's constraint)
  // -------------------------------------------------------------------------

  test("the receipt name stays OUT of the lane-declaration registry's phase set", () => {
    expect(SEGMENT_ONE_TAG_RECEIPT.startsWith("lane-declaration-")).toBe(false);
    expect(LANE_REGISTRY_PHASE_RECEIPTS).not.toContain(SEGMENT_ONE_TAG_RECEIPT);
  });

  // -------------------------------------------------------------------------
  // The three dispositions
  // -------------------------------------------------------------------------

  test("an OPEN segment with exactly one uncontested word keeps it as its name", () => {
    insertSegment(60, "open", ["claude-mnemo"]);
    runSegmentOneTagMigration(db, 500);

    expect(storedTags(60)).toEqual(["claude-mnemo"]);
    expect(receipt().named).toEqual([{ segmentId: 60, tag: "claude-mnemo" }]);
  });

  test("a segment that takes no new members has its derived list emptied, whatever its size", () => {
    const monster = Array.from({ length: 29 }, (_, index) => `derived-${index}`);
    insertSegment(53, "delivered", monster);
    insertSegment(13, "closed", ["engine-wiring-v2", "scene-data-v2"]);
    insertSegment(43, "abandoned", ["san11-spec-mvp-scope"]);
    runSegmentOneTagMigration(db, 500);

    expect(storedTags(53)).toEqual([]);
    expect(storedTags(13)).toEqual([]);
    expect(storedTags(43)).toEqual([]);
    // The receipt records what each one used to carry — those words are still
    // on the member turns, and the receipt says which container they came from.
    const retired = receipt().retired;
    expect(retired.map((entry) => entry.segmentId).sort((a, b) => a - b)).toEqual([13, 43, 53]);
    expect(retired.find((entry) => entry.segmentId === 53)!.clearedTags).toHaveLength(29);
  });

  test("an OPEN container with no word, several words, or a contested word is left PENDING HUMAN NAMING", () => {
    insertSegment(61, "open", []);
    insertSegment(62, "open", ["several", "words", "here"]);
    insertSegment(9, "open", ["contested"]);
    insertSegment(63, "open", ["contested"]);
    runSegmentOneTagMigration(db, 500);

    // Nothing was generated for any of them.
    expect(storedTags(61)).toEqual([]);
    expect(storedTags(62)).toEqual([]);
    expect(storedTags(63)).toEqual([]);
    // The FIRST claimant of a contested word keeps it; the later one is the
    // one that has to be renamed by hand.
    expect(storedTags(9)).toEqual(["contested"]);

    const pending = receipt().pendingNaming;
    expect(pending.map((entry) => [entry.segmentId, entry.reason])).toEqual([
      [61, "none"],
      [62, "several"],
      [63, "collision"],
    ]);
    expect(pending.find((entry) => entry.segmentId === 63)!.heldBy).toBe(9);
    expect(pending.find((entry) => entry.segmentId === 62)!.clearedTags).toEqual([
      "several",
      "words",
      "here",
    ]);
  });

  test("existing memberships are grandfathered — the phase rewrites no segment_members row", () => {
    insertSegment(60, "open", ["claude-mnemo"]);
    db.query<unknown, []>(
      `INSERT INTO sessions (content_session_id, project, created_at_epoch, updated_at_epoch)
       VALUES ('one-tag-migration-session', 'claude-mnemo', 100, 100)`,
    ).run();
    const sessionDbId = db
      .query<{ id: number }, []>("SELECT id FROM sessions LIMIT 1")
      .get()!.id;
    const turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, 1, 'extracted', 100) RETURNING id`,
      )
      .get(sessionDbId)!.id;
    db.query<unknown, [number, number]>(
      "INSERT INTO segment_members (segment_id, turn_id, created_at_epoch) VALUES (?, ?, 100)",
    ).run(60, turnId);

    runSegmentOneTagMigration(db, 500);

    // The member carries none of the segment's words and stays a member: a
    // migration cannot decide which past turns belonged where, so derivation
    // governs writes from here on and nothing retroactively.
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM segment_members")
        .get()!.count,
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The unique index — global uniqueness as a schema fact
  // -------------------------------------------------------------------------

  test("the unique index is created by the phase, AFTER the duplicates are gone", () => {
    insertSegment(6, "delivered", ["scene-data-v2"]);
    insertSegment(8, "delivered", ["scene-data-v2"]);
    runSegmentOneTagMigration(db, 500);

    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_segments_tag_unique'",
        )
        .get(),
    ).not.toBeNull();
    insertSegment(70, "open", ["fresh"]);
    expect(() => insertSegment(71, "open", ["fresh"])).toThrow(/UNIQUE constraint failed/);
  });

  /**
   * THE GUARD HAS TO BE MONOTONIC, and the receipt cannot make it so.
   *
   * This phase has two outcomes of different kinds: a one-time clearing of the
   * legacy tag lists, which the receipt honestly attests to, and a STANDING
   * structural guarantee that no two segments hold the same word, which is an
   * INDEX — not row data, and therefore not something a receipt can vouch for.
   * Any later `segments` rebuild drops every index attached to the table, and
   * under a receipt-only gate no reopen would ever put this one back. The
   * uniqueness precheck in the write faces would then be the whole guarantee,
   * and two concurrent writers can pass a precheck in the same instant.
   *
   * Caught by the peer review of this batch; the fixture below is the reopen
   * that a receipt-gated version silently sleeps through.
   */
  test("the unique index is re-issued on reopen, so a later segments rebuild cannot retire the guard", () => {
    insertSegment(60, "open", ["claude-mnemo"]);
    runSegmentOneTagMigration(db, 500);
    const first = receipt();
    expect(indexExists()).toBe(true);

    // What a `segments` rebuild does to it, stated directly.
    db.exec("DROP INDEX idx_segments_tag_unique");
    expect(indexExists()).toBe(false);

    // The reopen. The receipt is present and stays present — this is not a
    // second migration, and the clearing must NOT run again.
    runSegmentOneTagMigration(db, 600);

    expect(indexExists()).toBe(true);
    insertSegment(70, "open", ["fresh"]);
    expect(() => insertSegment(71, "open", ["fresh"])).toThrow(/UNIQUE constraint failed/);
    expect(storedTags(60)).toEqual(["claude-mnemo"]);
    expect(receipt()).toEqual(first);
  });

  // -------------------------------------------------------------------------
  // Atomicity: data and receipt in ONE transaction (this ticket's constraint)
  // -------------------------------------------------------------------------

  test("FAILPOINT: a crash at the receipt write leaves the segment rows untouched, and a rerun completes", () => {
    insertSegment(53, "delivered", ["a", "b", "c"]);
    insertSegment(60, "open", ["claude-mnemo"]);

    // The failpoint: the receipt insert is the phase's LAST statement, so a
    // trigger that raises on it interrupts the transaction exactly where a
    // crash would be most damaging — after every data write.
    db.exec(`
      CREATE TRIGGER segment_one_tag_failpoint
      BEFORE INSERT ON migration_receipts
      WHEN NEW.name = '${SEGMENT_ONE_TAG_RECEIPT}'
      BEGIN SELECT RAISE(ABORT, 'failpoint'); END
    `);
    expect(() => runSegmentOneTagMigration(db, 500)).toThrow(/failpoint/);

    // Nothing half-applied: the delivered segment still holds its three words,
    // and no receipt claims the phase ran.
    expect(storedTags(53)).toEqual(["a", "b", "c"]);
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM migration_receipts WHERE name = ?",
        )
        .get(SEGMENT_ONE_TAG_RECEIPT)!.count,
    ).toBe(0);
    // The index went back too — it is created inside the same transaction.
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_segments_tag_unique'",
        )
        .get(),
    ).toBeNull();

    db.exec("DROP TRIGGER segment_one_tag_failpoint");
    runSegmentOneTagMigration(db, 600);
    expect(storedTags(53)).toEqual([]);
    expect(storedTags(60)).toEqual(["claude-mnemo"]);
  });

  test("a second run is a no-op, and does not rewrite a name a human set afterwards", () => {
    insertSegment(61, "open", []);
    runSegmentOneTagMigration(db, 500);
    const first = receipt();

    db.query<unknown, [string, number]>("UPDATE segments SET tags = ? WHERE id = ?").run(
      JSON.stringify(["named-by-hand"]),
      61,
    );
    runSegmentOneTagMigration(db, 600);

    expect(storedTags(61)).toEqual(["named-by-hand"]);
    expect(receipt()).toEqual(first);
  });
});
