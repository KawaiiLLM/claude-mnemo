import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import {
  createSessionInitHandler,
} from "../../src/hooks/handlers/session-init";
import type { NormalizedHookInput } from "../../src/hooks/types";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "UserPromptSubmit",
    sessionId: "session-1",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    prompt: "Initial prompt",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("handleSessionInitHook", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("first prompt creates session and pending turn without extraction", async () => {
    const forkMnemosyne = mock(async () => {});
    const extractAssistantResponse = mock(() => "");
    const handler = createSessionInitHandler({
      db,
      forkMnemosyne,
      extractAssistantResponse,
    });

    const result = await handler(
      createInput({
        prompt: "Diagnose the auth race",
      }),
    );

    const session = getSessionByContentId(db, "session-1");
    const turn = getTurn(db, session!.id, 1);

    expect(result).toEqual({
      continue: true,
      suppressOutput: true,
    });
    expect(session?.project).toBe("/Users/zhaoqixuan/Projects/claude-mnemo");
    expect(turn?.status).toBe("pending");
    expect(turn?.userPrompt).toBe("Diagnose the auth race");
    expect(forkMnemosyne).not.toHaveBeenCalled();
    expect(extractAssistantResponse).not.toHaveBeenCalled();
  });

  test("second prompt backfills the previous turn and triggers extraction", async () => {
    const forkMnemosyne = mock(async () => {});
    const extractAssistantResponse = mock(
      () => "I found a race condition in token refresh.",
    );
    const handler = createSessionInitHandler({
      db,
      forkMnemosyne,
      extractAssistantResponse,
    });

    await handler(
      createInput({
        prompt: "Diagnose the auth race",
      }),
    );

    await handler(
      createInput({
        prompt: "Fix it and add tests",
        transcriptPath: "/tmp/session.jsonl",
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    const firstTurn = getTurn(db, session.id, 1)!;
    const secondTurn = getTurn(db, session.id, 2)!;

    expect(extractAssistantResponse).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      "Diagnose the auth race",
    );
    expect(firstTurn.assistantResponse).toBe(
      "I found a race condition in token refresh.",
    );
    expect(secondTurn.status).toBe("pending");
    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    expect(forkMnemosyne.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-1",
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    });
    expect(forkMnemosyne.mock.calls[0]?.[0]?.prompt).toContain(
      '#1 [pending]: "Diagnose the auth race"',
    );
  });

  test("does not retrigger extraction when the previous turn is already extracted", async () => {
    const forkMnemosyne = mock(async () => {});
    const extractAssistantResponse = mock(() => "already handled");
    const handler = createSessionInitHandler({
      db,
      forkMnemosyne,
      extractAssistantResponse,
    });

    await handler(
      createInput({
        prompt: "Diagnose the auth race",
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    db.query(
      `UPDATE turns
       SET status = 'extracted', assistant_response = 'done'
       WHERE session_id = ? AND prompt_number = 1`,
    ).run(session.id);

    await handler(
      createInput({
        prompt: "Add another change",
        transcriptPath: "/tmp/session.jsonl",
      }),
    );

    expect(extractAssistantResponse).not.toHaveBeenCalled();
    expect(forkMnemosyne).not.toHaveBeenCalled();
  });
});
