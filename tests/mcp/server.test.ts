import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSessionByContentId } from "../../src/db/sessions";
import { createSessionInitHandler } from "../../src/hooks/handlers/session-init";
import type { NormalizedHookInput } from "../../src/hooks/types";
import {
  MNEMO_TOOL_DESCRIPTIONS,
  noteInputSchema,
  recallInputSchema,
  timelineInputSchema,
} from "../../src/mcp/definitions";
import {
  createMcpServer,
  registerMainMcpTools,
  resolveCallerSessionIdFromEnv,
} from "../../src/mcp/server";

type ToolRegistration = {
  name: string;
  config: {
    description: string;
    inputSchema: unknown;
  };
  handler: (args: unknown) => unknown;
};

describe("registerMainMcpTools", () => {
  test("registers exactly the three main-server tools", () => {
    const registrations: ToolRegistration[] = [];

    registerMainMcpTools(
      {
        registerTool(name, config, handler) {
          registrations.push({ name, config, handler });
        },
      },
      {
        recall: mock(() => ({ content: [{ type: "text", text: "recall" }] })),
        timeline: mock(() => ({ content: [{ type: "text", text: "timeline" }] })),
        note: mock(() => ({ content: [{ type: "text", text: "note" }] })),
      },
    );

    expect(registrations.map((registration) => registration.name)).toEqual([
      "recall",
      "timeline",
      "note",
    ]);
    expect(registrations).toHaveLength(3);
    expect(registrations[0]?.config).toEqual({
      description: MNEMO_TOOL_DESCRIPTIONS.recall,
      inputSchema: recallInputSchema,
    });
    expect(registrations[1]?.config).toEqual({
      description: MNEMO_TOOL_DESCRIPTIONS.timeline,
      inputSchema: timelineInputSchema,
    });
    expect(registrations[2]?.config).toEqual({
      description: MNEMO_TOOL_DESCRIPTIONS.note,
      inputSchema: noteInputSchema,
    });
  });

  test("delegates timeline calls through the registered handler", async () => {
    const registrations: ToolRegistration[] = [];
    const timeline = mock(async () => ({
      content: [{ type: "text" as const, text: "timeline" }],
    }));

    registerMainMcpTools(
      {
        registerTool(name, config, handler) {
          registrations.push({ name, config, handler });
        },
      },
      {
        recall: mock(() => ({ content: [{ type: "text", text: "recall" }] })),
        timeline,
        note: mock(() => ({ content: [{ type: "text", text: "note" }] })),
      },
    );

    await registrations[1]?.handler({ id: "S42/T10..30" });

    expect(timeline).toHaveBeenCalledTimes(1);
    expect(timeline).toHaveBeenCalledWith({ id: "S42/T10..30" });
  });

  test("createMcpServer registers the actual tool map", async () => {
    const registrations: ToolRegistration[] = [];
    const registerToolSpy = spyOn(McpServer.prototype, "registerTool").mockImplementation(
      function (
        this: McpServer,
        name: string,
        config: ToolRegistration["config"],
        handler: ToolRegistration["handler"],
      ) {
        registrations.push({ name, config, handler });
        return this;
      },
    );

    const recall = mock(async () => ({
      content: [{ type: "text" as const, text: "recall" }],
    }));
    const timeline = mock(async () => ({
      content: [{ type: "text" as const, text: "timeline" }],
    }));
    const note = mock(async () => ({
      content: [{ type: "text" as const, text: "note" }],
    }));

    try {
      createMcpServer({
        handlers: { recall, timeline, note },
      });

      expect(registrations.map((registration) => registration.name)).toEqual([
        "recall",
        "timeline",
        "note",
      ]);
      expect(registrations).toHaveLength(3);
      expect(registrations[0]?.config).toEqual({
        description: MNEMO_TOOL_DESCRIPTIONS.recall,
        inputSchema: recallInputSchema,
      });
      expect(registrations[1]?.config).toEqual({
        description: MNEMO_TOOL_DESCRIPTIONS.timeline,
        inputSchema: timelineInputSchema,
      });
      expect(registrations[2]?.config).toEqual({
        description: MNEMO_TOOL_DESCRIPTIONS.note,
        inputSchema: noteInputSchema,
      });

      await registrations[1]?.handler({ id: "S42/T10..30" });

      expect(timeline).toHaveBeenCalledTimes(1);
      expect(timeline).toHaveBeenCalledWith({ id: "S42/T10..30" });
    } finally {
      registerToolSpy.mockRestore();
    }
  });
});

/**
 * The join, driven from both real ends: the UserPromptSubmit hook handler is
 * the only thing that ever writes this map, and `resolveCallerSessionIdFromEnv`
 * the only thing that ever reads it. Recording the mapping with a key the test
 * itself chose — which is how each half used to be tested alone — proves
 * nothing about whether the two halves agree, and is exactly how the
 * single-key join shipped broken.
 */
