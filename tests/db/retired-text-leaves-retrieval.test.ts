import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  initializeSchema,
  SEGMENT_CONTENT_TENANCY_REINDEX_RECEIPT,
  type SegmentContentTenancyReindexReceipt,
} from "../../src/db/schema";
import { rebuildSearchIndex, searchMemory } from "../../src/db/search";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  createSegment,
  readSegmentTaskImpression,
  replaceSegmentTaskImpression,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { recallMemory } from "../../src/mcp/recall";

/**
 * Retired text leaves retrieval — user ruling S15069/T2331
 * (「已经退役的文本，不要参与检索」).
 *
 * `segments.content` has ONE column and TWO possible tenants: the task-tier
 * impression (settlement wrote it and stamped `impression_origin`), or the
 * prose the main agent used to write there before lane-impressions ticket 05
 * took the field off the write face. The reader and the card already apply that
 * tenancy — an untenanted `content` renders nowhere. These tests pin the index
 * to the same answer, on BOTH paths, because half of this ruling is worse than
 * none: it would leave the live path and the stored index disagreeing about the
 * same words.
 */
describe("retired segment text leaves retrieval (ruling S15069/T2331)", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  const EPOCH = 1_900_000_000;

  /** A phrase that exists nowhere but the `content` column under test. */
  const RETIRED_PHRASE = "zephyrquartz-retired-prose";
  const RETIRED_CONTENT = `${RETIRED_PHRASE} was the old segment body`;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-retired-text",
      project: "/tmp/project",
      title: "Retired text session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const turnId = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, 1, 'extracted', '["implement"]', 'build the thing', '[]', ?,
                   'user prompt text', 'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, EPOCH)!.id;

    segmentId = createSegment(db, {
      title: "the segment under test",
      type: ["implement"],
      nowEpoch: EPOCH,
    }).id;
    addSegmentMembers(db, segmentId, [turnId], EPOCH);
  });

  afterEach(() => {
    db.close();
  });

  /** The stored FTS projection of the segment, as the index actually holds it. */
  function segmentFtsRow(): { content: string | null; extra: string | null } {
    return (
      db
        .query<{ content: string | null; extra: string | null }, [number]>(
          "SELECT content, extra FROM memory_fts WHERE layer = 'segment' AND source_id = ?",
        )
        .get(segmentId) ?? { content: null, extra: null }
    );
  }

  /**
   * Put untenanted prose in the column — exactly the shape every pre-ticket-05
   * row has on the live database: bytes in `content`, `impression_origin` NULL.
   * Written by SQL because no writer in this codebase can produce it any more,
   * which is the point.
   */
  function seedRetiredProse(): void {
    db.query("UPDATE segments SET content = ?, impression_origin = NULL WHERE id = ?").run(
      RETIRED_CONTENT,
      segmentId,
    );
  }

  /** Drive the INCREMENTAL index path through an ordinary `remember`-style write. */
  function driveIncrementalReindex(): void {
    appendSegmentWorkingStateRows(db, segmentId, "goal", ["- some unrelated goal"], EPOCH);
  }

  // The whole claim, end to end, through the real read surface — both
  // directions, or the predicate is only pinned one way.
  test("recall cannot find retired prose, and finds the same words once settlement claims the slot", () => {
    seedRetiredProse();
    driveIncrementalReindex();

    expect(recallMemory(db, { query: RETIRED_PHRASE })).not.toContain(`[E${segmentId}]`);

    // The slot is CLAIMED the way settlement claims it — the
    // `impression_origin` write is what turns those bytes into this task's
    // impression (`replaceSegmentTaskImpression`, db/segments.ts).
    const before = readSegmentTaskImpression(db, segmentId)!;
    expect(before.text).toBeNull();
    expect(
      replaceSegmentTaskImpression(db, {
        segmentId,
        baseRevision: before.revision,
        text: RETIRED_CONTENT,
        nowEpoch: EPOCH,
      }),
    ).toBe(true);

    expect(readSegmentTaskImpression(db, segmentId)!.text).toBe(RETIRED_CONTENT);
    expect(recallMemory(db, { query: RETIRED_PHRASE })).toContain(`[E${segmentId}]`);
  });

  // The same claim at the FTS layer, on each path separately, so a regression
  // names the path that broke.
  test("the incremental path withholds untenanted content and admits a claimed impression", () => {
    seedRetiredProse();
    driveIncrementalReindex();
    expect(segmentFtsRow().content ?? "").not.toContain(RETIRED_PHRASE);
    expect(searchMemory(db, { scope: "segments", query: RETIRED_PHRASE })).toEqual([]);

    const before = readSegmentTaskImpression(db, segmentId)!;
    replaceSegmentTaskImpression(db, {
      segmentId,
      baseRevision: before.revision,
      text: RETIRED_CONTENT,
      nowEpoch: EPOCH,
    });
    expect(segmentFtsRow().content ?? "").toContain(RETIRED_PHRASE);
    expect(
      searchMemory(db, { scope: "segments", query: RETIRED_PHRASE }).map((hit) => hit.sourceId),
    ).toContain(segmentId);
  });

  test("the full rebuild answers identically — one predicate, not one per path", () => {
    seedRetiredProse();
    rebuildSearchIndex(db);
    expect(segmentFtsRow().content ?? "").not.toContain(RETIRED_PHRASE);
    expect(searchMemory(db, { scope: "segments", query: RETIRED_PHRASE })).toEqual([]);

    const before = readSegmentTaskImpression(db, segmentId)!;
    replaceSegmentTaskImpression(db, {
      segmentId,
      baseRevision: before.revision,
      text: RETIRED_CONTENT,
      nowEpoch: EPOCH,
    });
    rebuildSearchIndex(db);
    expect(segmentFtsRow().content ?? "").toContain(RETIRED_PHRASE);
    expect(
      searchMemory(db, { scope: "segments", query: RETIRED_PHRASE }).map((hit) => hit.sourceId),
    ).toContain(segmentId);
  });

  // Ticket acceptance: "the retired columns are already out of
  // `indexSegmentToFTS`; assert it, so a future re-add is caught rather than
  // reviewed." Their COLUMNS still hold text (nothing deletes stored bytes),
  // so the fixture seeds them by SQL and both paths must ignore them.
  test("the retired columns contribute nothing to the FTS payload, on either path", () => {
    const retiredColumnPhrases = {
      decisions: "kelvinator-triage-protocol",
      done: "zorbathon-cutover-ruling",
      next_steps: "glimmerfrost-next-move",
    } as const;

    db.query(
      "UPDATE segments SET decisions = ?, done = ?, next_steps = ? WHERE id = ?",
    ).run(
      `- ${retiredColumnPhrases.decisions} governs the retry order`,
      `- ${retiredColumnPhrases.done} is final`,
      `- ${retiredColumnPhrases.next_steps}`,
      segmentId,
    );

    for (const drive of [driveIncrementalReindex, () => rebuildSearchIndex(db)]) {
      drive();
      const row = segmentFtsRow();
      for (const phrase of Object.values(retiredColumnPhrases)) {
        expect(`${row.content ?? ""}\n${row.extra ?? ""}`).not.toContain(phrase);
        expect(searchMemory(db, { scope: "segments", query: phrase })).toEqual([]);
      }
    }

    // The bytes are STILL THERE. This ticket changes what the index points at,
    // never what storage holds.
    expect(
      db
        .query<{ decisions: string | null }, [number]>(
          "SELECT decisions FROM segments WHERE id = ?",
        )
        .get(segmentId)?.decisions,
    ).toContain(retiredColumnPhrases.decisions);
  });
});

