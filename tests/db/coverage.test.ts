import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  computeCoverageGaps,
  isEligibleCoverageTurn,
  isNoReplySlashCommandPrompt,
} from "../../src/db/coverage";
import { initializeSchema } from "../../src/db/schema";
import { updateTurnById } from "../../src/db/turns";
import { upsertSession } from "../../src/db/sessions";

interface SeedTurnInput {
  promptNumber: number;
  status?: "active" | "provisional" | "extracted" | "skipped" | "failed" | "undone";
  userPrompt?: string | null;
  title?: string | null;
  content?: string | null;
  type?: string[];
}

describe("db/coverage — the coverage predicate (spec G1-G4, G8, ticket 08)", () => {
  let db: Database;
  let sessionId: number;
  let nextEpoch = 100;

  function seedTurn(input: SeedTurnInput): number {
    nextEpoch += 1;
    return db
      .query<{ id: number }, [number, number, string, string | null, string | null, string | null, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, title, content, type, created_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        sessionId,
        input.promptNumber,
        input.status ?? "active",
        input.userPrompt ?? "do the thing",
        input.title ?? null,
        input.content ?? null,
        JSON.stringify(input.type ?? []),
        nextEpoch,
      )!.id;
  }

  function seedDeclinedDebt(turnId: number, promptNumber: number): void {
    db.query<unknown, [number, number, number, number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason, opened_at_epoch, closed_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'skipped', 'declined', ?, ?, ?)`,
    ).run(turnId, sessionId, promptNumber, nextEpoch, nextEpoch, nextEpoch);
  }

  // A stale historical write-off, the shape `db/note-debt.ts`'s own
  // settlement backfill predicate (`listOwedNoteTurnsInRange`) still treats
  // as owed — used to prove this predicate agrees rather than disagrees.
  function seedClosedDebt(turnId: number, promptNumber: number): void {
    db.query<unknown, [number, number, number, number, number, number]>(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason, opened_at_epoch, closed_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, 'skipped', 'closed', ?, ?, ?)`,
    ).run(turnId, sessionId, promptNumber, nextEpoch, nextEpoch, nextEpoch);
  }

  function snapshotDb(): string {
    const turns = db.query<Record<string, unknown>, []>("SELECT * FROM turns ORDER BY id").all();
    const noteDebt = db
      .query<Record<string, unknown>, []>("SELECT * FROM note_debt ORDER BY turn_id")
      .all();
    return JSON.stringify({ turns, noteDebt });
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "coverage-session",
      project: "claude-mnemo",
      title: "Coverage session",
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  // Acceptance criterion 1.
  test("is a pure function: two calls leave the database byte-identical", () => {
    const gapTurn = seedTurn({ promptNumber: 1 }); // eligible, empty type → gap
    seedTurn({ promptNumber: 2, status: "skipped" }); // mechanically covered
    const declinedTurn = seedTurn({ promptNumber: 3 });
    seedDeclinedDebt(declinedTurn, 3);
    seedTurn({ promptNumber: 4, type: ["compact"], userPrompt: "/compact" });
    seedTurn({
      promptNumber: 5,
      status: "undone",
      userPrompt: "<local-command-stdout>ok</local-command-stdout>",
    });

    const turnIds = [gapTurn, declinedTurn]; // any subset; purity must hold regardless
    const before = snapshotDb();

    const firstResult = computeCoverageGaps(db, turnIds);
    const afterFirst = snapshotDb();
    expect(afterFirst).toBe(before);

    const secondResult = computeCoverageGaps(db, turnIds);
    const afterSecond = snapshotDb();
    expect(afterSecond).toBe(before);

    expect(secondResult).toEqual(firstResult);
  });

  // Acceptance criterion 2.
  test("an eligible turn with an empty type is a gap, and filling the field clears it", () => {
    const turnId = seedTurn({
      promptNumber: 1,
      status: "extracted",
      title: "design+coverage: draft the predicate",
      content: "wrote the predicate; type left unstated",
    });

    const before = computeCoverageGaps(db, [turnId]);
    expect(before).toEqual([{ turnId, sessionId, promptNumber: 1 }]);

    updateTurnById(db, turnId, { type: ["design"], updatedAtEpoch: nextEpoch });

    const after = computeCoverageGaps(db, [turnId]);
    expect(after).toEqual([]);
  });

  // Acceptance criterion 3.
  describe("a skipped turn counts as covered, not a gap", () => {
    test("the mechanical floor (status = 'skipped') covers it, with no note_debt row at all", () => {
      const turnId = seedTurn({ promptNumber: 1, status: "skipped" });
      expect(computeCoverageGaps(db, [turnId])).toEqual([]);
    });

    test("the agent's real-time decline (note_debt declined) covers it before the floor ever runs", () => {
      const turnId = seedTurn({ promptNumber: 1, status: "active" });
      seedDeclinedDebt(turnId, 1);
      expect(computeCoverageGaps(db, [turnId])).toEqual([]);
    });

    test("a declined sidechain turn is covered even though it stays 'undone' forever", () => {
      const turnId = seedTurn({ promptNumber: 5, status: "undone" });
      seedDeclinedDebt(turnId, 5);
      expect(computeCoverageGaps(db, [turnId])).toEqual([]);
    });

    // F4: "a turn that cannot yield a type is a skip, not a kept empty row" —
    // the empty-field check and the skip check are one test, not two: this
    // single assertion set covers both.
    test("a stale historical write-off (note_debt 'closed', not 'declined') does NOT read as covered", () => {
      // Matches db/note-debt.ts's own listOwedNoteTurnsInRange, which only
      // excludes 'declined' — an 'aged'/'closed'/'rolled-back' write-off is
      // still owed there, specifically so settlement can reconstruct it. This
      // predicate must agree, not silently re-cover what settlement expects
      // to still see as work.
      const turnId = seedTurn({ promptNumber: 1, status: "active" });
      seedClosedDebt(turnId, 1);
      expect(computeCoverageGaps(db, [turnId])).toEqual([
        { turnId, sessionId, promptNumber: 1 },
      ]);
    });
  });

  // Acceptance criterion 4.
  describe("the eligible set (spec G4)", () => {
    test("a compact marker is excluded", () => {
      const turnId = seedTurn({
        promptNumber: 1,
        userPrompt: "/compact",
        type: ["compact"],
      });
      expect(computeCoverageGaps(db, [turnId])).toEqual([]);
    });

    test("a slash command the harness answered with no model reply is excluded", () => {
      const turnId = seedTurn({
        promptNumber: 1,
        userPrompt: "<local-command-stdout>1.23</local-command-stdout>",
      });
      expect(computeCoverageGaps(db, [turnId])).toEqual([]);
    });

    test("a slash command envelope that DID reach the model (carries <command-name>) stays eligible", () => {
      const turnId = seedTurn({
        promptNumber: 1,
        userPrompt: "<command-message>compact</command-message><command-name>/compact</command-name>",
      });
      expect(computeCoverageGaps(db, [turnId])).toEqual([
        { turnId, sessionId, promptNumber: 1 },
      ]);
    });

    test("a sidechain row (status = 'undone') is included, not excluded", () => {
      const turnId = seedTurn({ promptNumber: 5, status: "undone" });
      expect(computeCoverageGaps(db, [turnId])).toEqual([
        { turnId, sessionId, promptNumber: 5 },
      ]);
    });

    test("isEligibleCoverageTurn / isNoReplySlashCommandPrompt agree with the predicate's own classification", () => {
      expect(isNoReplySlashCommandPrompt(null)).toBe(false);
      expect(isNoReplySlashCommandPrompt("do the thing")).toBe(false);
      expect(isNoReplySlashCommandPrompt("<local-command-stdout>x</local-command-stdout>")).toBe(
        true,
      );
      expect(isNoReplySlashCommandPrompt("<command-args>x</command-args>")).toBe(true);
      expect(
        isNoReplySlashCommandPrompt(
          "<command-args>x</command-args><command-name>/foo</command-name>",
        ),
      ).toBe(false);

      expect(isEligibleCoverageTurn({ type: ["compact"], userPrompt: "/compact" })).toBe(false);
      expect(
        isEligibleCoverageTurn({
          type: [],
          userPrompt: "<local-command-stdout>x</local-command-stdout>",
        }),
      ).toBe(false);
      expect(isEligibleCoverageTurn({ type: [], userPrompt: "do the thing" })).toBe(true);
    });
  });

  test("a stale turn id (absent from the database) is silently dropped, not an error", () => {
    expect(() => computeCoverageGaps(db, [999_999])).not.toThrow();
    expect(computeCoverageGaps(db, [999_999])).toEqual([]);
  });

  test("an empty turnIds list produces no gaps and issues no IN () query", () => {
    expect(computeCoverageGaps(db, [])).toEqual([]);
  });
});
