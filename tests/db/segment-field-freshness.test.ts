import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import {
  latestSegmentFieldWriteEpoch,
  readSegmentFieldFreshness,
} from "../../src/db/segment-field-freshness";
import { createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { stampField } from "../../src/db/write-gate";
import { SEGMENT_EDITABLE_FIELDS } from "../../src/shared/segment-fields";
import { selectSegmentMaintenanceReminder } from "../../src/shared/segment-maintenance";

/**
 * memory-guidance ticket 02 — the reminder reads REAL per-field stamps.
 *
 * The ticket's own 要害: one write resets ONE field's count. The global
 * counter it replaces reset everything, so writing `next_steps` wiped
 * `constraints`'s twenty-turn debt and the field that mattered was never
 * surfaced. That property is asserted on its own below, separately from
 * "a reminder appeared", because a test that checks both at once passes
 * while only one of them holds.
 */
describe("readSegmentFieldFreshness", () => {
  let db: Database;
  let sessionId: number;
  const BIRTH = 1_000;

  let nextPromptNumber = 1;

  function seedTurns(count: number, fromEpoch: number): void {
    for (let index = 0; index < count; index += 1) {
      db.query(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch, type, tags)
         VALUES (?, ?, 'extracted', ?, '[]', '[]')`,
      ).run(sessionId, nextPromptNumber, fromEpoch + index + 1);
      nextPromptNumber += 1;
    }
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    nextPromptNumber = 1;
    sessionId = upsertSession(db, {
      contentSessionId: "freshness",
      project: "/tmp/p",
      title: null,
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: BIRTH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("returns a TOTAL map — every editable field present, none omitted", () => {
    const segment = createSegment(db, { title: "s", nowEpoch: BIRTH });
    const freshness = readSegmentFieldFreshness(db, segment.id, sessionId);
    expect(Object.keys(freshness).sort()).toEqual([...SEGMENT_EDITABLE_FIELDS].sort());
  });

  // THE TICKET'S 要害, asserted alone.
  test("writing one field leaves every OTHER field's debt standing", () => {
    const segment = createSegment(db, { title: "s", nowEpoch: BIRTH });
    seedTurns(30, BIRTH);

    const before = readSegmentFieldFreshness(db, segment.id, sessionId);
    expect(before.constraints).toBe(30);
    expect(before.reference).toBe(30);

    // One field written, 30 turns in.
    stampField(db, "segment", segment.id, "reference", "main", BIRTH + 30);

    const after = readSegmentFieldFreshness(db, segment.id, sessionId);
    expect(after.reference).toBe(0);
    // The whole point: untouched by a write to a different field.
    expect(after.constraints).toBe(30);
    expect(after.insight).toBe(30);
    expect(after.goal).toBe(30);
  });

  // And the consequence the agent actually sees.
  test("after writing reference, the reminder switches to the field still owing", () => {
    const segment = createSegment(db, { title: "s", nowEpoch: BIRTH });
    seedTurns(30, BIRTH);
    stampField(db, "segment", segment.id, "reference", "main", BIRTH + 30);

    const reminder = selectSegmentMaintenanceReminder(
      readSegmentFieldFreshness(db, segment.id, sessionId),
    );
    expect(reminder).not.toBeNull();
    expect(reminder!.field).not.toBe("reference");
    expect(reminder!.field).toBe("constraints");
  });

  // A never-written field owes from the segment's BIRTH, not from forever.
  // Ticket 01 modelled it as `null` (ranked Infinity), and wiring that
  // literally made a segment demand `constraints` on its first turn.
  test("a young segment owes nothing yet, and an old one owes its whole life", () => {
    const young = createSegment(db, { title: "young", nowEpoch: BIRTH });
    seedTurns(3, BIRTH);
    expect(readSegmentFieldFreshness(db, young.id, sessionId).constraints).toBe(3);
    expect(
      selectSegmentMaintenanceReminder(readSegmentFieldFreshness(db, young.id, sessionId)),
    ).toBeNull();

    seedTurns(40, BIRTH + 10);
    const old = readSegmentFieldFreshness(db, young.id, sessionId);
    expect(old.constraints).toBe(43);
    expect(
      selectSegmentMaintenanceReminder(old)!.field,
    ).toBe("constraints");
  });
});

describe("latestSegmentFieldWriteEpoch", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("is null until a field is written, then the newest field write", () => {
    const segment = createSegment(db, { title: "s", nowEpoch: 1_000 });
    expect(latestSegmentFieldWriteEpoch(db, segment.id)).toBeNull();

    stampField(db, "segment", segment.id, "goal", "main", 1_100);
    stampField(db, "segment", segment.id, "constraints", "main", 1_050);
    expect(latestSegmentFieldWriteEpoch(db, segment.id)).toBe(1_100);
  });

  // The card measured maintenance from `updated_at_epoch`, which any row
  // write bumps — so a retag read as maintenance. A stamp on a field that is
  // NOT one of the eight must not count either.
  test("ignores stamps on fields outside the editable eight", () => {
    const segment = createSegment(db, { title: "s", nowEpoch: 1_000 });
    stampField(db, "segment", segment.id, "constraints", "main", 1_050);
    stampField(db, "segment", segment.id, "title", "main", 9_999);
    expect(latestSegmentFieldWriteEpoch(db, segment.id)).toBe(1_050);
  });
});
