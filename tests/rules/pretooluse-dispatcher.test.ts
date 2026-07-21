import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runHookCommand } from "../../src/hooks/hook-command";
import {
  createPreToolUseDispatcher,
  resolveHitSidecarPath,
  resolveSessionStateDirectory,
  resolveTriggerIndexPath,
} from "../../src/rules/pretooluse-dispatcher";
import type { TriggerIndex } from "../../src/rules/schema";

const project = "/projects/mnemo";
const fixedNowMs = new Date(2026, 6, 21, 12, 34, 56).getTime();

function writeIndex(dataRoot: string, rules: TriggerIndex["rules"]): void {
  const path = resolveTriggerIndexPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rules }));
}

function fixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: "session-03",
    cwd: project,
    tool_name: "Bash",
    tool_input: { command: "bun test" },
    tool_use_id: "tool-use-03",
    ...overrides,
  };
}

async function invoke(
  dataRoot: string,
  rawInput: Record<string, unknown>,
  nowMs = fixedNowMs,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const dispatcher = createPreToolUseDispatcher({ dataRoot, nowMs: () => nowMs });
  const exitCode = await runHookCommand({
    env: {},
    argv: ["bun", "hook-command.ts", "pre-tool-dispatch"],
    stdout: { write: (chunk) => ((stdout += chunk), true) },
    stderr: { write: (chunk) => ((stderr += chunk), true) },
    readJsonFromStdin: () => rawInput,
    handlers: { PreToolUse: dispatcher },
  });
  return { stdout, stderr, exitCode };
}

function withTempRoot(run: (dataRoot: string) => void | Promise<void>) {
  return async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "mnemo-pretooluse-"));
    try {
      await run(dataRoot);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  };
}

