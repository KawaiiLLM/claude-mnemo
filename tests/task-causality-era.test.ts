import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../src/db/database";
import { initializeSchema } from "../src/db/schema";
import { getTurn } from "../src/db/turns";
import { rememberTool } from "../src/mcp/remember";
import { isTaskCausalityEra } from "../src/task-causality-era";

describe("task-causality era", () => {
  const cutoffEpoch = 200;
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = Number(
      db.query(
        `INSERT INTO sessions (
           content_session_id, project, title, created_at_epoch, updated_at_epoch
         ) VALUES ('era-session', '/tmp/project', 'Era session', 100, 100)
         RETURNING id`,
      ).get()!.id,
    );
  });

  afterEach(() => {
    db.close();
  });

  test("flips exactly at the injected cutoff for seeded turns", () => {
    for (const [promptNumber, createdAtEpoch] of [
      [1, cutoffEpoch - 1],
      [2, cutoffEpoch],
      [3, cutoffEpoch + 1],
    ] as const) {
      db.query(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, ?, 'active', ?, ?)`,
      ).run(sessionId, promptNumber, `Turn ${promptNumber}`, createdAtEpoch);
    }

    expect(
      isTaskCausalityEra(getTurn(db, sessionId, 1)!.createdAtEpoch, cutoffEpoch),
    ).toBe(false);
    expect(
      isTaskCausalityEra(getTurn(db, sessionId, 2)!.createdAtEpoch, cutoffEpoch),
    ).toBe(true);
    expect(
      isTaskCausalityEra(getTurn(db, sessionId, 3)!.createdAtEpoch, cutoffEpoch),
    ).toBe(true);
  });

  test("regrade leaves the creation-epoch era unchanged", () => {
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, significance_grade,
         created_at_epoch
       ) VALUES (?, 1, 'extracted', 'Legacy premise', 3, ?),
                (?, 2, 'active', 'Correct premise', NULL, ?)`,
    ).run(sessionId, cutoffEpoch - 1, sessionId, cutoffEpoch + 1);
    const legacyTurn = getTurn(db, sessionId, 1)!;
    const currentTurn = getTurn(db, sessionId, 2)!;

    rememberTool(db, {
      id: `T${currentTurn.id}`,
      title: "Correct premise",
      content: `Evidence overturned [T${legacyTurn.id}].`,
      type: "discovery",
      grade: 2,
      regrade: { id: `T${legacyTurn.id}`, grade: 1 },
    });

    const regraded = getTurn(db, sessionId, 1)!;
    expect(regraded.significanceGrade).toBe(1);
    expect(regraded.createdAtEpoch).toBe(cutoffEpoch - 1);
    expect(isTaskCausalityEra(regraded.createdAtEpoch, cutoffEpoch)).toBe(false);
  });
});
