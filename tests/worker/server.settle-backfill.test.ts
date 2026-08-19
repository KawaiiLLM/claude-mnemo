import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  listNoteSettlementJobs,
  NOTE_SETTLEMENT_BACKFILL_MAX_TURNS,
} from "../../src/db/note-settlement";
import { createWorkerFetchHandler } from "../../src/worker/server";
import { DEFAULT_CONFIG, type MnemoConfig } from "../../src/shared/config";
import { SETTLEMENT_ENABLED_CONFIG } from "../support/settlement-config";

/**
 * `POST /settle` — the operator's explicit backfill surface.
 *
 * Deliberately HTTP and not an MCP tool: an MCP tool would hand the main agent a
 * lever over the grading of its own record. It states one window, creates at most
 * one job, and every refusal comes back NAMED — an operator driving this from a
 * shell cannot act on "nothing happened".
 */

const ERA_CUTOFF_EPOCH = 1_000;

function settleConfig(overrides: Partial<MnemoConfig> = {}): MnemoConfig {
  return {
    ...SETTLEMENT_ENABLED_CONFIG,
    eraCutoffEpoch: ERA_CUTOFF_EPOCH,
    ...overrides,
  };
}

function seedSession(db: Database, contentSessionId: string): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-settle-backfill",
    title: null,
    content: null,
    insight: null,
    createdAtEpoch: 1,
    updatedAtEpoch: 2_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurns(
  db: Database,
  sessionDbId: number,
  from: number,
  count: number,
  createdAtEpoch: number,
): void {
  for (let promptNumber = from; promptNumber < from + count; promptNumber += 1) {
    db.query<unknown, [number, number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         assistant_response, created_at_epoch
       ) VALUES (?, ?, 'failed', 'prompt', 'reply', ?)`,
    ).run(sessionDbId, promptNumber, createdAtEpoch);
  }
}

function settle(
  handler: (req: Request) => Promise<Response>,
  body: Record<string, unknown>,
): Promise<Response> {
  return handler(
    new Request("http://127.0.0.1:37778/settle", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /settle", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("returns the one backfill job it created", async () => {
    const sessionDbId = seedSession(db, "settle-created");
    seedTurns(db, sessionDbId, 1, 60, ERA_CUTOFF_EPOCH + 500);
    const handler = createWorkerFetchHandler({ db, config: settleConfig() });

    const response = await settle(handler, {
      session_id: sessionDbId,
      window_start: 10,
      window_end: 40,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      job: {
        sessionId: sessionDbId,
        windowStart: 10,
        windowEnd: 40,
        triggerType: "backfill",
        status: "pending",
        attempts: 0,
      },
    });
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(1);
  });

  test("names each refusal instead of silently doing nothing", async () => {
    const sessionDbId = seedSession(db, "settle-refusals");
    // 1-10 legacy, 11-60 in the era.
    seedTurns(db, sessionDbId, 1, 10, ERA_CUTOFF_EPOCH - 500);
    seedTurns(db, sessionDbId, 11, 50, ERA_CUTOFF_EPOCH + 500);
    const handler = createWorkerFetchHandler({ db, config: settleConfig() });

    const belowEraFloor = await settle(handler, {
      session_id: sessionDbId,
      window_start: 5,
      window_end: 40,
    });
    expect(belowEraFloor.status).toBe(409);
    expect(await belowEraFloor.json()).toMatchObject({
      ok: false,
      reason: "below_era_floor",
    });

    const inverted = await settle(handler, {
      session_id: sessionDbId,
      window_start: 40,
      window_end: 39,
    });
    expect(inverted.status).toBe(400);
    expect(await inverted.json()).toMatchObject({
      ok: false,
      reason: "inverted_range",
    });

    const unknownSession = await settle(handler, {
      session_id: sessionDbId + 999,
      window_start: 11,
      window_end: 40,
    });
    expect(unknownSession.status).toBe(404);
    expect(await unknownSession.json()).toMatchObject({
      ok: false,
      reason: "unknown_session",
    });

    const invalid = await settle(handler, {
      session_id: sessionDbId,
      window_start: "11",
      window_end: 40,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      ok: false,
      reason: "invalid_payload",
    });

    // Nothing above wrote anything.
    expect(listNoteSettlementJobs(db, sessionDbId)).toEqual([]);

    const first = await settle(handler, {
      session_id: sessionDbId,
      window_start: 11,
      window_end: 40,
    });
    expect(first.status).toBe(200);
    const duplicate = await settle(handler, {
      session_id: sessionDbId,
      window_start: 11,
      window_end: 60,
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      ok: false,
      reason: "duplicate_window",
    });
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(1);
  });

  test("rejects a window wider than the 100-turn backfill cap; the exact cap is accepted (ticket 04)", async () => {
    const sessionDbId = seedSession(db, "settle-cap");
    seedTurns(db, sessionDbId, 1, 300, ERA_CUTOFF_EPOCH + 500);
    const handler = createWorkerFetchHandler({ db, config: settleConfig() });

    // Reject-over-100 (ticket 04 judgment call): a window one turn past the
    // cap is refused outright rather than silently clamped to 100, so the
    // receipt never implies more was settled than the operator asked for.
    const tooWide = await settle(handler, {
      session_id: sessionDbId,
      window_start: 1,
      window_end: NOTE_SETTLEMENT_BACKFILL_MAX_TURNS + 1,
    });
    expect(tooWide.status).toBe(400);
    expect(await tooWide.json()).toMatchObject({
      ok: false,
      reason: "backfill_too_large",
    });
    expect(listNoteSettlementJobs(db, sessionDbId)).toEqual([]);

    const exactlyAtCap = await settle(handler, {
      session_id: sessionDbId,
      window_start: 1,
      window_end: NOTE_SETTLEMENT_BACKFILL_MAX_TURNS,
    });
    expect(exactlyAtCap.status).toBe(200);
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(1);
  });

  test("a configured noteSettlementBackfillMaxTurns of 10 refuses an 11-turn window and accepts exactly 10 (ticket 02)", async () => {
    const sessionDbId = seedSession(db, "settle-configured-cap");
    seedTurns(db, sessionDbId, 1, 20, ERA_CUTOFF_EPOCH + 500);
    const handler = createWorkerFetchHandler({
      db,
      config: settleConfig({ noteSettlementBackfillMaxTurns: 10 }),
    });

    // The compiled-in 100-turn default would accept this window; the
    // configured 10-turn cap must be what actually governs the refusal.
    const tooWide = await settle(handler, {
      session_id: sessionDbId,
      window_start: 1,
      window_end: 11,
    });
    expect(tooWide.status).toBe(400);
    expect(await tooWide.json()).toMatchObject({
      ok: false,
      reason: "backfill_too_large",
    });
    expect(listNoteSettlementJobs(db, sessionDbId)).toEqual([]);

    const exactlyAtConfiguredCap = await settle(handler, {
      session_id: sessionDbId,
      window_start: 1,
      window_end: 10,
    });
    expect(exactlyAtConfiguredCap.status).toBe(200);
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(1);
  });

  test("refuses before writing when settlement is off or the era is unset", async () => {
    const sessionDbId = seedSession(db, "settle-gates");
    seedTurns(db, sessionDbId, 1, 60, ERA_CUTOFF_EPOCH + 500);

    const killed = createWorkerFetchHandler({
      db,
      config: settleConfig({ settlementEnabled: false }),
    });
    const killedResponse = await settle(killed, {
      session_id: sessionDbId,
      window_start: 10,
      window_end: 40,
    });
    expect(killedResponse.status).toBe(503);
    expect(await killedResponse.json()).toMatchObject({
      ok: false,
      reason: "settlement_disabled",
    });

    // No configured pin and nothing recorded in this database either.
    const noEra = createWorkerFetchHandler({
      db,
      config: { ...DEFAULT_CONFIG, eraCutoffEpoch: null },
    });
    const noEraResponse = await settle(noEra, {
      session_id: sessionDbId,
      window_start: 10,
      window_end: 40,
    });
    expect(noEraResponse.status).toBe(503);
    expect(await noEraResponse.json()).toMatchObject({
      ok: false,
      reason: "no_era_cutoff",
    });

    expect(listNoteSettlementJobs(db, sessionDbId)).toEqual([]);
  });

  test("a successful enqueue starts dispatch in the same request; refusals never do", async () => {
    const sessionDbId = seedSession(db, "settle-dispatch");
    seedTurns(db, sessionDbId, 1, 60, ERA_CUTOFF_EPOCH + 500);
    const drained: number[] = [];
    const handler = createWorkerFetchHandler({
      db,
      config: settleConfig(),
      drainSettleSessionImpl: async (sessionId) => {
        drained.push(sessionId);
      },
    });

    const refused = await settle(handler, {
      session_id: sessionDbId,
      window_start: 40,
      window_end: 39,
    });
    expect(refused.status).toBe(400);
    expect(drained).toEqual([]);

    const ok = await settle(handler, {
      session_id: sessionDbId,
      window_start: 10,
      window_end: 40,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, dispatch: "started" });
    expect(drained).toEqual([sessionDbId]);

    // duplicate_window is the one refusal that still dispatches: the job it
    // names exists and is due, and "run this window" is exactly what the
    // operator asked for — a stranded row must not need a sibling window
    // enqueued beside it just to hitch a ride.
    const duplicate = await settle(handler, {
      session_id: sessionDbId,
      window_start: 10,
      window_end: 40,
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      ok: false,
      reason: "duplicate_window",
      dispatch: "started",
    });
    expect(drained).toEqual([sessionDbId, sessionDbId]);
  });

  test("allow_pre_era crosses the era floor through the endpoint — the exact literal true only", async () => {
    const sessionDbId = seedSession(db, "settle-pre-era");
    // 1-10 legacy, 11-60 in the era.
    seedTurns(db, sessionDbId, 1, 10, ERA_CUTOFF_EPOCH - 500);
    seedTurns(db, sessionDbId, 11, 50, ERA_CUTOFF_EPOCH + 500);
    const handler = createWorkerFetchHandler({ db, config: settleConfig() });

    const truthyButNotTrue = await settle(handler, {
      session_id: sessionDbId,
      window_start: 1,
      window_end: 30,
      allow_pre_era: "yes",
    });
    expect(truthyButNotTrue.status).toBe(409);
    expect(await truthyButNotTrue.json()).toMatchObject({
      ok: false,
      reason: "below_era_floor",
    });
    expect(listNoteSettlementJobs(db, sessionDbId)).toEqual([]);

    const crossed = await settle(handler, {
      session_id: sessionDbId,
      window_start: 1,
      window_end: 30,
      allow_pre_era: true,
    });
    expect(crossed.status).toBe(200);
    expect(await crossed.json()).toMatchObject({
      ok: true,
      job: { windowStart: 1, windowEnd: 30, triggerType: "backfill" },
    });
    expect(listNoteSettlementJobs(db, sessionDbId)).toHaveLength(1);
  });
});
