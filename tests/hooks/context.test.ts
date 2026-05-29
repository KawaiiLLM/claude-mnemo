import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { createMemory } from "../../src/db/memories";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import * as formatModule from "../../src/mcp/format";
import * as timelineModule from "../../src/mcp/timeline";
import * as sessionsModule from "../../src/db/sessions";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { resolveTranscriptPath } from "../../src/shared/paths";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "SessionStart",
    source: "resume",
    sessionId: "session-context",
    cwd: "/Users/zhaoqixuan/Projects/claude-mnemo",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

function insertTurn(
  db: Database,
  input: {
    sessionId: number;
    promptNumber: number;
    title: string;
    content: string;
    userPrompt: string;
    assistantResponse: string;
    toolCallCount: number;
    createdAtEpoch: number;
    filesRead?: string[];
    filesModified?: string[];
  },
): number {
  const turn = db
    .query<{ id: number }, [number, number, string, string, string, string, string | null, string, string, number, number, number | null]>(`
      INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        title,
        content,
        insight,
        files_read,
        files_modified,
        tool_call_count,
        created_at_epoch,
        updated_at_epoch
      ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      RETURNING id
    `)
    .get(
      input.sessionId,
      input.promptNumber,
      input.userPrompt,
      input.assistantResponse,
      input.title,
      input.content,
      JSON.stringify(input.filesRead ?? []),
      JSON.stringify(input.filesModified ?? []),
      input.toolCallCount,
      input.createdAtEpoch,
      null,
    );

  if (!turn) {
    throw new Error("Failed to insert turn.");
  }

  return turn.id;
}

