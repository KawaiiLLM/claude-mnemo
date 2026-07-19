import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createCompactHandler } from "../../src/hooks/handlers/compact";
import type { NormalizedHookInput } from "../../src/hooks/types";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "PreCompact",
    sessionId: "session-compact",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("handleCompactHook", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-compact",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Compact session",
      content: "Compact hook coverage",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("sends a synchronous compact request for the resolved session", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createCompactHandler({
      db,
      workerClientDeps: { fetchImpl },
      workerEnv: {},
    });

    const result = await handler(
      createInput({
        transcriptPath: "/tmp/session.jsonl",
      }),
    );

    expect(result).toEqual({ continue: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:37778/health");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:37778/trigger");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      action: "compact",
      content_session_id: "session-compact",
      session_id: sessionId,
      transcript_path: "/tmp/session.jsonl",
      env: {},
    });
  });

  test("continues without contacting the worker when the session is missing", async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const handler = createCompactHandler({
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
