import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getPendingTurns, getTurn } from "../../src/db/turns";
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

  test("returns asyncWork when it claims turns and defers fork until asyncWork runs", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Pending work', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createCompactHandler({
      db,
      forkMnemosyne,
    });

    const result = await handler(
      createInput({
        transcriptPath: "/tmp/session.jsonl",
      }),
    );

    expect(result.continue).toBe(true);
    expect(typeof result.asyncWork).toBe("function");
    expect(forkMnemosyne).not.toHaveBeenCalled();
    expect(getTurn(db, sessionId, 1)?.status).toBe("extracting_pending");
    expect(getPendingTurns(db, sessionId)).toEqual([]);

    await result.asyncWork?.();

    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
  });

  test("backfills assistant responses and tool counts before async extraction runs", async () => {
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
    });

    const result = await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    const turn = getTurn(db, sessionId, 1)!;

    expect(turn.assistantResponse).toBe("Compact response");
    expect(turn.toolCallCount).toBe(1);
    expect(typeof result.asyncWork).toBe("function");
    expect(forkMnemosyne).not.toHaveBeenCalled();

    await result.asyncWork?.();

    const prompt = String(forkMnemosyne.mock.calls[0]?.[0]?.prompt);
    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
    expect(prompt).toContain(`[S${sessionId}] Compact session`);
    expect(prompt).toContain("/Users/zhaoqixuan/Projects/claude-mnemo");
    expect(prompt).toContain("Compact hook coverage");
    expect(prompt).toContain("[T1] Untitled");

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("recovered turns are backfilled before they are claimed again", async () => {
    const transcript = writeTranscript([
      {
        role: "user",
        content: [{ type: "text", text: "Recovered pending work" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "src/recovered.ts" },
          },
          { type: "text", text: "Recovered response" },
        ],
      },
    ]);

    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        created_at_epoch,
        updated_at_epoch
      ) VALUES (?, 1, 'extracting_pending', 'Recovered pending work', 120, 100)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {});
    const handler = createCompactHandler({
      db,
      forkMnemosyne,
      now: () => 500,
    });

    const result = await handler(
      createInput({
        transcriptPath: transcript.path,
      }),
    );

    const recoveredTurn = getTurn(db, sessionId, 1)!;

    expect(typeof result.asyncWork).toBe("function");
    expect(recoveredTurn.assistantResponse).toBe("Recovered response");
    expect(recoveredTurn.toolCallCount).toBe(1);
    expect(recoveredTurn.status).toBe("extracting_pending");
    expect(getPendingTurns(db, sessionId)).toEqual([]);

    await result.asyncWork?.();

    const prompt = String(forkMnemosyne.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain("[T1] Untitled");
    expect(prompt).toContain("[pending]");

    rmSync(transcript.directory, { recursive: true, force: true });
  });

  test("does not return asyncWork when there is nothing to claim", async () => {
    const forkMnemosyne = mock(async () => {});
    const handler = createCompactHandler({
      db,
      forkMnemosyne,
      now: () => 500,
    });

    const result = await handler(createInput());

    expect(result).toEqual({
      continue: true,
    });
    expect(result.asyncWork).toBeUndefined();
    expect(forkMnemosyne).not.toHaveBeenCalled();
  });

  test("claiming turns prevents duplicate compact extraction", async () => {
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

    const firstResult = await handler(
      createInput({
        transcriptPath: "/tmp/missing.jsonl",
      }),
    );
    const secondResult = await handler(
      createInput({
        transcriptPath: "/tmp/missing.jsonl",
      }),
    );

    expect(typeof firstResult.asyncWork).toBe("function");
    expect(secondResult).toEqual({
      continue: true,
    });
    expect(secondResult.asyncWork).toBeUndefined();
    expect(getPendingTurns(db, sessionId)).toEqual([]);
    expect(forkMnemosyne).not.toHaveBeenCalled();

    await firstResult.asyncWork?.();

    expect(forkMnemosyne).toHaveBeenCalledTimes(1);
  });

  test("updates the compact anchor after async extraction succeeds", async () => {
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, 1, 'pending', 'Pending work', 120)`,
    ).run(sessionId);

    const forkMnemosyne = mock(async () => {
      db.query(
        `UPDATE turns
         SET status = 'extracted', title = 'Processed turn', content = 'Processed content'
         WHERE session_id = ? AND prompt_number = 1`,
      ).run(sessionId);
    });

    const handler = createCompactHandler({ db, forkMnemosyne });
    const result = await handler(createInput());

    expect(typeof result.asyncWork).toBe("function");
    expect(
      db.query<{ lastCompactTurn: number | null }, [number]>(
        "SELECT last_compact_turn AS lastCompactTurn FROM sessions WHERE id = ?",
      ).get(sessionId)?.lastCompactTurn ?? null,
    ).toBeNull();

    await result.asyncWork?.();

    expect(
      db.query<{ lastCompactTurn: number | null }, [number]>(
        "SELECT last_compact_turn AS lastCompactTurn FROM sessions WHERE id = ?",
      ).get(sessionId)?.lastCompactTurn,
    ).toBe(1);
  });
});
