import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { createContextHandler } from "../../src/hooks/handlers/context";
import type { NormalizedHookInput } from "../../src/hooks/types";

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

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function insertTurn(
  db: Database,
  input: {
    sessionId: number;
    promptNumber: number;
    title: string;
    description: string;
    userPrompt: string;
    assistantResponse: string;
    toolCallCount: number;
    createdAtEpoch: number;
    filesRead?: string[];
    filesModified?: string[];
  },
): number {
  const turn = db
    .query<{ id: number }, [number, number, string, string, string, string, string | null, string | null, string | null, string, string, number, number | null]>(`
      INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        title,
        description,
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
      input.description,
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
    type: string;
    title: string;
    description: string;
    narrative?: string;
    facts?: string[];
    concepts?: string[];
    filesRead?: string[];
    filesModified?: string[];
    createdAtEpoch: number;
  },
): void {
  db.query(
    `INSERT INTO observations (
      turn_id,
      type,
      title,
      description,
      narrative,
      facts,
      concepts,
      files_read,
      files_modified,
      created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turnId,
    input.type,
    input.title,
    input.description,
    input.narrative ?? null,
    JSON.stringify(input.facts ?? []),
    JSON.stringify(input.concepts ?? []),
    JSON.stringify(input.filesRead ?? []),
    JSON.stringify(input.filesModified ?? []),
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
      description:
        "Most recent session description that should be truncated in the context hook output because it is intentionally too long for the collapsed view.",
      insight: null,
      startedAtEpoch: 500,
      updatedAtEpoch: 505,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-secondary",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Secondary session",
      description:
        "Secondary session description that should also be truncated in the context hook output because it exceeds the visible budget.",
      insight: null,
      startedAtEpoch: 400,
      updatedAtEpoch: 405,
      completedAtEpoch: null,
    });

    currentSessionId = upsertSession(db, {
      contentSessionId: "session-context",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Anchored session",
      description:
        "Current session description that is intentionally verbose so truncation can be verified in the primary context block.",
      insight: "- Primary insight bullet for the current session",
      nextSteps: "Implement the mutex fix before the next session begins.",
      startedAtEpoch: 300,
      updatedAtEpoch: 305,
      completedAtEpoch: null,
    }).id;

    upsertSession(db, {
      contentSessionId: "session-older",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Older session",
      description:
        "Older session description that should be visible only as a collapsed header with truncation applied.",
      insight: null,
      startedAtEpoch: 200,
      updatedAtEpoch: 205,
      completedAtEpoch: null,
    });

    upsertSession(db, {
      contentSessionId: "session-oldest",
      project: "/Users/zhaoqixuan/Projects/claude-mnemo",
      title: "Oldest session",
      description:
        "Oldest session description that is intentionally long so the collapsed-only header uses the truncated form.",
      insight: null,
      startedAtEpoch: 100,
      updatedAtEpoch: 105,
      completedAtEpoch: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("returns the fallback message when no memory rows exist", async () => {
    const emptyDb = createDatabase(":memory:");
    initializeSchema(emptyDb);

    const handler = createContextHandler({
      db: emptyDb,
    });

    const result = await handler(createInput({ sessionId: "missing-session" }));

    expect(result.hookSpecificOutput).toBe(
      "claude-mnemo memory available via recall() and replay().",
    );

    emptyDb.close();
  });

  test("anchors on the current session and applies graduated depth", async () => {
    const currentTurn1 = insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 1,
      title: "Prep cache",
      description:
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
      description: "Trace the timeout path under parallel load.",
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
      type: "discovery",
      title: "Parallel requests share a refresh race",
      description: "Logs confirmed the race window under load.",
      createdAtEpoch: 321,
    });

    insertTurn(db, {
      sessionId: currentSessionId,
      promptNumber: 3,
      title: "Validate fix",
      description: "Confirm the mutex patch removes the race.",
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
      description: "Document the durable outcome and follow-up work.",
      userPrompt:
        "Document the findings in enough detail that future sessions can resume the investigation without rereading the logs.",
      assistantResponse:
        "The root cause is a missing mutex around token refresh. The follow-up is to ship the guard and keep the regression test.",
      toolCallCount: 4,
      createdAtEpoch: 340,
      filesRead: ["src/auth.ts", "tests/auth.test.ts"],
      filesModified: ["src/auth.ts"],
    });

    insertObservation(db, turn4, {
      type: "discovery",
      title: "Parallel refreshes share one race window",
      description: "Timing confirmed the overlap under concurrent requests.",
      createdAtEpoch: 341,
    });

    insertObservation(db, turn4, {
      type: "decision",
      title: "Use a mutex instead of a queue",
      description: "The simpler guard keeps the common path fast.",
      createdAtEpoch: 342,
    });

    insertObservation(db, turn4, {
      type: "bugfix",
      title: "Mutex patch applied",
      description: "The shared refresh path is now serialized.",
      createdAtEpoch: 343,
    });

    insertObservation(db, turn4, {
      type: "feature",
      title: "Follow-up regression kept",
      description: "The regression test still exercises the race.",
      createdAtEpoch: 344,
    });

    const newestSessionTurnNumbers = [1, 2, 3, 4, 5, 6];
    for (const promptNumber of newestSessionTurnNumbers) {
      insertTurn(db, {
        sessionId: 1,
        promptNumber,
        title: `Recent turn ${promptNumber}`,
        description: `Recent turn ${promptNumber} description that should be truncated in collapsed context output.`,
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
      description: "Secondary turn one description.",
      userPrompt: "Secondary prompt 1",
      assistantResponse: "Secondary response 1",
      toolCallCount: 1,
      createdAtEpoch: 410,
    });

    insertTurn(db, {
      sessionId: 2,
      promptNumber: 2,
      title: "Secondary turn 2",
      description: "Secondary turn two description.",
      userPrompt: "Secondary prompt 2",
      assistantResponse: "Secondary response 2",
      toolCallCount: 2,
      createdAtEpoch: 420,
    });

    insertTurn(db, {
      sessionId: 4,
      promptNumber: 1,
      title: "Older turn 1",
      description: "Older turn one description.",
      userPrompt: "Older prompt 1",
      assistantResponse: "Older response 1",
      toolCallCount: 1,
      createdAtEpoch: 210,
    });

    insertTurn(db, {
      sessionId: 5,
      promptNumber: 1,
      title: "Oldest turn 1",
      description: "Oldest turn one description.",
      userPrompt: "Oldest prompt 1",
      assistantResponse: "Oldest response 1",
      toolCallCount: 1,
      createdAtEpoch: 110,
    });

    const handler = createContextHandler({
      db,
    });

    const result = await handler(
      createInput({
        sessionId: "session-context",
      }),
    );

    const output = result.hookSpecificOutput ?? "";

    expect(output).toContain("claude-mnemo: 5 sessions, 5 observations");
    expect(output).toContain("Types: 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision");
    expect(output).toContain("Stats: 💬turns 💡observations 📖read ✏️modified 🔧tools");
    expect(output).toContain("Format:");
    expect(output).toContain("Expand: recall(session=x, turn=y) | Raw: replay(session=x, turn=y)");
    expect(output).toContain("## Current Session");
    expect(output).toContain("## Recent Sessions");
    expect(output).toContain(
      `- [S3] Anchored session | 💬4 💡5 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).toContain(`  - desc: ${truncate(
      "Current session description that is intentionally verbose so truncation can be verified in the primary context block.",
      60,
    )}`);
    expect(output).toContain("  - insight:");
    expect(output).toContain("    - Primary insight bullet for the current session");
    expect(output).toContain("  - next_steps:");
    expect(output).toContain("    - Implement the mutex fix before the next session begins.");

    expect(output).toContain(`  - [T1] Prep cache | 🔧1`);
    expect(output).toContain(`    - desc: ${truncate(
      "This turn description is intentionally verbose so the collapsed line must be truncated at sixty characters.",
      60,
    )}`);
    expect(output).toContain(
      `  - [T2] Investigate timeout | 💡1 📖1 ✏️1 🔧2`,
    );
    expect(output).toContain(
      `    - prompt: "${truncate(
        "Investigate the timeout path under parallel load and capture the important findings in the session summary.",
        120,
      )}"`,
    );
    expect(output).toContain(
      `    - response: "${truncate(
        "The timeout is caused by overlapping refresh requests that each open a new retry window and race each other.",
        200,
      )}"`,
    );
    expect(output).toContain(
      `  - [T4] Document findings | 💡4 📖2 ✏️1 🔧4`,
    );
    expect(output).toContain("    - [O");
    expect(output).toContain("    - ... and 1 more observations");

    expect(output).toContain(
      `- [S1] Most recent session | 💬6 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).toContain(
      `  - desc: ${truncate(
        "Most recent session description that should be truncated in the context hook output because it is intentionally too long for the collapsed view.",
        60,
      )}`,
    );
    expect(output).toContain("  - ... and 1 more turns");
    expect(output).toContain(`  - [T2] Recent turn 2 | 🔧2`);
    expect(output).toContain(`  - [T6] Recent turn 6 | 🔧6`);
    expect(output).not.toContain("Recent turn 1");

    expect(output).toContain(
      `- [S2] Secondary session | 💬2 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).toContain(
      `  - desc: ${truncate(
        "Secondary session description that should also be truncated in the context hook output because it exceeds the visible budget.",
        60,
      )}`,
    );

    expect(output).toContain(
      `- [S4] Older session | 💬1 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).toContain(
      `  - desc: ${truncate(
        "Older session description that should be visible only as a collapsed header with truncation applied.",
        60,
      )}`,
    );
    expect(output).not.toContain("Older turn 1");

    expect(output).toContain(
      `- [S5] Oldest session | 💬1 | 1970-01-01 | /Users/zhaoqixuan/Projects/claude-mnemo`,
    );
    expect(output).toContain(
      `  - desc: ${truncate(
        "Oldest session description that is intentionally long so the collapsed-only header uses the truncated form.",
        60,
      )}`,
    );
    expect(output).not.toContain("Oldest turn 1");

    expect(output.indexOf("- [S3] Anchored session")).toBeLessThan(
      output.indexOf("- [S1] Most recent session"),
    );
  });
});
