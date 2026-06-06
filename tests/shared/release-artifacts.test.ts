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

  test("release metadata is consistently bumped to 0.2.27", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      version?: string;
    };
    const pluginManifest = JSON.parse(
      readFileSync("plugin/.claude-plugin/plugin.json", "utf8"),
    ) as {
      version?: string;
    };
    const marketplace = JSON.parse(
      readFileSync(".claude-plugin/marketplace.json", "utf8"),
    ) as {
      metadata?: { version?: string };
      plugins?: Array<{ version?: string }>;
    };

    expect(packageJson.version).toBe("0.2.27");
    expect(pluginManifest.version).toBe("0.2.27");
    expect(marketplace.metadata?.version).toBe("0.2.27");
    expect(marketplace.plugins?.[0]?.version).toBe("0.2.27");
  });

  test("plugin scripts declare local ESM module type for bun-runner", () => {
    const scriptsPackage = JSON.parse(
      readFileSync("plugin/scripts/package.json", "utf8"),
    ) as {
      type?: string;
    };

    expect(scriptsPackage).toEqual({ type: "module" });
  });

  test("tracks built plugin entrypoints in git", () => {
    const result = spawnSync(
      "git",
      [
        "ls-files",
        "--error-unmatch",
        "plugin/scripts/hook-command.cjs",
        "plugin/scripts/mcp-server.cjs",
        "plugin/scripts/replay-parse.cjs",
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
