import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { countSubstantiveToolCalls } from "../../src/db/note-debt";
import {
  collectDebtFacts,
  computeCompliance,
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
