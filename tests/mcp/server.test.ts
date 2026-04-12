import { describe, expect, mock, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  recallInputSchema,
  rememberInputSchema,
  timelineInputSchema,
} from "../../src/mcp/definitions";
import {
  createMcpServer,
  registerMainMcpTools,
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
        remember: mock(() => ({ content: [{ type: "text", text: "remember" }] })),
      },
    );

    expect(registrations.map((registration) => registration.name)).toEqual([
      "recall",
      "timeline",
      "remember",
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
      description: MNEMO_TOOL_DESCRIPTIONS.remember,
      inputSchema: rememberInputSchema,
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

    try {
      createMcpServer({
        handlers: { recall, timeline, remember },
      });

      expect(registrations.map((registration) => registration.name)).toEqual([
        "recall",
        "timeline",
        "remember",
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
        description: MNEMO_TOOL_DESCRIPTIONS.remember,
        inputSchema: rememberInputSchema,
      });

      await registrations[1]?.handler({ id: "S42/T10..30" });

      expect(timeline).toHaveBeenCalledTimes(1);
      expect(timeline).toHaveBeenCalledWith({ id: "S42/T10..30" });
    } finally {
      registerToolSpy.mockRestore();
    }
  });
});
