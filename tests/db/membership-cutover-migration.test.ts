import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  initializeSchema,
  MEMBERSHIP_CUTOVER_MIGRATION_WRITER,
  MEMBERSHIP_CUTOVER_RECEIPT,
  type MembershipCutoverReceipt,
} from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getFieldStamp } from "../../src/db/write-gate";

/**
 * Settlement-read-once ticket 03 (spec D5) — the cutover migration.
 *
 * Every member of a NAMED task whose turn lacks that task's own tag receives
 * it, through the ticket-02 primitive, once. Unnamed tasks (frozen legacy
 * ownership) are never read by this sweep at all — their `segment_members`
 * rows stay exactly as they are.
 *
 * `initializeSchema` runs this migration on every open, so a fresh in-memory
 * database created in `beforeEach` already carries the receipt (empty
 * corpus). Fixtures are seeded RAW — `addSegmentMembers` directly, bypassing
 * `writeMembershipTags` — which reproduces the exact pre-cutover shape: a
 * `segment_members` row whose turn's own `tags` never got the word. The
 * receipt is then cleared and `initializeSchema` re-run, which is what makes
 * the database "not yet cut over" again.
 */
describe("settlement-read-once ticket 03 — the cutover migration", () => {
  let db: Database;
  let sessionId: number;
  let nextPrompt = 1;
  const EPOCH = 1_900_000_000;

  function addTurn(tags: string[] = []): number {
    return db
      .query<{ id: number }, [number, number, number, string]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, tags)
         VALUES (?, ?, 'extracted', ?, ?)
         RETURNING id`,
      )
      .get(sessionId, nextPrompt++, EPOCH, JSON.stringify(tags))!.id;
  }

  function storedTags(turnId: number): string[] {
    const raw = db
      .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
      .get(turnId)!.tags;
    return raw === null ? [] : (JSON.parse(raw) as string[]);
  }

  function memberCount(segmentId: number): number {
    return db
      .query<{ c: number }, [number]>(
        "SELECT COUNT(*) AS c FROM segment_members WHERE segment_id = ?",
      )
      .get(segmentId)!.c;
  }

  function clearReceipt(): void {
    db.run("DELETE FROM migration_receipts WHERE name = ?", [MEMBERSHIP_CUTOVER_RECEIPT]);
  }

  function receiptRows(): number {
    return db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM migration_receipts WHERE name = ?",
      )
      .get(MEMBERSHIP_CUTOVER_RECEIPT)!.c;
  }

  function receipt(): MembershipCutoverReceipt {
    const row = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM migration_receipts WHERE name = ?",
      )
      .get(MEMBERSHIP_CUTOVER_RECEIPT);
    expect(row).not.toBeNull();
    return JSON.parse(row!.payload) as MembershipCutoverReceipt;
  }

  /** A task nobody has named — production's 66, and this migration's exclusion. */
  function unnamedTask(title: string): number {
    return createSegment(db, { title, nowEpoch: EPOCH }).id;
  }

  /** A task WITH its own tag — production's population of 4. */
  function namedTask(title: string, tag: string): number {
    return createSegment(db, { title, tags: [tag], nowEpoch: EPOCH }).id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "membership-cutover",
      project: "/tmp/project-membership-cutover",
      title: null,
      insight: null,
      createdAtEpoch: EPOCH,
      updatedAtEpoch: EPOCH,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("a member of a NAMED task whose turn lacks the tag gains it", () => {
    const turnId = addTurn(["topic:auth"]);
    const segmentId = namedTask("Auth fix", "auth-fix");
    addSegmentMembers(db, segmentId, [turnId], EPOCH);
    expect(storedTags(turnId)).toEqual(["topic:auth"]);

    clearReceipt();
    initializeSchema(db);

    expect(storedTags(turnId)).toEqual(["topic:auth", "auth-fix"]);
    expect(getFieldStamp(db, "turn", turnId, "tags")?.writer).toBe(
      MEMBERSHIP_CUTOVER_MIGRATION_WRITER,
    );
    expect(memberCount(segmentId)).toBe(1);

    const r = receipt();
    expect(r.candidates).toBe(1);
    expect(r.tagged).toBe(1);
    expect(r.conflicts).toEqual([]);
  });

  test("an unnamed task's members keep their rows, untouched", () => {
    const turnA = addTurn([]);
    const turnB = addTurn(["topic:misc"]);
    const segmentId = unnamedTask("Nobody named this yet");
    addSegmentMembers(db, segmentId, [turnA, turnB], EPOCH);
    const before = memberCount(segmentId);
    const beforeTagsA = storedTags(turnA);
    const beforeTagsB = storedTags(turnB);

    clearReceipt();
    initializeSchema(db);

    expect(memberCount(segmentId)).toBe(before);
    expect(storedTags(turnA)).toEqual(beforeTagsA);
    expect(storedTags(turnB)).toEqual(beforeTagsB);
    expect(getFieldStamp(db, "turn", turnA, "tags")).toBeNull();
    expect(getFieldStamp(db, "turn", turnB, "tags")).toBeNull();

    const r = receipt();
    expect(r.candidates).toBe(0);
    expect(r.tagged).toBe(0);
  });

  test("a member already carrying the task tag is untouched — no re-stamp", () => {
    const turnId = addTurn(["ship-it"]);
    const segmentId = namedTask("Ship it", "ship-it");
    addSegmentMembers(db, segmentId, [turnId], EPOCH);

    clearReceipt();
    initializeSchema(db);

    expect(storedTags(turnId)).toEqual(["ship-it"]);
    // Never a candidate at all, so no stamp — distinguishable from "written
    // and happened to be a no-op", which the primitive itself also never
    // stamps (writeMembershipTags only stamps a turn whose tags MOVED).
    expect(getFieldStamp(db, "turn", turnId, "tags")).toBeNull();

    const r = receipt();
    expect(r.candidates).toBe(0);
    expect(r.tagged).toBe(0);
    expect(r.conflicts).toEqual([]);
  });

  test("a foreign-task conflict is refused and counted, not written", () => {
    const turnId = addTurn(["already-b"]);
    namedTask("Task B", "already-b");
    const taskA = namedTask("Task A", "task-a");
    addSegmentMembers(db, taskA, [turnId], EPOCH);

    clearReceipt();
    initializeSchema(db);

    // Left exactly as it was: still only "already-b", task A's tag never
    // added, and no stamp — a refusal changes nothing.
    expect(storedTags(turnId)).toEqual(["already-b"]);
    expect(getFieldStamp(db, "turn", turnId, "tags")).toBeNull();

    const r = receipt();
    expect(r.candidates).toBe(1);
    expect(r.tagged).toBe(0);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.segmentId).toBe(taskA);
    expect(r.conflicts[0]!.message).toContain("already-b");
  });

  test("idempotent: a second open changes nothing and writes no second receipt", () => {
    const turnId = addTurn([]);
    const segmentId = namedTask("Retry safety", "retry-safety");
    addSegmentMembers(db, segmentId, [turnId], EPOCH);

    clearReceipt();
    initializeSchema(db);
    expect(receiptRows()).toBe(1);
    const first = receipt();
    const tagsAfterFirst = storedTags(turnId);
    const stampAfterFirst = getFieldStamp(db, "turn", turnId, "tags");

    // A second open — WITHOUT clearing the receipt — must be a pure no-op:
    // no second receipt row, tags and stamp byte-identical.
    initializeSchema(db);

    expect(receiptRows()).toBe(1);
    expect(receipt()).toEqual(first);
    expect(storedTags(turnId)).toEqual(tagsAfterFirst);
    expect(getFieldStamp(db, "turn", turnId, "tags")).toEqual(stampAfterFirst);
  });

  test("empty corpus: initializeSchema alone writes a receipt with zero candidates", () => {
    // No fixtures beyond what `beforeEach` already set up (a session, no
    // segments) — this is the state every FRESH database opens `initializeSchema`
    // into, and the migration must not throw or loop on it.
    expect(receiptRows()).toBe(1);
    const r = receipt();
    expect(r.candidates).toBe(0);
    expect(r.tagged).toBe(0);
    expect(r.conflicts).toEqual([]);
  });
});
