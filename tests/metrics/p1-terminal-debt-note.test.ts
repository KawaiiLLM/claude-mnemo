import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { closeNoteDebtAsNoted } from "../../src/db/note-debt";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { collectDebtFacts, computeCompliance } from "../../src/metrics/p1/compliance";

/**
 * Ticket 06's 01-carryover: `closeNoteDebtAsNoted` (note-debt.ts) only flips a
 * `pending` or `skipped(declined)` debt to `noted` — a debt the SYSTEM closed
 * as `aged`/`rolled-back`/`closed` stays terminal even when a real,
 * agent-authored note lands on that same turn afterward (a backfill, or the
 * agent simply writing an address it had already been told was settled).
 * The P1 compliance metric's denominator has to read `shadow_notes`, not the
 * stale ledger status, or it reports a real note as a missed debt.
 */

const NOW = 1_900_000_000;

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
    .query<{ id: number }, [number, number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         created_at_epoch
       ) VALUES (?, ?, 'active', 'prompt', 'response', ?)
       RETURNING id`,
    )
    .get(sessionDbId, promptNumber, NOW)!.id;
}

function seedTerminalDebt(
  turnId: number,
  sessionDbId: number,
  promptNumber: number,
  reason: "aged" | "rolled-back" | "closed",
): void {
  db.query<unknown, [number, number, number, string, number, number, number]>(
    `INSERT INTO note_debt (
       turn_id, session_id, prompt_number, status, reason,
       opened_at_epoch, closed_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?)`,
  ).run(turnId, sessionDbId, promptNumber, reason, NOW, NOW, NOW);
}

describe("P1 compliance reads shadow_notes over a terminal debt row", () => {
  test("a real note written after aged/rolled-back/closed still counts as noted", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "terminal-debt-backfill",
      project: "/tmp/project-terminal-debt",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: NOW - 100,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;

    const agedTurn = seedTurn(sessionDbId, 1);
    const rolledBackTurn = seedTurn(sessionDbId, 2);
    const closedTurn = seedTurn(sessionDbId, 3);

    seedTerminalDebt(agedTurn, sessionDbId, 1, "aged");
    seedTerminalDebt(rolledBackTurn, sessionDbId, 2, "rolled-back");
    seedTerminalDebt(closedTurn, sessionDbId, 3, "closed");

    for (const turnId of [agedTurn, rolledBackTurn, closedTurn]) {
      upsertShadowNote(db, {
        turnId,
        title: `implement+terminal-debt: backfilled note for turn ${turnId}`,
        content: "Written after the ledger had already closed this debt.",
        writerModel: "claude-opus-5",
        nowEpoch: NOW + 10,
      });
      // Reproduces the real write path (mcp/note.ts): the note lands, and the
      // debt-closing call that follows it is a no-op on a terminal row — the
      // WHERE clause only matches `pending` or `skipped(declined)`.
      expect(closeNoteDebtAsNoted(db, turnId, NOW + 10)).toBe(false);
    }

    const byTurn = new Map(
      collectDebtFacts(db).map((fact) => [fact.turnId, fact]),
    );
    expect(byTurn.get(agedTurn)!.status).toBe("skipped");
    expect(byTurn.get(agedTurn)!.reason).toBe("aged");
    expect(byTurn.get(agedTurn)!.outcome).toBe("noted");
    expect(byTurn.get(rolledBackTurn)!.reason).toBe("rolled-back");
    expect(byTurn.get(rolledBackTurn)!.outcome).toBe("noted");
    expect(byTurn.get(closedTurn)!.reason).toBe("closed");
    expect(byTurn.get(closedTurn)!.outcome).toBe("noted");

    const report = computeCompliance(db);
    expect(report.overall.counts.noted).toBe(3);
    expect(report.overall.counts.defaulted).toBe(0);
    expect(report.overall.counts.unreached).toBe(0);
    expect(report.overall.counts.waived).toBe(0);
    expect(report.overall.complianceRate).toBe(1);
  });

  test("a terminal debt with no note is unaffected — the fix only reacts to a real note", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "terminal-debt-no-backfill",
      project: "/tmp/project-terminal-debt",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: NOW - 100,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;

    const closedTurn = seedTurn(sessionDbId, 1);
    seedTerminalDebt(closedTurn, sessionDbId, 1, "closed");

    const fact = collectDebtFacts(db).find(
      (candidate) => candidate.turnId === closedTurn,
    )!;
    // `defaulted`, not `unreached`: this database's exposure ledger is empty,
    // so it is entirely post-freeze and every turn counts as shown. What this
    // test is actually about is the line below — a terminal debt with no note
    // does not become `noted`.
    expect(fact.outcome).toBe("defaulted");
  });
});
