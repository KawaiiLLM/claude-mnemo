import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { setSessionParent, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import {
  enqueueQueueItem,
  listPendingQueueItems,
  queueItemExistsForTurn,
  resetClaimedQueueItemsForSession,
} from "../../src/db/pending-queue";
import {
  recoverStrandedAncestors,
  recoverStrandedTurns,
} from "../../src/db/recover-stranded";

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

test("connection-released work stays recoverable while terminal turns stay excluded", () => {
  const insert = db.query<
    { id: number },
    [number, number, string, string | null, string | null]
  >(
    `INSERT INTO turns (
       session_id, prompt_number, status, assistant_response,
       title, content, created_at_epoch
     )
     VALUES (?, ?, ?, 'reply', ?, ?, 1000)
     RETURNING id`,
  );
  const releasedTurnId = insert.get(
    sessionId,
    1,
    "active",
    null,
    null,
  )!.id;
  const extractedTurnId = insert.get(
    sessionId,
    2,
    "extracted",
    "done",
    "content",
  )!.id;
  const failedTurnId = insert.get(
    sessionId,
    3,
    "failed",
    null,
    null,
  )!.id;

  db.query(
    `INSERT INTO pending_queue (
       kind, target_id, session_db_id, claimed_at_epoch, enqueued_at_epoch
     )
     VALUES ('turn-stop', ?, ?, 1234, 1000)`,
  ).run(releasedTurnId, sessionId);

  // Exact durable shape left by suspendSessionAfterConnectionError: the
  // non-terminal turn and queue row remain, while the session claim is reset.
  resetClaimedQueueItemsForSession(db, sessionId);
  const recovered = recoverStrandedTurns(db, sessionId, 5000);

  expect(recovered).toBe(0); // already queued: recovery is idempotent
  expect(getTurnById(db, releasedTurnId)?.status).toBe("active");
  const queued = listPendingQueueItems(db, sessionId);
  expect(
    queued.filter(
      (item) =>
        item.kind === "turn-stop" && item.targetId === releasedTurnId,
    ),
  ).toHaveLength(1);
  expect(queued[0]?.claimedAtEpoch).toBeNull();
  expect(queueItemExistsForTurn(db, "turn-stop", extractedTurnId)).toBe(false);
  expect(queueItemExistsForTurn(db, "turn-stop", failedTurnId)).toBe(false);
});

// ===========================================================================
// The era exception: a promoted note is a record, not a stale extraction
// ===========================================================================

const ERA_CUTOFF = 2_000;

// A noted era turn as `note` leaves it: title/content/insight on the row and
// `provisional` because the note was written inside its own turn (裁决 26).
function seedNotedEraTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, assistant_response,
         title, content, insight, created_at_epoch
       )
       VALUES (?, ?, 'provisional', 'r', 'the agent''s own note',
               'First-person record of this turn.', 'why it mattered', 3000)
       RETURNING id`,
    )
    .get(sessionDbId, promptNumber)!.id;
}

function seedLegacyStrandedTurn(promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, assistant_response,
         title, content, created_at_epoch
       )
       VALUES (?, ?, 'provisional', 'r', 'partial extraction', 'half a record', 1000)
       RETURNING id`,
    )
    .get(sessionId, promptNumber)!.id;
}

test("re-enqueues an era turn without wiping the note that is its record", () => {
  const eraTurnId = seedNotedEraTurn(sessionId, 1);
  const legacyTurnId = seedLegacyStrandedTurn(2);

  const recovered = recoverStrandedTurns(db, sessionId, 5000, ERA_CUTOFF);

  expect(recovered).toBe(2);
  // The note survives untouched, and its status is left for the turn's own end
  // (the writeback settles it) rather than reset to `active`.
  expect(getTurnById(db, eraTurnId)).toMatchObject({
    status: "provisional",
    title: "the agent's own note",
    content: "First-person record of this turn.",
    insight: "why it mattered",
  });
  expect(queueItemExistsForTurn(db, "turn-stop", eraTurnId)).toBe(true);
  // Pre-cutoff turns keep the destructive reset: their fields are an
  // extraction's, and the re-enqueued extraction rewrites them.
  expect(getTurnById(db, legacyTurnId)).toMatchObject({
    status: "active",
    title: null,
    content: null,
  });
  expect(queueItemExistsForTurn(db, "turn-stop", legacyTurnId)).toBe(true);
});

