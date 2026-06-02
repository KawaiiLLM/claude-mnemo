import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "../../src/db/database";
import { initializeDatabase } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
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
  function wireRememberHandler(db: Database, seen: string[]): (args: any) => Promise<any> {
    let rememberHandler: ((args: any) => Promise<any>) | null = null;
    createMnemoSdkServer(db, "p", {
      createSdkMcpServerImpl: ((cfg: any) => {
        rememberHandler = cfg.tools.find((t: any) => t.name === "remember").handler;
        return cfg;
      }) as any,
      toolImpl: ((name: string, _d: string, _s: unknown, handler: any) => ({ name, handler })) as any,
      onRemember: (id: string) => seen.push(id),
    } as any);
    return rememberHandler!;
  }

  // Seed a real session + active turn so a remember actually writes. Returns the
  // turn's id selector ("T<n>").
  function seedTurn(db: Database): string {
    const sessionId = upsertSession(db, {
      contentSessionId: "agent-session-onremember",
      project: "p",
      title: "seed",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'active', ?, ?)",
    ).run(sessionId, 1, "do something", 120);
    const turnId = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = 1",
      )
      .get(sessionId)!.id;
    return `T${turnId}`;
  }

  test("invokes onRemember after a successful write", async () => {
    const db = createDatabase(":memory:");
    initializeDatabase(db);
    const seen: string[] = [];
    const rememberHandler = wireRememberHandler(db, seen);
    const id = seedTurn(db);
    const result = await rememberHandler({ id, status: "skipped" });
    expect(result.content[0].text).toStartWith("Updated turn ");
    expect(seen).toEqual([id]);
    db.close();
  });

  test("does NOT invoke onRemember when the write is rejected (turn not found)", async () => {
    const db = createDatabase(":memory:");
    initializeDatabase(db);
    const seen: string[] = [];
    const rememberHandler = wireRememberHandler(db, seen);
    // T99999 does not exist — the route returns "Turn T99999 not found." and
    // must NOT mark the id resolved (the High finding this pins).
    const result = await rememberHandler({ id: "T99999", status: "skipped" });
    expect(result.content[0].text).toContain("not found");
    expect(seen).toEqual([]);
    db.close();
  });

  test("does not invoke onRemember when id is not a string", async () => {
    const db = createDatabase(":memory:");
    initializeDatabase(db);
    const seen: string[] = [];
    const rememberHandler = wireRememberHandler(db, seen);
    // Call with no id — should not crash and should not add to seen
    try {
      await rememberHandler({ status: "skipped" });
    } catch {
      // handler may throw for missing id — that's fine
    }
    expect(seen).toEqual([]);
    db.close();
  });
});
