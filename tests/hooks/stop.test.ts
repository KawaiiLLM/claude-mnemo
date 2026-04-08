import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId, upsertSession } from "../../src/db/sessions";
import { getPendingTurns, getTurn } from "../../src/db/turns";
import { createStopHandler } from "../../src/hooks/handlers/stop";
import * as transcriptParser from "../../src/shared/transcript-parser";
import type { NormalizedHookInput } from "../../src/hooks/types";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "Stop",
    sessionId: "session-stop",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-stop-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
}

describe("handleStopHook", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "session-stop",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Stop handler session",
      content: "Stop hook coverage",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("guards stop_hook_active to avoid infinite loops", async () => {
    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    const result = await handler(
      createInput({
        stopHookActive: true,
      }),
    );

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(forkMnemosyne).not.toHaveBeenCalled();
  });

  test("backfills pending turns using replay numbering and writes tool counts", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Draft approach" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/draft.ts" } },
          { type: "text", text: "Draft response" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Investigate logs" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
          { type: "text", text: "Replay-compatible response" },
        ],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, title, created_at_epoch
      ) VALUES (?, 1, 'extracted', 'Draft approach', 'Draft response', 'Draft approach', 120)`,
    ).run(sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 2, 'pending', 'Investigate logs', 130)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const stderrWrite = mock(() => true);
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: stderrWrite },
      now: () => 500,
    });

    const result = await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    const extractedTurn = getTurn(db, sessionId, 1)!;
    const secondPendingTurn = getTurn(db, sessionId, 2)!;
    const session = getSessionByContentId(db, "session-stop")!;

    expect(result).toEqual({
      continue: true,
      exitCode: 0,
    });
    expect(extractedTurn.status).toBe("stale");
    expect(extractedTurn.toolCallCount).toBeNull();
    expect(secondPendingTurn.assistantResponse).toBe("Replay-compatible response");
    expect(secondPendingTurn.toolCallCount).toBe(1);
    expect(getPendingTurns(db, sessionId).map((turn) => turn.promptNumber)).toEqual([
      1,
      2,
    ]);
    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    const prompt = String(forkMnemosyne.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain(`[S${sessionId}] Stop handler session`);
    expect(prompt).toContain("/Users/zhaoqixuan/Projects/claude-mnemo");
    expect(prompt).toContain("Stop hook coverage");
    expect(prompt).toContain("[T1] Draft approach");
    expect(prompt).toContain("[stale]");
    expect(prompt).toContain("[T2] Untitled");
    expect(prompt).toContain("[pending]");
    expect(session.completedAtEpoch).toBe(500);
    expect(stderrWrite).toHaveBeenCalled();

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("handles missing transcript by falling back without crashing", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Only pending turn', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    const result = await handler(
      createInput({
        transcriptPath: "/tmp/missing.jsonl",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    expect(getTurn(db, sessionId, 1)?.assistantResponse).toBe("");
  });

  test("marks the last extracted turn stale when it was undone before exit", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        isSidechain: true,
        content: [{ type: "text", text: "Undone turn" }],
      },
      {
        role: "assistant",
        isSidechain: true,
        content: [{ type: "text", text: "Old response" }],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch
      ) VALUES (?, 1, 'extracted', 'Undone turn', 'Old response', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    expect(getTurn(db, sessionId, 1)?.status).toBe("stale");
    expect(forkMnemosyne).toHaveBeenCalledTimes(1);

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("calls forkMnemosyne for pending turns", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Pending work', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => ({
      sessionId: "test-extraction",
      numTurns: 3,
      inputTokens: 45000,
      outputTokens: 1800,
      cacheReadInputTokens: 39000,
      cacheCreationInputTokens: 0,
      durationMs: 4200,
      totalCostUsd: 0.05,
    }));

    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    await handler(createInput());

    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
  });

  test("parses the replay transcript once per stop event", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Investigate logs" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Replay-compatible response" }],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Investigate logs', 130)`,
    ).run(sessionId);

    const parseReplayTranscriptSpy = spyOn(
      transcriptParser,
      "parseReplayTranscript",
    );
    const handler = createStopHandler({
      db,
      forkMnemosyne: mock(async () => {}),
      stderr: { write: mock(() => true) },
    });

    await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    expect(parseReplayTranscriptSpy).toHaveBeenCalledTimes(1);

    parseReplayTranscriptSpy.mockRestore();
    rmSync(transcript.directory, { recursive: true, force: true });
  });
});
