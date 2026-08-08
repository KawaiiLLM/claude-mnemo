import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openReadOnlyDatabase } from "../../src/metrics/p1/database";
import {
  detectMisattribution,
  type ChannelReport,
} from "../../src/metrics/p1/misattribution";
import { createFixtureDatabase, type FixtureIds } from "./p1-fixture";

describe("P1 mis-attribution signature", () => {
  let fixture: FixtureIds;
  let db: Database;

  beforeAll(() => {
    fixture = createFixtureDatabase();
    db = openReadOnlyDatabase(fixture.path);
  });

  afterAll(() => {
    db.close();
  });

  function channel(reports: ChannelReport[], name: string): ChannelReport {
    return reports.find((report) => report.channel === name)!;
  }

  test("counts a repeated response as one victim, not two", () => {
    const report = detectMisattribution(db);
    const response = channel(report.channels, "response");

    expect(response.eligible).toBe(5);
    expect(response.clusters).toBe(2);
    expect(response.victims).toBe(2);
    expect(response.rate).toBeCloseTo(2 / 5, 10);
  });

  test("catches a truncated re-attachment through the prefix rule", () => {
    const report = detectMisattribution(db);
    const prefixCluster = report.clusters.find(
      (cluster) => cluster.channel === "response" && cluster.kind === "prefix",
    )!;

    expect(prefixCluster.members.map((member) => member.turnId)).toEqual([
      fixture.turns.b20!,
      fixture.turns.b21!,
    ]);
    expect(prefixCluster.victims).toBe(1);
  });

  test("annotates retried turns instead of dropping them", () => {
    const report = detectMisattribution(db);
    const exactCluster = report.clusters.find(
      (cluster) => cluster.channel === "response" && cluster.kind === "exact",
    )!;

    expect(exactCluster.members[1]!.wasRolledBack).toBe(true);
    expect(channel(report.channels, "response").victimsExcludingRetries).toBe(1);
  });

  test("legacy summaries are checked with the same rule", () => {
    const legacy = channel(detectMisattribution(db).channels, "legacy-note");

    expect(legacy.eligible).toBe(4);
    expect(legacy.victims).toBe(1);
  });

  test("the shadow channel has no duplicates to find", () => {
    const shadow = channel(detectMisattribution(db).channels, "shadow-note");

    expect(shadow.eligible).toBeGreaterThan(1);
    expect(shadow.victims).toBe(0);
  });

  test("a longer minimum length drops the short duplicate", () => {
    const report = detectMisattribution(db, { minCharacters: 120 });
    const response = channel(report.channels, "response");

    // PREFIX_TRUNCATED is 100 characters, so the prefix pair falls out while
    // the exact pair survives.
    expect(response.victims).toBe(1);
  });

  test("raising the prefix ratio drops the prefix pair only", () => {
    const report = detectMisattribution(db, { prefixRatio: 0.9 });
    const response = channel(report.channels, "response");

    expect(response.victims).toBe(1);
    expect(
      report.clusters.filter(
        (cluster) => cluster.channel === "response" && cluster.kind === "prefix",
      ),
    ).toHaveLength(0);
  });

  test("scopes to one session", () => {
    const report = detectMisattribution(db, { sessionId: fixture.sessionA });

    expect(channel(report.channels, "response").eligible).toBe(0);
    expect(channel(report.channels, "legacy-note").victims).toBe(1);
  });
});
