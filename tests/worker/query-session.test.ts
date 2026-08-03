import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { DATA_DIR, resolveTranscriptPath } from "../../src/shared/paths";
import { resolveClaudeCodeExecutablePath } from "../../src/worker/agent-session";
import {
  classifyWorkerError,
  createWorkerAbortError,
} from "../../src/worker/error-classifier";
import {
  createWorkerQuerySession,
  isExtractionAgentActivity,
} from "../../src/worker/query-session";

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
    let queryModel: string | undefined;
    let queryOptionsEnv: Record<string, string | undefined> | undefined;
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
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
          model?: string;
          env?: Record<string, string | undefined>;
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
          queryModel = options?.model;
          queryOptionsEnv = options?.env;
          options?.spawnClaudeCodeProcess?.({
            command: "claude",
            args: [],
            cwd: "/tmp/project",
            env: options.env,
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
        agentEnv: {
          HOME: "/Users/session-a",
          ANTHROPIC_AUTH_TOKEN: "session-a-token",
          CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        },
      },
      {
        queryImpl: queryImpl as never,
        onPid,
        spawnImpl:
          (mock((_command, _args, options) => {
            spawnedEnv = options?.env;
            return { pid: 4321 };
          }) as unknown) as typeof import("node:child_process").spawn,
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
    expect(queryModel).toBe("sonnet");
    expect(queryOptionsEnv).toEqual({
      HOME: "/Users/session-a",
      ANTHROPIC_AUTH_TOKEN: "session-a-token",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      ENABLE_TOOL_SEARCH: "false",
    });
    expect(spawnedEnv).toEqual(queryOptionsEnv);

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

  test("a marked watchdog close rejects the in-flight prompt as a connection error", async () => {
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const queryImpl = mock(
      ({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<unknown>;
        options?: { abortController?: AbortController };
      }) =>
        (async function* () {
          for await (const _message of prompt) {
            promptStarted();
            await new Promise<void>((resolve) => {
              options?.abortController?.signal.addEventListener(
                "abort",
                () => resolve(),
                { once: true },
              );
            });
            return;
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
        isProcessAliveImpl: () => false,
      },
    );

    const pendingPrompt = session.sendPrompt("will stall");
    await started;
    await session.close(createWorkerAbortError("stall-watchdog"));

    const classification = await pendingPrompt.catch((error) =>
      classifyWorkerError(error),
    );
    expect(classification).toBe("connection");
  });

  test("a SessionEnd shutdown abort kills the in-flight query child", async () => {
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const killImpl = mock(() => true);
    const queryImpl = mock(
      ({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<unknown>;
        options?: {
          abortController?: AbortController;
          spawnClaudeCodeProcess?: (options: {
            command: string;
            args: string[];
          }) => { pid?: number };
        };
      }) =>
        (async function* () {
          options?.spawnClaudeCodeProcess?.({ command: "claude", args: [] });
          for await (const _message of prompt) {
            promptStarted();
            await new Promise<void>((resolve) => {
              options?.abortController?.signal.addEventListener(
                "abort",
                () => resolve(),
                { once: true },
              );
            });
            return;
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
        spawnImpl:
          (mock(() => ({ pid: 4321 })) as unknown) as typeof import("node:child_process").spawn,
        mkdirSyncImpl: mock(() => undefined),
        killImpl: killImpl as typeof process.kill,
        isProcessAliveImpl: () => true,
      },
    );

    const pendingPrompt = session.sendPrompt("will be interrupted");
    await started;
    await session.close(createWorkerAbortError("shutdown"));

    expect(await pendingPrompt.catch(classifyWorkerError)).toBe("connection");
    expect(killImpl).toHaveBeenCalledWith(4321, "SIGKILL");
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
    expect(prompt).toContain("tool errors");
    expect(prompt).toContain("repeated trial-and-error");
    expect(prompt).toContain("repeated operations");
    expect(prompt).toContain("environment facts");
    expect(prompt).toContain("self-corrected successfully");
    expect(prompt).toContain("grade: REQUIRED integer 0-4");
    expect(prompt).toContain("Grade 4 — task origin or re-foundation");
    expect(prompt).toContain("scope of the ask");
    expect(prompt).toContain("50+ turns");
    expect(prompt).toContain("deletion test");
    expect(prompt).toContain(
      "would the task's design, evaluation method, principles of action, or established conclusions change",
    );
    expect(prompt).toContain("unblock execution");
    expect(prompt).toContain("cap at Grade 2");
    expect(prompt).toContain(
      "complete answer to a knowledge-question task is a delivery",
    );
    expect(prompt).toContain("judged by outcome, not action type");
    expect(prompt).toContain(
      '"no later decision consumed it" is never sufficient by itself',
    );
    expect(prompt).toContain("bridge Grade 4");
    expect(prompt).toContain("must cite the Grade 4 it re-founds");
    expect(prompt).toContain(
      "Grade 3 that resumes an earlier arc must cite that arc's Grade 4",
    );
    expect(prompt).toContain("extraction-failure diagnosis");
    expect(prompt).toContain("probe design and SFT-pilot design");
    expect(prompt).toContain("probe result determining the SFT go decision");
    expect(prompt).toContain("driver root-cause chain");
    expect(prompt).toContain("probe launch confirmations");
    expect(prompt).toContain('"still healthy" polls');
    expect(prompt).not.toContain("before this turn the next action was");
    expect(prompt).not.toContain("better flag bearer");
    expect(prompt).not.toContain("T925");
    expect(prompt).not.toContain("T909");
    expect(prompt).not.toContain("T908");
    expect(prompt).not.toContain("T850");
    expect(prompt).not.toContain("G4 <2%");
    expect(prompt).toContain("Misleading-turn downgrade");
    expect(prompt).toContain("only with witnessed disproof or rollback evidence");
    expect(prompt).toContain("Grade-4 re-foundation");
    expect(prompt).toContain('regrade: { id: "T<n>", grade: 0|1|2|3|4 }');

    // Rubric repair pack (spec §E). Each pin is one rule; if a rule is dropped
    // the grades drift back to the audited failure mode it was written against.
    // (1) Chain rule — only the landing turn of a diagnose→decide→formalize
    // chain is Grade 3.
    expect(prompt).toContain("only the turn that LANDS the change is Grade 3");
    expect(prompt).toContain("named the diagnosis are Grade 2");
    // (4) Counter-examples: shipping and dispatching are not Grade 3.
    expect(prompt).toContain("a release or a commit is Grade 2");
    expect(prompt).toContain("dispatching a worker or starting a run is Grade 1");
    // (2) Arc-scoped Grade-4 origin duty, provisional until settlement.
    expect(prompt).toContain("Origin duty, arc-scoped");
    expect(prompt).toContain("delimited by the re-prime skeleton");
    expect(prompt).toContain("even when it called no tools and touched no files");
    expect(prompt).toContain("This grading is PROVISIONAL");
    expect(prompt).toContain(
      "Never withhold the Grade 4 now for fear of that demotion",
    );
    // (3) Worked example, generalized.
    expect(prompt).toContain("Worked example, generalized shape of a design arc");
    expect(prompt).toContain("the opening ask that framed the problem = Grade 4");
    expect(prompt).toContain(
      "the spec finalized and the core mechanism locked = Grade 3",
    );
    expect(prompt).toContain("a repeated attempt and an inconclusive poll = Grade 0");
    expect(prompt).toContain("the release or commit itself = Grade 2");
    // (4) Positive example: the DISCOVERY of an eval-validity defect is Grade 3.
    expect(prompt).toContain("Grade 3 at its DISCOVERY");
    // (6) Final over draft.
    expect(prompt).toContain("Final over draft");
    expect(prompt).toContain("the grade lands on the FINAL resubmission's turn");
    // (5) Skip discipline: not a tool-count decision, a complete knowledge
    // answer is NOT skippable, and skipped rows still carry a title so a
    // citation can revive them as a ↳ row.
    expect(prompt).toContain(
      '`remember({ id: "T<n>", status: "skipped", grade: 0, title })`',
    );
    expect(prompt).toContain("Never decide this from the tool-call count alone");
    expect(prompt).toContain("complete knowledge-answer delivery");
    expect(prompt).toContain("that founds an arc, settles a direction");
    expect(prompt).toContain("is NOT skippable");
    expect(prompt).toContain(
      "Every skipped turn STILL gets a one-line minimal title",
    );
    // (7) title = conclusion, content = process/evidence, no restatement.
    expect(prompt).toContain("title: the turn's CONCLUSION in ~10 tokens");
    expect(prompt).toContain(
      "content: the process and the evidence behind that conclusion",
    );
    expect(prompt).toContain(
      "MUST NOT restate the title's conclusion sentence",
    );
    expect(prompt).not.toContain("5-15 words summarizing the turn's outcome");
    expect(prompt).not.toContain("100-300 chars, what happened and why");
    // (8) Structured cites: shape, replace-set, and the two mandatory relations.
    expect(prompt).toContain(
      '`remember({ id: "T<n>", title, content, insight, type, tags, grade, cites })`',
    );
    expect(prompt).toContain(
      'relation: "builds-on" | "implements" | "supersedes" | "evidence-for"',
    );
    expect(prompt).toContain('"this turn genuinely consumes nothing"');
    expect(prompt).toContain(
      "MUST cite the victim with `supersedes`",
    );
    expect(prompt).toContain(
      "MUST cite that decision with `implements`",
    );
    expect(prompt).toContain(
      "Citing the IMMEDIATELY preceding turn is explicitly encouraged",
    );
    expect(prompt).toContain("`cites` is the machine source");
    // Replace-set survives the streamed-slice merge rules.
    expect(prompt).toContain(
      "`cites` is the exception to field-level merge: it is a replace-set",
    );
    // (9) Rev-4 reconciliation clause: a discovery is Grade 2 unless it
    // invalidates the arc's own conclusions (the eval-validity exception).
    expect(prompt).toContain(
      "rises to Grade 3 only when it invalidates the arc's own conclusions",
    );
    // (10) Corrective resend must name the id-bearing skip form; the bare
    // no-id call is rejected by the real remember route.
    expect(prompt).toContain("a `remember()` without an id is rejected");
    expect(prompt).not.toContain('remember({status:"skipped"})');

    // `timeline` joined the agent's surface for settlement (spec §A): a settle
    // re-grades a trailing window against the arc it belongs to. Read-only.
    expect(capturedAllowedTools).toEqual([
      "mcp__mnemo__remember",
      "mcp__mnemo__recall",
      "mcp__mnemo__timeline",
    ]);
    expect(prompt).toContain("## Settlement messages");
    expect(prompt).toContain("Do NOT call `remember()` in a settlement");

    // Tool scope rules — the memory-creation boundary must be present, and the
    // dead obs-extraction guidance must be gone (D6).
    expect(prompt).toContain("`remember()` — your only output");
    expect(prompt).toContain("`recall()` — the only read fallback");
    expect(prompt).toContain(
      "`recall()` is usually unnecessary — the inline data, the recent-turn index, and conversation history usually suffice. Only escalate when they genuinely do not.",
    );
    // Component 2: turn content may carry causal `[T<n>]` citations.
    expect(prompt).toContain("cite that driver inline as `[T<n>]`");
    // Two-class tags: bare role tags + topic:-prefixed topic tags.
    expect(prompt).toContain("BARE role tags + `topic:`-prefixed topic tags");
    expect(prompt).toContain(
      "Every bare tag MUST name the turn's role in the session arc",
    );
    expect(prompt).toContain("topic tags NEVER affect milestones");
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
    expect(prompt).toContain("one-sentence arc overview");
    expect(prompt).toContain("only decisions that still govern current or next work");
    expect(prompt).toContain("only recent fine-grained completions useful to next work");
    expect(prompt).toContain("Safe to prune");
    expect(prompt).toContain("milestone timeline is independent");
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

  test("a streamed slice rides the same prompt stream and the same rubric system prompt", async () => {
    let capturedSystemPrompt: string | undefined;
    const seenPromptTexts: string[] = [];
    const queryImpl = mock(
      (args: {
        prompt: AsyncIterable<{
          session_id: string;
          message: { content: Array<{ text: string }> };
        }>;
        options?: { systemPrompt?: string };
      }) => {
        capturedSystemPrompt = args.options?.systemPrompt;
        return (async function* () {
          let turn = 0;
          for await (const message of args.prompt) {
            turn += 1;
            seenPromptTexts.push(
              message.message.content.map((block) => block.text).join(""),
            );
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
                server_tool_use: { web_search_requests: 0 },
                service_tier: "standard",
              },
              modelUsage: {},
              permission_denials: [],
              uuid: `result-${turn}`,
              session_id: "agent-session-1",
            };
          }
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

    const ordinaryTurn = `<turn id="T6">\n  prompt: ship the fix\n</turn>`;
    const slice = `<turn id="T7" slice="2">\n  prompt: keep going\n  <obs id="O3">ran the verifier</obs>\n</turn>\n<prior_turn id="T7">\n  title: prior title\n</prior_turn>`;

    await session.sendPrompt(ordinaryTurn);
    const result = await session.sendPrompt(slice);

    // Both flows go through the one promptStream — a slice is not a separate
    // query with its own (possibly stale) system prompt.
    expect(result.session_id).toBe("agent-session-1");
    expect(seenPromptTexts).toEqual([ordinaryTurn, slice]);
    expect(queryImpl).toHaveBeenCalledTimes(1);

    // …so the slice is graded against the same rubric package as a fresh turn.
    const prompt = capturedSystemPrompt ?? "";
    expect(prompt).toContain("grade: REQUIRED integer 0-4");
    expect(prompt).toContain("Origin duty, arc-scoped");
    expect(prompt).toContain("only the turn that LANDS the change is Grade 3");
    expect(prompt).toContain(
      "rises to Grade 3 only when it invalidates the arc's own conclusions",
    );
    expect(prompt).toContain("complete knowledge-answer delivery");
    expect(prompt).toContain(
      'relation: "builds-on" | "implements" | "supersedes" | "evidence-for"',
    );
    expect(prompt).toContain(
      "`cites` is the exception to field-level merge: it is a replace-set",
    );
    expect(prompt).toContain("EVERY slice");

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

  test("enables and forwards partial assistant stream events", async () => {
    let includePartialMessages: boolean | undefined;
    const seenMessageTypes: string[] = [];
    const queryImpl = mock(
      ({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<unknown>;
        options?: { includePartialMessages?: boolean };
      }) =>
        (async function* () {
          includePartialMessages = options?.includePartialMessages;
          for await (const _message of prompt) {
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "still working" },
              },
              parent_tool_use_id: null,
              uuid: "partial-1",
              session_id: "agent-session-partial",
            };
            yield {
              type: "result",
              subtype: "success",
              duration_ms: 1,
              duration_api_ms: 1,
              is_error: false,
              num_turns: 1,
              result: "",
              total_cost_usd: 0,
              usage: {},
              modelUsage: {},
              permission_denials: [],
              uuid: "result-partial",
              session_id: "agent-session-partial",
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
        onMessage: (message) => seenMessageTypes.push(message.type),
      },
    );

    await session.sendPrompt("first");

    expect(includePartialMessages).toBe(true);
    expect(seenMessageTypes).toEqual(["stream_event", "result"]);

    await session.close();
  });

  test("parses agent activity without treating error-only events as liveness", () => {
    const activityMessages = [
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial" },
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "whole" }] },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__mnemo__remember", input: {} },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__mnemo__recall", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "" }],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "..." }] },
      },
      {
        type: "tool_progress",
        tool_use_id: "tool-1",
        tool_name: "mcp__mnemo__recall",
      },
    ];

    for (const message of activityMessages) {
      expect(isExtractionAgentActivity(message as never)).toBe(true);
    }

    expect(
      isExtractionAgentActivity({
        type: "system",
        subtype: "api_error",
        error: { status: 503 },
      } as never),
    ).toBe(false);
    expect(
      isExtractionAgentActivity({
        type: "stream_event",
        event: { type: "error", error: { type: "overloaded_error" } },
      } as never),
    ).toBe(false);
    expect(
      isExtractionAgentActivity({
        type: "stream_event",
        event: { type: "message_stop" },
      } as never),
    ).toBe(false);
    expect(
      isExtractionAgentActivity({
        type: "assistant",
        error: "server_error",
        message: { content: [] },
      } as never),
    ).toBe(false);
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
