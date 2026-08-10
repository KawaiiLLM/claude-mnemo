import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runHookCommand } from "../../src/hooks/hook-command";
import {
  createUserPromptSubmitDispatcher,
  resolveHitSidecarPath,
  resolveTriggerIndexPath,
} from "../../src/rules/pretooluse-dispatcher";
import type { TriggerIndex } from "../../src/rules/schema";

const project = "/projects/mnemo";
const fixedNowMs = new Date(2026, 6, 21, 13, 0, 0).getTime();

function writeIndex(dataRoot: string, rules: TriggerIndex["rules"]): void {
  const path = resolveTriggerIndexPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rules }));
}

function withTempRoot(run: (dataRoot: string) => void | Promise<void>) {
  return async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "mnemo-prompt-result-"));
    try {
      await run(dataRoot);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  };
}

/**
 * UserPromptSubmit is the ONLY event mnemo dispatches from (裁决 22/23, ticket
 * 15). The PreToolUse/PostToolUse dispatchers that used to sit here unregistered
 * are gone, and with them the only consumers of the `tool` / `result` trigger
 * classes: mnemo emits no `additionalContext` from tool-adjacent events, because
 * Claude Code re-renders that context per request and destroys the message-side
 * cache breakpoint.
 */
async function invoke(
  dataRoot: string,
  rawInput: Record<string, unknown>,
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runHookCommand({
    env: {},
    argv: ["bun", "hook-command.ts", "prompt-dispatch"],
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
    readJsonFromStdin: () => ({
      event_name: "UserPromptSubmit",
      ...rawInput,
    }),
    handlers: {
      "UserPromptSubmit:rule-dispatch": createUserPromptSubmitDispatcher({
        dataRoot,
        nowMs: () => fixedNowMs,
      }),
    },
  });
  return { stdout, stderr, exitCode };
}

describe("UserPromptSubmit dispatcher", () => {
  test(
    "prompt keywords support default any and explicit all semantics",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 1,
          name: "prompt-any",
          claim: "先校准计量口径。",
          scope: "global",
          trigger: { kind: "prompt", keywords: ["成本异常", "billing"] },
        },
        {
          id: 2,
          name: "prompt-all",
          claim: "同时检查缓存身份。",
          scope: "global",
          trigger: {
            kind: "prompt",
            keywords: ["CACHE", "Identity"],
            match: "all",
          },
        },
      ]);

      const anyHit = await invoke(dataRoot, {
        session_id: "prompt-any-hit",
        cwd: project,
        prompt: "Please investigate the BILLING regression",
      });
      expect(JSON.parse(anyHit.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- 先校准计量口径。",
      );

      const anyMiss = await invoke(dataRoot, {
        session_id: "prompt-any-miss",
        cwd: project,
        prompt: "Investigate an unrelated latency regression",
      });
      expect(anyMiss).toEqual({ stdout: "", stderr: "", exitCode: 0 });

      const allMiss = await invoke(dataRoot, {
        session_id: "prompt-all-miss",
        cwd: project,
        prompt: "Check cache invalidation",
      });
      expect(allMiss).toEqual({ stdout: "", stderr: "", exitCode: 0 });

      const allHit = await invoke(dataRoot, {
        session_id: "prompt-all-hit",
        cwd: project,
        prompt: "Audit CACHE keys and identity mapping",
      });
      expect(JSON.parse(allHit.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- 同时检查缓存身份。",
      );
    }),
  );

  test(
    "prompt sidecar stores the first 200 characters and throttling is shared across events",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 4,
          name: "shared-rule",
          claim: "只推送一次。",
          scope: "global",
          trigger: { kind: "prompt", keywords: ["shared"] },
        },
      ]);
      const prompt = `shared-${"界".repeat(240)}`;
      const first = await invoke(dataRoot, {
        session_id: "shared-session",
        cwd: project,
        prompt,
      });
      expect(first.stdout).not.toBe("");
      const repeated = await invoke(dataRoot, {
        session_id: "shared-session",
        cwd: project,
        prompt,
      });
      expect(repeated.stdout).toBe("");

      const row = JSON.parse(
        readFileSync(resolveHitSidecarPath(dataRoot, fixedNowMs), "utf8").trim(),
      );
      expect(row).toMatchObject({
        event_type: "UserPromptSubmit",
        content_session_id: "shared-session",
        rule_id: 4,
      });
      expect(row.prompt_summary).toBe(Array.from(prompt).slice(0, 200).join(""));
      expect(Array.from(row.prompt_summary)).toHaveLength(200);
    }),
  );

  test("the plugin registers the prompt dispatcher and nothing tool-adjacent", () => {
    const raw = readFileSync("plugin/hooks/hooks.json", "utf8");
    const config = JSON.parse(raw) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command: string }> }>
      >;
    };
    expect(config.hooks.UserPromptSubmit[0]?.hooks.map((hook) => hook.command))
      .toContain(
        "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs prompt-dispatch",
      );
    // `result-dispatch` was the PostToolUse text channel; it is retired whole,
    // leaving the async capture entry as the only PostToolUse registration.
    expect(raw).not.toContain("result-dispatch");
    expect(config.hooks.PostToolUse[0]?.hooks).toHaveLength(1);
  });
});
