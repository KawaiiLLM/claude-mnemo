import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

describe("release artifacts", () => {
  test("plugin manifest declares an author", () => {
    const manifest = JSON.parse(
      readFileSync("plugin/.claude-plugin/plugin.json", "utf8"),
    ) as {
      author?: {
        name?: string;
      };
    };

    expect(typeof manifest.author).toBe("object");
    expect(typeof manifest.author?.name).toBe("string");
    expect(manifest.author?.name?.trim().length).toBeGreaterThan(0);
  });

  test("tracks built plugin entrypoints in git", () => {
    const result = spawnSync(
      "git",
      [
        "ls-files",
        "--error-unmatch",
        "plugin/scripts/hook-command.cjs",
        "plugin/scripts/mcp-server.cjs",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
  });

  test("bundles claude agent sdk into hook entrypoint", () => {
    const hookCommand = readFileSync("plugin/scripts/hook-command.cjs", "utf8");

    expect(hookCommand).not.toContain(
      'var import_claude_agent_sdk = require("@anthropic-ai/claude-agent-sdk")',
    );
  });
});
