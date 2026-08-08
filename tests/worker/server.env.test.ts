import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { listPendingQueueItems } from "../../src/db/pending-queue";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DEFAULT_CONFIG } from "../../src/shared/config";
import { DREAM_ENABLED_CONFIG } from "../support/dream-config";
import { createWorkerCore } from "../../src/worker/server";
import {
  createWorkerQuerySession,
  type WorkerQuerySession,
} from "../../src/worker/query-session";

function addQueuedTurn(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
): number {
  const turnId = db
    .query<{ id: number }, [number, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         assistant_response, created_at_epoch
       ) VALUES (?, ?, 'active', 'prompt', 'reply', 100)
       RETURNING id`,
    )
    .get(sessionDbId, promptNumber)!.id;
  db.query(
    `INSERT INTO pending_queue (
       kind, target_id, session_db_id, enqueued_at_epoch
     ) VALUES ('turn-stop', ?, ?, 100)`,
  ).run(turnId, sessionDbId);
  return turnId;
}

describe("worker per-session env registry", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("presence-gates rows, spawns A/B with their own env, recycles changes, and clears on end", async () => {
    const sessionA = upsertSession(db, {
      contentSessionId: "content-a",
      project: "/project/a",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    });
    const sessionB = upsertSession(db, {
      contentSessionId: "content-b",
      project: "/project/b",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    });
    addQueuedTurn(db, sessionA.id, 1);
    addQueuedTurn(db, sessionB.id, 1);

    const spawned: Array<{
      contentSessionId: string;
      env: NodeJS.ProcessEnv | undefined;
    }> = [];
    let closes = 0;
    const sessionEnvRegistry = new Map();
    const core = createWorkerCore({
      db,
      workerEnv: {
        HOME: "/Users/worker",
        PATH: "/usr/bin",
        GITHUB_TOKEN: "worker-github",
        AWS_SECRET_ACCESS_KEY: "worker-aws",
        ANTHROPIC_AUTH_TOKEN: "worker-auth",
      },
      sessionEnvRegistry,
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 1,
        maxQueuedBatches: 0,
      },
      createWorkerQuerySessionImpl: mock(((input, deps) => {
        spawned.push({
          contentSessionId: input.contentSessionId,
          env: input.agentEnv,
        });
        return {
          sessionId: `agent-${input.contentSessionId}`,
          queryPid: undefined,
          async sendPrompt(prompt: string) {
            for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
              deps?.onRemember?.(`T${match[1]}`);
            }
            return { session_id: `agent-${input.contentSessionId}` };
          },
          async close() {
            closes += 1;
          },
        } satisfies WorkerQuerySession;
      }) as typeof import("../../src/worker/query-session").createWorkerQuerySession),
      isProcessAliveImpl: () => false,
      logger: { warn() {}, error() {} },
    });

    await core.scanAndDrainQueue();
    expect(spawned).toEqual([]);
    expect(listPendingQueueItems(db)).toHaveLength(2);
    expect(listPendingQueueItems(db).every((item) => item.claimedAtEpoch === null)).toBe(true);

    await core.registerSessionEnv("content-a", undefined, {
      ANTHROPIC_AUTH_TOKEN: "auth-a",
      HTTP_PROXY: "http://proxy-a",
    });
    await core.scanAndDrainQueue();
    expect(spawned[0]).toEqual({
      contentSessionId: "content-a",
      env: {
        HOME: "/Users/worker",
        PATH: "/usr/bin",
        ANTHROPIC_AUTH_TOKEN: "auth-a",
        HTTP_PROXY: "http://proxy-a",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      },
    });
    expect(listPendingQueueItems(db)).toHaveLength(1);

    await core.registerSessionEnv("content-b", sessionB.id, {
      ANTHROPIC_API_KEY: "api-b",
    });
    await core.scanAndDrainQueue();
    expect(spawned[1]).toEqual({
      contentSessionId: "content-b",
      env: {
        HOME: "/Users/worker",
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "api-b",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      },
    });
    expect(listPendingQueueItems(db)).toEqual([]);

    await core.registerSessionEnv("content-a", sessionA.id, {
      ANTHROPIC_AUTH_TOKEN: "auth-a-rotated",
    });
    expect(closes).toBe(1);
    addQueuedTurn(db, sessionA.id, 2);
    await core.handleTurnStop(sessionA.id);
    expect(spawned[2]?.env?.ANTHROPIC_AUTH_TOKEN).toBe("auth-a-rotated");

    core.clearSessionEnv("content-a", sessionA.id);
    addQueuedTurn(db, sessionA.id, 3);
    await core.handleTurnStop(sessionA.id);
    expect(spawned).toHaveLength(3);
    expect(listPendingQueueItems(db, sessionA.id)).toHaveLength(1);
  });

  test("an inherited ANTHROPIC_MODEL cannot override extraction's explicit sonnet alias", async () => {
    const session = upsertSession(db, {
      contentSessionId: "explicit-sonnet-alias",
      project: "/project/alias",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    });
    const turnId = addQueuedTurn(db, session.id, 1);
    let queryOptions:
      | {
          model?: string;
          env?: NodeJS.ProcessEnv;
        }
      | undefined;

    const core = createWorkerCore({
      db,
      workerEnv: {
        HOME: "/Users/worker",
        PATH: "/usr/bin",
        ANTHROPIC_MODEL: "worker-inherited-model",
      },
      config: {
        ...DEFAULT_CONFIG,
        mergeThresholdChars: 1,
        maxQueuedBatches: 0,
      },
      createWorkerQuerySessionImpl: ((input, deps) =>
        createWorkerQuerySession(input, {
          ...deps,
          mkdirSyncImpl: mock(() => undefined),
          isProcessAliveImpl: () => false,
          queryImpl: (({
            prompt,
            options,
          }: {
            prompt: AsyncIterable<unknown>;
            options?: {
              model?: string;
              env?: NodeJS.ProcessEnv;
            };
          }) => {
            queryOptions = options;
            return (async function* () {
              for await (const _message of prompt) {
                deps?.onRemember?.(`T${turnId}`);
                yield {
                  type: "result",
                  subtype: "success",
                  duration_ms: 1,
                  duration_api_ms: 1,
                  is_error: false,
                  num_turns: 1,
                  result: "",
                  total_cost_usd: 0,
                  usage: {},
                  modelUsage: {},
                  permission_denials: [],
                  uuid: "result-explicit-sonnet-alias",
                  session_id: "agent-explicit-sonnet-alias",
                };
              }
            })();
          }) as never,
        })) as typeof createWorkerQuerySession,
      isProcessAliveImpl: () => false,
      logger: { warn() {}, error() {} },
    });

    await core.registerSessionEnv("explicit-sonnet-alias", session.id, {
      ANTHROPIC_AUTH_TOKEN: "session-auth",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.6-sol",
      ANTHROPIC_MODEL: "must-not-override-sonnet",
    });
    await core.scanAndDrainQueue(session.id);

    expect(queryOptions?.model).toBe("sonnet");
    expect(queryOptions?.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "session-auth",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.6-sol",
    });
    expect(queryOptions?.env).not.toHaveProperty("ANTHROPIC_MODEL");

    await core.closeSessionQuery(session.id);
  });

  test("a dream fired by session A's turn-stop spawns with A's safe env snapshot", async () => {
    const sessionA = upsertSession(db, {
      contentSessionId: "dream-env-a",
      project: "/project/a",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    });
    addQueuedTurn(db, sessionA.id, 1);
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });

    const dreamSpawnEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const sessionEnvRegistry = new Map();
    const core = createWorkerCore({
      db,
      workerEnv: {
        HOME: "/Users/worker",
        PATH: "/usr/bin",
        GITHUB_TOKEN: "worker-github",
        AWS_SECRET_ACCESS_KEY: "worker-aws",
        ANTHROPIC_AUTH_TOKEN: "worker-auth",
      },
      sessionEnvRegistry,
      config: {
        ...DREAM_ENABLED_CONFIG,
        mergeThresholdChars: 1,
        maxQueuedBatches: 0,
      },
      createWorkerQuerySessionImpl: mock((() => ({
        sessionId: "agent-dream-env-a",
        queryPid: undefined,
        async sendPrompt() {
          return { session_id: "agent-dream-env-a" };
        },
        async close() {},
      })) as typeof import("../../src/worker/query-session").createWorkerQuerySession),
      async processDiaryItem(item, agentEnv) {
        dreamSpawnEnvs.push(agentEnv);
        stateStore.acknowledgeDiaryItem(item.seq);
      },
      isProcessAliveImpl: () => false,
      logger: { warn() {}, error() {} },
    });

    await core.registerSessionEnv("dream-env-a", sessionA.id, {
      ANTHROPIC_AUTH_TOKEN: "auth-a",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.6-sol",
      ANTHROPIC_MODEL: "must-not-override-opus",
      HTTP_PROXY: "http://proxy-a",
    });
    await core.handleTurnStop(sessionA.id);

    expect(dreamSpawnEnvs).toEqual([
      {
        HOME: "/Users/worker",
        PATH: "/usr/bin",
        ANTHROPIC_AUTH_TOKEN: "auth-a",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.6-sol",
        HTTP_PROXY: "http://proxy-a",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      },
    ]);
  });

  test("a dream falls back to the operational baseline when A's env clears before spawn", async () => {
    const sessionA = upsertSession(db, {
      contentSessionId: "dream-env-cleared",
      project: "/project/a",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    });
    addQueuedTurn(db, sessionA.id, 1);
    const stateStore = createDiaryStateStore(db);
    stateStore.enqueueDay({ date: "2026-07-10", enqueuedAtEpoch: 100 });

    const dreamSpawnEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const warnings: Array<{ message: string; context: unknown }> = [];
    const sessionEnvRegistry = new Map();
    const core = createWorkerCore({
      db,
      workerEnv: {
        HOME: "/Users/worker",
        PATH: "/usr/bin",
        GITHUB_TOKEN: "worker-github",
        AWS_SECRET_ACCESS_KEY: "worker-aws",
        ANTHROPIC_AUTH_TOKEN: "worker-auth",
      },
      sessionEnvRegistry,
      config: {
        ...DREAM_ENABLED_CONFIG,
        mergeThresholdChars: 1,
        maxQueuedBatches: 0,
      },
      createWorkerQuerySessionImpl: mock(((_input, deps) => ({
        sessionId: "agent-dream-env-cleared",
        queryPid: undefined,
        async sendPrompt(prompt: string) {
          for (const match of prompt.matchAll(/<turn id="T(\d+)"/g)) {
            deps?.onRemember?.(`T${match[1]}`);
          }
          sessionEnvRegistry.delete("dream-env-cleared");
          return { session_id: "agent-dream-env-cleared" };
        },
        async close() {},
      })) as typeof import("../../src/worker/query-session").createWorkerQuerySession),
      async processDiaryItem(item, agentEnv) {
        dreamSpawnEnvs.push(agentEnv);
        stateStore.acknowledgeDiaryItem(item.seq);
      },
      isProcessAliveImpl: () => false,
      logger: {
        warn(message, context) {
          warnings.push({ message, context });
        },
        error() {},
      },
    });

    await core.registerSessionEnv("dream-env-cleared", sessionA.id, {
      ANTHROPIC_AUTH_TOKEN: "auth-a",
      HTTPS_PROXY: "http://proxy-a",
    });
    await core.handleTurnStop(sessionA.id);

    expect(dreamSpawnEnvs).toEqual([
      {
        HOME: "/Users/worker",
        PATH: "/usr/bin",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      },
    ]);
    expect(warnings).toContainEqual({
      message:
        "dream triggering session env unavailable; using operational baseline",
      context: { triggeringSessionDbId: sessionA.id },
    });
  });
});
