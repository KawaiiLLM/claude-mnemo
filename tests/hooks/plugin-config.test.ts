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

// ---------------------------------------------------------------------------
// The attach menu (lane-model-v12 ticket 17, spec D3g) — the plugin's first
// `commands/` entry.
// ---------------------------------------------------------------------------

function readAttachCommand(): { frontmatter: string; body: string } {
  const raw = readFileSync(
    join(process.cwd(), "plugin", "commands", "attach.md"),
    "utf8",
  );
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error("plugin/commands/attach.md has no YAML frontmatter block");
  }
  return { frontmatter: match[1]!, body: match[2]! };
}

/**
 * Claude Code discovers a plugin's commands by DIRECTORY when the manifest
 * declares no `commands` key (`pluginLoader.ts`: `!manifest.commands ?
 * pathExists(join(pluginPath, 'commands'))` → `plugin.commandsPath`), and
 * names each one `<plugin>:<file basename>`. So this pair of facts — the file
 * sits at `plugin/commands/attach.md`, and the manifest stays silent about
 * commands — IS the registration; adding a `commands` key would replace
 * auto-discovery with an explicit path list and silently drop this file.
 */
test("the attach menu is a plugin command Claude Code auto-discovers", () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "plugin", ".claude-plugin", "plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(manifest.commands).toBeUndefined();

  const { frontmatter } = readAttachCommand();
  // A description that is not a scalar string is DROPPED at load time
  // (`claude plugin validate` reports it as an error), leaving the command
  // nameless in the picker.
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1] ?? "";
  expect(description.trim().length).toBeGreaterThan(0);
  expect(description.trimStart()).not.toStartWith("[");
  expect(description.trimStart()).not.toStartWith("{");
});

test("the attach menu drives the real verbs, and never picks for the user", () => {
  const { body } = readAttachCommand();
  // Same store, new entrance (ticket 17): the menu is a prompt over
  // `remember`'s own verbs, not a second attachment mechanism.
  expect(body).toContain('verb: "attach"');
  expect(body).toContain('verb: "detach"');
  expect(body).toContain("AskUserQuestion");
  // AskUserQuestion accepts 2-4 options and there are usually more live
  // segments than that, so the command has to say how the rest are reachable.
  expect(body).toContain("Other");
  // The decision has an owner, and it is not the model.
  expect(body.toLowerCase()).toContain("never pick on their behalf");
});
