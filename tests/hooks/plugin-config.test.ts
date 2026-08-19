import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ATTACHED_SEGMENT_BLOCK_SLOTS } from "../../src/hooks/session-composition";

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
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context digest",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context rubric",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context notes",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context proposals",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context segment1-fields",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context segment1-milestones",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context segment2-fields",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context segment2-milestones",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context segment3-fields",
    "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context segment3-milestones",
  ]);
});

test("SessionStart's segment-block pool is a FIXED size tied to ATTACHED_SEGMENT_BLOCK_SLOTS — ticket 10's linear-scaling contract", () => {
  const config = readHookConfig();
  const commands = config.hooks.SessionStart?.[0]?.hooks.map((hook) => hook.command) ?? [];

  const segmentCommands = commands.filter((command) => /context segment\d+-(fields|milestones)/.test(command));
  expect(segmentCommands).toHaveLength(ATTACHED_SEGMENT_BLOCK_SLOTS * 2);
  // Exactly one fields + one milestones command per slot 1..N — no gaps, no
  // duplicates, and nothing that scales with attachment count at the
  // hooks.json level (the pool is fixed; overflow attachments get a roster
  // pointer instead of a new hook command).
  for (let slot = 1; slot <= ATTACHED_SEGMENT_BLOCK_SLOTS; slot += 1) {
    expect(commands).toContain(
      `node \${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js \${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context segment${slot}-fields`,
    );
    expect(commands).toContain(
      `node \${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js \${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs context segment${slot}-milestones`,
    );
  }
  // recent/milestones (RecentSessions, diary index, the old single-timeline
  // milestones section) are gone — ticket 10 requirement 6.
  expect(commands.some((command) => command.endsWith("context recent"))).toBe(false);
  expect(commands.some((command) => command.endsWith("context milestones"))).toBe(false);
});

test("UserPromptSubmit keeps exactly two entries, split the same way", () => {
  const config = readHookConfig();
  const commands = config.hooks.UserPromptSubmit?.[0]?.hooks.map(
    (hook) => hook.command,
  );

  // The backlog relief (裁决 21) and the rule digest ride `prompt-dispatch`
  // rather than registrations of their own; `session-init` owns the turn row
  // and emits the current-turn address line (裁决 25) — the one thing only the
  // row's creator can say without racing. A third entry would only add another
  // process to every prompt the user types.
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
