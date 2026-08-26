import { describe, expect, test } from "bun:test";

import {
  SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS,
  SEGMENT_MAINTENANCE_HIGH_FREQUENCY_INTERVAL_TURNS,
  SEGMENT_MAINTENANCE_LOW_FREQUENCY_INTERVAL_TURNS,
  SEGMENT_MAINTENANCE_MID_FREQUENCY_INTERVAL_TURNS,
  selectSegmentMaintenanceReminder,
  type SegmentFieldFreshness,
} from "../../src/shared/segment-maintenance";

/**
 * Ticket 01 (`.scratch/memory-guidance/issues/01-per-field-reminder-selector.md`,
 * spec D2/D3/D4). Pure function over an already-computed "turns since last
 * write" map — no database, no clock. See segment-maintenance.ts's own doc
 * comment for the WHY (the rubric-forwarding failure this replaces).
 */

/**
 * `SegmentFieldFreshness` is a TOTAL map by design (see the type's own doc
 * comment) — every field must say either a turn count or `null`. This helper
 * builds an all-fresh baseline (0 turns since write on every field, i.e.
 * "just written", never due) so each test only has to state the field(s) it
 * actually cares about, without silently leaving the rest ambiguous the way
 * a `Partial` fixture would.
 */
function freshFixture(overrides: Partial<SegmentFieldFreshness> = {}): SegmentFieldFreshness {
  return {
    goal: 0,
    constraints: 0,
    decisions: 0,
    done: 0,
    next_steps: 0,
    reference: 0,
    content: 0,
    insight: 0,
    ...overrides,
  };
}

/** All eight fields never written — the brand-new-segment case. */
function neverWrittenFixture(overrides: Partial<SegmentFieldFreshness> = {}): SegmentFieldFreshness {
  return {
    goal: null,
    constraints: null,
    decisions: null,
    done: null,
    next_steps: null,
    reference: null,
    content: null,
    insight: null,
    ...overrides,
  };
}

describe("tier constants", () => {
  test("three distinct tiers, ascending", () => {
    expect(SEGMENT_MAINTENANCE_HIGH_FREQUENCY_INTERVAL_TURNS).toBe(20);
    expect(SEGMENT_MAINTENANCE_MID_FREQUENCY_INTERVAL_TURNS).toBe(60);
    expect(SEGMENT_MAINTENANCE_LOW_FREQUENCY_INTERVAL_TURNS).toBe(120);
  });

  test("every field maps to one of the three tier constants", () => {
    const values = new Set(Object.values(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS));
    expect(values).toEqual(
      new Set([
        SEGMENT_MAINTENANCE_HIGH_FREQUENCY_INTERVAL_TURNS,
        SEGMENT_MAINTENANCE_MID_FREQUENCY_INTERVAL_TURNS,
        SEGMENT_MAINTENANCE_LOW_FREQUENCY_INTERVAL_TURNS,
      ]),
    );
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.next_steps).toBe(20);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.constraints).toBe(20);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.decisions).toBe(20);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.done).toBe(60);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.content).toBe(60);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.insight).toBe(60);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.reference).toBe(120);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.goal).toBe(120);
  });
});

describe("MUST NAIL 1 — tiering really tiers (D2)", () => {
  test("goal owed 100 turns (< its 120 interval) stays quiet while next_steps owed 20 (= its 20 interval) fires", () => {
    const freshness = freshFixture({ goal: 100, next_steps: 20 });

    const reminder = selectSegmentMaintenanceReminder(freshness);

    // If both tiers were implemented as the same interval, goal's raw 100
    // would outrank next_steps's raw 20 and this would select goal instead.
    expect(reminder?.field).toBe("next_steps");
  });

  test("a field exactly at its own interval is due; one turn short is not", () => {
    expect(selectSegmentMaintenanceReminder(freshFixture({ goal: 119 }))).toBeNull();
    expect(selectSegmentMaintenanceReminder(freshFixture({ goal: 120 }))?.field).toBe("goal");
  });
});

