import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import {
  moveAgentSession,
  resolveClaudeCodeExecutablePath,
} from "../../src/worker/agent-session";
import { createWorkerQuerySession } from "../../src/worker/query-session";

describe("worker query session", () => {
  let db: Database;
  let sessionDbId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionDbId = upsertSession(db, {
      contentSessionId: "content-session-1",
      project: "/tmp/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 1,
      updatedAtEpoch: 1,
      completedAtEpoch: null,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  test("sendPrompt uses the content session id until the agent session is known", async () => {
    const seenInputSessionIds: string[] = [];
    const queryImpl = mock(
      ({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<{
          session_id: string;
          message: { content: Array<{ text: string }> };
        }>;
        options?: {
          spawnClaudeCodeProcess?: (options: {
            command: string;
            args: string[];
            cwd?: string;
            env?: Record<string, string | undefined>;
            signal?: AbortSignal;
          }) => { pid?: number };
        };
      }) =>
        (async function* () {
          options?.spawnClaudeCodeProcess?.({
            command: "claude",
            args: [],
            cwd: "/tmp/project",
            env: {},
            signal: undefined,
          });

          let turn = 0;
          for await (const message of prompt) {
            turn += 1;
            seenInputSessionIds.push(message.session_id);
            yield {
              type: "result",
              subtype: "success",
              duration_ms: 10,
              duration_api_ms: 10,
              is_error: false,
              num_turns: turn,
              result: "",
              total_cost_usd: 0,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                server_tool_use: {
                  web_search_requests: 0,
                },
                service_tier: "standard",
              },
              modelUsage: {},
              permission_denials: [],
              uuid: `result-${turn}`,
              session_id: `agent-session-${turn}`,
            };
          }
        })(),
    );

    const onPid = mock(() => {});
    const session = createWorkerQuerySession(
      {
        db,
        sessionDbId,
        contentSessionId: "content-session-1",
        project: "/tmp/project",
      },
      {
        queryImpl: queryImpl as never,
        onPid,
        spawnImpl:
          (mock(() => ({ pid: 4321 })) as unknown) as typeof import("node:child_process").spawn,
      },
    );

    const first = await session.sendPrompt("first");
    const second = await session.sendPrompt("second");

    expect(first.session_id).toBe("agent-session-1");
    expect(second.session_id).toBe("agent-session-2");
    expect(seenInputSessionIds).toEqual(["content-session-1", "agent-session-1"]);
    expect(session.queryPid).toBe(4321);
    expect(onPid).toHaveBeenCalledWith(4321);

    await session.close();
  });

  test("close is idempotent and rejects prompts after shutdown", async () => {
    const movedSessions: Array<{ project: string; sessionId: string }> = [];
    let closeSignalCount = 0;
    const queryImpl = mock(
      ({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<{
          session_id: string;
          message: { content: Array<{ text: string }> };
        }>;
        options?: {
          spawnClaudeCodeProcess?: (options: {
            command: string;
            args: string[];
            cwd?: string;
            env?: Record<string, string | undefined>;
            signal?: AbortSignal;
          }) => { pid?: number };
        };
      }) =>
        (async function* () {
          options?.spawnClaudeCodeProcess?.({
            command: "claude",
            args: [],
            cwd: "/tmp/project",
            env: {},
            signal: undefined,
          });

          for await (const _message of prompt) {
            yield {
              type: "result",
              subtype: "success",
              duration_ms: 10,
              duration_api_ms: 10,
              is_error: false,
              num_turns: 1,
              result: "",
              total_cost_usd: 0,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                server_tool_use: {
                  web_search_requests: 0,
                },
                service_tier: "standard",
              },
              modelUsage: {},
              permission_denials: [],
              uuid: "result-1",
              session_id: "agent-session-1",
            };
          }
          closeSignalCount += 1;
        })(),
    );

    const session = createWorkerQuerySession(
      {
        db,
        sessionDbId,
        contentSessionId: "content-session-1",
        project: "/tmp/project",
      },
      {
        queryImpl: queryImpl as never,
        moveAgentSessionImpl: async (project: string, sessionId: string) => {
          movedSessions.push({ project, sessionId });
        },
        spawnImpl:
          (mock(() => ({ pid: 4321 })) as unknown) as typeof import("node:child_process").spawn,
        isProcessAliveImpl: () => false,
      },
    );

    await session.sendPrompt("first");
    await session.close();
    await session.close();

    await expect(session.sendPrompt("after-close")).rejects.toThrow(
      "Worker query session is closed.",
    );
    expect(closeSignalCount).toBe(1);
    expect(movedSessions).toEqual([
      { project: "/tmp/project", sessionId: "agent-session-1" },
    ]);
  });

  test("uses worker agent-session helpers from the worker module path", () => {
    expect(typeof moveAgentSession).toBe("function");
    expect(typeof resolveClaudeCodeExecutablePath).toBe("function");
  });

  test("defaults the system prompt to the hardened Mnemosyne rules", async () => {
    let capturedSystemPrompt: string | undefined;
    const queryImpl = mock(
      (args: { options?: { systemPrompt?: string } }) => {
        capturedSystemPrompt = args.options?.systemPrompt;
        // eslint-disable-next-line @typescript-eslint/require-await
        return (async function* () {
          return;
        })();
      },
    );

    const session = createWorkerQuerySession(
      {
        db,
        sessionDbId,
        contentSessionId: "content-session-1",
        project: "/tmp/project",
      },
      {
        queryImpl: queryImpl as never,
        spawnImpl:
          (mock(() => ({ pid: 1 })) as unknown) as typeof import("node:child_process").spawn,
        isProcessAliveImpl: () => false,
      },
    );

    expect(capturedSystemPrompt).toBeDefined();
    const prompt = capturedSystemPrompt ?? "";

    // Identity and lifetime anchors
    expect(prompt).toContain("long-lived memory worker");
    expect(prompt).toContain("Never revisit records from earlier messages");

    // Section structure — if someone regresses the prompt back to a one-liner,
    // these markers all disappear.
    expect(prompt).toContain("## Tools");
    expect(prompt).toContain("## Observation messages");
    expect(prompt).toContain("## Turn messages");
    expect(prompt).toContain("## Forbidden across all messages");

    // Turn-type enum — the single most load-bearing string; if this drifts,
    // `recall(query="type:bugfix")` silently stops matching new records.
    expect(prompt).toContain(
      "bugfix | feature | refactor | change | discovery | decision",
    );

    // Tool scope rules — obs path must explicitly forbid recall/replay, and
    // the memory-creation boundary must be present.
    expect(prompt).toContain(
      "Never update T/S records, create memories, or call",
    );
    expect(prompt).toContain(
      "Never call `remember()` without an `id` field",
    );

    await session.close();
  });

  test("respects a custom systemPrompt override instead of the default", async () => {
    let capturedSystemPrompt: string | undefined;
    const queryImpl = mock(
      (args: { options?: { systemPrompt?: string } }) => {
        capturedSystemPrompt = args.options?.systemPrompt;
        // eslint-disable-next-line @typescript-eslint/require-await
        return (async function* () {
          return;
        })();
      },
    );

    const session = createWorkerQuerySession(
      {
        db,
        sessionDbId,
        contentSessionId: "content-session-1",
        project: "/tmp/project",
        systemPrompt: "CUSTOM TEST PROMPT",
      },
      {
        queryImpl: queryImpl as never,
        spawnImpl:
          (mock(() => ({ pid: 1 })) as unknown) as typeof import("node:child_process").spawn,
        isProcessAliveImpl: () => false,
      },
    );

    expect(capturedSystemPrompt).toBe("CUSTOM TEST PROMPT");
    // Sanity: none of the default markers should leak through when overridden.
    expect(capturedSystemPrompt).not.toContain("long-lived memory worker");
    expect(capturedSystemPrompt).not.toContain("## Tools");

    await session.close();
  });
});
