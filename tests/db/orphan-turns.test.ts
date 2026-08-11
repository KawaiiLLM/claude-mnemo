import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getOrphanTurns, skipOrphanTurns } from "../../src/db/orphan-turns";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";

let db: Database;
let sessionId: number;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  sessionId = upsertSession(db, {
    contentSessionId: "orphan-turns",
    project: "claude-mnemo",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
});

afterEach(() => {
  db.close();
});

test("an orphan still records the files it touched", () => {
  // Same writer, same hole as the stranded floor: skipping extraction must not
  // mean skipping the mechanical aggregation, or the turn drops out of `file:`
  // recall permanently.
  const turnId = seedTurn(1, "active", null);
  db.query(
    `INSERT INTO observations (turn_id, tool_name, tool_input, status, created_at_epoch)
     VALUES (?, 'Read', ?, 'pending', 1000),
            (?, 'Write', ?, 'pending', 1001)`,
  ).run(
    turnId,
    JSON.stringify({ file_path: "/proj/read.ts" }),
    turnId,
    JSON.stringify({ file_path: "/proj/written.ts" }),
  );

  skipOrphanTurns(db, sessionId, 2000, [{ id: turnId, promptNumber: 1 }]);

  const turn = getTurnById(db, turnId);
  expect(turn?.status).toBe("skipped");
  expect(turn?.filesRead).toEqual(["/proj/read.ts"]);
  expect(turn?.filesModified).toEqual(["/proj/written.ts"]);
  expect(turn?.toolCallCount).toBe(2);
});

function seedTurn(promptNumber: number, status: string, title: string | null): number {
  return db
    .query<{ id: number }, [number, number, string, string | null]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         assistant_response, title, created_at_epoch
       )
       VALUES (?, ?, ?, 'prompt', NULL, ?, 1000)
       RETURNING id`,
    )
    .get(sessionId, promptNumber, status, title)!.id;
}

test("selects a turn left provisional, not just an active one", () => {
  const activeTurnId = seedTurn(1, "active", null);
  const notedTurnId = seedTurn(2, "provisional", "the agent's own note");
  seedTurn(3, "extracted", "already settled");

  expect(getOrphanTurns(db, sessionId).map((turn) => turn.id)).toEqual([
    activeTurnId,
    notedTurnId,
  ]);
});

test("a noted turn whose session died before Stop is settled as extracted", () => {
  // No assistant_response and no queued turn-stop: the session ended before the
  // Stop hook could capture one, so SessionEnd's pass is this turn's last
  // chance to become visible to search (db/search.ts renders `extracted`).
  const notedTurnId = seedTurn(1, "provisional", "the agent's own note");

  const orphans = getOrphanTurns(db, sessionId);
  expect(skipOrphanTurns(db, sessionId, 2000, orphans)).toBe(1);

  expect(getTurnById(db, notedTurnId)).toMatchObject({
    status: "extracted",
    title: "the agent's own note",
  });
});

test("a turn with a queued turn-stop is left to the extraction path", () => {
  const notedTurnId = seedTurn(1, "provisional", "the agent's own note");
  db.query<unknown, [number, number]>(
    `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
     VALUES ('turn-stop', ?, ?, 1000)`,
  ).run(notedTurnId, sessionId);

  expect(getOrphanTurns(db, sessionId)).toEqual([]);
});
