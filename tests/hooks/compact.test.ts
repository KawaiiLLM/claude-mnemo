import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { createCompactHandler } from "../../src/hooks/handlers/compact";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function writeTranscript(lines: unknown[]): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-compact-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );

  return { directory, path };
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
    } as any);

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

  test("backfills assistant responses and tool counts without an extractor dependency", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Compact pending work" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/compact.ts" } },
          { type: "text", text: "Compact response" },
        ],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Compact pending work', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createCompactHandler({
      db,
      forkMnemosyne,
    } as any);

    await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    const turn = getTurn(db, sessionId, 1)!;
    const prompt = String(forkMnemosyne.mock.calls[0]?.[0]?.prompt);

    expect(turn.assistantResponse).toBe("Compact response");
    expect(turn.toolCallCount).toBe(1);
    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    expect(prompt).toContain(`[S${sessionId}] Compact session`);
    expect(prompt).toContain("/Users/zhaoqixuan/Projects/claude-mnemo");
    expect(prompt).toContain("Compact hook coverage");
    expect(prompt).toContain("[T1] Untitled");

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("leaves stale turns with existing responses untouched", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Already handled" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/stale.ts" } },
          { type: "text", text: "Transcript response" },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Needs backfill" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "src/pending.ts" } },
          { type: "text", text: "Pending response" },
        ],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, assistant_response, created_at_epoch
      ) VALUES (?, 1, 'stale', 'Already handled', 'Keep me', 120)`,
    ).run(sessionId);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 2, 'pending', 'Needs backfill', 130)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createCompactHandler({
      db,
      forkMnemosyne,
    });

    await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    const staleTurn = getTurn(db, sessionId, 1)!;
    const pendingTurn = getTurn(db, sessionId, 2)!;

    expect(staleTurn.assistantResponse).toBe("Keep me");
    expect(staleTurn.toolCallCount).toBeNull();
    expect(pendingTurn.assistantResponse).toBe("Pending response");
    expect(pendingTurn.toolCallCount).toBe(1);

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
      numTurns: 2,
      inputTokens: 30000,
      outputTokens: 1200,
      cacheReadInputTokens: 25000,
      cacheCreationInputTokens: 0,
      durationMs: 3100,
      totalCostUsd: 0.03,
    }));

    const handler = createCompactHandler({ db, forkMnemosyne });

    await handler(
      createInput({
        transcriptPath: "/tmp/missing.jsonl",
      }),
    );

    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
  });
});
