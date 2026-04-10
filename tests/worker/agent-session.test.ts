import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  moveAgentSession,
  resolveClaudeCodeExecutablePath,
  type MoveAgentSessionDeps,
} from "../../src/worker/agent-session";

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
