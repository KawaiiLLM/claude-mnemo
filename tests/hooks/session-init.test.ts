import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { upsertSession } from "../../src/db/sessions";
import { createSessionInitHandler } from "../../src/hooks/handlers/session-init";
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

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-session-init-"));
  const path = join(directory, "session.jsonl");

  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

describe("handleSessionInitHook", () => {
  let db: Database;
  const transcriptDirectories: string[] = [];

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    for (const directory of transcriptDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }

    db.close();
  });

  test("first prompt creates session and pending turn without extraction", async () => {
    const handler = createSessionInitHandler({
      db,
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
  });

  test("second prompt only inserts another pending turn", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "Diagnose the auth race" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const handler = createSessionInitHandler({
      db,
    });

    await handler(
      createInput({
        prompt: "Diagnose the auth race",
      }),
    );

    await handler(
      createInput({
        prompt: "Fix it and add tests",
        transcriptPath: transcript.path,
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    const firstTurn = getTurn(db, session.id, 1)!;
    const secondTurn = getTurn(db, session.id, 2)!;

    expect(firstTurn.assistantResponse).toBeNull();
    expect(firstTurn.status).toBe("pending");
    expect(secondTurn.status).toBe("pending");
  });

  test("does not do any transcript work even when previous turn is already extracted", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "Add another change" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const handler = createSessionInitHandler({
      db,
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
        transcriptPath: transcript.path,
      }),
    );
  });

  test("uses JSONL-derived numbering for adopted sessions", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "First prompt" }] },
      { role: "user", content: [{ type: "text", text: "Second prompt" }] },
      { role: "user", content: [{ type: "text", text: "Third prompt" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const session = upsertSession(db, {
      contentSessionId: "session-1",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: 1000,
      completedAtEpoch: null,
    });

    const handler = createSessionInitHandler({
      db,
      now: () => 1001,
    });

    await handler(
      createInput({
        prompt: "Fourth prompt",
        transcriptPath: transcript.path,
      }),
    );

    const insertedTurn = getTurn(db, session.id, 4);

    expect(insertedTurn?.promptNumber).toBe(4);
    expect(insertedTurn?.userPrompt).toBe("Fourth prompt");
  });

  test("uses matching JSONL numbering for normal tracked sessions", async () => {
    const firstTranscript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "First prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "First answer" }] },
      { role: "user", content: [{ type: "text", text: "Second prompt" }] },
    ]);
    transcriptDirectories.push(firstTranscript.directory);

    const handler = createSessionInitHandler({
      db,
      now: () => 2000,
    });

    await handler(
      createInput({
        prompt: "First tracked prompt",
      }),
    );

    await handler(
      createInput({
        prompt: "Second tracked prompt",
      }),
    );

    await handler(
      createInput({
        prompt: "Third tracked prompt",
        transcriptPath: firstTranscript.path,
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    const thirdTurn = getTurn(db, session.id, 3);

    expect(thirdTurn?.promptNumber).toBe(3);
    expect(thirdTurn?.userPrompt).toBe("Third tracked prompt");
  });

  test("falls back to DB count when transcriptPath is unavailable", async () => {
    const transcript = writeTranscript([
      { role: "user", content: [{ type: "text", text: "Ignored one" }] },
      { role: "user", content: [{ type: "text", text: "Ignored two" }] },
      { role: "user", content: [{ type: "text", text: "Ignored three" }] },
    ]);
    transcriptDirectories.push(transcript.directory);

    const handler = createSessionInitHandler({
      db,
      now: () => 3000,
    });

    await handler(
      createInput({
        prompt: "First tracked prompt",
      }),
    );

    await handler(
      createInput({
        prompt: "Second tracked prompt",
      }),
    );

    await handler(
      createInput({
        prompt: "Third tracked prompt",
      }),
    );

    const session = getSessionByContentId(db, "session-1")!;
    const thirdTurn = getTurn(db, session.id, 3);

    expect(thirdTurn?.promptNumber).toBe(3);
    expect(thirdTurn?.userPrompt).toBe("Third tracked prompt");
  });
});
