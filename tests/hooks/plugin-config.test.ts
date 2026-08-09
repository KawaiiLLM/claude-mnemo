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
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context notes",
  ]);
});

test("UserPromptSubmit keeps exactly two entries, split the same way", () => {
  const config = readHookConfig();
  const commands = config.hooks.UserPromptSubmit?.[0]?.hooks.map(
    (hook) => hook.command,
  );

  // The note backlog relief (裁决 21) rides `prompt-dispatch` rather than a
  // third registration, for the same reason the reminder rides
  // `result-dispatch`: the split is by response shape — `session-init` owns the
  // turn row and returns no context, `prompt-dispatch` answers with
  // `additionalContext` — and a third entry would only add another process to
  // every prompt the user types.
  expect(config.hooks.UserPromptSubmit).toHaveLength(1);
  expect(commands).toEqual([
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs session-init",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs prompt-dispatch",
  ]);
});

test("PostToolUse keeps exactly two entries, one async and one synchronous", () => {
  const config = readHookConfig();
  const commands = config.hooks.PostToolUse?.[0]?.hooks.map(
    (hook) => hook.command,
  );

  // The pending-notes reminder rides `result-dispatch` rather than a third
  // registration: `additionalContext` and `asyncWork` are mutually exclusive per
  // handler (R1#11), so the split has to be by response shape — `tool-use`
  // captures and wakes the worker, `result-dispatch` answers with text.
  expect(config.hooks.PostToolUse).toHaveLength(1);
  expect(commands).toEqual([
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs tool-use",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs result-dispatch",
  ]);
});
