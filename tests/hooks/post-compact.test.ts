import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurnsForSession } from "../../src/db/turns";
import { runHookCommand } from "../../src/hooks/hook-command";
import type { HookHandler, NormalizedHookInput } from "../../src/hooks/types";
import { createPostCompactHandler } from "../../src/hooks/handlers/post-compact";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "PostCompact",
    sessionId: "session-compact",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    transcriptPath: "/tmp/session.jsonl",
    trigger: "manual",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

function writeTranscript(
  directory: string,
  name: string,
  lines: unknown[],
): string {
  const transcriptPath = join(directory, name);
  writeFileSync(
    transcriptPath,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8",
  );

  return transcriptPath;
}

describe("handlePostCompactHook", () => {
  let db: Database;
  let transcriptDir: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    transcriptDir = mkdtempSync(join(tmpdir(), "claude-mnemo-post-compact-"));

    upsertSession(db, {
      contentSessionId: "session-compact",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Compact session",
      content: "Current summary",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    });
  });

  afterEach(() => {
    rmSync(transcriptDir, { recursive: true, force: true });
    db.close();
  });

  test("inserts one compact turn from the latest summary wrapper", async () => {
    const transcriptPath = writeTranscript(transcriptDir, "basic.jsonl", [
      {
        type: "user",
        uuid: "user-1",
        promptId: "prompt-1",
        message: { role: "user", content: "Before compact" },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Acknowledged" }],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-1",
        compactMetadata: { preCompactTokenCount: 128 },
      },
      {
        type: "user",
        uuid: "summary-1",
        parentUuid: "boundary-1",
        promptId: "prompt-2",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation.",
        },
      },
      {
        type: "user",
        uuid: "user-2",
        promptId: "prompt-3",
        message: { role: "user", content: "After compact" },
      },
    ]);
    const handler = createPostCompactHandler({ db, now: () => 500 });

    const result = await handler(
      createInput({
        transcriptPath,
        raw: { compact_metadata: { preCompactTokenCount: 128 } },
      }),
    );

    const turns = getTurnsForSession(db, 1);

    expect(result).toEqual({ continue: true });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      promptNumber: 2,
      contentPromptId: "prompt-2",
      transcriptLineStart: 4,
      status: "extracted",
      title: "/compact",
      content: "This session is being continued from a previous conversation.",
      type: "compact",
      tags: ["compact:pre_tokens=128", "compact:trigger=manual"],
      toolCallCount: 0,
      userPrompt: null,
      assistantResponse: null,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 500,
    });
  });

  test("preserves the raw summary-wrapper string content without trimming", async () => {
    const rawSummary = "  This session is being continued.\n\n  ";
    const transcriptPath = writeTranscript(transcriptDir, "raw-string.jsonl", [
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-1",
        compactMetadata: { preCompactTokenCount: 11 },
      },
      {
        type: "user",
        uuid: "summary-1",
        parentUuid: "boundary-1",
        promptId: "prompt-1",
        message: { role: "user", content: rawSummary },
      },
    ]);
    const handler = createPostCompactHandler({ db, now: () => 500 });

    await handler(createInput({ transcriptPath }));

    const turns = getTurnsForSession(db, 1);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toBe(rawSummary);
  });

  test("is idempotent when the same compact transcript is handled twice", async () => {
    const transcriptPath = writeTranscript(transcriptDir, "idempotent.jsonl", [
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-1",
        compactMetadata: { preCompactTokenCount: 64 },
      },
      {
        type: "user",
        uuid: "summary-1",
        parentUuid: "boundary-1",
        promptId: "prompt-1",
        message: { role: "user", content: "Summary wrapper" },
      },
    ]);
    const handler = createPostCompactHandler({ db, now: () => 501 });

    await handler(createInput({ transcriptPath }));
    await handler(createInput({ transcriptPath }));

    const turns = getTurnsForSession(db, 1);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.contentPromptId).toBe("prompt-1");
  });

  test("tolerates transcripts without a compact boundary", async () => {
    const transcriptPath = writeTranscript(transcriptDir, "no-boundary.jsonl", [
      {
        type: "user",
        uuid: "user-1",
        promptId: "prompt-1",
        message: { role: "user", content: "Normal prompt" },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Normal response" }],
        },
      },
    ]);
    const handler = createPostCompactHandler({ db, now: () => 502 });

    const result = await handler(createInput({ transcriptPath }));

    expect(result).toEqual({ continue: true });
    expect(getTurnsForSession(db, 1)).toHaveLength(0);
  });

  test("uses the most recent compact boundary and its matching wrapper", async () => {
    const transcriptPath = writeTranscript(transcriptDir, "latest.jsonl", [
      {
        type: "user",
        uuid: "user-1",
        promptId: "prompt-1",
        message: { role: "user", content: "Before first compact" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-1",
        compactMetadata: { preCompactTokenCount: 10 },
      },
      {
        type: "user",
        uuid: "summary-1",
        parentUuid: "boundary-1",
        promptId: "prompt-2",
        message: { role: "user", content: "Older summary wrapper" },
      },
      {
        type: "user",
        uuid: "user-2",
        promptId: "prompt-3",
        message: { role: "user", content: "Between compacts" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-2",
        compactMetadata: { preCompactTokenCount: 77 },
      },
      {
        type: "user",
        uuid: "summary-2",
        parentUuid: "boundary-2",
        promptId: "prompt-4",
        message: { role: "user", content: "Latest summary wrapper" },
      },
    ]);
    const handler = createPostCompactHandler({ db, now: () => 503 });

    await handler(
      createInput({
        transcriptPath,
        trigger: "auto",
      }),
    );

    const turns = getTurnsForSession(db, 1);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      promptNumber: 4,
      contentPromptId: "prompt-4",
      transcriptLineStart: 6,
      content: "Latest summary wrapper",
      tags: ["compact:pre_tokens=77", "compact:trigger=auto"],
    });
  });

  test("requires the immediate next entry after the boundary to be the summary wrapper", async () => {
    const transcriptPath = writeTranscript(transcriptDir, "immediate.jsonl", [
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-1",
        compactMetadata: { preCompactTokenCount: 22 },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "intervening entry" }],
        },
      },
      {
        type: "user",
        uuid: "summary-1",
        parentUuid: "boundary-1",
        promptId: "prompt-1",
        message: { role: "user", content: "Late summary wrapper" },
      },
    ]);
    const handler = createPostCompactHandler({ db, now: () => 504 });

    const result = await handler(createInput({ transcriptPath }));

    expect(result).toEqual({ continue: true });
    expect(getTurnsForSession(db, 1)).toHaveLength(0);
  });

  test("maps post-compact argv to the PostCompact handler", async () => {
    const handler = mock(async () => ({ continue: true }));
    const normalized = mock(() => createInput());

    const exitCode = await runHookCommand({
      env: {},
      argv: ["bun", "hook-command.ts", "post-compact"],
      stdout: { write: mock(() => true) },
      stderr: { write: mock(() => true) },
      readJsonFromStdin: () => ({}),
      normalizeHookInputImpl: normalized,
      handlers: {
        PostCompact: handler as unknown as HookHandler,
      } as unknown as Record<string, HookHandler>,
    });

    expect(exitCode).toBe(0);
    expect(normalized).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });
});
