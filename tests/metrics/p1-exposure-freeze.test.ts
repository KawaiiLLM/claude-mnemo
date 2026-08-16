import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  collectDebtFacts,
  resolveExposureLedgerFreeze,
} from "../../src/metrics/p1/compliance";

/**
 * The exposure ledger stopped being written when the per-debt reminder's
 * successor — the current-turn address injection — made every turn's address
 * visible, so `unreached` ("aged out without ever being shown") became an empty
 * category by design. The rows already accumulated stay, because they are the
 * only evidence that separates the two outcomes over the corpus the ledger DID
 * cover.
 *
 * What the metric therefore must not do is read a missing row after the freeze
 * as "never shown". The freeze is the ledger's own last row: before it, absence
 * means unexposed; after it, absence means nothing at all.
 */

const FREEZE = 1_900_000_000;

let db: Database;
let sessionDbId: number;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  sessionDbId = upsertSession(db, {
    contentSessionId: "exposure-freeze",
    project: "/tmp/project-exposure-freeze",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: FREEZE - 1000,
    updatedAtEpoch: FREEZE + 1000,
    completedAtEpoch: null,
  }).id;
});

afterEach(() => {
  db.close();
});

function seedTurn(promptNumber: number, createdAtEpoch: number): number {
  return db
    .query<{ id: number }, [number, number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         created_at_epoch
       ) VALUES (?, ?, 'active', 'prompt', 'response', ?)
       RETURNING id`,
    )
    .get(sessionDbId, promptNumber, createdAtEpoch)!.id;
}

function seedAgedDebt(turnId: number, promptNumber: number): void {
  db.query<unknown, [number, number, number, number, number, number]>(
    `INSERT INTO note_debt (
       turn_id, session_id, prompt_number, status, reason,
       opened_at_epoch, closed_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'skipped', 'aged', ?, ?, ?)`,
  ).run(turnId, sessionDbId, promptNumber, FREEZE, FREEZE, FREEZE);
}

/** A ledger row, which is what pins the freeze for the whole database. */
function seedExposure(turnId: number, createdAtEpoch: number): void {
  db.query<unknown, [number, number, number, number]>(
    `INSERT INTO note_id_exposures (
       session_id, ride_turn_id, exposed_turn_id, source, created_at_epoch
     ) VALUES (?, ?, ?, 'injection', ?)`,
  ).run(sessionDbId, turnId, turnId, createdAtEpoch);
}

function outcomeOf(turnId: number): string {
  return collectDebtFacts(db).find((fact) => fact.turnId === turnId)!.outcome;
}

describe("the exposure ledger's freeze (metric a)", () => {
  test("an empty ledger means the freeze never happened here — every turn is post-freeze", () => {
    expect(resolveExposureLedgerFreeze(db)).toBeNull();
  });

  test("the freeze is the ledger's own last row, not a pinned release date", () => {
    const early = seedTurn(1, FREEZE - 100);
    const last = seedTurn(2, FREEZE);
    seedExposure(early, FREEZE - 100);
    seedExposure(last, FREEZE);

    expect(resolveExposureLedgerFreeze(db)).toBe(FREEZE);
  });

  test("before the freeze, a turn absent from the ledger was genuinely never shown", () => {
    const shown = seedTurn(1, FREEZE - 200);
    seedExposure(shown, FREEZE);

    const unshown = seedTurn(2, FREEZE - 100);
    seedAgedDebt(unshown, 2);
    // A later turn ends the session so the aged one is past the aging bound.
    seedTurn(99, FREEZE - 50);

    expect(outcomeOf(unshown)).toBe("unreached");
  });

  test("a turn created in the SAME second as the ledger's last row counts as shown", () => {
    const shown = seedTurn(1, FREEZE - 200);
    seedExposure(shown, FREEZE);

    // Epochs are whole seconds, so this turn is genuinely ambiguous: it may
    // have been created just before or just after the last write. Resolving
    // it as `unreached` would drop it out of the compliance denominator
    // entirely — a real miss vanishing rather than being over-counted, which
    // is the one direction this rule must never take.
    const sameSecond = seedTurn(2, FREEZE);
    seedAgedDebt(sameSecond, 2);
    seedTurn(99, FREEZE + 50);

    expect(outcomeOf(sameSecond)).toBe("defaulted");
  });

  test("after the freeze, a turn absent from the ledger is not evidence it was never shown", () => {
    const shown = seedTurn(1, FREEZE - 200);
    seedExposure(shown, FREEZE);

    const later = seedTurn(2, FREEZE + 100);
    seedAgedDebt(later, 2);
    seedTurn(99, FREEZE + 150);

    // The same fixture as the test above but for the turn's timestamp, and it
    // has to land on the other side: charging the agent is the conservative
    // direction, and `unreached` here would hide a real miss behind "we never
    // asked it".
    expect(outcomeOf(later)).toBe("defaulted");
  });
});
