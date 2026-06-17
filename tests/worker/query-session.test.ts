import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DATA_DIR, resolveTranscriptPath } from "../../src/shared/paths";
import { resolveClaudeCodeExecutablePath } from "../../src/worker/agent-session";
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
        mkdirSyncImpl: mock(() => undefined),
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
        spawnImpl:
          (mock(() => ({ pid: 4321 })) as unknown) as typeof import("node:child_process").spawn,
        mkdirSyncImpl: mock(() => undefined),
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
  });

  test("uses worker agent-session helpers from the worker module path", () => {
    expect(typeof resolveClaudeCodeExecutablePath).toBe("function");
  });

  test("creates DATA_DIR locally and uses it as the SDK cwd", () => {
    const mkdirSyncImpl = mock(() => undefined);
    let capturedOptions: { cwd?: string } | undefined;
    const queryImpl = mock((args: { options?: { cwd?: string } }) => {
      capturedOptions = args.options;
      // eslint-disable-next-line @typescript-eslint/require-await
      return (async function* () {
        return;
      })();
    });

    createWorkerQuerySession(
      {
        db,
        sessionDbId,
        contentSessionId: "content-session-1",
        project: "/tmp/project",
      },
      {
        queryImpl: queryImpl as never,
        mkdirSyncImpl,
      },
    );

    expect(mkdirSyncImpl).toHaveBeenCalledWith(DATA_DIR, { recursive: true });
    expect(capturedOptions?.cwd).toBe(DATA_DIR);
  });

  test("passes resume to query and pre-fills the first prompt session id when the transcript exists", async () => {
    const seenInputSessionIds: string[] = [];
    let capturedOptions:
      | {
          cwd?: string;
          resume?: string;
        }
      | undefined;
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
          cwd?: string;
          resume?: string;
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
          capturedOptions = options;
          for await (const message of prompt) {
            seenInputSessionIds.push(message.session_id);
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
              session_id: "resume-target",
            };
          }
        })(),
    );

    const session = createWorkerQuerySession(
      {
        db,
        sessionDbId,
        contentSessionId: "content-session-1",
        project: "/tmp/project",
        resumeAgentSessionId: "resume-target",
      },
      {
        queryImpl: queryImpl as never,
        existsSyncImpl: (path: string) =>
          path === resolveTranscriptPath(DATA_DIR, "resume-target"),
        mkdirSyncImpl: mock(() => undefined),
      },
    );

    await session.sendPrompt("first");

    expect(capturedOptions?.cwd).toBe(DATA_DIR);
    expect(capturedOptions?.resume).toBe("resume-target");
    expect(seenInputSessionIds).toEqual(["resume-target"]);

    await session.close();
  });

  test("omits resume and does not leak a stale resume id into the first prompt when the transcript is missing", async () => {
    const seenInputSessionIds: string[] = [];
    let capturedOptions:
      | {
          cwd?: string;
          resume?: string;
        }
      | undefined;
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
          cwd?: string;
          resume?: string;
        };
      }) =>
        (async function* () {
          capturedOptions = options;
          for await (const message of prompt) {
            seenInputSessionIds.push(message.session_id);
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
              session_id: "fresh-agent-session",
            };
          }
        })(),
    );

    const session = createWorkerQuerySession(
      {
        db,
        sessionDbId,
        contentSessionId: "content-session-1",
        project: "/tmp/project",
        resumeAgentSessionId: "stale-agent-session",
      },
      {
        queryImpl: queryImpl as never,
        existsSyncImpl: () => false,
        mkdirSyncImpl: mock(() => undefined),
      },
    );

    await session.sendPrompt("first");

    expect(capturedOptions?.cwd).toBe(DATA_DIR);
    expect(capturedOptions).not.toHaveProperty("resume");
    expect(seenInputSessionIds).toEqual(["content-session-1"]);

    await session.close();
  });

  test("defaults the system prompt to the hardened Mnemosyne rules", async () => {
    let capturedSystemPrompt: string | undefined;
    let capturedAllowedTools: string[] | undefined;
    const queryImpl = mock(
      (args: {
        options?: {
          systemPrompt?: string;
          allowedTools?: string[];
        };
      }) => {
        capturedSystemPrompt = args.options?.systemPrompt;
        capturedAllowedTools = args.options?.allowedTools;
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
        mkdirSyncImpl: mock(() => undefined),
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
    // D6: the standalone obs-extraction section is gone (obs are bundled into
    // turn mini-turns now); the session-summary field spec replaces it.
    expect(prompt).not.toContain("## Observation messages");
    expect(prompt).not.toContain("## Observation messages (<obs id=");
    expect(prompt).toContain("## Turn messages");
    expect(prompt).toContain("## Session summary fields");
    expect(prompt).toContain("## Streamed turns (mini-turns)");
    expect(prompt).toContain("## Reminder envelope");
    expect(prompt).toContain("## Forbidden across all messages");

    // Streaming exemption: slices may revisit the same record; non-sliced
    // turns still extract once.
    expect(prompt).toContain('slice="<n>"');
    expect(prompt).toContain('final="true"');
    expect(prompt).toContain("<prior_turn id=\"T<n>\">");
    expect(prompt).toContain("only case where updating the same record across multiple messages is allowed");
    // D3: corrective resend is the second exception to "never revisit".
    expect(prompt).toContain("Apart from a corrective resend");
    expect(prompt).toContain("delivery_dropped");

    // Turn-type enum — the single most load-bearing string; if this drifts,
    // `recall(query="type:bugfix")` silently stops matching new records.
    expect(prompt).toContain(
      "bugfix | feature | refactor | change | discovery | decision",
    );

    expect(capturedAllowedTools).toEqual([
      "mcp__mnemo__remember",
      "mcp__mnemo__recall",
    ]);

    // Tool scope rules — the memory-creation boundary must be present, and the
    // dead obs-extraction guidance must be gone (D6).
    expect(prompt).toContain("`remember()` — your only output");
    expect(prompt).toContain("`recall()` — the only read fallback");
    expect(prompt).toContain(
      "`recall()` is usually unnecessary — the inline data, the recent-turn index, and conversation history usually suffice. Only escalate when they genuinely do not.",
    );
    // Component 2: turn content may carry causal `[T<n>]` citations.
    expect(prompt).toContain("cite that driver inline as `[T<n>]`");
    expect(prompt).toContain("A tag names the turn's role in the session arc");
    expect(prompt).toContain("Correcting an earlier turn");
    expect(prompt).toContain('Use the literal tag `rolled-back`');
    expect(prompt).toContain('remember({ id: "T<n>", tags: ["rolled-back"] })');
    expect(prompt).toContain("promote it by supplying `title`, `content`, `type`, and `tags: [\"rolled-back\"]`");
    expect(prompt).not.toContain("from an obs message");
    expect(prompt).not.toContain(
      "Routine operations (repeated reads, navigation, failed retries, environment probes) can be silently ignored",
    );
    expect(prompt).not.toContain('remember({ id: "O<n>", status: "skipped" })');

    // Session-summary refresh contract (D1/D2): whole-rewrite, all seven fields.
    expect(prompt).toContain("rewritten WHOLE on every refresh");
    expect(prompt).toContain(
      'remember({ id: "S<n>", title, content, decision, done, current, next_steps, reference })',
    );
    expect(prompt).toContain(
      "Always call `remember()` with an `id`",
    );
    expect(prompt).toContain(
      "Never call `recall()` from a session-summary message",
    );
    expect(prompt).toContain(
      "Turn messages are the ONLY context where `recall()` is permitted as a fallback",
    );
    expect(prompt).toContain(
      "Messages may be prefixed with a `<reminder>` block listing recently invalidated turns that need one-time attention",
    );
    expect(prompt).toContain(
      '**Present**: process normally, but treat the turn as invalidated',
    );
    expect(prompt).toContain(
      '`- T<n> (<flags>[, replaced by T<m>])[: "<priorTitle>" -- <priorContent>]' ,
    );
    expect(prompt).toContain(
      "Each invalidation kind is notified at most once",
    );
    expect(prompt).toContain(
      "Do NOT invent a replacement turn number not present in the envelope.",
    );
    expect(prompt).toContain('invalidated="interrupt"');
    expect(prompt).not.toContain("status='active'");
    expect(prompt).not.toContain("Envelope lines persist until you call `remember()`");
    expect(prompt).toContain("<subagent_invalidated>");
    expect(prompt).not.toContain('invalidated="<kinds>"');
    expect(prompt).not.toContain("<invalidated>");
    expect(prompt).toContain("recall({ id: \"T<n>\", depth: \"expanded\", truncate: 2000 })");
    expect(prompt).not.toContain("replay(");
    expect(prompt).not.toContain("replay()");

    // D3: corrective resend clause — agent re-extracts when reminded
    expect(prompt).toContain("did not extract");
    expect(prompt).toContain("re-extract");

    // D1: slice rule changed — mandate remember per slice, no "leave alone"
    expect(prompt).not.toContain("leave alone");
    expect(prompt).toContain("EVERY slice");

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
        mkdirSyncImpl: mock(() => undefined),
        isProcessAliveImpl: () => false,
      },
    );

    expect(capturedSystemPrompt).toBe("CUSTOM TEST PROMPT");
    // Sanity: none of the default markers should leak through when overridden.
    expect(capturedSystemPrompt).not.toContain("long-lived memory worker");
    expect(capturedSystemPrompt).not.toContain("## Tools");

    await session.close();
  });

  test("passes tools:[] to disable built-in tools while keeping the mnemo MCP server", () => {
    let capturedTools: unknown = "NOT_SET";
    let capturedMcpServers: unknown = "NOT_SET";
    const queryImpl = mock(
      (args: {
        options?: {
          tools?: unknown;
          mcpServers?: unknown;
        };
      }) => {
        capturedTools = args.options?.tools;
        capturedMcpServers = args.options?.mcpServers;
        // eslint-disable-next-line @typescript-eslint/require-await
        return (async function* () {
          return;
        })();
      },
    );

    createWorkerQuerySession(
      {
        db,
        sessionDbId,
        contentSessionId: "content-session-1",
        project: "/tmp/project",
      },
      {
        queryImpl: queryImpl as never,
        mkdirSyncImpl: mock(() => undefined),
      },
    );

    // D0: tools:[] removes all built-in tools from the model's context
    expect(capturedTools).toEqual([]);
    // The mnemo MCP server must still be present (arrives via mcpServers, not tools)
    expect((capturedMcpServers as Record<string, unknown>)?.mnemo).toBeDefined();
  });

  test("compact pushes /compact and resolves on compact_boundary", async () => {
    const seenMessages: string[] = [];
    const queryImpl = mock(
      ({
        prompt,
      }: {
        prompt: AsyncIterable<{
          session_id: string;
          message: { content: Array<{ text: string }> };
        }>;
      }) =>
        (async function* () {
          for await (const message of prompt) {
            seenMessages.push(message.message.content[0]?.text ?? "");
            if (message.message.content[0]?.text === "/compact") {
              yield {
                type: "system",
                subtype: "compact_boundary",
                session_id: "agent-session-compact",
                uuid: "compact-boundary-1",
              };
              continue;
            }

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
              session_id: "agent-session-compact",
            };
          }
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
        mkdirSyncImpl: mock(() => undefined),
      },
    );

    await session.sendPrompt("first");
    await session.compact();

    expect(seenMessages).toEqual(["first", "/compact"]);

    await session.close();
  });

  test("an explicit compact()'s own boundary does NOT fire onCompactBoundary", async () => {
    const onCompactBoundary = mock(() => {});
    const queryImpl = mock(
      ({
        prompt,
      }: {
        prompt: AsyncIterable<{
          session_id: string;
          message: { content: Array<{ text: string }> };
        }>;
      }) =>
        (async function* () {
          for await (const message of prompt) {
            if (message.message.content[0]?.text === "/compact") {
              yield {
                type: "system",
                subtype: "compact_boundary",
                session_id: "agent-session-compact",
                uuid: "compact-boundary-explicit",
              };
              continue;
            }

            yield {
              type: "result",
              subtype: "success",
              duration_ms: 1,
              duration_api_ms: 1,
              is_error: false,
              num_turns: 1,
              result: "",
              usage: {},
              modelUsage: {},
              permission_denials: [],
              uuid: "result-explicit",
              session_id: "agent-session-compact",
            };
          }
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
        mkdirSyncImpl: mock(() => undefined),
        onCompactBoundary,
      },
    );

    await session.sendPrompt("first");
    await session.compact();

    // The explicit compact() awaits its own boundary (pendingCompact !== null at
    // the time the boundary arrives), so the unsolicited-only callback never
    // fires — no double re-prime.
    expect(onCompactBoundary).not.toHaveBeenCalled();

    await session.close();
  });

  test("an unsolicited (SDK-auto) compact_boundary fires onCompactBoundary", async () => {
    const onCompactBoundary = mock(() => {});
    const queryImpl = mock(
      ({
        prompt,
      }: {
        prompt: AsyncIterable<{
          session_id: string;
          message: { content: Array<{ text: string }> };
        }>;
      }) =>
        (async function* () {
          for await (const message of prompt) {
            // The SDK injects an auto-compact boundary BEFORE the result for a
            // normal prompt — no explicit compact() is awaiting it.
            yield {
              type: "system",
              subtype: "compact_boundary",
              session_id: "agent-session-auto",
              uuid: "compact-boundary-auto",
            };
            yield {
              type: "result",
              subtype: "success",
              duration_ms: 1,
              duration_api_ms: 1,
              is_error: false,
              num_turns: 1,
              result: "",
              usage: {},
              modelUsage: {},
              permission_denials: [],
              uuid: "result-auto",
              session_id: "agent-session-auto",
            };
          }
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
        mkdirSyncImpl: mock(() => undefined),
        onCompactBoundary,
      },
    );

    await session.sendPrompt("hello");

    expect(onCompactBoundary).toHaveBeenCalledTimes(1);

    await session.close();
  });
});
