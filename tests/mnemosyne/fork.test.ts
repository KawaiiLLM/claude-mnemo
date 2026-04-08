import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";
import { resolveAgentSessionPath } from "../../src/shared/paths";

import { forkMnemosyne, resolveClaudeCodeExecutablePath } from "../../src/mnemosyne/fork";

describe("resolveClaudeCodeExecutablePath", () => {
  test("prefers explicit CLAUDE_CODE_PATH when it exists", () => {
    const path = resolveClaudeCodeExecutablePath(
      {
        CLAUDE_CODE_PATH: "/custom/claude",
      },
      {
        existsSync: (candidate) => candidate === "/custom/claude",
        findOnPath: () => null,
      },
    );

    expect(path).toBe("/custom/claude");
  });

  test("falls back to discovered claude binary on PATH", () => {
    const path = resolveClaudeCodeExecutablePath(
      {},
      {
        existsSync: () => false,
        findOnPath: () => "/opt/homebrew/bin/claude",
      },
    );

    expect(path).toBe("/opt/homebrew/bin/claude");
  });

  test("returns undefined when no executable can be resolved", () => {
    const path = resolveClaudeCodeExecutablePath(
      {},
      {
        existsSync: () => false,
        findOnPath: () => null,
      },
    );

    expect(path).toBeUndefined();
  });
});

describe("forkMnemosyne", () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test("injects an in-process mnemo MCP server with explicit allowed tools", async () => {
    db = createDatabase(":memory:");
    initializeDatabase(db);

    let capturedQueryParams: Record<string, unknown> | null = null;
    let capturedToolNames: string[] = [];
    const fakeServer = {
      type: "sdk",
      name: "mnemo",
      instance: {},
    };
    const createSdkMcpServerImpl = mock((options: { tools?: Array<{ name: string }> }) => {
      capturedToolNames = (options.tools ?? []).map((toolDef) => toolDef.name);
      return fakeServer;
    });
    const queryImpl = mock((params: Record<string, unknown>) => {
      capturedQueryParams = params;

      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            session_id: "test-session-id",
            num_turns: 1,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 40,
            },
            duration_ms: 50,
            total_cost_usd: 0.01,
          };
        },
      };
    });

    const result = await forkMnemosyne(
      {
        prompt: "extract memory",
        cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
        database: db,
      },
      {
        queryImpl: queryImpl as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
        createSdkMcpServerImpl: createSdkMcpServerImpl as unknown as typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer,
        resolveClaudeCodeExecutablePathImpl: () => "/usr/local/bin/claude",
      },
    );

    expect(result).toEqual({
      sessionId: "test-session-id",
      numTurns: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
      durationMs: 50,
      totalCostUsd: 0.01,
    });
    expect(createSdkMcpServerImpl).toHaveBeenCalledTimes(1);
    expect(capturedToolNames).toEqual([
      "remember",
      "save_turn",
      "update_session",
      "recall",
      "replay",
    ]);
    expect(capturedQueryParams).not.toBeNull();

    const options = (capturedQueryParams as { options: Record<string, unknown> }).options;

    expect(options.mcpServers).toEqual({
      mnemo: fakeServer,
    });
    expect(options.allowedTools).toEqual([
      "mcp__mnemo__remember",
      "mcp__mnemo__save_turn",
      "mcp__mnemo__update_session",
      "mcp__mnemo__recall",
      "mcp__mnemo__replay",
    ]);
    expect(options.resume).toBeUndefined();
    expect(options.forkSession).toBeUndefined();
    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
  });

  test("does not inject a mnemo MCP server when no database is provided", async () => {
    let capturedQueryParams: Record<string, unknown> | null = null;
    const createSdkMcpServerImpl = mock(() => {
      throw new Error("createSdkMcpServer should not be called without a database");
    });
    const queryImpl = mock((params: Record<string, unknown>) => {
      capturedQueryParams = params;

      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            num_turns: 0,
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 4,
            },
            duration_ms: 5,
          };
        },
      };
    });

    await forkMnemosyne(
      {
        prompt: "extract memory",
      },
      {
        queryImpl: queryImpl as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
        createSdkMcpServerImpl: createSdkMcpServerImpl as unknown as typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer,
        resolveClaudeCodeExecutablePathImpl: () => "/usr/local/bin/claude",
      },
    );

    expect(createSdkMcpServerImpl).not.toHaveBeenCalled();
    expect(capturedQueryParams).not.toBeNull();

    const options = (capturedQueryParams as { options: Record<string, unknown> }).options;

    expect(options.mcpServers).toBeUndefined();
    expect(options.allowedTools).toEqual([
      "mcp__mnemo__remember",
      "mcp__mnemo__save_turn",
      "mcp__mnemo__update_session",
      "mcp__mnemo__recall",
      "mcp__mnemo__replay",
    ]);
    expect(options.resume).toBeUndefined();
    expect(options.forkSession).toBeUndefined();
  });

  test("pins model to claude-sonnet-4-6", async () => {
    let capturedQueryParams: Record<string, unknown> | null = null;
    const queryImpl = mock((params: Record<string, unknown>) => {
      capturedQueryParams = params;

      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            session_id: "model-test",
            num_turns: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            duration_ms: 0,
            total_cost_usd: 0,
          };
        },
      };
    });

    await forkMnemosyne(
      { prompt: "test" },
      {
        queryImpl: queryImpl as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
        resolveClaudeCodeExecutablePathImpl: () => "/usr/local/bin/claude",
      },
    );

    const options = (capturedQueryParams as { options: Record<string, unknown> }).options;
    expect(options.model).toBe("claude-sonnet-4-6");
  });

  test("moves agent session JSONL to ~/.claude-mnemo/sessions/", async () => {
    db = createDatabase(":memory:");
    initializeDatabase(db);

    const testCwd = "/tmp/mnemo-move-test-project";
    const testSessionId = "move-test-" + Date.now();

    // Create source JSONL at the path resolveTranscriptPath would compute
    const { resolveTranscriptPath } = await import("../../src/shared/paths");
    const srcPath = resolveTranscriptPath(testCwd, testSessionId);
    mkdirSync(join(srcPath, ".."), { recursive: true });
    writeFileSync(srcPath, '{"type":"test-payload"}\n');

    const queryImpl = mock(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          session_id: testSessionId,
          num_turns: 1,
          usage: {
            input_tokens: 5,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          duration_ms: 100,
          total_cost_usd: 0,
        };
      },
    }));

    await forkMnemosyne(
      {
        prompt: "test",
        cwd: testCwd,
        database: db,
      },
      {
        queryImpl: queryImpl as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
        resolveClaudeCodeExecutablePathImpl: () => "/usr/local/bin/claude",
      },
    );

    const destPath = resolveAgentSessionPath(testSessionId);

    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe('{"type":"test-payload"}\n');
    expect(existsSync(srcPath)).toBe(false);

    // Clean up
    try { require("node:fs").unlinkSync(destPath); } catch {}
  });
});
