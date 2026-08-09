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

  // Both pending-notes paths (裁决 21 and 22) and the rule digest ride
  // `prompt-dispatch` rather than registrations of their own: the split is by
  // response shape — `session-init` owns the turn row and returns no context,
  // `prompt-dispatch` answers with `additionalContext` — and a third entry
  // would only add another process to every prompt the user types.
  expect(config.hooks.UserPromptSubmit).toHaveLength(1);
  expect(commands).toEqual([
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs session-init",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs prompt-dispatch",
  ]);
});

test("no tool-adjacent entry can answer with text", () => {
  const config = readHookConfig();
  const raw = readFileSync(
    join(process.cwd(), "plugin", "hooks", "hooks.json"),
    "utf8",
  );

  // 裁决 23's unified principle. Claude Code renders Pre/PostToolUse
  // `additionalContext` as a floating attachment and re-renders it at request
  // assembly, which rewrites the previous turn's tail: the message-side cache
  // breakpoint dies and the whole prefix re-ingests at cache-write price. So
  // PostToolUse keeps only the async capture entry, which returns no context,
  // and PreToolUse — whose only output was rule tips — is not registered at all.
  expect(config.hooks.PostToolUse).toHaveLength(1);
  expect(config.hooks.PostToolUse?.[0]?.hooks.map((hook) => hook.command)).toEqual([
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs tool-use",
  ]);
  expect(config.hooks.PreToolUse).toBeUndefined();
  expect(raw).not.toContain("result-dispatch");
  expect(raw).not.toContain("pre-tool-dispatch");
});
