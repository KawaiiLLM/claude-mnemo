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
      description: "Compact hook coverage",
      insight: null,
      startedAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("waits for Mnemosyne to finish before returning", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Pending work', 120)`,
    ).run(sessionId);

    let releaseFork!: () => void;
    const forkMnemosyne = mock(
      () =>
        new Promise<void>((resolve) => {
          releaseFork = resolve;
        }),
    );
    const handler = createCompactHandler({
      db,
      forkMnemosyne,
      extractAssistantResponse: mock(() => "Backfilled response"),
    });

    let settled = false;
    const handlerPromise = handler(
      createInput({
        transcriptPath: "/tmp/session.jsonl",
      }),
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);

    releaseFork();
    await handlerPromise;

    expect(settled).toBe(true);
  });
});
