import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { DREAM_ENABLED_CONFIG } from "../support/dream-config";
import { createObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { runHookCommand } from "../../src/hooks/hook-command";
import { createPostToolUseHandler } from "../../src/hooks/handlers/post-tool-use";
import { createSessionEndHandler } from "../../src/hooks/handlers/session-end";
import { createSessionInitHandler } from "../../src/hooks/handlers/session-init";
import type { HookHandler } from "../../src/hooks/types";
import {
  createWorkerCore,
  createWorkerFetchHandler,
  createWorkerServerState,
} from "../../src/worker/server";

const DUE_DATE = "2026-07-21";
const DUE_EPOCH = Date.parse(`${DUE_DATE}T12:00:00Z`) / 1_000;
const NOW_EPOCH = Date.parse("2026-07-22T12:00:00Z") / 1_000;

describe("async tool attribution production-blockade regression", () => {
  let db: Database;
  let dataRoot: string;
  let handlers: Record<string, HookHandler>;
  let dreamClaims: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    dataRoot = mkdtempSync(join(tmpdir(), "mnemo-async-liveness-"));
    dreamClaims = 0;

    const sessionEnvRegistry = new Map<string, Record<string, string>>();
    const diaryStore = createDiaryStateStore(db);
    const core = createWorkerCore({
      db,
      now: () => NOW_EPOCH,
      sessionEnvRegistry,
      config: DREAM_ENABLED_CONFIG,
      reconcileDreamBacklog: async () => [DUE_DATE],
      async processDiaryItem(item) {
        dreamClaims += 1;
        diaryStore.acknowledgeDiaryItem(item.seq);
      },
      logger: { warn() {}, error() {} },
    });

    const workerState = createWorkerServerState(NOW_EPOCH * 1_000);
    const workerRequestHandler = createWorkerFetchHandler(
      {
        db,
        dataRoot,
        sessionEnvRegistry,
        scanAndDrainQueue: core.scanAndDrainQueue,
        handleTurnStopImpl: core.handleTurnStop,
        handleFlushImpl: core.finishSession,
        handleCompactImpl: core.handleCompact,
        registerSessionEnvImpl: core.registerSessionEnv,
        clearSessionEnvImpl: core.clearSessionEnv,
        logger: { warn() {}, error() {} },
      },
      workerState,
    );
    const workerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      // ticket 02's request gate requires an exact loopback Host header on
      // every route now; a real network client (worker/client.ts, this
      // test's own subject) never sets one itself -- the transport layer
      // does, which this in-process fetch shim stands in for.
      request.headers.set("host", "127.0.0.1:37778");
      const response = await workerRequestHandler(request);
      await workerState.globalScanInFlight;
      return response;
    };
    const workerClientDeps = { fetchImpl: workerFetch };
    const workerEnv = { HOME: dataRoot };
    handlers = {
      UserPromptSubmit: createSessionInitHandler({ db, now: () => NOW_EPOCH }),
      PostToolUse: createPostToolUseHandler({
        db,
        now: () => NOW_EPOCH,
        logger: { warn() {} },
      }),
      SessionEnd: createSessionEndHandler({
        db,
        now: () => NOW_EPOCH,
        workerClientDeps,
        workerEnv,
      }),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  async function run(command: string, raw: Record<string, unknown>): Promise<void> {
    const exitCode = await runHookCommand({
      env: {},
      argv: ["bun", "hook-command.ts", command],
      stdout: { write: () => true },
      stderr: { write: () => true },
      readJsonFromStdin: () => raw,
      handlers,
    });
    expect(exitCode).toBe(0);
  }

  function makeSession(contentSessionId: string): number {
    return upsertSession(db, {
      contentSessionId,
      project: "/proj",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: DUE_EPOCH,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  }

  test("repairs all three production shapes before the due diary becomes claimable", async () => {
    const diaryStore = createDiaryStateStore(db);
    diaryStore.enqueueDay({ date: DUE_DATE, enqueuedAtEpoch: DUE_EPOCH });

    const completedSessionId = makeSession("completed-root");
    const completedTurnId = db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, created_at_epoch
       ) VALUES (?, 1, 'extracted', 'done prompt', 'done response', 'done', 'done', ?)
       RETURNING id`,
    ).get(completedSessionId, DUE_EPOCH)!.id;

    const provisionalSessionId = makeSession("provisional-root");
    const provisionalTurnId = db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, created_at_epoch
       ) VALUES (?, 1, 'provisional', 'old work', 'partial response', 'usable partial', ?)
       RETURNING id`,
    ).get(provisionalSessionId, DUE_EPOCH)!.id;
    const provisionalObsId = createObservation(db, {
      turnId: provisionalTurnId,
      toolName: "WebSearch",
      status: "pending",
      createdAtEpoch: DUE_EPOCH,
    }).id;
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('obs', ?, ?, ?)`,
    ).run(provisionalObsId, provisionalSessionId, DUE_EPOCH);
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, created_at_epoch
       ) VALUES (?, 2, 'extracted', 'later prompt', 'later response', 'later', 'later', ?)`
    ).run(provisionalSessionId, DUE_EPOCH + 10);

    const pollutedSessionId = makeSession("polluted-root");
    const terminalOwnerId = db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, created_at_epoch
       ) VALUES (?, 1, 'extracted', 'terminal', 'terminal', 'terminal', 'terminal', ?)
       RETURNING id`,
    ).get(pollutedSessionId, DUE_EPOCH)!.id;
    const pollutionObsId = createObservation(db, {
      turnId: terminalOwnerId,
      toolName: "Bash",
      status: "pending",
      createdAtEpoch: DUE_EPOCH,
    }).id;
    const blockedTurnId = db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch
       ) VALUES (?, 2, 'active', 'blocked work', 'finished response', ?)
       RETURNING id`,
    ).get(pollutedSessionId, DUE_EPOCH + 20)!.id;
    db.query(
      `INSERT INTO pending_queue (kind, target_id, session_db_id, enqueued_at_epoch)
       VALUES ('obs', ?, ?, ?), ('turn-stop', ?, ?, ?)`
    ).run(
      pollutionObsId,
      pollutedSessionId,
      DUE_EPOCH,
      blockedTurnId,
      pollutedSessionId,
      DUE_EPOCH + 20,
    );

    await run("tool-use", {
      hook_event_name: "PostToolUse",
      session_id: "completed-root",
      agent_id: "child-agent-42",
      tool_name: "WebFetch",
      tool_response: "child result",
    });
    expect(db.query<{ count: number }, [number]>(
      "SELECT COUNT(*) AS count FROM observations WHERE turn_id = ?",
    ).get(completedTurnId)?.count).toBe(0);

    await run("session-init", {
      hook_event_name: "UserPromptSubmit",
      session_id: "current-trigger",
      cwd: "/proj",
      prompt: "current-day work",
    });
    const currentSession = getSessionByContentId(db, "current-trigger")!;
    const currentTurnId = db.query<{ id: number }, [number]>(
      "SELECT id FROM turns WHERE session_id = ?",
    ).get(currentSession.id)!.id;
    await run("tool-use", {
      hook_event_name: "PostToolUse",
      session_id: "current-trigger",
      tool_name: "Agent",
      tool_input: { prompt: "delegate" },
      tool_response: "launched",
    });
    expect(db.query<{ count: number }, [number]>(
      "SELECT COUNT(*) AS count FROM observations WHERE turn_id = ?",
    ).get(currentTurnId)?.count).toBe(1);

    expect(diaryStore.hasReadyDiaryItem(NOW_EPOCH)).toBe(false);
    await run("session-end", {
      hook_event_name: "SessionEnd",
      session_id: "current-trigger",
      cwd: "/proj",
    });

    expect(dreamClaims).toBe(1);
    expect(getTurnById(db, provisionalTurnId)?.status).toBe("extracted");
    expect(getTurnById(db, blockedTurnId)?.status).toBe("failed");
    expect(getTurnById(db, currentTurnId)?.status).toBe("active");
    // observation-queue-teardown: the queue drop no longer special-cases a
    // terminal-owner obs row into `skipped` — that update lived only in the
    // retired queue branch. The row still drains below (queue pollution does
    // not linger), but the observation's own status is whatever it already
    // was, untouched.
    expect(db.query<{ status: string }, [number]>(
      "SELECT status FROM observations WHERE id = ?",
    ).get(pollutionObsId)?.status).toBe("pending");
    expect(db.query<{ count: number }, [number, number]>(
      `SELECT COUNT(*) AS count FROM pending_queue
       WHERE (kind = 'turn-stop' AND target_id = ?)
          OR (kind = 'obs' AND target_id = ?)`,
    ).get(blockedTurnId, pollutionObsId)?.count).toBe(0);
    expect(diaryStore.hasReadyDiaryItem(NOW_EPOCH)).toBe(false);
    expect(diaryStore.hasQueuedDay(DUE_DATE)).toBe(false);
  });

  test("keeps completion notifications independent from child PostToolUse", async () => {
    const sessionId = makeSession("notification-root");
    const parentTurnId = db.query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, created_at_epoch
       ) VALUES (?, 1, 'extracted', 'delegate', 'launched', 'parent', 'parent', ?)
       RETURNING id`,
    ).get(sessionId, DUE_EPOCH)!.id;

    await run("session-init", {
      hook_event_name: "UserPromptSubmit",
      session_id: "notification-root",
      cwd: "/proj",
      prompt: "Task child-agent-42 completed",
    });
    const notificationTurnId = db.query<{ id: number }, [number]>(
      "SELECT id FROM turns WHERE session_id = ? ORDER BY prompt_number DESC LIMIT 1",
    ).get(sessionId)!.id;
    await run("tool-use", {
      hook_event_name: "PostToolUse",
      session_id: "notification-root",
      agent_id: "child-agent-42",
      tool_name: "SendMessage",
      tool_response: "sidechain result",
    });

    expect(notificationTurnId).not.toBe(parentTurnId);
    expect(db.query<{ prompt: string | null }, [number]>(
      "SELECT user_prompt AS prompt FROM turns WHERE id = ?",
    ).get(notificationTurnId)?.prompt).toBe("Task child-agent-42 completed");
    expect(db.query<{ count: number }, [number, number]>(
      "SELECT COUNT(*) AS count FROM observations WHERE turn_id IN (?, ?)",
    ).get(parentTurnId, notificationTurnId)?.count).toBe(0);
  });
});
