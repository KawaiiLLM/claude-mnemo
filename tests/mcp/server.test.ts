import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createDatabase } from "../../src/db/database";
import { upsertProcessSessionMap } from "../../src/db/process-session-map";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  MNEMO_TOOL_DESCRIPTIONS,
  noteInputSchema,
  recallInputSchema,
  rememberInputSchema,
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
  test("registers exactly the four main-server tools", () => {
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
        remember: mock(() => ({ content: [{ type: "text", text: "remember" }] })),
        note: mock(() => ({ content: [{ type: "text", text: "note" }] })),
      },
    );

    expect(registrations.map((registration) => registration.name)).toEqual([
      "recall",
      "timeline",
      "remember",
      "note",
    ]);
    expect(registrations).toHaveLength(4);
    expect(registrations[0]?.config).toEqual({
      description: MNEMO_TOOL_DESCRIPTIONS.recall,
      inputSchema: recallInputSchema,
    });
    expect(registrations[1]?.config).toEqual({
      description: MNEMO_TOOL_DESCRIPTIONS.timeline,
      inputSchema: timelineInputSchema,
    });
    expect(registrations[2]?.config).toEqual({
      description: MNEMO_TOOL_DESCRIPTIONS.remember,
      inputSchema: rememberInputSchema,
    });
    expect(registrations[3]?.config).toEqual({
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
        remember: mock(() => ({ content: [{ type: "text", text: "remember" }] })),
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
    const remember = mock(async () => ({
      content: [{ type: "text" as const, text: "remember" }],
    }));
    const note = mock(async () => ({
      content: [{ type: "text" as const, text: "note" }],
    }));

    try {
      createMcpServer({
        handlers: { recall, timeline, remember, note },
      });

      expect(registrations.map((registration) => registration.name)).toEqual([
        "recall",
        "timeline",
        "remember",
        "note",
      ]);
      expect(registrations).toHaveLength(4);
      expect(registrations[0]?.config).toEqual({
        description: MNEMO_TOOL_DESCRIPTIONS.recall,
        inputSchema: recallInputSchema,
      });
      expect(registrations[1]?.config).toEqual({
        description: MNEMO_TOOL_DESCRIPTIONS.timeline,
        inputSchema: timelineInputSchema,
      });
      expect(registrations[2]?.config).toEqual({
        description: MNEMO_TOOL_DESCRIPTIONS.remember,
        inputSchema: rememberInputSchema,
      });
      expect(registrations[3]?.config).toEqual({
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

describe("resolveCallerSessionIdFromEnv (spec D2)", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "server-identity-session",
      project: "claude-mnemo",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("resolves the mapped mnemo session when the env var and mapping both exist", () => {
    upsertProcessSessionMap(db, "proc-xyz", sessionId, 100);

    expect(
      resolveCallerSessionIdFromEnv(db, { CLAUDE_CODE_SESSION_ID: "proc-xyz" }),
    ).toBe(sessionId);
  });

  test("a missing env var reads as unknown, not as an error", () => {
    expect(resolveCallerSessionIdFromEnv(db, {})).toBeNull();
  });

  test("an env var with no recorded mapping reads as unknown", () => {
    // The MCP server can start before the session's first UserPromptSubmit
    // hook has run — the mapping this reads may simply not exist yet.
    expect(
      resolveCallerSessionIdFromEnv(db, { CLAUDE_CODE_SESSION_ID: "proc-unmapped" }),
    ).toBeNull();
  });
});