function insertObservation(
  db: Database,
  turnId: number,
  input: {
    toolName?: string;
    title: string;
    content: string;
    createdAtEpoch: number;
  },
): void {
  db.query(
    `INSERT INTO observations (
      turn_id,
      tool_name,
      title,
      content,
      created_at_epoch
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    turnId,
    input.toolName ?? null,
    input.title,
    input.content,
    input.createdAtEpoch,
  );
}

describe("handleContextHook", () => {
  let db: Database;
  let currentSessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    upsertSession(db, {
      contentSessionId: "session-newest",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Most recent session",
      content:
        "Most recent session description that should be truncated in the context hook output because it is intentionally too long for the collapsed view.",
      insight: null,
      createdAtEpoch: 500,
      updatedAtEpoch: 505,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-secondary",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Secondary session",
      content:
        "Secondary session description that should also be truncated in the context hook output because it exceeds the visible budget.",
      insight: null,
      createdAtEpoch: 400,
      updatedAtEpoch: 405,
      completedAtEpoch: null,
    });

    currentSessionId = upsertSession(db, {
      contentSessionId: "session-context",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Anchored session",
      content:
        "Current session description that is intentionally verbose so truncation can be verified in the primary context block.",
      insight: "- Primary insight bullet for the current session",
      nextSteps: "Implement the mutex fix before the next session begins.",
      createdAtEpoch: 300,
      updatedAtEpoch: 305,
      completedAtEpoch: null,
    }).id;

    upsertSession(db, {
      contentSessionId: "session-older",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Older session",
      content:
        "Older session description that should be visible only as a collapsed header with truncation applied.",
      insight: null,
      createdAtEpoch: 200,
      updatedAtEpoch: 205,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-oldest",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Oldest session",
      content:
        "Oldest session description that is intentionally long so the collapsed-only header uses the truncated form.",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 105,
      completedAtEpoch: null,
    });

    createMemory(db, {
      type: "feedback",
      scope: "global",
      title: "Use real DB tests",
      content: "Integration tests should exercise the real database layer.",
      reasoning: "Mocks hide transaction and locking behavior.",
      application: "When validating persistence or concurrency changes.",
      tags: ["testing", "database"],
      createdAtEpoch: 250,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    createMemory(db, {
      type: "project",
      scope: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Auth mutex policy",
      content: "Refresh token work must be serialized with a mutex.",
      reasoning: null,
      application: null,
      tags: [],
      createdAtEpoch: 260,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });

    createMemory(db, {
      type: "project",
      scope: "other-project",
      title: "Other project note",
      content: "This should stay out of the current project memory block.",
      reasoning: null,
      application: null,
      tags: [],
      createdAtEpoch: 270,
      updatedAtEpoch: null,
      sourceTurnId: null,
      status: "active",
      supersededBy: null,
      expiresAtEpoch: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("startup upserts a minimal current session even when memory rows do not exist", async () => {
    const emptyDb = createDatabase(":memory:");
    initializeSchema(emptyDb);

    const handler = createContextHandler({
      db: emptyDb,
    });

    const result = await handler(
      createInput({ sessionId: "missing-session", source: "startup" }),
    );

    expect(result.hookSpecificOutput).toContain(
      "claude-mnemo: 1 sessions, 0 observations | current: S1",
    );
    expect(result.hookSpecificOutput).toContain("## Recent Sessions");
    expect(result.hookSpecificOutput).not.toContain("## Current Session");

    emptyDb.close();
  });

  test("startup skips Current Session and adds compact header axes", async () => {
    const singleSessionDb = createDatabase(":memory:");
    initializeSchema(singleSessionDb);

    const singleSession = upsertSession(singleSessionDb, {
      contentSessionId: "single-session",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Single session",
      content: "Single session description",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    });

    const getRecentSessionsSpy = spyOn(sessionsModule, "getRecentSessions");
    const renderNodeSpy = spyOn(formatModule, "renderNode");
    const handler = createContextHandler({
      db: singleSessionDb,
    });

    await handler(
      createInput({
        sessionId: "single-session",
        source: "startup",
      }),
    );

    expect(getRecentSessionsSpy).toHaveBeenCalledTimes(1);
    expect(renderNodeSpy).toHaveBeenCalledTimes(0);

    const output = (await handler(
      createInput({
        sessionId: "single-session",
        source: "startup",
      }),
    )).hookSpecificOutput ?? "";
    expect(output).toContain(`claude-mnemo: 1 sessions, 0 observations | current: S${singleSession.id}`);
    expect(output).toContain(
      "Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)",
    );
    expect(output).not.toContain("## Current Session");
    expect(output).toContain("## Recent Sessions");

    getRecentSessionsSpy.mockRestore();
    renderNodeSpy.mockRestore();
    singleSessionDb.close();
  });

  test("caps the combined memory block at 50 rows", async () => {
    for (let index = 0; index < 35; index += 1) {
      createMemory(db, {
        type: "feedback",
        scope: "global",
        title: `Global memory ${index + 1}`,
        content: `Global memory content ${index + 1}`,
        reasoning: null,
        application: null,
        tags: ["global"],
        createdAtEpoch: 1_000 - index,
        updatedAtEpoch: 1_000 - index,
        sourceTurnId: null,
        status: "active",
        supersededBy: null,
        expiresAtEpoch: null,
      });
    }

    for (let index = 0; index < 35; index += 1) {
      createMemory(db, {
        type: "feedback",
        scope: "/Users/zhaoqixuan/Projects/claude-mnemo",
        title: `Project memory ${index + 1}`,
        content: `Project memory content ${index + 1}`,
        reasoning: null,
        application: null,
        tags: ["project"],
        createdAtEpoch: 900 - index,
        updatedAtEpoch: 900 - index,
        sourceTurnId: null,
        status: "active",
        supersededBy: null,
        expiresAtEpoch: null,
      });
    }

    const handler = createContextHandler({
      db,
    });

    const result = await handler(
      createInput({
        sessionId: "session-context",
      }),
    );

    const memoryLines = (result.hookSpecificOutput ?? "")
      .split("\n")
      .filter((line) => /^-\s+\[M\d+\]/.test(line.trimStart()));
    const memoryIds = memoryLines
      .map((line) => line.match(/\[M(\d+)\]/)?.[1])
      .filter((value): value is string => value !== undefined);

    expect(memoryLines).toHaveLength(50);
    expect(new Set(memoryIds).size).toBe(50);
  });

  test("compact injects current-session timeline and keeps recent sessions collapsed", async () => {
    insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 1,
      title: "Prep cache",
      content:
        "This turn description is intentionally verbose so the collapsed line must be truncated at sixty characters.",
      userPrompt: "Prep cache",
      assistantResponse: "Prepared cache state.",
      toolCallCount: 1,
      createdAtEpoch: 310,
    });

    insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 2,
      title: "Investigate timeout",
      content: "Trace the timeout path under parallel load.",
      userPrompt:
        "Investigate the timeout path under parallel load and capture the important findings in the session summary.",
      assistantResponse:
        "The timeout is caused by overlapping refresh requests that each open a new retry window and race each other.",
      toolCallCount: 2,
      createdAtEpoch: 320,
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
    });

    const turn2 = db
      .query<{ id: number }, [number, number]>(
        `SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?`,
      )
      .get(currentSessionId, 2);

    if (!turn2) {
      throw new Error("Failed to load turn 2.");
    }

    insertObservation(db, turn2.id, {
      toolName: "Read",
      title: "Parallel requests share a refresh race",
      content: "Logs confirmed the race window under load.",
      createdAtEpoch: 321,
    });

    insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 3,
      title: "Validate fix",
      content: "Confirm the mutex patch removes the race.",
      userPrompt: "Validate the fix with the regression suite.",
      assistantResponse: "The regression suite passes and the race no longer reproduces.",
      toolCallCount: 3,
      createdAtEpoch: 330,
      filesRead: ["tests/auth.test.ts"],
      filesModified: ["tests/auth.test.ts"],
    });

    const turn4 = insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 4,
      title: "Document findings",
      content: "Document the durable outcome and follow-up work.",
      userPrompt:
        "Document the findings in enough detail that future sessions can resume the investigation without rereading the logs.",
      assistantResponse:
        "The root cause is a missing mutex around token refresh. The follow-up is to ship the guard and keep the regression test.",
      toolCallCount: 4,
      createdAtEpoch: 340,
      filesRead: ["src/auth.ts", "tests/auth.test.ts"],
      filesModified: ["src/auth.ts"],
    });

    insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 5,
      title: "Ship mutex",
      content: "Land the mutex patch in the auth middleware.",
      userPrompt: "Ship the mutex patch.",
      assistantResponse: "The mutex patch is ready to land.",
      toolCallCount: 1,
      createdAtEpoch: 350,
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts"],
    });

    insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 6,
      title: "Close out session",
      content: "Summarize the final state before stopping.",
      userPrompt: "Close out the session.",
      assistantResponse: "The session is ready to stop.",
      toolCallCount: 1,
      createdAtEpoch: 360,
      filesRead: [],
      filesModified: [],
    });

    insertObservation(db, turn4, {
      toolName: "Read",
      title: "Parallel refreshes share one race window",
      content: "Timing confirmed the overlap under concurrent requests.",
      createdAtEpoch: 341,
    });

    insertObservation(db, turn4, {
      toolName: "TodoWrite",
      title: "Use a mutex instead of a queue",
      content: "The simpler guard keeps the common path fast.",
      createdAtEpoch: 342,
    });

    insertObservation(db, turn4, {
      toolName: "Edit",
      title: "Mutex patch applied",
      content: "The shared refresh path is now serialized.",
      createdAtEpoch: 343,
    });

    insertObservation(db, turn4, {
      toolName: "Write",
      title: "Follow-up regression kept",
      content: "The regression test still exercises the race.",
      createdAtEpoch: 344,
    });

    const newestSessionTurnNumbers = [1, 2, 3, 4, 5, 6];
    for (const promptNumber of newestSessionTurnNumbers) {
      insertTurn(db, {
        sessionId: 1,
        promptNumber,
        title: `Recent turn ${promptNumber}`,
        content: `Recent turn ${promptNumber} description that should be truncated in collapsed context output.`,
        userPrompt: `Recent prompt ${promptNumber}`,
        assistantResponse: `Recent response ${promptNumber}`,
        toolCallCount: promptNumber,
        createdAtEpoch: 500 + promptNumber,
      });
    }

    insertTurn(db, {
      sessionId: 2,
      promptNumber: 1,
      title: "Secondary turn 1",
      content: "Secondary turn one description.",
      userPrompt: "Secondary prompt 1",
      assistantResponse: "Secondary response 1",
      toolCallCount: 1,
      createdAtEpoch: 410,
    });

    insertTurn(db, {
      sessionId: 2,
      promptNumber: 2,
      title: "Secondary turn 2",
      content: "Secondary turn two description.",
      userPrompt: "Secondary prompt 2",
      assistantResponse: "Secondary response 2",
      toolCallCount: 2,
      createdAtEpoch: 420,
    });

    insertTurn(db, {
      sessionId: 4,
      promptNumber: 1,
      title: "Older turn 1",
      content: "Older turn one description.",
      userPrompt: "Older prompt 1",
      assistantResponse: "Older response 1",
      toolCallCount: 1,
      createdAtEpoch: 210,
    });

    insertTurn(db, {
      sessionId: 5,
      promptNumber: 1,
      title: "Oldest turn 1",
      content: "Oldest turn one description.",
      userPrompt: "Oldest prompt 1",
      assistantResponse: "Oldest response 1",
      toolCallCount: 1,
      createdAtEpoch: 110,
    });

    const handler = createContextHandler({
      db,
    });
    const renderNodeSpy = spyOn(formatModule, "renderNode");

    const result = await handler(
      createInput({
        sessionId: "session-context",
        source: "compact",
      }),
    );

    const output = result.hookSpecificOutput ?? "";

    expect(output).toContain(`claude-mnemo: 5 sessions, 5 observations | current: S${currentSessionId}`);
    expect(output).toContain(
      "Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)",
    );
    expect(output).not.toContain("Format:");
    expect(output).not.toContain("Stats:");
    expect(output).toContain("## Current Session");
    expect(output).toContain("## Memories");
    expect(output).toContain("## Recent Sessions");
    expect(output).toContain(`[S${currentSessionId}] Anchored session`);
    expect(output).toContain(
      `raw: ${resolveTranscriptPath("/Users/zhaoqixuan/Projects/claude-mnemo", "session-context")}`,
    );
    expect(output).toContain(
      `[M1] feedback/global: Use real DB tests | 1970-01-01`,
    );
    expect(output).toContain(
      `[M2] project//Users/zhaoqixuan/Projects/claude-mnemo: Auth mutex policy | 1970-01-01`,
    );
    expect(output).not.toContain("Other project note");
    // D4: the current-session block injects every summary field. With no
    // `decision`, the legacy `insight` bullets render as the fallback.
    expect(output).toContain("  insight:");
    expect(output).toContain("  - Primary insight bullet for the current session");
    expect(output).toContain("T#");
    expect(output).not.toContain("showing:");
    expect(output).toContain("phases (session-wide):");
    expect(output).toContain("shape signals (window T1-T6");
    // next_steps renders under its display label "next".
    expect(output).not.toContain("next_steps:");
    expect(output).toContain(
      "  next: Implement the mutex fix before the next session begins.",
    );
    expect(output).toContain(
      "  content: Current session description that is intentionally verbose so truncation can be verified in the primary context block.",
    );

    expect(output).toContain(
      `- [S1] Most recent session | 💬6 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).not.toContain(
      `raw: ${resolveTranscriptPath("/Users/zhaoqixuan/Projects/claude-mnemo", "session-newest")}`,
    );
    expect(output).toContain(
      "  - desc: Most recent session description that should be truncated in the context hook output because it is intentionally too long...",
    );
    expect(output).toContain(
      "[use mnemo-replay skill → read S1 for full content]",
    );
    expect(output).not.toContain("Recent turn 1");
    expect(output).not.toContain("Recent turn 2");
    expect(output).not.toContain("Recent turn 6");
    expect(output).not.toContain("Recent turn 1");

    expect(output).toContain(
      `- [S2] Secondary session | 💬2 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).toContain(
      "  - desc: Secondary session description that should also be truncated in the context hook output because it exceeds the visible bu...",
    );

    expect(output).toContain(
      `- [S4] Older session | 💬1 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).toContain(
      "  - desc: Older session description that should be visible only as a collapsed header with truncation applied.",
    );
    expect(output).not.toContain("Older turn 1");

    expect(output).toContain(
      `- [S5] Oldest session | 💬1 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).toContain(
      "  - desc: Oldest session description that is intentionally long so the collapsed-only header uses the truncated form.",
    );
    expect(output).not.toContain("Oldest turn 1");

    expect(output.indexOf(`[S${currentSessionId}] Anchored session`)).toBeLessThan(
      output.indexOf("- [S1] Most recent session"),
    );
    expect(renderNodeSpy).toHaveBeenCalledWith(
      { type: "session", value: expect.objectContaining({ id: 1 }) },
      { depth: "collapsed", truncate: 120, mode: "unified" },
    );
    expect(renderNodeSpy).toHaveBeenCalledWith(
      {
        type: "memory",
        value: expect.objectContaining({ title: "Use real DB tests" }),
      },
      { depth: "collapsed", mode: "legacy" },
    );
    renderNodeSpy.mockRestore();
  });

  test("startup shows current session id but skips Current Session timeline when there are no turns", async () => {
    const handler = createContextHandler({ db });

    const result = await handler(
      createInput({
        source: "startup",
        sessionId: "session-context",
      }),
    );

    const output = result.hookSpecificOutput ?? "";
    expect(output).toContain(`current: S${currentSessionId}`);
    expect(output).toContain("Axes: recall (content) · timeline (temporal) · mnemo-replay (raw)");
    expect(output).not.toContain("## Current Session");
    expect(output).not.toContain("T#");
  });

  test("compact injects a last-page timeline instead of collapsed turns", async () => {
    for (let promptNumber = 1; promptNumber <= 40; promptNumber += 1) {
      insertTurn(db, {
        sessionId: currentSessionId,
        promptNumber,
        title: `Turn ${promptNumber}`,
        content: `Turn ${promptNumber} content`,
        userPrompt: `Turn ${promptNumber} ${"x".repeat(120)}`,
        assistantResponse: `Response ${promptNumber}`,
        toolCallCount: 1,
        createdAtEpoch: 300 + promptNumber,
      });
    }

    const handler = createContextHandler({ db });
    const result = await handler(
      createInput({
        source: "compact",
        sessionId: "session-context",
      }),
    );

    const output = result.hookSpecificOutput ?? "";
    expect(output).toContain(`claude-mnemo: 5 sessions, 0 observations | current: S${currentSessionId}`);
    expect(output).toContain("## Current Session");
    expect(output).toContain("T#");
    expect(output).not.toContain("showing:");
    expect(output).toContain("phases (window T11-T40):");
    expect(output).toContain("shape signals (window T11-T40):");
    expect(output).toContain('earlier: timeline(id="S3/T1..10") or recall(id="S3")');
    expect(output).not.toContain("Format:");
    expect(output).not.toContain("Stats:");
    expect(output).not.toContain('Expand: recall(id="Sx/Ty", depth="expanded")');
  });

  test("recent sessions are grouped by calendar day boundary", async () => {
    const now = new Date();
    const todayEpoch = Math.floor(now.getTime() / 1000) - 3600; // 1 hour ago
    const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayEpoch = Math.floor(yesterdayStart.getTime() / 1000) - 3600; // 1 hour before midnight
    const fiveDaysAgoEpoch = Math.floor(yesterdayStart.getTime() / 1000) - 5 * 86400;
    const tenDaysAgoEpoch = Math.floor(yesterdayStart.getTime() / 1000) - 10 * 86400;

    const groupDb = createDatabase(":memory:");
    initializeSchema(groupDb);

    upsertSession(groupDb, {
      contentSessionId: "current-s",
      project: "/test/project",
      title: "Current",
      content: null,
      insight: null,
      createdAtEpoch: todayEpoch + 1800,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(groupDb, {
      contentSessionId: "today-s",
      project: "/test/project",
      title: "Today session",
      content: "Created today",
      insight: null,
      createdAtEpoch: todayEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(groupDb, {
      contentSessionId: "yesterday-s",
      project: "/test/project",
      title: "Yesterday session",
      content: "Created yesterday",
      insight: null,
      createdAtEpoch: yesterdayEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(groupDb, {
      contentSessionId: "week-s",
      project: "/test/project",
      title: "Five days ago session",
      content: "Created 5 days ago",
      insight: null,
      createdAtEpoch: fiveDaysAgoEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    upsertSession(groupDb, {
      contentSessionId: "old-s",
      project: "/test/project",
      title: "Ten days ago session",
      content: "Created 10 days ago",
      insight: null,
      createdAtEpoch: tenDaysAgoEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const handler = createContextHandler({ db: groupDb });
    const result = await handler(
      createInput({ sessionId: "current-s", cwd: "/test/project", source: "startup" }),
    );

    const output = result.hookSpecificOutput ?? "";
    expect(output).toContain("### Today");
    expect(output).toContain("### Yesterday");
    expect(output).toContain("### Last 7 days");
    expect(output).toContain("### Earlier");
    expect(output).toContain("Today session");
    expect(output).toContain("Yesterday session");
    expect(output).toContain("Five days ago session");
    expect(output).toContain("Ten days ago session");

    // Verify ordering: Today before Yesterday before Last 7 days before Earlier
    const todayIdx = output.indexOf("### Today");
    const yesterdayIdx = output.indexOf("### Yesterday");
    const weekIdx = output.indexOf("### Last 7 days");
    const earlierIdx = output.indexOf("### Earlier");
    expect(todayIdx).toBeLessThan(yesterdayIdx);
    expect(yesterdayIdx).toBeLessThan(weekIdx);
    expect(weekIdx).toBeLessThan(earlierIdx);

    groupDb.close();
  });

  test("recent sessions are capped at 10 and scoped to project", async () => {
    const capDb = createDatabase(":memory:");
    initializeSchema(capDb);

    const nowEpoch = Math.floor(Date.now() / 1000);

    // Current session
    upsertSession(capDb, {
      contentSessionId: "primary",
      project: "/test/project",
      title: "Primary",
      content: null,
      insight: null,
      createdAtEpoch: nowEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    // 15 same-project sessions
    for (let i = 1; i <= 15; i++) {
      upsertSession(capDb, {
        contentSessionId: `same-${i}`,
        project: "/test/project",
        title: `Same project ${i}`,
        content: null,
        insight: null,
        createdAtEpoch: nowEpoch - i * 100,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
    }

    // 3 other-project sessions (should not appear)
    for (let i = 1; i <= 3; i++) {
      upsertSession(capDb, {
        contentSessionId: `other-${i}`,
        project: "/other/project",
        title: `Other project ${i}`,
        content: null,
        insight: null,
        createdAtEpoch: nowEpoch - i * 50,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
    }

    const handler = createContextHandler({ db: capDb });
    const result = await handler(
      createInput({ sessionId: "primary", cwd: "/test/project", source: "startup" }),
    );

    const output = result.hookSpecificOutput ?? "";

    // Should not contain other-project sessions
    expect(output).not.toContain("Other project");

    // Count session lines (cap at 10, excluding primary)
    const sessionLines = output.split("\n").filter((line) => /^- \[S\d+\]/.test(line));
    expect(sessionLines.length).toBeLessThanOrEqual(10);
    expect(sessionLines.length).toBeGreaterThan(0);

    capDb.close();
  });

  test("compact falls back to session summary when timeline rendering throws", async () => {
    const turnId = insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 1,
      title: "Investigate cache race",
      content: "Current session content that should stay out of the compact header block.",
      userPrompt: "Investigate the cache race.",
      assistantResponse: "The cache race is isolated to startup.",
      toolCallCount: 1,
      createdAtEpoch: 301,
    });

    insertObservation(db, turnId, {
      title: "Cache race reproduction",
      content: "The cache race reproduces only during startup.",
      createdAtEpoch: 302,
    });

    const buildTimelineSpy = spyOn(timelineModule, "buildContextTimelineView").mockImplementation(
      () => {
        throw new Error("timeline exploded");
      },
    );

    const handler = createContextHandler({ db });
    const result = await handler(
      createInput({
        source: "compact",
        sessionId: "session-context",
      }),
    );

    const output = result.hookSpecificOutput ?? "";
    expect(output).toContain("## Current Session");
    expect(output).toContain(`[S${currentSessionId}] Anchored session`);
    expect(output).toContain("  insight:");
    expect(output).not.toContain("T#");
    expect(output).not.toContain("showing:");
    expect(output).toContain("## Recent Sessions");

    buildTimelineSpy.mockRestore();
  });
});