describe("MUST NAIL 2 — one reminder per call, chosen by tier priority (D4)", () => {
  test("six fields due at once across all three tiers: exactly one comes back, from the highest tier owing", () => {
    const freshness = freshFixture({
      // high tier (interval 20) — three due, decisions most overdue
      next_steps: 20,
      constraints: 25,
      decisions: 45,
      // mid tier (interval 60) — two due
      done: 60,
      content: 70,
      // low tier (interval 120) — one due
      reference: 125,
      // goal, insight stay at the fresh-fixture default (0) — not due
    });

    const reminder = selectSegmentMaintenanceReminder(freshness);

    expect(reminder).not.toBeNull();
    expect(reminder?.field).toBe("decisions");
  });

  test("falls through to mid tier only when no high-tier field is due", () => {
    const freshness = freshFixture({
      next_steps: 5,
      constraints: 10,
      done: 60,
      content: 90,
    });

    expect(selectSegmentMaintenanceReminder(freshness)?.field).toBe("content");
  });

  test("falls through to low tier only when neither high nor mid tier has anything due", () => {
    const freshness = freshFixture({ reference: 120 });

    expect(selectSegmentMaintenanceReminder(freshness)?.field).toBe("reference");
  });

  test("nothing due anywhere returns null, not an empty reminder", () => {
    expect(selectSegmentMaintenanceReminder(freshFixture())).toBeNull();
  });
});

describe("MUST NAIL 3 — the criterion text travels with the field, constraints alone carries the split (D3)", () => {
  test("constraints' reminder carries the three-way routing", () => {
    const reminder = selectSegmentMaintenanceReminder(freshFixture({ constraints: 20 }));

    expect(reminder?.field).toBe("constraints");
    expect(reminder?.text).toContain("holds again in this project  -> constraints");
    expect(reminder?.text).toContain("holds only for this task     -> decisions");
    expect(reminder?.text).toContain(
      "holds only for this turn     -> stays in that turn's own insight (via note) — do not promote it here",
    );
  });

  test("goal's reminder carries its own sentence and none of the routing split", () => {
    const reminder = selectSegmentMaintenanceReminder(freshFixture({ goal: 120 }));

    expect(reminder?.field).toBe("goal");
    expect(reminder?.text).toContain("the task's real target has shifted or sharpened");
    expect(reminder?.text).not.toContain("->");
    expect(reminder?.text).not.toContain("constraints");
    expect(reminder?.text).not.toContain("decisions");
  });

  test("every field's criterion sentence is distinct — no field reuses another's text", () => {
    const texts = new Set<string>();
    const fields = [
      "goal",
      "constraints",
      "decisions",
      "done",
      "next_steps",
      "reference",
      "content",
      "insight",
    ] as const;
    for (const field of fields) {
      const reminder = selectSegmentMaintenanceReminder(freshFixture({ [field]: 999 }));
      expect(reminder?.field).toBe(field);
      texts.add(reminder!.text);
    }
    expect(texts.size).toBe(8);
  });

  test("the full rendered text for a numeric overdue count names the field and the turn count", () => {
    const reminder = selectSegmentMaintenanceReminder(freshFixture({ next_steps: 20 }));
    expect(reminder?.text).toBe(
      "mnemo segment maintenance: next_steps has gone 20 turns without a write — write it the moment " +
        "what is waiting to be done changes — a new item queued, or a stale one that should drop off.",
    );
  });
});

describe("MUST NAIL 4 — never written owes the most, not zero", () => {
  test("a never-written field (null) is due even though a zero-default would read it as just written", () => {
    const reminder = selectSegmentMaintenanceReminder(freshFixture({ goal: null }));
    expect(reminder?.field).toBe("goal");
    expect(reminder?.text).toContain("goal has never been written on this segment");
  });

  test("never-written outranks a large but finite overdue count in the same tier", () => {
    const freshness = freshFixture({
      goal: null, // low tier, never written
      reference: 500, // low tier, very overdue but finite
    });

    // A zero-default bug would make `goal` read as freshly written (not due
    // at all), letting `reference` win by default instead.
    expect(selectSegmentMaintenanceReminder(freshness)?.field).toBe("goal");
  });

  test("a brand-new segment (every field never written) still resolves to exactly one field", () => {
    const reminder = selectSegmentMaintenanceReminder(neverWrittenFixture());
    // All eight tie for maximal overdue-ness; the highest tier is
    // high-frequency (constraints/decisions/next_steps), and within that tie
    // the declared order of SEGMENT_EDITABLE_FIELDS (goal, constraints,
    // decisions, done, next_steps, reference, content, insight) decides —
    // `constraints` is the first high-frequency field in that order.
    expect(reminder?.field).toBe("constraints");
    expect(reminder?.text).toContain("constraints has never been written on this segment");
  });
});
