import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema, retireLegacyPendingNoteDebts } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";

/**
 * Spec note-prompt-clock D8, ticket 06: the owed set has been a derived query
 * since 03, and nothing has opened a `pending` `note_debt` row since — the one
 * surviving INSERT (`recordDeclinedNoteDebt`) is born `skipped`. A `pending`
 * row still in the ledger is therefore stranded pre-cutover bookkeeping, and
 * `initializeSchema` writes every one of them off once, in place, the same
 * `status = 'skipped', reason = 'closed'` shape residual settlement already
 * uses to abandon a dead session's tail.
 */
describe("note_debt pending retirement (spec D8)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedTurn(sessionDbId: number, promptNumber: number): number {
    return db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, ?, 'active', 'p', 'r', 1000)
         RETURNING id`,
      )
      .get(sessionDbId, promptNumber)!.id;
  }

  function seedDebt(
    turnId: number,
    sessionDbId: number,
    promptNumber: number,
    status: "pending" | "noted" | "skipped",
    reason: "aged" | "rolled-back" | "closed" | "declined" | null,
  ): void {
    db.query<
      unknown,
      [number, number, number, string, string | null, number | null]
    >(
      `INSERT INTO note_debt (
         turn_id, session_id, prompt_number, status, reason,
         opened_at_epoch, closed_at_epoch, updated_at_epoch
       ) VALUES (?, ?, ?, ?, ?, 10, ?, 10)`,
    ).run(
      turnId,
      sessionDbId,
      promptNumber,
      status,
      reason,
      status === "pending" ? null : 10,
    );
  }

  function seedLedger(): {
    sessionDbId: number;
    pendingA: number;
    pendingB: number;
    noted: number;
    declined: number;
    aged: number;
    rolledBack: number;
    alreadyClosed: number;
  } {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "legacy-pending-retirement",
      project: "/tmp/project-note-debt-retirement",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;

    const pendingA = seedTurn(sessionDbId, 1);
    const pendingB = seedTurn(sessionDbId, 2);
    const noted = seedTurn(sessionDbId, 3);
    const declined = seedTurn(sessionDbId, 4);
    const aged = seedTurn(sessionDbId, 5);
    const rolledBack = seedTurn(sessionDbId, 6);
    const alreadyClosed = seedTurn(sessionDbId, 7);

    seedDebt(pendingA, sessionDbId, 1, "pending", null);
    seedDebt(pendingB, sessionDbId, 2, "pending", null);
    seedDebt(noted, sessionDbId, 3, "noted", null);
    seedDebt(declined, sessionDbId, 4, "skipped", "declined");
    seedDebt(aged, sessionDbId, 5, "skipped", "aged");
    seedDebt(rolledBack, sessionDbId, 6, "skipped", "rolled-back");
    seedDebt(alreadyClosed, sessionDbId, 7, "skipped", "closed");

    return {
      sessionDbId,
      pendingA,
      pendingB,
      noted,
      declined,
      aged,
      rolledBack,
      alreadyClosed,
    };
  }

  function debtRow(turnId: number) {
    return db
      .query<
        {
          status: string;
          reason: string | null;
          closedAtEpoch: number | null;
          updatedAtEpoch: number;
        },
        [number]
      >(
        `SELECT status, reason, closed_at_epoch AS closedAtEpoch,
                updated_at_epoch AS updatedAtEpoch
         FROM note_debt WHERE turn_id = ?`,
      )
      .get(turnId)!;
  }

  function pendingCount(): number {
    return (
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM note_debt WHERE status = 'pending'",
        )
        .get()!.count
    );
  }

  test("closes every pending row and leaves every other outcome untouched", () => {
    const ids = seedLedger();
    const notedBefore = debtRow(ids.noted);
    const declinedBefore = debtRow(ids.declined);
    const agedBefore = debtRow(ids.aged);
    const rolledBackBefore = debtRow(ids.rolledBack);
    const alreadyClosedBefore = debtRow(ids.alreadyClosed);
    expect(pendingCount()).toBe(2);

    initializeSchema(db);

    expect(pendingCount()).toBe(0);
    for (const turnId of [ids.pendingA, ids.pendingB]) {
      const row = debtRow(turnId);
      expect(row.status).toBe("skipped");
      expect(row.reason).toBe("closed");
      expect(row.closedAtEpoch).not.toBeNull();
    }

    // Every other outcome is byte-identical — the migration is a `pending`-only
    // write, not a general reconciliation pass.
    expect(debtRow(ids.noted)).toEqual(notedBefore);
    expect(debtRow(ids.declined)).toEqual(declinedBefore);
    expect(debtRow(ids.aged)).toEqual(agedBefore);
    expect(debtRow(ids.rolledBack)).toEqual(rolledBackBefore);
    expect(debtRow(ids.alreadyClosed)).toEqual(alreadyClosedBefore);
  });

  test("is idempotent — a second and third pass touch nothing further", () => {
    const ids = seedLedger();

    initializeSchema(db);
    const afterFirst = [ids.pendingA, ids.pendingB].map(debtRow);

    initializeSchema(db);
    initializeSchema(db);

    expect([ids.pendingA, ids.pendingB].map(debtRow)).toEqual(afterFirst);
    expect(pendingCount()).toBe(0);
  });

  test("the exported migration reports how many rows it closed", () => {
    // `beforeEach`'s own `initializeSchema` already ran before any row
    // existed to close, so this direct call is the first pass over the two
    // pending rows this test seeds — it reports them, and a second pass
    // reports none, since the predicate it runs against is now empty.
    seedLedger();

    expect(retireLegacyPendingNoteDebts(db)).toBe(2);
    expect(retireLegacyPendingNoteDebts(db)).toBe(0);

    const db2 = createDatabase(":memory:");
    initializeSchema(db2);
    const sessionDbId = upsertSession(db2, {
      contentSessionId: "direct-call",
      project: "/tmp/project-note-debt-retirement",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
    const turnId = db2
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt,
           assistant_response, created_at_epoch
         ) VALUES (?, 1, 'active', 'p', 'r', 1000)
         RETURNING id`,
      )
      .get(sessionDbId)!.id;
    db2
      .query<unknown, [number, number]>(
        `INSERT INTO note_debt (
           turn_id, session_id, prompt_number, status,
           opened_at_epoch, updated_at_epoch
         ) VALUES (?, ?, 1, 'pending', 10, 10)`,
      )
      .run(turnId, sessionDbId);

    expect(retireLegacyPendingNoteDebts(db2)).toBe(1);
    expect(retireLegacyPendingNoteDebts(db2)).toBe(0);
    db2.close();
  });

  test("a fresh database (nothing seeded) is a no-op", () => {
    expect(pendingCount()).toBe(0);
    initializeSchema(db);
    expect(pendingCount()).toBe(0);
  });
});
