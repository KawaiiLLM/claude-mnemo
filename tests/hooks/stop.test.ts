import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as nodeFs from "node:fs";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId, upsertSession } from "../../src/db/sessions";
import { getPendingTurns, getTurn } from "../../src/db/turns";
import { createStopHandler } from "../../src/hooks/handlers/stop";
import type { ForkMnemosyneResult } from "../../src/mnemosyne/fork";
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
      description: "Stop hook coverage",
      insight: null,
      startedAtEpoch: 100,
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
    expect(forkMnemosyne.mock.calls[0]?.[0]?.prompt).toContain(
      '#1 [stale]: "Draft approach"',
    );
    expect(forkMnemosyne.mock.calls[0]?.[0]?.prompt).toContain(
      '#2 [pending]: "Investigate logs"',
    );
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

  test("logs extraction metrics when forkMnemosyne returns results", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Pending work', 120)`,
    ).run(sessionId);

    const forkResult: ForkMnemosyneResult = {
      numTurns: 3,
      inputTokens: 45000,
      outputTokens: 1800,
      cacheReadInputTokens: 39000,
      cacheCreationInputTokens: 0,
      durationMs: 4200,
    };
    const forkMnemosyne = mock(async () => forkResult);

    const appendSpy = spyOn(nodeFs, "appendFileSync").mockImplementation(
      () => {},
    );

    const handler = createStopHandler({
      db,
      forkMnemosyne,
      stderr: { write: mock(() => true) },
    });

    await handler(createInput());

    const logCalls = appendSpy.mock.calls.filter(([path]) =>
      (path as string).includes("claude-mnemo.log"),
    );
    expect(logCalls.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse((logCalls[0][1] as string).trim());
    expect(entry.message).toBe("extraction complete");
    expect(entry.context.hook).toBe("stop");
    expect(entry.context.inputTokens).toBe(45000);
    expect(entry.context.cacheReadTokens).toBe(39000);
    expect(entry.context.cacheHitPct).toBe(87);
    expect(entry.context.durationMs).toBe(4200);

    appendSpy.mockRestore();
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
