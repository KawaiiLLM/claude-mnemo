import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { collectDebtFacts, computeCompliance } from "../../src/metrics/p1/compliance";

/**
 * P2 settlement writes shadow notes too (interior-hole reconstruction). The P1
 * trial measures whether the MAIN AGENT writes its own, so every measurement has
 * to be blind to the settlement-authored ones — counting them would report
 * compliance that never happened.
 */

const NOW = 1_800_000_000;

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

describe("P1 metrics exclude settlement-authored notes", () => {
  test("a settlement reconstruction neither closes a debt nor counts as a stray note", () => {
    const sessionDbId = upsertSession(db, {
      contentSessionId: "origin-session",
      project: "/tmp/project-origin",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: NOW - 100,
      updatedAtEpoch: NOW,
      completedAtEpoch: null,
    }).id;

    const agentTurn = seedTurn(sessionDbId, 1);
    const settledTurn = seedTurn(sessionDbId, 2);
    const strayTurn = seedTurn(sessionDbId, 3);

    for (const [turnId, promptNumber] of [
      [agentTurn, 1],
      [settledTurn, 2],
    ] as const) {
      db.query<unknown, [number, number, number, number, number]>(
        `INSERT INTO note_debt (
           turn_id, session_id, prompt_number, status, reason,
           opened_at_epoch, closed_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, 'noted', NULL, ?, ?, ?)`,
      ).run(turnId, sessionDbId, promptNumber, NOW, NOW, NOW);
    }

    upsertShadowNote(db, {
      turnId: agentTurn,
      title: "implement+origin: the agent wrote this",
      content: "Agent-authored.",
      writerModel: "claude-opus-5",
      nowEpoch: NOW,
    });
    upsertShadowNote(db, {
      turnId: settledTurn,
      title: "research+origin: reconstructed after the fact",
      content: "Settlement-authored.",
      writerModel: "claude-sonnet-5",
      writerOrigin: "settlement",
      nowEpoch: NOW,
    });
    // A note with no debt row at all — the "stray note" counter's subject.
    upsertShadowNote(db, {
      turnId: strayTurn,
      title: "fix+origin: reconstructed with no debt",
      content: "Settlement-authored.",
      writerOrigin: "settlement",
      nowEpoch: NOW,
    });

    const byTurn = new Map(
      collectDebtFacts(db).map((fact) => [fact.turnId, fact]),
    );
    expect(byTurn.get(agentTurn)!.writerModel).toBe("claude-opus-5");
    // The settlement note is invisible: the debt shows no writer at all.
    expect(byTurn.get(settledTurn)!.writerModel).not.toBe("claude-sonnet-5");

    expect(computeCompliance(db).notesWithoutDebt).toBe(0);
  });
});
