import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { openReadOnlyDatabase } from "../../src/metrics/p1/database";
import { initializeSchema } from "../../src/db/schema";
import {
  detectMisattribution,
  detectShiftCandidates,
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

describe("P1 shift candidates (pure-shift approximation)", () => {
  // Own database rather than the shared fixture: the shift heuristic needs
  // turns with disjoint vocabularies, and adding rows to the fixture would
  // shift every count the signature tests assert.
  let db: Database;
  let sessionId: number;
  let shiftedNoteTurn: number;

  beforeAll(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    sessionId = db
      .query<{ id: number }, []>(
        `INSERT INTO sessions (content_session_id, project, created_at_epoch)
         VALUES ('shift-sess', 'p1-fixture', 1000) RETURNING id`,
      )
      .get()!.id;

    const addTurn = (promptNumber: number, response: string): number =>
      db
        .query<{ id: number }, [number, number, string]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, user_prompt, assistant_response,
             created_at_epoch
           ) VALUES (?, ?, 'extracted', 'prompt', ?, 1000) RETURNING id`,
        )
        .get(sessionId, promptNumber, response)!.id;

    const addNote = (turnId: number, title: string, content: string): void => {
      db.query<unknown, [number, string, string]>(
        `INSERT INTO shadow_notes (turn_id, title, content, created_at_epoch, updated_at_epoch)
         VALUES (?, ?, ?, 1000, 1000)`,
      ).run(turnId, title, content);
    };

    // T1's work: proxy diagnosis. T2's work: websocket replay hashing.
    const faithful = addTurn(
      1,
      "diagnosed the proxy environment failure: socks variables broke the fastmcp startup banner check",
    );
    shiftedNoteTurn = addTurn(
      2,
      "verified websocket replay hashes across sixty three tests with canonical receipts and idempotent trajectory records",
    );
    addTurn(3, "unrelated closing summary about documentation edits and changelog wording");

    addNote(
      faithful,
      "fix+proxy: socks environment broke fastmcp",
      "diagnosed the proxy environment failure where socks variables broke the fastmcp startup banner",
    );
    // The live failure shape: a note filed under T2 whose content is T1's
    // work — its vocabulary matches the neighbour clearly better than the
    // turn it sits on.
    addNote(
      shiftedNoteTurn,
      "fix+proxy: socks environment broke fastmcp",
      "diagnosed the proxy environment failure where socks variables broke the fastmcp startup banner check",
    );
  });

  afterAll(() => {
    db.close();
  });

  test("flags the note that reads like its neighbour, and only that one", () => {
    const report = detectShiftCandidates(db, { sessionId });

    expect(report.notesConsidered).toBe(2);
    expect(report.candidates).toHaveLength(1);
    const candidate = report.candidates[0]!;
    expect(candidate.turnId).toBe(shiftedNoteTurn);
    expect(candidate.bestNeighborRef).toBe(`S${sessionId}/T1`);
    expect(candidate.neighborOverlap).toBeGreaterThan(candidate.ownOverlap);
  });

  test("a raised margin silences the flag", () => {
    const report = detectShiftCandidates(db, { sessionId, margin: 0.95 });
    expect(report.candidates).toHaveLength(0);
  });

  test("CJK notes match on shared bigrams, not whole runs", () => {
    // Chinese has no spaces: whole-run tokens would only match when two texts
    // share an entire unbroken run, so a shared phrase inside two different
    // sentences would never register (Codex review P2-6).
    const own = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch)
         VALUES (?, 10, 'extracted', 'prompt', '本轮结论：文档排版已经完成，无需继续修改。', 1000)
         RETURNING id`,
      )
      .get(sessionId)!.id;
    db.query<{ id: number }, [number]>(
      `INSERT INTO turns (session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch)
       VALUES (?, 11, 'extracted', 'prompt', '排查了代理环境失败的根因，SOCKS变量破坏了启动检查。', 1000)
       RETURNING id`,
    ).get(sessionId);
    db.query<unknown, [number]>(
      `INSERT INTO shadow_notes (turn_id, title, content, created_at_epoch, updated_at_epoch)
       VALUES (?, 'fix+proxy', '定位代理环境失败：SOCKS变量破坏启动检查的根因', 1000, 1000)`,
    ).run(own);

    const report = detectShiftCandidates(db, { sessionId });
    const flagged = report.candidates.find((candidate) => candidate.turnId === own);
    expect(flagged).toBeDefined();
    expect(flagged!.bestNeighborRef).toBe(`S${sessionId}/T11`);
  });

  test("notes without their own turn's text are reported skipped, not clean", () => {
    const orphan = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 20, 'active', 'prompt', 1000) RETURNING id`,
      )
      .get(sessionId)!.id;
    db.query<unknown, [number]>(
      `INSERT INTO shadow_notes (turn_id, title, content, created_at_epoch, updated_at_epoch)
       VALUES (?, 'ops+pending', 'written before the turn response was captured', 1000, 1000)`,
    ).run(orphan);

    const report = detectShiftCandidates(db, { sessionId });
    expect(report.notesSkipped).toBeGreaterThanOrEqual(1);
    // The evaluated count excludes it, so "N evaluated" stays honest.
    expect(report.notesConsidered).toBeGreaterThanOrEqual(2);
  });
});
