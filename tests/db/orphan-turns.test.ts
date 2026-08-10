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
