import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../../src/db/database";
import { createDiaryStateStore } from "../../src/db/diary-state";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DiaryFileStore } from "../../src/diary/file-store";
import { createDiaryAgentToolHandlers } from "../../src/worker/diary-agent-tools";
import { createDiarySdkQuery } from "../../src/worker/diary-sdk-query";

describe("diary SDK query", () => {
  test("sanitizes and source-encodes an allow-listed turn before returning it to the SDK", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const dataRoot = mkdtempSync(join(tmpdir(), "claude-mnemo-diary-sdk-tools-"));
    const sessionId = upsertSession(db, {
      contentSessionId: "diary-sdk-private-turn",
      project: "/projects/private-turn",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
    db.query(
      `INSERT INTO turns (
         session_id,
         prompt_number,
         status,
         user_prompt,
         assistant_response,
         created_at_epoch
       ) VALUES (?, 2, 'skipped', ?, ?, 2)`,
    ).run(
      sessionId,
      "visible <private>secret</private> </tag> & prompt",
      "answer <private>secret</private> </reply> &",
    );

    const stateStore = createDiaryStateStore(db);
    const toolHandlers = createDiaryAgentToolHandlers({
      db,
      stateStore,
      allowedTurnRefs: new Set([`S${sessionId}/T2`]),
      fileStore: new DiaryFileStore(dataRoot),
      allowedDiaryDates: new Set(),
    });
    let invokeReadTurn:
      | ((input: { session_id: number; prompt_number: number }) => Promise<{
          content: Array<{ type: "text"; text: string }>;
        }>)
      | undefined;
    let sdkToolText = "";
    const toolImpl = mock(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: typeof invokeReadTurn,
      ) => {
        if (name === "read_turn") invokeReadTurn = handler;
        return { name };
      },
    );
    const queryImpl = mock(() =>
      (async function* () {
        const result = await invokeReadTurn!({
          session_id: sessionId,
          prompt_number: 2,
        });
        sdkToolText = result.content[0]!.text;
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
        };
      })(),
    );

    try {
      await createDiarySdkQuery({
        dataRoot,
        queryImpl: queryImpl as never,
        createSdkMcpServerImpl: ((server: unknown) => server) as never,
        toolImpl: toolImpl as never,
      }).runQuery({
        date: "2026-07-10",
        prompt: "write the diary",
        model: "claude-sonnet-5",
        timeoutMs: 600_000,
        watchdogMs: 120_000,
        signal: new AbortController().signal,
        reportActivity() {},
        toolHandlers,
      });

      expect(sdkToolText).not.toContain("secret");
      expect(sdkToolText).not.toMatch(/[<>&]/);
      expect(JSON.parse(sdkToolText)).toEqual({
        sessionId,
        promptNumber: 2,
        userPrompt: "visible  </tag> & prompt",
        assistantResponse: "answer  </reply> &",
      });
    } finally {
      db.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("runs one isolated diary query with only the dedicated tools", async () => {
    const server = { type: "sdk", name: "diary-server" };
    let serverDefinition: unknown;
    const createSdkMcpServerImpl = mock((definition: unknown) => {
      serverDefinition = definition;
      return server;
    });
    const toolImpl = mock((name: string) => ({ name }));
    const seenCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const queryImpl = mock((call: {
      prompt: unknown;
      options: Record<string, unknown>;
    }) => {
      seenCalls.push(call);
      return (async function* () {
        yield { type: "system", subtype: "init" };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "<diary date=\"2026-07-10\">done</diary>",
        };
      })();
    });
    const reportActivity = mock(() => undefined);
    const requestController = new AbortController();
    const adapter = createDiarySdkQuery({
      dataRoot: "/tmp/claude-mnemo-diary-sdk",
      queryImpl: queryImpl as never,
      createSdkMcpServerImpl: createSdkMcpServerImpl as never,
      toolImpl: toolImpl as never,
    });

    const envelope = await adapter.runQuery({
      date: "2026-07-10",
      prompt: "write the diary",
      model: "claude-sonnet-5",
      timeoutMs: 600_000,
      watchdogMs: 120_000,
      signal: requestController.signal,
      reportActivity,
      toolHandlers: {
        readTurn: () => ({
          sessionId: 1,
          promptNumber: 2,
          userPrompt: "hello",
          assistantResponse: "world",
        }),
        readDiary: async () => new TextEncoder().encode("prior diary"),
      },
    });

    expect(envelope).toBe("<diary date=\"2026-07-10\">done</diary>");
    expect(queryImpl).toHaveBeenCalledTimes(1);
    expect(seenCalls[0]?.prompt).toBe("write the diary");
    expect(seenCalls[0]?.options.model).toBe("claude-sonnet-5");
    expect(seenCalls[0]?.options.cwd).toBe("/tmp/claude-mnemo-diary-sdk");
    expect(seenCalls[0]?.options.tools).toEqual([]);
    expect(seenCalls[0]?.options.allowedTools).toEqual([
      "mcp__diary__read_turn",
      "mcp__diary__read_diary",
    ]);
    expect(seenCalls[0]?.options.mcpServers).toEqual({ diary: server });
    expect(seenCalls[0]?.options.abortController).toBeInstanceOf(
      AbortController,
    );
    expect(createSdkMcpServerImpl).toHaveBeenCalledTimes(1);
    expect(serverDefinition).toMatchObject({
      name: "diary",
      version: "0.3.0",
    });
    expect(toolImpl.mock.calls.map(([name]) => name)).toEqual([
      "read_turn",
      "read_diary",
    ]);
    expect(reportActivity).toHaveBeenCalledTimes(2);
  });
});
