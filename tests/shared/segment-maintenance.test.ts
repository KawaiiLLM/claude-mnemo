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
 *
 * FOUR FIELDS, not eight (lane-impressions ticket 05): `decisions`, `done` and
 * `next_steps` left the product and `content` became the settlement-owned
 * task-tier impression, so the reminder channel has nothing to say about any of
 * them. What it still has to get right is unchanged — tiering, one reminder per
 * call, the criterion travelling with the field, never-written owing most.
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
    reference: 0,
    insight: 0,
    ...overrides,
  };
}

/** All four fields never written — the brand-new-segment case. */
function neverWrittenFixture(overrides: Partial<SegmentFieldFreshness> = {}): SegmentFieldFreshness {
  return {
    goal: null,
    constraints: null,
    reference: null,
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
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.constraints).toBe(20);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.insight).toBe(60);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.reference).toBe(120);
    expect(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS.goal).toBe(120);
  });

  test("the retired fields carry no interval at all — the map is exactly the four", () => {
    expect(Object.keys(SEGMENT_FIELD_MAINTENANCE_INTERVAL_TURNS).sort()).toEqual([
      "constraints",
      "goal",
      "insight",
      "reference",
    ]);
  });
});

describe("MUST NAIL 1 — tiering really tiers (D2)", () => {
  test("goal owed 100 turns (< its 120 interval) stays quiet while constraints owed 20 (= its 20 interval) fires", () => {
    const freshness = freshFixture({ goal: 100, constraints: 20 });

    const reminder = selectSegmentMaintenanceReminder(freshness);

    // If both tiers were implemented as the same interval, goal's raw 100
    // would outrank constraints's raw 20 and this would select goal instead.
    expect(reminder?.field).toBe("constraints");
  });

  test("a field exactly at its own interval is due; one turn short is not", () => {
    expect(selectSegmentMaintenanceReminder(freshFixture({ goal: 119 }))).toBeNull();
    expect(selectSegmentMaintenanceReminder(freshFixture({ goal: 120 }))?.field).toBe("goal");
  });
});

describe("MUST NAIL 2 — one reminder per call, chosen by tier priority (D4)", () => {
  test("every field due at once across all three tiers: exactly one comes back, from the highest tier owing", () => {
    const freshness = freshFixture({
      // high tier (interval 20)
      constraints: 25,
      // mid tier (interval 60)
      insight: 70,
      // low tier (interval 120) — the most overdue of all, and still loses
      goal: 500,
      reference: 125,
    });

    const reminder = selectSegmentMaintenanceReminder(freshness);

    expect(reminder).not.toBeNull();
    expect(reminder?.field).toBe("constraints");
  });

  test("falls through to mid tier only when no high-tier field is due", () => {
    const freshness = freshFixture({
      constraints: 10,
      insight: 90,
      reference: 500,
    });

    expect(selectSegmentMaintenanceReminder(freshness)?.field).toBe("insight");
  });

  test("falls through to low tier only when neither high nor mid tier has anything due", () => {
    const freshness = freshFixture({ reference: 120 });

    expect(selectSegmentMaintenanceReminder(freshness)?.field).toBe("reference");
  });

  test("within one tier the MOST overdue field wins — goal and reference share the low tier", () => {
    expect(
      selectSegmentMaintenanceReminder(freshFixture({ goal: 500, reference: 130 }))?.field,
    ).toBe("goal");
    expect(
      selectSegmentMaintenanceReminder(freshFixture({ goal: 130, reference: 500 }))?.field,
    ).toBe("reference");
  });

  test("nothing due anywhere returns null, not an empty reminder", () => {
    expect(selectSegmentMaintenanceReminder(freshFixture())).toBeNull();
  });
});

describe("MUST NAIL 3 — the criterion text travels with the field, constraints alone carries the split (D3)", () => {
  test("constraints' reminder carries the three-way routing, and the task leg points at the impression", () => {
    const reminder = selectSegmentMaintenanceReminder(freshFixture({ constraints: 20 }));

    expect(reminder?.field).toBe("constraints");
    expect(reminder?.text).toContain("holds again in this project  -> constraints");
    // Ticket 05: this leg used to route to `decisions`. That field left the
    // product, so the routing must name what actually holds a task-scoped
    // ruling now — and must NOT go on naming a field the tool refuses.
    expect(reminder?.text).toContain(
      "holds only for this task     -> nothing of yours; settlement writes it into the task's impressions",
    );
    expect(reminder?.text).not.toContain("-> decisions");
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
  });

  test("every field's criterion sentence is distinct — no field reuses another's text", () => {
    const texts = new Set<string>();
    const fields = ["goal", "constraints", "reference", "insight"] as const;
    for (const field of fields) {
      const reminder = selectSegmentMaintenanceReminder(freshFixture({ [field]: 999 }));
      expect(reminder?.field).toBe(field);
      texts.add(reminder!.text);
    }
    expect(texts.size).toBe(4);
  });

  test("the full rendered text for a numeric overdue count names the field and the turn count", () => {
    const reminder = selectSegmentMaintenanceReminder(freshFixture({ reference: 120 }));
    expect(reminder?.text).toBe(
      "mnemo segment maintenance: reference has gone 120 turns without a write — write it when a new " +
        "durable pointer appears — a source location, spec, PR, or URL worth finding again later, not " +
        "a plan or an intention.",
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
    // All four tie for maximal overdue-ness; the highest tier is
    // high-frequency, whose only member since ticket 05 is `constraints`.
    expect(reminder?.field).toBe("constraints");
    expect(reminder?.text).toContain("constraints has never been written on this segment");
  });
});
