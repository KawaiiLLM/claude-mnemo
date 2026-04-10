import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { createWorkerProcessors } from "../../src/worker/processors";

describe("worker processors", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let observationId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "worker-session",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Auth race",
      content: "Current summary",
      insight: "- current insight",
      nextSteps: "Ship it",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    turnId = db
      .query<{ id: number }, []>(
        `
          INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            assistant_response,
            created_at_epoch
          ) VALUES (?, 1, 'active', 'Diagnose auth race', 'Added mutex', 120)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;

    observationId = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/auth.ts"}',
      toolResult: "file contents",
      status: "pending",
      createdAtEpoch: 130,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("processObs invokes Mnemosyne for pending observations", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processObs(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        priorTitles: [],
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      observationId,
    );

    expect(pushMessage).toHaveBeenCalledTimes(1);
    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain(`<obs id="O${observationId}">`);
    expect(prompt).toContain("🔧 Read");
    expect(prompt).toContain('in: {"file_path":"src/auth.ts"}');
  });

  test("processObs skips already-finalized observations", async () => {
    db.query("UPDATE observations SET status = 'extracted' WHERE id = ?").run(observationId);
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processObs(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        priorTitles: [],
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      observationId,
    );

    expect(pushMessage).not.toHaveBeenCalled();
  });

  test("processTurnStop invokes Mnemosyne for active turns", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processTurnStop(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        priorTitles: [],
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      turnId,
    );

    expect(pushMessage).toHaveBeenCalledTimes(1);
    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain(`<turn id="T${turnId}">`);
    expect(prompt).toContain("Diagnose auth race");
    expect(prompt).toContain("Added mutex");
    expect(prompt).toContain(`<session id="S${sessionId}">`);
  });

  test("processTurnStop skips turns that are already finalized", async () => {
    db.query("UPDATE turns SET status = 'extracted' WHERE id = ?").run(turnId);
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processTurnStop(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        priorTitles: [],
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      turnId,
    );

    expect(pushMessage).not.toHaveBeenCalled();
  });

  test("pushSessionSummaryPrompt invokes Mnemosyne with current session state", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.pushSessionSummaryPrompt(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        priorTitles: [],
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      sessionId,
    );

    expect(pushMessage).toHaveBeenCalledTimes(1);
    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain(`<session id="S${sessionId}">`);
    expect(prompt).toContain("Current summary");
  });

  test("processTurnStop does not mutate the turn before Mnemosyne writes back", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processTurnStop(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        priorTitles: [],
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      turnId,
    );

    expect(getTurnById(db, turnId)?.status).toBe("active");
  });

  test("processTurnStop aggregates file paths from observation tool input", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.processTurnStop(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        initialized: false,
        priorTitles: [],
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      turnId,
    );

    const turn = getTurnById(db, turnId);
    expect(turn?.filesRead).toEqual(["src/auth.ts"]);
    expect(turn?.toolCallCount).toBe(1);
    expect(String(pushMessage.mock.calls[0]?.[0])).toContain("files_read: src/auth.ts");
  });
});
