import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createObservation, getObservation } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurnById } from "../../src/db/turns";
import { renderFileTree as renderSharedFileTree } from "../../src/shared/file-tree";
import {
  buildBatchPrompt,
  cleanInput,
  cleanOutput,
  createWorkerProcessors,
} from "../../src/worker/processors";

describe("worker processors", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let observationId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "worker-session",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Auth race",
      content: "Current summary",
      insight: "- current insight",
      nextSteps: "Ship it",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    turnId = db
      .query<{ id: number }, []>(
        `
          INSERT INTO turns (
            session_id,
            prompt_number,
            status,
            user_prompt,
            assistant_response,
            created_at_epoch
          ) VALUES (?, 1, 'active', 'Diagnose auth race', 'Added mutex', 120)
          RETURNING id
        `,
      )
      .get(sessionId)!.id;

    observationId = createObservation(db, {
      turnId,
      toolName: "Read",
      toolInput: '{"file_path":"src/auth.ts"}',
      toolResult: "file contents",
      status: "pending",
      createdAtEpoch: 130,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("cleanInput strips Bash metadata and unwraps the command", () => {
    expect(
      cleanInput(
        "Bash",
        '{"command":"npm test","description":"system note","timeout":120000}',
      ),
    ).toBe("npm test");
  });

  test("cleanInput preserves all keys for non-Bash tools", () => {
    expect(
      cleanInput(
        "Grep",
        '{"pattern":"token","path":"src","output_mode":"content","-n":true}',
      ),
    ).toBe('{"pattern":"token","path":"src","output_mode":"content","-n":true}');
  });

  test("cleanInput returns the raw string when JSON parsing fails", () => {
    expect(cleanInput("Read", '{"file_path":"src/auth.ts"')).toBe(
      '{"file_path":"src/auth.ts"',
    );
  });

  test("cleanOutput extracts nested Read file.content", () => {
    expect(
      cleanOutput(
        "Read",
        '{"type":"text","file":{"filePath":"src/auth.ts","content":"export const auth = true;"}}',
      ),
    ).toBe("export const auth = true;");
  });

  test("cleanOutput falls through to filtered Read output when file.content is missing", () => {
    expect(
      cleanOutput(
        "Read",
        '{"type":"text","error":"ENOENT","file":{"filePath":"src/auth.ts"}}',
      ),
    ).toBe("");
  });

  test("cleanOutput keeps Bash stderr as the primary result when stdout is empty", () => {
    expect(
      cleanOutput(
        "Bash",
        '{"stdout":"","stderr":"Permission denied","interrupted":false}',
      ),
    ).toBe("Permission denied");
  });

  test("cleanOutput keeps Grep allowlist fields", () => {
    expect(
      cleanOutput(
        "Grep",
        '{"filenames":["src/auth.ts"],"content":"token","numFiles":1,"numLines":4,"durationMs":12}',
      ),
    ).toBe('{"filenames":["src/auth.ts"],"content":"token","numFiles":1,"numLines":4}');
  });

  test("cleanOutput keeps Edit allowlist fields", () => {
    expect(
      cleanOutput(
        "Edit",
        '{"filePath":"src/auth.ts","oldString":"foo","newString":"bar","structuredPatch":[]}',
      ),
    ).toBe('{"filePath":"src/auth.ts","oldString":"foo","newString":"bar"}');
  });

  test("cleanOutput passes unknown tool output through unchanged", () => {
    expect(cleanOutput("CustomMcp", '{"foo":"bar","count":1}')).toBe(
      '{"foo":"bar","count":1}',
    );
  });

  test("cleanOutput returns the raw string when JSON parsing fails", () => {
    expect(cleanOutput("Bash", '{"stdout":"ok"')).toBe('{"stdout":"ok"');
  });

  test("renderFileTree groups files under a common root", () => {
    expect(
      renderSharedFileTree([
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/pending-queue.ts",
      ]),
    ).toBe(
      [
        "/Users/zhaoqixuan/Projects/claude-mnemo/src",
        "db/pending-queue.ts",
        "worker/",
        "  processors.ts",
        "  server.ts",
      ].join("\n"),
    );
  });

  test("shared renderFileTree matches the worker import contract", () => {
    const paths = [
      "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/processors.ts",
      "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
    ];
    expect(renderSharedFileTree(paths)).toBe(
      ["/Users/zhaoqixuan/Projects/claude-mnemo/src/worker", "processors.ts", "server.ts"].join("\n"),
    );
  });

  test("renderFileTree keeps the actual longest common directory prefix", () => {
    expect(
      renderSharedFileTree(["/a/b/c.ts", "/a/c/d.ts"]),
    ).toBe(["/a", "b/c.ts", "c/d.ts"].join("\n"));
  });

  test("renderFileTree returns none for an empty list", () => {
    expect(renderSharedFileTree([])).toBe("(none)");
  });

  test("renderFileTree renders single-file directories as dir/file", () => {
    expect(
      renderSharedFileTree([
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/db/pending-queue.ts",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
      ]),
    ).toBe(
      [
        "/Users/zhaoqixuan/Projects/claude-mnemo/src",
        "db/pending-queue.ts",
        "worker/server.ts",
      ].join("\n"),
    );
  });

  test("renderFileTree deduplicates the root path when it appears in the path list", () => {
    expect(
      renderSharedFileTree([
        "/Users/zhaoqixuan/Projects/claude-mnemo",
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
      ]),
    ).toBe(
      ["/Users/zhaoqixuan/Projects/claude-mnemo", "src/worker/server.ts"].join("\n"),
    );
  });

  test("renderFileTree handles cross-project paths without collapsing them incorrectly", () => {
    expect(
      renderSharedFileTree([
        "/Users/zhaoqixuan/Projects/claude-mnemo/src/worker/server.ts",
        "/Users/zhaoqixuan/Projects/another-repo/src/index.ts",
      ]),
    ).toBe(
      [
        "/Users/zhaoqixuan/Projects",
        "another-repo/src/index.ts",
        "claude-mnemo/src/worker/server.ts",
      ].join("\n"),
    );
  });

  test("renderFileTree handles relative paths with a shared prefix", () => {
    expect(
      renderSharedFileTree(["src/auth.ts", "src/server.ts"]),
    ).toBe(["src", "auth.ts", "server.ts"].join("\n"));
  });

  test("renderFileTree handles relative paths with no shared prefix", () => {
    expect(
      renderSharedFileTree(["src/auth.ts", "lib/utils.ts"]),
    ).toBe([".", "lib/utils.ts", "src/auth.ts"].join("\n"));
  });

  test("renderFileTree handles relative path that is a prefix of another", () => {
    expect(
      renderSharedFileTree(["src", "src/auth.ts"]),
    ).toBe(["src", "auth.ts"].join("\n"));
  });

  test("buildBatchPrompt renders session title and current_prompt while omitting user_request", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: "Diagnose auth race",
      priorTitle: null,
      priorContent: null,
      priorInsight: null,
      priorNextSteps: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).toContain("title: Auth race");
    expect(prompt).toContain("current_prompt: Diagnose auth race");
    expect(prompt).not.toContain("user_request:");
  });

  test("buildBatchPrompt omits current_prompt when it is null", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: null,
      priorTitle: null,
      priorContent: null,
      priorInsight: null,
      priorNextSteps: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).toContain("title: Auth race");
    expect(prompt).not.toContain("current_prompt:");
  });

  test("buildBatchPrompt omits title when it is null", () => {
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: null,
      currentPrompt: "Diagnose auth race",
      priorTitle: null,
      priorContent: null,
      priorInsight: null,
      priorNextSteps: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).not.toContain("title:");
    expect(prompt).toContain("current_prompt: Diagnose auth race");
  });

  test("buildBatchPrompt truncates current_prompt at 200 chars", () => {
    const longPrompt = `${"a".repeat(120)}${"b".repeat(120)}`;
    const prompt = buildBatchPrompt({
      sessionId,
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      sessionTitle: "Auth race",
      currentPrompt: longPrompt,
      priorTitle: null,
      priorContent: null,
      priorInsight: null,
      priorNextSteps: null,
      completedTurnBlocks: ["  <turn id=\"T1\" />"],
    });

    expect(prompt).toContain(`current_prompt: ${"a".repeat(90)}`);
    expect(prompt).toContain("[...60 chars truncated...]");
    expect(prompt).toContain(`${"b".repeat(90)}\n</session>`);
    expect(prompt).not.toContain(longPrompt);
  });

  test("pushSessionSummaryPrompt invokes Mnemosyne with current session state", async () => {
    const pushMessage = mock(async () => {});
    const processors = createWorkerProcessors(db);

    await processors.pushSessionSummaryPrompt(
      {
        sessionDbId: sessionId,
        processingLock: Promise.resolve(),
        pushMessage,
        querySession: null,
        contentSessionId: null,
        project: null,
        lastPushAt: 0,
        lastMessageAt: 0,
        lastActivity: 0,
      },
      sessionId,
    );

    expect(pushMessage).toHaveBeenCalledTimes(1);
    const prompt = String(pushMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain(`<session id="S${sessionId}">`);
    expect(prompt).toContain("Current summary");
    // Session-summary still carries its length budget inline.
    expect(prompt).toContain("Length budget");
    expect(prompt).toContain("material change");
    expect(prompt).toContain("no tool calls");
    expect(prompt).not.toContain("You are Mnemosyne");
  });
});
