import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  resetTurnExtractionFields,
  updateTurnBackfill,
  updateTurnById,
} from "../../src/db/turns";
import { saveTurnFixture } from "../support/turn-fixtures";

describe("turn diary invalidation", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("marks a settled diary day stale when extracted content changes", () => {
    const stateStore = createDiaryStateStore(db);
    stateStore.initializeBootstrap("2026-07-11");
    const session = upsertSession(db, {
      contentSessionId: "diary-invalidation",
      project: "/projects/diary",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const turn = saveTurnFixture(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "original prompt",
      assistantResponse: "original response",
      title: "Original title",
      content: "Original content",
      insight: "Original insight",
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T04:00:00Z") / 1_000,
      updatedAtEpoch: 100,
      observations: [],
    });
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    stateStore.settleDreamDay({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      watermark: "watermark",
      settledAtEpoch: 250,
    });

    updateTurnById(db, turn.id, {
      insight: "Corrected insight",
      updatedAtEpoch: 300,
    });

    expect(stateStore.getDayState("2026-07-10")).toMatchObject({
      needsRegen: true,
      attemptCount: 0,
    });
  });

  test("marks a settled diary day stale when backfill changes the raw response", () => {
    const stateStore = createDiaryStateStore(db);
    stateStore.initializeBootstrap("2026-07-11");
    const session = upsertSession(db, {
      contentSessionId: "diary-backfill-invalidation",
      project: "/projects/diary",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const turn = saveTurnFixture(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "original prompt",
      assistantResponse: "partial response",
      title: null,
      content: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T04:00:00Z") / 1_000,
      updatedAtEpoch: 100,
      observations: [],
    });
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    stateStore.settleDreamDay({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      watermark: "watermark",
      settledAtEpoch: 250,
    });

    updateTurnBackfill(db, turn.id, "complete response", 0);

    expect(stateStore.getDayState("2026-07-10")?.needsRegen).toBe(true);
  });

  test("marks a settled diary day stale when extracted fields are reset", () => {
    const stateStore = createDiaryStateStore(db);
    stateStore.initializeBootstrap("2026-07-11");
    const session = upsertSession(db, {
      contentSessionId: "diary-reset-invalidation",
      project: "/projects/diary",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const turn = saveTurnFixture(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "original prompt",
      assistantResponse: "original response",
      title: "Original title",
      content: "Original content",
      insight: "Original insight",
      filesRead: [],
      filesModified: [],
      createdAtEpoch: Date.parse("2026-07-10T04:00:00Z") / 1_000,
      updatedAtEpoch: 100,
      observations: [],
    });
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });
    const claimed = stateStore.claimNextDiaryItem(200)!;
    stateStore.settleDreamDay({
      date: "2026-07-10",
      queueSeq: claimed.seq,
      watermark: "watermark",
      settledAtEpoch: 250,
    });

    resetTurnExtractionFields(db, turn.id, 300);

    expect(stateStore.getDayState("2026-07-10")?.needsRegen).toBe(true);
  });
});
