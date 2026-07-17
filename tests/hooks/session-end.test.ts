import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import { createSessionEndHandler } from "../../src/hooks/handlers/session-end";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { BUILD_ID } from "../../src/shared/build-id";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "SessionEnd",
    sessionId: "session-end-1",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("handleSessionEndHook", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-end-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("returns asyncWork and defers worker flush for the resolved session", async () => {
    await createContextHandler({
      db,
      nowEpoch: () => 200,
    })(
      createInput({
        eventName: "SessionStart",
        source: "resume",
      }),
    );
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, created_at_epoch
       ) VALUES (?, 1, 'active', 'new prompt', 201)`,
    ).run(sessionId);
    await createContextHandler({ db })(
      createInput({
        eventName: "SessionStart",
        source: "compact",
      }),
    );
    const fetchImpl = mock(async (input: string | URL) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, buildId: BUILD_ID }), {
          status: 200,
        });
      }
      return new Response(null, { status: 200 });
    });
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    });

    const result = await handler(createInput());

    expect(result.continue).toBe(true);
    expect(typeof result.asyncWork).toBe("function");
    expect(fetchImpl).not.toHaveBeenCalled();

    await result.asyncWork?.();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:37778/health");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:37778/flush");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      session_id: sessionId,
    });
  });

  test("a resume glance with no new turn does not contact or spawn the worker", async () => {
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt,
         assistant_response, created_at_epoch
       ) VALUES (?, 1, 'extracted', 'prior prompt', 'prior response', 90)`,
    ).run(sessionId);
    await createContextHandler({
      db,
      nowEpoch: () => 200,
    })(
      createInput({
        eventName: "SessionStart",
        source: "resume",
      }),
    );
    const fetchImpl = mock(async () => {
      throw new Error("worker is down");
    });
    const spawnImpl = mock(() => ({ unref() {} }));
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: {
        fetchImpl,
        spawnImpl: spawnImpl as never,
        existsSyncImpl: () => true,
      },
    });

    const result = await handler(createInput());

    expect(result).toEqual({ continue: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test("does nothing when the content session is unknown", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl },
    });

    const result = await handler(
      createInput({
        sessionId: "missing-session",
      }),
    );

    expect(result).toEqual({ continue: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
