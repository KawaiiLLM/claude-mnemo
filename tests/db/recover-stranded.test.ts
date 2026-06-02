import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import {
  enqueueQueueItem,
  listPendingQueueItems,
} from "../../src/db/pending-queue";
import { recoverStrandedTurns } from "../../src/db/recover-stranded";

let db: Database;
let sessionId: number;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);

  sessionId = upsertSession(db, {
    contentSessionId: "content-recover-test",
    project: "claude-mnemo",
    title: "Recovery test",
    content: "Testing recovery",
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
});

afterEach(() => {
  db.close();
});

test("resets + enqueues stranded turns in prompt_number order, deduped", () => {
  const insert = db.query<
    { id: number },
    [number, number, string, string | null, string | null, string | null]
  >(
    `INSERT INTO turns (session_id, prompt_number, status, assistant_response, title, content, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, 1000)
     RETURNING id`,
  );

  // p1 active, assistant_response='r' -> recovered
  const p1id = insert.get(sessionId, 1, "active", "r", null, null)!.id;
  // p2 extracted, title=NULL, content=NULL, resp='r' -> recovered (phantom)
  const p2id = insert.get(sessionId, 2, "extracted", "r", null, null)!.id;
  // p3 extracted, title='ok', content='c', resp='r' -> ignored (valid)
  insert.get(sessionId, 3, "extracted", "r", "ok", "c");
  // p4 active, assistant_response='r' -> already has a queued turn-stop -> deduped
  const p4id = insert.get(sessionId, 4, "active", "r", null, null)!.id;

  // pre-enqueue a turn-stop for p4's id
  enqueueQueueItem(db, {
    kind: "turn-stop",
    targetId: p4id,
    sessionDbId: sessionId,
    enqueuedAtEpoch: 1000,
  });

  const count = recoverStrandedTurns(db, sessionId, 5000);
  expect(count).toBe(2); // p1, p2 (p4 deduped, p3 valid)
  expect(getTurnById(db, p2id)?.status).toBe("active"); // phantom reset
  const queued = listPendingQueueItems(db)
    .filter((i) => i.kind === "turn-stop")
    .map((i) => i.targetId);
  expect(queued).toEqual([p4id, p1id, p2id]); // p4 pre-existing first, then p1, p2 by prompt_number
});
