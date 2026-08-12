import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import {
  collectDebtFacts,
  computeCompliance,
  countSubstantiveToolCalls,
  countSubstantiveToolCallsForDebts,
  type BucketRow,
} from "../../src/metrics/p1/compliance";
import { openReadOnlyDatabase } from "../../src/metrics/p1/database";
import { createFixtureDatabase, type FixtureIds } from "./p1-fixture";

describe("P1 compliance metric", () => {
  let fixture: FixtureIds;
  let db: Database;

  beforeAll(() => {
    fixture = createFixtureDatabase();
    db = openReadOnlyDatabase(fixture.path);
  });

  afterAll(() => {
    db.close();
  });

  function bucket(rows: BucketRow[], label: string): BucketRow {
    const found = rows.find((row) => row.label === label);
    if (!found) {
      throw new Error(`missing bucket ${label}: ${rows.map((r) => r.label).join(", ")}`);
    }
    return found;
  }

  test("classifies every debt outcome the ledger can produce", () => {
    const facts = collectDebtFacts(db);
    const byTurn = new Map(facts.map((fact) => [fact.turnId, fact]));

    expect(byTurn.get(fixture.turns.a1!)!.outcome).toBe("noted");
    expect(byTurn.get(fixture.turns.a2!)!.outcome).toBe("open");
    expect(byTurn.get(fixture.turns.a3!)!.outcome).toBe("defaulted");
    expect(byTurn.get(fixture.turns.a4!)!.outcome).toBe("unreached");
    expect(byTurn.get(fixture.turns.a5!)!.outcome).toBe("waived");
    expect(byTurn.get(fixture.turns.a7!)!.outcome).toBe("noted");
  });

  test("separates a debt that was shown from one that never was", () => {
    const facts = collectDebtFacts(db);
    const byTurn = new Map(facts.map((fact) => [fact.turnId, fact]));

    // Both aged out; only the exposed one is the agent's to answer for.
    expect(byTurn.get(fixture.turns.a3!)!.exposed).toBe(true);
    expect(byTurn.get(fixture.turns.a3!)!.outcome).toBe("defaulted");
    expect(byTurn.get(fixture.turns.a4!)!.exposed).toBe(false);
    expect(byTurn.get(fixture.turns.a4!)!.outcome).toBe("unreached");
  });

  test("ages a pending debt past the bound at read time", () => {
    const fact = collectDebtFacts(db).find(
      (candidate) => candidate.turnId === fixture.turns.c1,
    )!;

    expect(fact.status).toBe("pending");
    expect(fact.lazyAged).toBe(true);
    expect(fact.outcome).toBe("defaulted");
  });

  test("turn weight uses the ledger's own tool predicate", () => {
    const batched = countSubstantiveToolCallsForDebts(db);

    for (const [turnId, count] of batched) {
      expect(count).toBe(countSubstantiveToolCalls(db, turnId));
    }

    // Four tool calls on the turn, one of them mnemo's own note call.
    expect(batched.get(fixture.turns.a1!)).toBe(3);
  });

  test("reports the headline rate and its three bucketings", () => {
    const report = computeCompliance(db);

    expect(report.overall.counts).toMatchObject({
      total: 8,
      noted: 3,
      defaulted: 2,
      unreached: 1,
      open: 1,
      openExposed: 1,
      waived: 1,
      exposed: 4,
    });
    expect(report.overall.complianceRate).toBeCloseTo(3 / 5, 10);
    expect(report.overall.reachRate).toBeCloseTo(4 / 7, 10);

    expect(bucket(report.bySessionLength, "1-24 turns").counts.total).toBe(7);
    expect(bucket(report.bySessionLength, "25-99 turns").counts.total).toBe(1);

    expect(bucket(report.byTurnWeight, "1 tool").counts.total).toBe(4);
    expect(bucket(report.byTurnWeight, "2-3 tools").counts.total).toBe(3);
    expect(bucket(report.byTurnWeight, "8+ tools").counts.total).toBe(1);

    expect(bucket(report.byWriterModel, "claude-opus-5").counts.total).toBe(6);
    expect(bucket(report.byWriterModel, "claude-sonnet-5").counts.total).toBe(1);
    expect(bucket(report.byWriterModel, "unknown").counts.total).toBe(1);
    expect(report.inferredWriterModels).toBe(5);
  });

  test("counts notes the ledger never opened a debt for", () => {
    expect(computeCompliance(db).notesWithoutDebt).toBe(1);
  });

  test("measures note latency from the ride turn", () => {
    const { latency } = computeCompliance(db);

    expect(latency.measured).toBe(3);
    expect(latency.median).toBe(1);
    expect(latency.withinThreeTurns).toBe(1);
  });

  test("restricts to one session when asked", () => {
    const report = computeCompliance(db, { sessionId: fixture.sessionB });

    expect(report.overall.counts.total).toBe(1);
    expect(report.sessionsCovered).toBe(1);
  });
});

