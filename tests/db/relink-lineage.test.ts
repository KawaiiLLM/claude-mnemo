import { expect, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { linkIntraSessionChain } from "../../src/db/lineage";

test("Step A chains turns by prompt_number, skips first turn, idempotent", () => {
  const db = createDatabase(":memory:");
  initializeSchema(db);

  const s = upsertSession(db, {
    contentSessionId: "s",
    project: "p",
    title: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: null,
    completedAtEpoch: null,
  }).id;

  const insert = db.query<{ id: number }, [number, number]>(
    `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
     VALUES (?, ?, 'active', 1000)
     RETURNING id`,
  );

  const t1 = insert.get(s, 1)!.id;
  const t2 = insert.get(s, 2)!.id;
  const t3 = insert.get(s, 3)!.id;

  linkIntraSessionChain(db, s);

  expect(getTurnById(db, t1)!.parentTurnId).toBeNull();  // first turn untouched
  expect(getTurnById(db, t2)!.parentTurnId).toBe(t1);
  expect(getTurnById(db, t3)!.parentTurnId).toBe(t2);

  const t4 = insert.get(s, 4)!.id;
  linkIntraSessionChain(db, s);                          // re-run after append

  expect(getTurnById(db, t4)!.parentTurnId).toBe(t3);

  // idempotent: re-running doesn't change existing links
  linkIntraSessionChain(db, s);
  expect(getTurnById(db, t2)!.parentTurnId).toBe(t1);
  expect(getTurnById(db, t3)!.parentTurnId).toBe(t2);
  expect(getTurnById(db, t4)!.parentTurnId).toBe(t3);

  // first turn stays null across all re-runs
  expect(getTurnById(db, t1)!.parentTurnId).toBeNull();
});