describe("resolveCallerSessionIdFromEnv (spec D2)", () => {
  let db: Database;

  const SOCKET = "/tmp/cc-socks/52426.sock";

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  async function recordMappingThroughHook(
    env: NodeJS.ProcessEnv,
    contentSessionId = "server-identity-session",
  ): Promise<number> {
    const input: NormalizedHookInput = {
      eventName: "UserPromptSubmit",
      sessionId: contentSessionId,
      cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
      prompt: "a prompt",
      stopHookActive: false,
      raw: {},
    };

    await createSessionInitHandler({ db, env })(input);

    return getSessionByContentId(db, contentSessionId)!.id;
  }

  test("a resumed session resolves: the socket agrees, the session var does not", async () => {
    // The measured production shape. Claude Code hands each child a snapshot of
    // its environment at spawn: the MCP server is spawned before the resumed
    // conversation's id is adopted and keeps the boot id for the session's
    // whole life, while every hook is spawned per invocation and sees the
    // current one. Keyed on the session var alone this join never matches, and
    // the note guard it feeds is inert for every resumed session.
    const sessionId = await recordMappingThroughHook({
      CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
      CLAUDE_CODE_SESSION_ID: "resumed-conversation-id",
    });

    expect(
      resolveCallerSessionIdFromEnv(db, {
        CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
        CLAUDE_CODE_SESSION_ID: "boot-id-frozen-at-spawn",
      }),
    ).toBe(sessionId);
  });

  test("a fresh session resolves: both variables agree", async () => {
    const env = {
      CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
      CLAUDE_CODE_SESSION_ID: "same-on-both-sides",
    };
    const sessionId = await recordMappingThroughHook(env);

    expect(resolveCallerSessionIdFromEnv(db, env)).toBe(sessionId);
  });

  test("with no socket anywhere, an agreeing session var still resolves", async () => {
    // The socket is feature-gated in Claude Code and absent in bare mode, which
    // is why the session var stays as a fallback rather than being replaced:
    // where the socket is unavailable the behaviour must be exactly today's.
    const sessionId = await recordMappingThroughHook({
      CLAUDE_CODE_SESSION_ID: "no-socket-build",
    });

    expect(
      resolveCallerSessionIdFromEnv(db, {
        CLAUDE_CODE_SESSION_ID: "no-socket-build",
      }),
    ).toBe(sessionId);
  });

  test("with no socket anywhere, a disagreeing session var reads as unknown", async () => {
    // Today's honest miss, preserved: nothing in this environment can tell the
    // two processes apart, so identity is unknown rather than guessed — and
    // unknown admits.
    await recordMappingThroughHook({ CLAUDE_CODE_SESSION_ID: "hook-side-id" });

    expect(
      resolveCallerSessionIdFromEnv(db, {
        CLAUDE_CODE_SESSION_ID: "mcp-side-id",
      }),
    ).toBeNull();
  });

  test("the first HIT wins, not the first key present", async () => {
    // The socket appearing in the reader's environment must not shadow a
    // session var the writer did record — a build that gates the socket on
    // mid-session would otherwise lose an identity it already had.
    const sessionId = await recordMappingThroughHook({
      CLAUDE_CODE_SESSION_ID: "recorded-without-socket",
    });

    expect(
      resolveCallerSessionIdFromEnv(db, {
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/never-recorded.sock",
        CLAUDE_CODE_SESSION_ID: "recorded-without-socket",
      }),
    ).toBe(sessionId);
  });

  test("two concurrent sessions are told apart by their sockets", async () => {
    const first = await recordMappingThroughHook(
      {
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
        CLAUDE_CODE_SESSION_ID: "shared-looking-id",
      },
      "concurrent-a",
    );
    const second = await recordMappingThroughHook(
      {
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/2.sock",
        CLAUDE_CODE_SESSION_ID: "shared-looking-id",
      },
      "concurrent-b",
    );

    expect(first).not.toBe(second);
    expect(
      resolveCallerSessionIdFromEnv(db, {
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
      }),
    ).toBe(first);
    expect(
      resolveCallerSessionIdFromEnv(db, {
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/2.sock",
      }),
    ).toBe(second);
  });

  test("no recognised variable at all reads as unknown, not as an error", () => {
    expect(resolveCallerSessionIdFromEnv(db, {})).toBeNull();
    expect(
      resolveCallerSessionIdFromEnv(db, { SOME_UNRELATED_VAR: "x" }),
    ).toBeNull();
  });

  test("an environment with no recorded mapping reads as unknown", () => {
    // The MCP server can start before the session's first UserPromptSubmit
    // hook has run — the mapping this reads may simply not exist yet.
    expect(
      resolveCallerSessionIdFromEnv(db, {
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/unmapped.sock",
        CLAUDE_CODE_SESSION_ID: "proc-unmapped",
      }),
    ).toBeNull();
  });
});
