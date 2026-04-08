import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";

import {
  forkMnemosyne,
  moveAgentSession,
  resolveClaudeCodeExecutablePath,
  type MoveAgentSessionDeps,
} from "../../src/mnemosyne/fork";

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

});

describe("moveAgentSession", () => {
  function createMockDeps(overrides: Partial<MoveAgentSessionDeps> = {}): MoveAgentSessionDeps {
    return {
      resolveSrcPath: () => "/src/session.jsonl",
      resolveDestPath: () => "/dest/sessions/session.jsonl",
      existsSync: () => true,
      mkdirSync: mock(() => undefined),
      renameSync: mock(() => undefined),
      copyFileSync: mock(() => undefined),
      unlinkSync: mock(() => undefined),
      ...overrides,
    };
  }

  test("renames source to dest on same device", () => {
    const deps = createMockDeps();

    moveAgentSession("/project", "abc-123", deps);

    expect(deps.renameSync).toHaveBeenCalledWith(
      "/src/session.jsonl",
      "/dest/sessions/session.jsonl",
    );
    expect(deps.copyFileSync).not.toHaveBeenCalled();
    expect(deps.unlinkSync).not.toHaveBeenCalled();
  });

  test("skips move when source does not exist", () => {
    const deps = createMockDeps({ existsSync: () => false });

    moveAgentSession("/project", "abc-123", deps);

    expect(deps.renameSync).not.toHaveBeenCalled();
    expect(deps.copyFileSync).not.toHaveBeenCalled();
  });

  test("falls back to copy+delete on EXDEV", () => {
    const exdevError = Object.assign(new Error("cross-device link"), {
      code: "EXDEV",
    });
    const deps = createMockDeps({
      renameSync: mock(() => { throw exdevError; }),
    });

    moveAgentSession("/project", "abc-123", deps);

    expect(deps.copyFileSync).toHaveBeenCalledWith(
      "/src/session.jsonl",
      "/dest/sessions/session.jsonl",
    );
    expect(deps.unlinkSync).toHaveBeenCalledWith("/src/session.jsonl");
  });

  test("rethrows non-EXDEV errors from renameSync", () => {
    const permError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const deps = createMockDeps({
      renameSync: mock(() => { throw permError; }),
    });

    expect(() => moveAgentSession("/project", "abc-123", deps)).toThrow(
      "permission denied",
    );
    expect(deps.copyFileSync).not.toHaveBeenCalled();
  });
});
