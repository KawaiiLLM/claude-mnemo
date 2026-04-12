import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
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

  test("signals worker flush for the resolved session and returns immediately", async () => {
    const fetchImpl = mock(async (input: string | URL) => {
      return new Response(null, { status: 200 });
    });
    const handler = createSessionEndHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: { CLAUDE_PLUGIN_ROOT: "/tmp/plugin-root" } as NodeJS.ProcessEnv,
    });

    const result = await handler(createInput());

    expect(result).toEqual({ continue: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:37778/flush");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      session_id: sessionId,
    });
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