/**
 * The SWEEP half. New behaviour on the write path only makes new installs
 * clean; the rows already in `memory_fts` are what makes the ruling land, and
 * they are re-derived by a receipt-guarded one-shot in `initializeSchema` —
 * the seam this codebase already uses for "existing rows must be re-derived
 * after a rule change".
 */
describe("the one-shot sweep re-derives rows indexed before the ruling", () => {
  let db: Database;
  let segmentId: number;
  const EPOCH = 1_900_000_000;
  const RETIRED_PHRASE = "zephyrquartz-retired-prose";

  function readReceipt(): SegmentContentTenancyReindexReceipt | null {
    const row = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM migration_receipts WHERE name = ?",
      )
      .get(SEGMENT_CONTENT_TENANCY_REINDEX_RECEIPT);
    return row ? (JSON.parse(row.payload) as SegmentContentTenancyReindexReceipt) : null;
  }

  function ftsContent(): string | null {
    return (
      db
        .query<{ content: string | null }, [number]>(
          "SELECT content FROM memory_fts WHERE layer = 'segment' AND source_id = ?",
        )
        .get(segmentId)?.content ?? null
    );
  }

  /**
   * A database as the released build left it: untenanted prose in `content`,
   * and an FTS row that still carries it. `initializeSchema` has already run,
   * so the receipt is dropped to put this database back in the state a real
   * one is in the moment this build first opens it.
   */
  function rewindToPreRulingState(): void {
    db.query("UPDATE segments SET content = ?, impression_origin = NULL WHERE id = ?").run(
      `${RETIRED_PHRASE} was the old segment body`,
      segmentId,
    );
    db.query("DELETE FROM memory_fts WHERE layer = 'segment' AND source_id = ?").run(segmentId);
    db.query(
      `INSERT INTO memory_fts (layer, source_id, title, content, extra, prompt, response)
       VALUES ('segment', ?, ?, ?, '', '', '')`,
    ).run(segmentId, "the segment under test", `${RETIRED_PHRASE} was the old segment body`);
    db.query("DELETE FROM migration_receipts WHERE name = ?").run(
      SEGMENT_CONTENT_TENANCY_REINDEX_RECEIPT,
    );
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    segmentId = createSegment(db, { title: "the segment under test", nowEpoch: EPOCH }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a fresh database records the sweep, so nothing re-runs it later", () => {
    expect(readReceipt()).not.toBeNull();
  });

  test("the sweep withholds an already-indexed untenanted content and records what it withheld", () => {
    rewindToPreRulingState();
    expect(ftsContent()).toContain(RETIRED_PHRASE);

    initializeSchema(db);

    expect(ftsContent() ?? "").not.toContain(RETIRED_PHRASE);
    expect(searchMemory(db, { scope: "segments", query: RETIRED_PHRASE })).toEqual([]);

    const receipt = readReceipt();
    expect(receipt).not.toBeNull();
    expect(receipt!.segmentsReindexed).toBe(1);
    expect(receipt!.untenantedRows).toBe(1);
    expect(receipt!.charactersWithheld).toBe(
      `${RETIRED_PHRASE} was the old segment body`.length,
    );
  });

  test("it runs ONCE — a later open leaves the index alone", () => {
    rewindToPreRulingState();
    initializeSchema(db);
    const receiptAfterSweep = readReceipt();

    // Something writes the retired prose back into the index behind the
    // sweep's back. A second open must NOT re-run the migration.
    db.query("UPDATE memory_fts SET content = ? WHERE layer = 'segment' AND source_id = ?").run(
      `${RETIRED_PHRASE} smuggled back in`,
      segmentId,
    );
    initializeSchema(db);

    expect(ftsContent()).toContain(RETIRED_PHRASE);
    expect(readReceipt()).toEqual(receiptAfterSweep);
  });

  test("a claimed impression survives the sweep", () => {
    const before = readSegmentTaskImpression(db, segmentId)!;
    replaceSegmentTaskImpression(db, {
      segmentId,
      baseRevision: before.revision,
      text: `${RETIRED_PHRASE} is now a real impression`,
      nowEpoch: EPOCH,
    });
    db.query("DELETE FROM migration_receipts WHERE name = ?").run(
      SEGMENT_CONTENT_TENANCY_REINDEX_RECEIPT,
    );

    initializeSchema(db);

    expect(ftsContent()).toContain(RETIRED_PHRASE);
    expect(readReceipt()!.untenantedRows).toBe(0);
    expect(readReceipt()!.charactersWithheld).toBe(0);
  });
});
