import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readHookConfig(): {
  hooks: Record<
    string,
    Array<{ matcher: string; hooks: Array<{ command: string }> }> | undefined
  >;
} {
  return JSON.parse(
    readFileSync(join(process.cwd(), "plugin", "hooks", "hooks.json"), "utf8"),
  ) as {
    hooks: Record<
      string,
      Array<{ matcher: string; hooks: Array<{ command: string }> }> | undefined
    >;
  };
}

test("PostCompact is not registered at all", () => {
  const config = readHookConfig();

  // The handler was removed wholesale (spec §F): capture repair now claims
  // boundaries from the transcript, so a re-added registration would mint
  // duplicate markers rather than being merely redundant.
  expect(Object.keys(config.hooks)).not.toContain("PostCompact");
  expect(config.hooks.PostCompact).toBeUndefined();
  expect(
    readFileSync(join(process.cwd(), "plugin", "hooks", "hooks.json"), "utf8"),
  ).not.toContain("post-compact");
});

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
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context recent",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context digest",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context milestones",
  ]);
});
