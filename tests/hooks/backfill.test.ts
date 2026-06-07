import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn, getTurnsForSession } from "../../src/db/turns";
import { backfillFromTranscript } from "../../src/hooks/backfill";
import type { ParsedReplayTurn } from "../../src/shared/transcript-parser";

describe("backfillFromTranscript", () => {
  const databases: Array<ReturnType<typeof createDatabase>> = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not double-count tool calls when a transcript segment is replay-appended", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-backfill",
      project: "/tmp/project",
      title: "Backfill session",
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 1, "Run the tool-heavy turn", 101);

    const pendingTurn = getTurn(db, session.id, 1);
    expect(pendingTurn).not.toBeNull();

    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-backfill-"));
    const transcriptPath = join(directory, "session.jsonl");
    directories.push(directory);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u1",
          type: "user",
          promptId: "pid-A",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Run the tool-heavy turn",
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Bash", input: { command: "npm test" } },
              { type: "text", text: "done" },
            ],
          },
        }),
        JSON.stringify({
          uuid: "u1",
          type: "user",
          promptId: "pid-A",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Run the tool-heavy turn",
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
              { type: "tool_use", name: "Bash", input: { command: "npm test" } },
              { type: "text", text: "done" },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    backfillFromTranscript(db, [pendingTurn!], transcriptPath);

    const updatedTurn = getTurn(db, session.id, 1);
    expect(updatedTurn?.toolCallCount).toBe(3);
    expect(updatedTurn?.contentPromptId).toBe("pid-A");
  });

  test("backfillFromTranscript writes transcriptLineStart from the matched prompt line", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-backfill-line-start",
      project: "/tmp/project",
      title: "Backfill line start session",
      content: null,
      insight: null,
      createdAtEpoch: 200,
      updatedAtEpoch: 200,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 1, "Match me", 201);

    const pendingTurn = getTurn(db, session.id, 1);
    expect(pendingTurn).not.toBeNull();

    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-backfill-line-"));
    const transcriptPath = join(directory, "session.jsonl");
    directories.push(directory);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u0",
          type: "system",
          subtype: "turn_start",
          content: "preface",
        }),
        JSON.stringify({
          uuid: "u1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "setup" }],
          },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "user",
          promptId: "pid-match",
          permissionMode: "default",
          message: {
            role: "user",
            content: "Match me",
          },
        }),
        JSON.stringify({
          uuid: "u3",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Matched response" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    backfillFromTranscript(db, [pendingTurn!], transcriptPath);

    const updatedTurn = getTurn(db, session.id, 1);
    expect(updatedTurn?.contentPromptId).toBe("pid-match");
    expect(updatedTurn?.transcriptLineStart).toBe(3);
  });

  test("tail-anchors the latest turn and does not bind older orphans by text fallback", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-backfill-tail-anchor",
      project: "/tmp/project",
      title: "Tail anchor session",
      content: null,
      insight: null,
      createdAtEpoch: 300,
      updatedAtEpoch: 300,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, content_prompt_id, status, user_prompt, assistant_response, created_at_epoch, updated_at_epoch
      ) VALUES (?, ?, ?, 'extracted', ?, ?, ?, ?)`,
    ).run(session.id, 1, "pid-first", "测试", "First answer", 301, 301);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 2, "测试", 302);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 3, "当前 prompt", 303);

    const directory = mkdtempSync(join(tmpdir(), "claude-mnemo-backfill-tail-"));
    const transcriptPath = join(directory, "session.jsonl");
    directories.push(directory);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          uuid: "u1",
          type: "user",
          promptId: "pid-first",
          permissionMode: "default",
          message: { role: "user", content: "测试" },
        }),
        JSON.stringify({
          uuid: "u2",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "First answer" }],
          },
        }),
        JSON.stringify({
          uuid: "u3",
          type: "user",
          promptId: "pid-orphan",
          permissionMode: "default",
          message: { role: "user", content: "测试" },
        }),
        JSON.stringify({
          uuid: "u4",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Orphan answer" }],
          },
        }),
        JSON.stringify({
          uuid: "u5",
          type: "user",
          promptId: "pid-current",
          permissionMode: "default",
          message: { role: "user", content: "当前 prompt" },
        }),
        JSON.stringify({
          uuid: "u6",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Transcript current answer" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    backfillFromTranscript(
      db,
      getTurnsForSession(db, session.id),
      transcriptPath,
      "Hook current answer",
    );

    const orphanTurn = getTurn(db, session.id, 2);
    const currentTurn = getTurn(db, session.id, 3);

    expect(orphanTurn?.assistantResponse).toBe("Orphan answer");
    expect(orphanTurn?.toolCallCount).toBe(0);
    expect(orphanTurn?.transcriptLineStart).toBe(3);
    expect(orphanTurn?.contentPromptId).toBeNull();

    expect(currentTurn?.assistantResponse).toBe("Hook current answer");
    expect(currentTurn?.contentPromptId).toBe("pid-current");
    expect(currentTurn?.transcriptLineStart).toBe(5);
  });

  test("skips contentPromptId writes when the latest replay anchor is already occupied", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-backfill-tail-occupied",
      project: "/tmp/project",
      title: "Tail occupied session",
      content: null,
      insight: null,
      createdAtEpoch: 400,
      updatedAtEpoch: 400,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, content_prompt_id, status, user_prompt, assistant_response, created_at_epoch, updated_at_epoch
      ) VALUES (?, ?, ?, 'extracted', ?, ?, ?, ?)`,
    ).run(session.id, 1, "pid-occupied", "Earlier", "Earlier answer", 401, 401);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 2, "Latest", 402);

    const transcriptTurns: ParsedReplayTurn[] = [
      {
        promptNumber: 2,
        promptId: "pid-occupied",
        userPrompt: "Latest",
        assistantText: "Latest answer",
        toolCalls: [],
        transcriptLineStart: 99,
      },
    ];

    backfillFromTranscript(
      db,
      getTurnsForSession(db, session.id),
      undefined,
      "Hook latest answer",
      transcriptTurns,
    );

    const latestTurn = getTurn(db, session.id, 2);
    expect(latestTurn?.assistantResponse).toBe("Hook latest answer");
    expect(latestTurn?.contentPromptId).toBeNull();
    expect(latestTurn?.transcriptLineStart).toBe(99);
  });

  test("stores the full assistant narration in assistantTranscript while assistantResponse keeps the final message", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-narration",
      project: "/tmp/project",
      title: "Narration session",
      content: null,
      insight: null,
      createdAtEpoch: 500,
      updatedAtEpoch: 500,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 1, "Do the multi-step thing", 501);

    // The transcript carries every assistant text block; the Stop hook only
    // hands over the final block. assistant_transcript must capture the whole
    // narration so replay can reconstruct the turn from SQLite alone.
    const fullNarration =
      "Let me check the config first.\n\nNow running the tests.\n\nAll green — shipping it.";

    const transcriptTurns: ParsedReplayTurn[] = [
      {
        promptNumber: 1,
        promptId: "pid-narration",
        userPrompt: "Do the multi-step thing",
        assistantText: fullNarration,
        toolCalls: [],
        transcriptLineStart: 5,
      },
    ];

    backfillFromTranscript(
      db,
      getTurnsForSession(db, session.id),
      undefined,
      "All green — shipping it.",
      transcriptTurns,
    );

    const turn = getTurn(db, session.id, 1);
    expect(turn?.assistantResponse).toBe("All green — shipping it.");
    expect(turn?.assistantTranscript).toBe(fullNarration);
  });

  test("strips <private> tags from the transcript-derived assistant_transcript", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-private-transcript",
      project: "/tmp/project",
      title: "Private session",
      content: null,
      insight: null,
      createdAtEpoch: 600,
      updatedAtEpoch: 600,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 1, "Do it", 601);

    const transcriptTurns: ParsedReplayTurn[] = [
      {
        promptNumber: 1,
        promptId: "pid-private",
        userPrompt: "Do it",
        assistantText:
          "Visible plan.\n\n<private>secret token abc</private>\n\nShipped.",
        toolCalls: [],
        transcriptLineStart: 3,
      },
    ];

    backfillFromTranscript(
      db,
      getTurnsForSession(db, session.id),
      undefined,
      "Shipped.",
      transcriptTurns,
    );

    const turn = getTurn(db, session.id, 1);
    expect(turn?.assistantTranscript).toContain("Visible plan.");
    expect(turn?.assistantTranscript).not.toContain("secret token abc");
  });

  test("strips <private> tags from an orphan turn's transcript-derived assistant_response", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-private-orphan",
      project: "/tmp/project",
      title: "Private orphan session",
      content: null,
      insight: null,
      createdAtEpoch: 620,
      updatedAtEpoch: 620,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 1, "Earlier", 621);
    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 2, "Latest", 622);

    const transcriptTurns: ParsedReplayTurn[] = [
      {
        promptNumber: 1,
        promptId: "pid-1",
        userPrompt: "Earlier",
        assistantText: "Public summary.\n\n<private>leaked</private>",
        toolCalls: [],
        transcriptLineStart: 1,
      },
      {
        promptNumber: 2,
        promptId: "pid-2",
        userPrompt: "Latest",
        assistantText: "Latest narration",
        toolCalls: [],
        transcriptLineStart: 5,
      },
    ];

    backfillFromTranscript(
      db,
      getTurnsForSession(db, session.id),
      undefined,
      "Latest final",
      transcriptTurns,
    );

    const orphan = getTurn(db, session.id, 1);
    expect(orphan?.assistantResponse).toContain("Public summary.");
    expect(orphan?.assistantResponse).not.toContain("leaked");
    expect(orphan?.assistantTranscript).not.toContain("leaked");
  });

  test("uses the hook message for assistant_transcript when parsed narration is blank", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-blank-narration",
      project: "/tmp/project",
      title: "Blank narration session",
      content: null,
      insight: null,
      createdAtEpoch: 640,
      updatedAtEpoch: 640,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (
        session_id, prompt_number, status, user_prompt, created_at_epoch
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).run(session.id, 1, "Do it", 641);

    // The transcript's final assistant message has not flushed yet, so the
    // parser yields an empty narration; the Stop hook still has the answer.
    const transcriptTurns: ParsedReplayTurn[] = [
      {
        promptNumber: 1,
        promptId: "pid-blank",
        userPrompt: "Do it",
        assistantText: "",
        toolCalls: [],
        transcriptLineStart: 3,
      },
    ];

    backfillFromTranscript(
      db,
      getTurnsForSession(db, session.id),
      undefined,
      "Final answer",
      transcriptTurns,
    );

    const turn = getTurn(db, session.id, 1);
    expect(turn?.assistantTranscript).toBe("Final answer");
  });
});