describe("PreToolUse dispatcher", () => {
  test(
    "stdin fixture injects matching claims and a non-match is silent without side effects",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 1,
          name: "bash-timeout",
          claim: "Bash 未设置 timeout 时先补上 timeout。",
          scope: "global",
          trigger: { kind: "tool", tool: "Bash", param_absent: "timeout" },
        },
      ]);

      const missRoot = mkdtempSync(join(tmpdir(), "mnemo-pretooluse-miss-"));
      try {
        writeIndex(missRoot, [
          {
            id: 1,
            name: "read-only",
            claim: "读取前确认路径。",
            scope: "global",
            trigger: { kind: "tool", tool: "Read" },
          },
        ]);
        const miss = await invoke(missRoot, fixture());
        expect(miss).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
        expect(existsSync(resolveSessionStateDirectory(missRoot))).toBeFalse();
        expect(existsSync(resolveHitSidecarPath(missRoot, fixedNowMs))).toBeFalse();
      } finally {
        rmSync(missRoot, { recursive: true, force: true });
      }

      const hit = await invoke(dataRoot, fixture());
      expect(JSON.parse(hit.stdout)).toEqual({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            "## Mnemo Tips\n- Bash 未设置 timeout 时先补上 timeout。",
        },
      });
      expect(hit.stderr).toBe("");
      expect(hit.exitCode).toBe(0);
    }),
  );

  test(
    "deduplicates each rule per session and caps one event at two hits",
    withTempRoot(async (dataRoot) => {
      writeIndex(
        dataRoot,
        [1, 2, 3].map((id) => ({
          id,
          name: `bash-rule-${id}`,
          claim: `提示 ${id}`,
          scope: "global",
          trigger: { kind: "tool" as const, tool: "Bash" },
        })),
      );

      const first = await invoke(dataRoot, fixture());
      expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- 提示 1\n- 提示 2",
      );

      const second = await invoke(dataRoot, fixture());
      expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- 提示 3",
      );

      const third = await invoke(dataRoot, fixture());
      expect(third.stdout).toBe("");
      const lines = readFileSync(
        resolveHitSidecarPath(dataRoot, fixedNowMs),
        "utf8",
      )
        .trim()
        .split("\n");
      expect(lines).toHaveLength(3);
    }),
  );

  test(
    "coordinates concurrent hook processes through the session state file",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 1,
          name: "concurrent-rule",
          claim: "并发时只注入一次。",
          scope: "global",
          trigger: { kind: "tool", tool: "Bash" },
        },
      ]);
      const childCode = `
        import { createPreToolUseDispatcher } from "./src/rules/pretooluse-dispatcher.ts";
        const handler = createPreToolUseDispatcher({ dataRoot: process.argv[1] });
        const result = await handler({
          eventName: "PreToolUse",
          sessionId: "concurrent-session",
          cwd: "/projects/mnemo",
          toolName: "Bash",
          toolInput: { command: "bun test" },
          stopHookActive: false,
          raw: {},
        });
        process.stdout.write(JSON.stringify(result));
      `;
      const children = [0, 1].map(() =>
        Bun.spawn([process.execPath, "-e", childCode, dataRoot], {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const results = await Promise.all(
        children.map(async (child) => {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { result: JSON.parse(stdout), stderr, exitCode };
        }),
      );

      expect(results.every(({ exitCode, stderr }) => exitCode === 0 && stderr === ""))
        .toBeTrue();
      expect(
        results.filter(({ result }) => result.hookSpecificOutput !== undefined),
      ).toHaveLength(1);
      expect(
        readFileSync(
          join(
            dataRoot,
            "rules",
            readdirSync(join(dataRoot, "rules")).find((name) =>
              /^hits-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name),
            )!,
          ),
          "utf8",
        )
          .trim()
          .split("\n"),
      ).toHaveLength(1);
    }),
  );

  test(
    "writes append-only daily sidecar rows with UUID and tool identity summary",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 7,
          name: "bash-rule",
          claim: "检查长命令。",
          scope: "global",
          trigger: { kind: "tool", tool: "Bash" },
        },
      ]);
      const longInput = { command: `echo ${"界".repeat(240)}` };

      await invoke(dataRoot, fixture({ tool_input: longInput }));

      const rows = readFileSync(
        resolveHitSidecarPath(dataRoot, fixedNowMs),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        content_session_id: "session-03",
        event_type: "PreToolUse",
        ts_ms: fixedNowMs,
        rule_id: 7,
        tool_name: "Bash",
        tool_use_id: "tool-use-03",
      });
      expect(rows[0].hit_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(Array.from(rows[0].tool_input_summary)).toHaveLength(200);
    }),
  );

  test(
    "rolls back session dedupe state when the sidecar append fails",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 9,
          name: "retry-after-sidecar-error",
          claim: "sidecar 恢复后仍应注入。",
          scope: "global",
          trigger: { kind: "tool", tool: "Bash" },
        },
      ]);
      const sidecarPath = resolveHitSidecarPath(dataRoot, fixedNowMs);
      mkdirSync(sidecarPath, { recursive: true });

      const failed = await invoke(dataRoot, fixture());
      expect(failed.stdout).toBe("");
      expect(failed.stderr).not.toBe("");

      rmSync(sidecarPath, { recursive: true, force: true });
      const retried = await invoke(dataRoot, fixture());
      expect(JSON.parse(retried.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- sidecar 恢复后仍应注入。",
      );
      expect(readFileSync(sidecarPath, "utf8").trim().split("\n")).toHaveLength(
        1,
      );
    }),
  );

  test(
    "filters scope and matches the tool trigger language",
    withTempRoot(async (dataRoot) => {
      writeIndex(dataRoot, [
        {
          id: 1,
          name: "other-project",
          claim: "不应出现。",
          scope: "/projects/other",
          trigger: { kind: "tool", tool: "Bash" },
        },
        {
          id: 2,
          name: "project-command",
          claim: "项目命令命中。",
          scope: `${project}/./`,
          trigger: {
            kind: "tool",
            tool: "Bash",
            require_param: "command",
            param_absent: "timeout",
            command_prefix: ["bun", "test"],
          },
        },
        {
          id: 3,
          name: "project-path",
          claim: "项目路径命中。",
          scope: project,
          trigger: {
            kind: "tool",
            tool: "Write",
            path_glob: "src/**/*.ts",
          },
        },
      ]);

      const bash = await invoke(dataRoot, fixture());
      expect(JSON.parse(bash.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- 项目命令命中。",
      );
      const write = await invoke(
        dataRoot,
        fixture({
          session_id: "session-path",
          tool_name: "Write",
          tool_input: { file_path: "src/rules/new-rule.ts" },
        }),
      );
      expect(JSON.parse(write.stdout).hookSpecificOutput.additionalContext).toBe(
        "## Mnemo Tips\n- 项目路径命中。",
      );
      const directWrite = await invoke(
        dataRoot,
        fixture({
          session_id: "session-direct-path",
          tool_name: "Write",
          tool_input: { file_path: "src/direct.ts" },
        }),
      );
      expect(
        JSON.parse(directWrite.stdout).hookSpecificOutput.additionalContext,
      ).toBe("## Mnemo Tips\n- 项目路径命中。");
    }),
  );

  test(
    "full 10-rule fixture stays below 50ms p95 after warmup across 100 samples",
    withTempRoot(async (dataRoot) => {
      writeIndex(
        dataRoot,
        Array.from({ length: 10 }, (_, offset) => ({
          id: offset + 1,
          name: `benchmark-${offset + 1}`,
          claim: `基准提示 ${offset + 1}`,
          scope: "global",
          trigger: { kind: "tool" as const, tool: "Bash" },
        })),
      );
      const dispatcher = createPreToolUseDispatcher({
        dataRoot,
        nowMs: () => fixedNowMs,
      });
      const inputBase = {
        eventName: "PreToolUse" as const,
        cwd: project,
        toolName: "Bash",
        toolInput: { command: "bun test" },
        stopHookActive: false,
        raw: { tool_use_id: "benchmark-tool-use" },
      };

      for (let index = 0; index < 5; index += 1) {
        await dispatcher({ ...inputBase, sessionId: `warmup-${index}` });
      }
      const samples: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        const started = performance.now();
        await dispatcher({ ...inputBase, sessionId: `sample-${index}` });
        samples.push(performance.now() - started);
      }
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
      console.log(`PreToolUse dispatcher p95: ${p95.toFixed(3)}ms`);
      expect(p95).toBeLessThanOrEqual(50);
    }),
  );

  test("plugin registers the PreToolUse subcommand", () => {
    const config = JSON.parse(
      readFileSync("plugin/hooks/hooks.json", "utf8"),
    ) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>> };
    expect(config.hooks.PreToolUse).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command:
              "node ${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js ${CLAUDE_PLUGIN_ROOT}/scripts/hook-command.cjs pre-tool-dispatch",
            timeout: 5,
          },
        ],
      },
    ]);
  });
});
