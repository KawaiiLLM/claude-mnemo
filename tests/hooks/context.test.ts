import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import * as formatModule from "../../src/mcp/format";
import * as sessionsModule from "../../src/db/sessions";
import type { NormalizedHookInput } from "../../src/hooks/types";
import { resolveTranscriptPath } from "../../src/shared/paths";
import { listPendingQueueItems } from "../../src/db/pending-queue";

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
    expect(output).toContain("## Recent Sessions");
    expect(output).toContain(`[S${currentSessionId}] Anchored session`);
    expect(output).toContain(
      `raw: ${resolveTranscriptPath("/Users/zhaoqixuan/Projects/claude-mnemo", "session-context")}`,
    );
    // D4: the current-session block injects every summary field. With no
    // `decision`, the legacy `insight` bullets render as the fallback (bullets
    // indented 4 spaces to match recall/worker).
    expect(output).toContain("  insight:");
    expect(output).toContain("    - Primary insight bullet for the current session");
    // The current-session block renders the day-grouped milestone digest
    // (session-output.ts injects the "milestones" view), not the turn table.
    expect(output).toMatch(/── \d{4}-\d{2}-\d{2} \w{3} · T\d+–T\d+ · \d+ kept/);
    expect(output).not.toContain("showing:");
    expect(output).not.toContain("phases (");
    expect(output).not.toContain("⏭");
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
    renderNodeSpy.mockRestore();
  });

  test("current-session block renders decision/done/reference as 4-space bullets with resolved [T<n>]", async () => {
    const turnId = insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 1,
      title: "Pick mutex",
      content: "Chose a mutex",
      userPrompt: "How to fix the race?",
      assistantResponse: "Use a mutex.",
      toolCallCount: 1,
      createdAtEpoch: 300,
    });
    db.query(
      `UPDATE sessions SET decision = ?, done = ?, "reference" = ? WHERE id = ?`,
    ).run(
      `- Chose a mutex over a queue [T${turnId}]\n- Serialized the refresh path`,
      `- Shipped the auth fix [T${turnId}]`,
      `- docs/plans/redesign.md`,
      currentSessionId,
    );

    const handler = createContextHandler({ db });
    const result = await handler(
      createInput({ source: "resume", sessionId: "session-context" }),
    );
    const output = result.hookSpecificOutput ?? "";

    // Bullet blocks at 4-space, with [T<n>] resolved to S/T + current title.
    expect(output).toContain("  decision:");
    expect(output).toContain(
      `    - Chose a mutex over a queue [S${currentSessionId}/T1] "Pick mutex"`,
    );
    expect(output).toContain("    - Serialized the refresh path");
    expect(output).toContain("  done:");
    expect(output).toContain(
      `    - Shipped the auth fix [S${currentSessionId}/T1] "Pick mutex"`,
    );
    expect(output).toContain("  reference:");
    expect(output).toContain("    - docs/plans/redesign.md");
    // decision present → legacy insight fallback is NOT used.
    expect(output).not.toContain("Primary insight bullet");
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
    // The current-session block renders the day-grouped milestone digest
    // (session-output.ts injects the "milestones" view), not the turn table.
    expect(output).toMatch(/── \d{4}-\d{2}-\d{2} \w{3} · T\d+–T\d+ · \d+ kept/);
    expect(output).not.toContain("showing:");
    expect(output).not.toContain("phases (");
    // Full-session milestone selection (not the old last-30-turns window): the
    // window is the whole session and the digest keeps the real first endpoint T1.
    expect(output).toContain("shape signals (window T1-T40 = full session):");
    expect(output).toMatch(/── .+ · T1–T40 · 2 kept ──/);
    expect(output).toMatch(/^\s+T1 .+ Turn 1$/m);
    expect(output).not.toContain("window T11-T40");
    // All kept milestones fit the tail, so no earlier hint.
    expect(output).not.toContain("earlier:");
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

  test("husk sessions (untitled AND 0 turns) are excluded from Recent Sessions", async () => {
    const huskDb = createDatabase(":memory:");
    initializeSchema(huskDb);

    upsertSession(huskDb, {
      contentSessionId: "primary",
      project: "/test/project",
      title: "Primary",
      content: null,
      insight: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    // Husk: untitled, no turns — must be excluded.
    const huskNullTitleId = upsertSession(huskDb, {
      contentSessionId: "husk-null-title",
      project: "/test/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 900,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // Husk: whitespace-only title, no turns — must be excluded.
    const huskBlankTitleId = upsertSession(huskDb, {
      contentSessionId: "husk-blank-title",
      project: "/test/project",
      title: "   ",
      content: null,
      insight: null,
      createdAtEpoch: 890,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // Titled but 0 turns — must still be shown (not a husk).
    upsertSession(huskDb, {
      contentSessionId: "titled-zero-turns",
      project: "/test/project",
      title: "Titled but empty",
      content: null,
      insight: null,
      createdAtEpoch: 800,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    // Untitled but has a turn — must still be shown (not a husk), rendered
    // with the format module's "Untitled" fallback for a null title.
    const untitledWithTurn = upsertSession(huskDb, {
      contentSessionId: "untitled-with-turn",
      project: "/test/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 700,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    huskDb
      .query(
        `INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch)
         VALUES (?, 1, 'active', 'hello', ?)`,
      )
      .run(untitledWithTurn, 701);

    const handler = createContextHandler({ db: huskDb });
    const result = await handler(
      createInput({ sessionId: "primary", cwd: "/test/project", source: "startup" }),
    );

    const output = result.hookSpecificOutput ?? "";

    expect(output).not.toContain(`[S${huskNullTitleId}]`);
    expect(output).not.toContain(`[S${huskBlankTitleId}]`);
    expect(output).toContain("Titled but empty");
    expect(output).toContain(`[S${untitledWithTurn}] Untitled`);
    // Only the untitled-with-turn session should render as "Untitled" — the
    // two husks must not contribute a line of their own.
    const untitledLines = output
      .split("\n")
      .filter((line) => /^- \[S\d+\] Untitled\b/.test(line));
    expect(untitledLines).toHaveLength(1);

    huskDb.close();
  });

  test("husk filter applies before the 10-slice so a real session survives 11 husks", async () => {
    const capDb = createDatabase(":memory:");
    initializeSchema(capDb);

    upsertSession(capDb, {
      contentSessionId: "primary",
      project: "/test/project",
      title: "Primary",
      content: null,
      insight: null,
      createdAtEpoch: 2000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    // 11 husks, all more recent than the one real session below — without the
    // pre-slice filter these alone would fill the 10-cap and push the real
    // session out entirely.
    for (let i = 1; i <= 11; i++) {
      upsertSession(capDb, {
        contentSessionId: `husk-${i}`,
        project: "/test/project",
        title: null,
        content: null,
        insight: null,
        createdAtEpoch: 1900 - i,
        updatedAtEpoch: null,
        completedAtEpoch: null,
      });
    }

    upsertSession(capDb, {
      contentSessionId: "real-session",
      project: "/test/project",
      title: "Real session",
      content: null,
      insight: null,
      createdAtEpoch: 1800,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const handler = createContextHandler({ db: capDb });
    const result = await handler(
      createInput({ sessionId: "primary", cwd: "/test/project", source: "startup" }),
    );

    const output = result.hookSpecificOutput ?? "";
    expect(output).toContain("Real session");

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

    const handler = createContextHandler({
      db,
      timelineRenderer: {
        buildContextTimelineView: () => {
          throw new Error("timeline exploded");
        },
        renderTimeline: () => {
          throw new Error("render should not run after build failure");
        },
      },
    });
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
  });

  test("resume source with a stranded active turn enqueues turn-stop and still returns hookSpecificOutput without asyncWork", async () => {
    // Insert a stranded turn: status='active', assistant_response set → qualifies for recovery
    db.query(`
      INSERT INTO turns (
        session_id, prompt_number, status,
        user_prompt, assistant_response,
        title, content, insight,
        files_read, files_modified, tool_call_count,
        created_at_epoch, updated_at_epoch
      ) VALUES (?, 1, 'active', 'How to fix the race?', 'Use a mutex.', NULL, NULL, NULL, '[]', '[]', 1, 301, NULL)
    `).run(currentSessionId);

    const handler = createContextHandler({ db });
    const result = await handler(
      createInput({ source: "resume", sessionId: "session-context" }),
    );

    // Handler must still return a context string and NO asyncWork
    expect(result.hookSpecificOutput).toBeDefined();
    expect(typeof result.hookSpecificOutput).toBe("string");
    expect(result.asyncWork).toBeUndefined();

    // Recovery must have enqueued a turn-stop item for this session
    const items = listPendingQueueItems(db, currentSessionId);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.kind === "turn-stop")).toBe(true);
  });

  test("startup source with a stranded active turn does NOT enqueue turn-stop", async () => {
    // Same stranded turn seed
    db.query(`
      INSERT INTO turns (
        session_id, prompt_number, status,
        user_prompt, assistant_response,
        title, content, insight,
        files_read, files_modified, tool_call_count,
        created_at_epoch, updated_at_epoch
      ) VALUES (?, 1, 'active', 'How to fix the race?', 'Use a mutex.', NULL, NULL, NULL, '[]', '[]', 1, 301, NULL)
    `).run(currentSessionId);

    const handler = createContextHandler({ db });
    await handler(
      createInput({ source: "startup", sessionId: "session-context" }),
    );

    // No turn-stop must have been enqueued
    const items = listPendingQueueItems(db, currentSessionId);
    expect(items.filter((item) => item.kind === "turn-stop").length).toBe(0);
  });
});