test("a null cutoff resets an era-dated turn exactly as before", () => {
  const eraTurnId = seedNotedEraTurn(sessionId, 1);

  expect(recoverStrandedTurns(db, sessionId, 5000)).toBe(1);

  expect(getTurnById(db, eraTurnId)).toMatchObject({
    status: "active",
    title: null,
    content: null,
    insight: null,
  });
});

// ===========================================================================
// recoverStrandedAncestors — walk the parent chain, recover stranded tails
// ===========================================================================

// Seed a session; returns its db id.
function makeSession(contentSessionId: string, createdAtEpoch: number): number {
  return upsertSession(db, {
    contentSessionId,
    project: "claude-mnemo",
    title: null,
    insight: null,
    createdAtEpoch,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;
}

// Seed a stranded turn (phantom-extracted: title/content NULL, response set).
const seedStrandedSql = `INSERT INTO turns (session_id, prompt_number, status, assistant_response, title, content, created_at_epoch)
   VALUES (?, ?, 'extracted', 'r', NULL, NULL, 1000)
   RETURNING id`;

function seedStranded(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number]>(seedStrandedSql)
    .get(sessionDbId, promptNumber)!.id;
}

test("recoverStrandedAncestors walks the chain + re-enqueues the parent tail", () => {
  const parent = makeSession("ancestor-parent", 1);
  const parentStranded = seedStranded(parent, 7);

  // `sessionId` from beforeEach is the child; point it at the parent.
  setSessionParent(db, sessionId, parent);

  const recovered = recoverStrandedAncestors(db, sessionId, 5000);

  expect(recovered).toBeGreaterThanOrEqual(1);
  expect(queueItemExistsForTurn(db, "turn-stop", parentStranded)).toBe(true);
});

test("recoverStrandedAncestors carries the cutoff to every ancestor", () => {
  const parent = makeSession("ancestor-era-parent", 1);
  const parentNoted = seedNotedEraTurn(parent, 7);
  setSessionParent(db, sessionId, parent);

  expect(recoverStrandedAncestors(db, sessionId, 5000, ERA_CUTOFF)).toBe(1);

  expect(getTurnById(db, parentNoted)).toMatchObject({
    status: "provisional",
    title: "the agent's own note",
  });
  expect(queueItemExistsForTurn(db, "turn-stop", parentNoted)).toBe(true);
});

test("recoverStrandedAncestors guards against parent-chain cycles", () => {
  const a = makeSession("cycle-a", 1);
  const b = makeSession("cycle-b", 2);

  // 2-cycle: a -> b -> a. Self-cycle on the child too.
  setSessionParent(db, a, b);
  setSessionParent(db, b, a);
  setSessionParent(db, sessionId, sessionId);

  // Stranded turns in the cycle nodes so a re-visit would double-count.
  seedStranded(a, 1);
  seedStranded(b, 1);

  // Must terminate; count is finite (each node visited at most once).
  const recoveredFromChild = recoverStrandedAncestors(db, sessionId, 5000);
  expect(Number.isFinite(recoveredFromChild)).toBe(true);

  const recoveredFromA = recoverStrandedAncestors(db, a, 6000);
  expect(Number.isFinite(recoveredFromA)).toBe(true);
  // a -> b -> (a already visited, stop). Only b's stranded turn is recovered.
  expect(recoveredFromA).toBe(1);
});

test("recoverStrandedAncestors stops at the depth cap", () => {
  // Build a long chain child -> a1 -> a2 -> ... -> a6, each with a stranded turn.
  let prev = sessionId;
  const ancestorTurns: number[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const ancestor = makeSession(`depth-a${i}`, 10 + i);
    setSessionParent(db, prev, ancestor);
    ancestorTurns.push(seedStranded(ancestor, 1));
    prev = ancestor;
  }

  // maxDepth = 2 → only the first two ancestors are visited/recovered.
  const recovered = recoverStrandedAncestors(db, sessionId, 5000, null, 2);
  expect(recovered).toBe(2);
  expect(queueItemExistsForTurn(db, "turn-stop", ancestorTurns[0]!)).toBe(true);
  expect(queueItemExistsForTurn(db, "turn-stop", ancestorTurns[1]!)).toBe(true);
  // Beyond the cap: never reached.
  expect(queueItemExistsForTurn(db, "turn-stop", ancestorTurns[2]!)).toBe(false);
});
