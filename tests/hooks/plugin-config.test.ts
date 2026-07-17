import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("SessionStart diary backfill also runs when a session resumes", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "plugin", "hooks", "hooks.json"), "utf8"),
  ) as {
    hooks: {
      SessionStart: Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
    };
  };

  expect(config.hooks.SessionStart[0]?.matcher.split("|")).toContain("resume");
  expect(config.hooks.SessionStart).toHaveLength(1);
  expect(config.hooks.SessionStart[0]?.hooks.map((hook) => hook.command)).toEqual([
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context persona",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context experience",
  ]);
});
