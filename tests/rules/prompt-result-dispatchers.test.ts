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
  createPostToolUseDispatcher,
  createPreToolUseDispatcher,
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

async function invoke(
  dataRoot: string,
  command: "pre-tool-dispatch" | "prompt-dispatch" | "result-dispatch",
  rawInput: Record<string, unknown>,
) {
  const dispatchers = {
    PreToolUse: createPreToolUseDispatcher({
      dataRoot,
      nowMs: () => fixedNowMs,
    }),
    "UserPromptSubmit:rule-dispatch": createUserPromptSubmitDispatcher({
      dataRoot,
      nowMs: () => fixedNowMs,
    }),
    "PostToolUse:rule-dispatch": createPostToolUseDispatcher({
      dataRoot,
      nowMs: () => fixedNowMs,
    }),
  };
  let stdout = "";
  let stderr = "";
  const exitCode = await runHookCommand({
    env: {},
    argv: ["bun", "hook-command.ts", command],
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
    readJsonFromStdin: () => rawInput,
    handlers: dispatchers,
  });
  return { stdout, stderr, exitCode };
}

describe("UserPromptSubmit and PostToolUse dispatchers", () => {
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

      const anyHit = await invoke(dataRoot, "prompt-dispatch", {
        session_id: "prompt-any-hit",
        cwd: project,
        prompt: "Please investigate the BILLING regression",
      });
      expect(JSON.parse(anyHit.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- 先校准计量口径。",
      );

      const anyMiss = await invoke(dataRoot, "prompt-dispatch", {
        session_id: "prompt-any-miss",
        cwd: project,
        prompt: "Investigate an unrelated latency regression",
      });
      expect(anyMiss).toEqual({ stdout: "", stderr: "", exitCode: 0 });

      const allMiss = await invoke(dataRoot, "prompt-dispatch", {
        session_id: "prompt-all-miss",
        cwd: project,
        prompt: "Check cache invalidation",
      });
      expect(allMiss).toEqual({ stdout: "", stderr: "", exitCode: 0 });

      const allHit = await invoke(dataRoot, "prompt-dispatch", {
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
    "result matching scans only the first 8KB and applies pattern OR semantics",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 3,
          name: "connection-result",
          claim: "先区分瞬时连接错误。",
          scope: "global",
          trigger: {
            kind: "result",
            tool: "Bash",
            patterns: ["ECONNRESET", "connection refused"],
          },
        },
      ]);

      const headHit = await invoke(dataRoot, "result-dispatch", {
        session_id: "result-head-hit",
        cwd: project,
        tool_name: "Bash",
        tool_input: { command: "curl service" },
        tool_response: `connection refused${"x".repeat(9_000)}`,
      });
      expect(JSON.parse(headHit.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- 先区分瞬时连接错误。",
      );

      const tailMiss = await invoke(dataRoot, "result-dispatch", {
        session_id: "result-tail-miss",
        cwd: project,
        tool_name: "Bash",
        tool_input: { command: "curl service" },
        tool_response: `${"x".repeat(8 * 1024)}ECONNRESET`,
      });
      expect(tailMiss).toEqual({ stdout: "", stderr: "", exitCode: 0 });

      const wrongTool = await invoke(dataRoot, "result-dispatch", {
        session_id: "result-wrong-tool",
        cwd: project,
        tool_name: "Read",
        tool_input: { file_path: "service.log" },
        tool_response: "ECONNRESET",
      });
      expect(wrongTool).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    }),
  );

  test(
    "stdin fixtures emit the correct hookEventName for all three events",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 1,
          name: "tool",
          claim: "tool tip",
          scope: "global",
          trigger: { kind: "tool", tool: "Bash" },
        },
        {
          id: 2,
          name: "prompt",
          claim: "prompt tip",
          scope: "global",
          trigger: { kind: "prompt", keywords: ["diagnose"] },
        },
        {
          id: 3,
          name: "result",
          claim: "result tip",
          scope: "global",
          trigger: { kind: "result", patterns: ["failed"] },
        },
      ]);
      const fixtures = [
        [
          "pre-tool-dispatch",
          "PreToolUse",
          {
            session_id: "event-pre",
            cwd: project,
            tool_name: "Bash",
            tool_input: { command: "bun test" },
          },
        ],
        [
          "prompt-dispatch",
          "UserPromptSubmit",
          {
            session_id: "event-prompt",
            cwd: project,
            prompt: "diagnose this",
          },
        ],
        [
          "result-dispatch",
          "PostToolUse",
          {
            session_id: "event-result",
            cwd: project,
            tool_name: "Bash",
            tool_input: { command: "bun test" },
            tool_response: "failed",
          },
        ],
      ] as const;

      for (const [command, eventName, rawInput] of fixtures) {
        const result = await invoke(dataRoot, command, rawInput);
        expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe(
          eventName,
        );
      }
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
      const first = await invoke(dataRoot, "prompt-dispatch", {
        session_id: "shared-session",
        cwd: project,
        prompt,
      });
      expect(first.stdout).not.toBe("");
      const repeated = await invoke(dataRoot, "prompt-dispatch", {
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

  test(
    "PostToolUse sidecar uses tool identity and the two-hit event cap",
    withTempRoot(async (dataRoot) => {
      writeIndex(
        dataRoot,
        [5, 6, 7].map((id) => ({
          id,
          name: `result-${id}`,
          claim: `result tip ${id}`,
          scope: "global",
          trigger: { kind: "result" as const, patterns: ["failure"] },
        })),
      );
      const result = await invoke(dataRoot, "result-dispatch", {
        session_id: "result-cap",
        cwd: project,
        tool_name: "Bash",
        tool_use_id: "tool-use-result",
        tool_input: { command: "bun test" },
        tool_response: "failure",
      });
      expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- result tip 5\n- result tip 6",
      );
      const rows = readFileSync(
        resolveHitSidecarPath(dataRoot, fixedNowMs),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        event_type: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tool-use-result",
        tool_input_summary: '{"command":"bun test"}',
      });
    }),
  );

  test(
    "full 10-rule fixture stays below 50ms p95 for all three events",
    withTempRoot(async (dataRoot) => {
      const eventFixtures = [
        {
          name: "PreToolUse",
          create: createPreToolUseDispatcher,
          trigger: { kind: "tool" as const, tool: "Bash" },
          input: {
            eventName: "PreToolUse" as const,
            cwd: project,
            toolName: "Bash",
            toolInput: { command: "bun test" },
          },
        },
        {
          name: "UserPromptSubmit",
          create: createUserPromptSubmitDispatcher,
          trigger: { kind: "prompt" as const, keywords: ["benchmark"] },
          input: {
            eventName: "UserPromptSubmit" as const,
            cwd: project,
            prompt: "benchmark prompt",
          },
        },
        {
          name: "PostToolUse",
          create: createPostToolUseDispatcher,
          trigger: { kind: "result" as const, patterns: ["benchmark"] },
          input: {
            eventName: "PostToolUse" as const,
            cwd: project,
            toolName: "Bash",
            toolInput: { command: "bun test" },
            toolResponse: "benchmark result",
          },
        },
      ];

      for (const fixture of eventFixtures) {
        writeIndex(
          dataRoot,
          Array.from({ length: 10 }, (_, offset) => ({
            id: offset + 1,
            name: `benchmark-${offset + 1}`,
            claim: `benchmark tip ${offset + 1}`,
            scope: "global",
            trigger: fixture.trigger,
          })),
        );
        const dispatcher = fixture.create({
          dataRoot,
          nowMs: () => fixedNowMs,
        });
        for (let index = 0; index < 5; index += 1) {
          await dispatcher({
            ...fixture.input,
            sessionId: `warmup-${fixture.name}-${index}`,
            stopHookActive: false,
            raw: {},
          });
        }
        const samples: number[] = [];
        for (let index = 0; index < 100; index += 1) {
          const started = performance.now();
          await dispatcher({
            ...fixture.input,
            sessionId: `sample-${fixture.name}-${index}`,
            stopHookActive: false,
            raw: {},
          });
          samples.push(performance.now() - started);
        }
        samples.sort((left, right) => left - right);
        const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
        console.log(`${fixture.name} dispatcher p95: ${p95.toFixed(3)}ms`);
        expect(p95).toBeLessThanOrEqual(50);
      }
    }),
  );

  test("plugin registers prompt and result dispatcher subcommands", () => {
    const config = JSON.parse(
      readFileSync("plugin/hooks/hooks.json", "utf8"),
    ) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command: string }> }>
      >;
    };
    expect(config.hooks.UserPromptSubmit[0]?.hooks.map((hook) => hook.command))
      .toContain(
        "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs prompt-dispatch",
      );
    expect(config.hooks.PostToolUse[0]?.hooks.map((hook) => hook.command))
      .toContain(
        "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs result-dispatch",
      );
  });
});