/**
 * P2 (note-prompt-clock): a purely new-protocol session opens no `note_debt`
 * row at all (D1/D8 — the owed set is derived, not written), and its notes
 * ride a LATER turn than the one they are about (principle 2 — the opposite
 * shape of 裁決 25's current-turn signature). Before the fix, `collectDebtFacts`
 * read `note_debt` alone, so such a session's compliance rate was always
 * `null` and every one of its normal notes was flagged `notesWithoutDebt`.
 */
describe("P1 compliance metric, note-prompt-clock era", () => {
  let db: Database;
  const ERA_CUTOFF = 500;
  const NOW = 1_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedTurn(sessionId: number, promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, ?, 'active', 'prompt', ?) RETURNING id`,
      )
      .get(sessionId, promptNumber, NOW)!.id;
  }

  test("a pure new-protocol session reports a non-null, correct compliance rate and no debtless-note anomalies", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "content-prompt-clock",
      project: "/tmp/project-prompt-clock",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;

    const t1 = seedTurn(sessionId, 1);
    const t2 = seedTurn(sessionId, 2);
    const t3 = seedTurn(sessionId, 3);
    // T4: the session's current, still-running turn — never itself a
    // candidate for a note yet (the prompt clock has not ended it).
    const t4 = seedTurn(sessionId, 4);

    // Principle 2: each note is written a turn LATER than the one it is
    // about — never `ride_turn_id === turn_id`, and no `note_debt` row is
    // ever opened for any of them (no decline, no residual close-out). T4 is
    // both the vessel riding T3's note AND the session's own current turn —
    // it is never itself a candidate, correctly excluded from the denominator.
    upsertShadowNote(db, { turnId: t1, title: "a", content: "a", rideTurnId: t2, nowEpoch: NOW });
    upsertShadowNote(db, { turnId: t2, title: "b", content: "b", rideTurnId: t3, nowEpoch: NOW });
    upsertShadowNote(db, { turnId: t3, title: "c", content: "c", rideTurnId: t4, nowEpoch: NOW });

    const report = computeCompliance(db, {
      sessionId,
      eraCutoffEpoch: ERA_CUTOFF,
    });

    // Before the fix: complianceRate was null (denominator = 0 note_debt rows).
    expect(report.overall.complianceRate).not.toBeNull();
    expect(report.overall.complianceRate).toBeCloseTo(1, 10);
    expect(report.overall.counts).toMatchObject({ total: 3, noted: 3 });

    // Before the fix: all three notes counted as `notesWithoutDebt` anomalies.
    expect(report.notesWithoutDebt).toBe(0);
    expect(report.currentTurnNotes).toBe(3);
  });

  test("a legacy (pre-era) session keeps reading null with no eraCutoffEpoch supplied — the old caliber is untouched", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "content-legacy-only",
      project: "/tmp/project-prompt-clock",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: NOW,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;
    const t1 = seedTurn(sessionId, 1);
    seedTurn(sessionId, 2);
    upsertShadowNote(db, {
      turnId: t1,
      title: "a",
      content: "a",
      rideTurnId: null,
      nowEpoch: NOW,
    });

    // No eraCutoffEpoch resolvable (never configured, never recorded in
    // era_state) — every turn stays on the old, note_debt-only caliber.
    const report = computeCompliance(db, { sessionId });

    expect(report.overall.complianceRate).toBeNull();
    // The debtless note still rides no turn at all (null), which is neither
    // signature — still counted anomalous under the unchanged old reading.
    expect(report.notesWithoutDebt).toBe(1);
  });
});
