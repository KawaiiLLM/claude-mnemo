import { describe, expect, mock, test } from "bun:test";

import {
  MNEMO_TOOL_DESCRIPTIONS,
  recallInputSchema,
  rememberInputSchema,
  timelineInputSchema,
} from "../../src/mcp/definitions";
import {
  MAIN_MCP_TOOL_NAMES,
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

    expect(MAIN_MCP_TOOL_NAMES).toEqual(["recall", "timeline", "remember"]);
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
});
