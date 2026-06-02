import { afterEach, describe, expect, mock, test } from "bun:test";
import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";
import { createMnemoSdkServer } from "../../src/worker/agent-session";

import { resolveClaudeCodeExecutablePath } from "../../src/worker/agent-session";

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

describe("createMnemoSdkServer onRemember", () => {
  test("invokes onRemember with the remembered id", async () => {
    const db = createDatabase(":memory:");
    initializeDatabase(db);
    const seen: string[] = [];
    let rememberHandler: ((args: any) => Promise<any>) | null = null;
    createMnemoSdkServer(db, "p", {
      createSdkMcpServerImpl: ((cfg: any) => {
        rememberHandler = cfg.tools.find((t: any) => t.name === "remember").handler;
        return cfg;
      }) as any,
      toolImpl: ((name: string, _d: string, _s: unknown, handler: any) => ({ name, handler })) as any,
      onRemember: (id: string) => seen.push(id),
    } as any);
    await rememberHandler!({ id: "T7", status: "skipped" });
    expect(seen).toEqual(["T7"]);
    db.close();
  });

  test("does not invoke onRemember when id is not a string", async () => {
    const db = createDatabase(":memory:");
    initializeDatabase(db);
    const seen: string[] = [];
    let rememberHandler: ((args: any) => Promise<any>) | null = null;
    createMnemoSdkServer(db, "p", {
      createSdkMcpServerImpl: ((cfg: any) => {
        rememberHandler = cfg.tools.find((t: any) => t.name === "remember").handler;
        return cfg;
      }) as any,
      toolImpl: ((name: string, _d: string, _s: unknown, handler: any) => ({ name, handler })) as any,
      onRemember: (id: string) => seen.push(id),
    } as any);
    // Call with no id — should not crash and should not add to seen
    try {
      await rememberHandler!({ status: "skipped" });
    } catch {
      // handler may throw for missing id — that's fine
    }
    expect(seen).toEqual([]);
    db.close();
  });
});
