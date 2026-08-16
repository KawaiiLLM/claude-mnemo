import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession, type SessionRecord } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  renderCurrentSessionStateOutput,
} from "../../src/mcp/session-output";
import type { FormattedSession } from "../../src/mcp/format";

describe("renderCurrentSessionStateOutput", () => {
  let db: Database;
  let sessionRecord: SessionRecord;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionRecord = upsertSession(db, {
      contentSessionId: "test-session-output",
      project: "/test/project",
      title: "Test session title",
      content: "Test session content description.",
      insight: "- Key insight one\n- Key insight two",
      nextSteps: "Next steps text.",
      createdAtEpoch: 1000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("renders [S<id>] header with session title", () => {
    const session: FormattedSession = {
      id: sessionRecord.id,
      title: sessionRecord.title,
      project: sessionRecord.project,
      createdAtEpoch: sessionRecord.createdAtEpoch,
      content: sessionRecord.content,
      insight: ["Key insight one", "Key insight two"],
      nextSteps: sessionRecord.nextSteps,
      decision: null,
      done: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).toContain(`[S${sessionRecord.id}]`);
    expect(output).toContain("Test session title");
    expect(output.startsWith(`[S${sessionRecord.id}] Test session title`)).toBe(true);
  });

  test("renders content field", () => {
    const session: FormattedSession = {
      id: sessionRecord.id,
      title: sessionRecord.title,
      project: sessionRecord.project,
      createdAtEpoch: sessionRecord.createdAtEpoch,
      content: "Test session content description.",
      insight: [],
      nextSteps: null,
      decision: null,
      done: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).toContain("  content: Test session content description.");
  });

  test("renders insight bullets when decision is absent (a legacy row is unchanged)", () => {
    const session: FormattedSession = {
      id: sessionRecord.id,
      title: sessionRecord.title,
      project: sessionRecord.project,
      createdAtEpoch: sessionRecord.createdAtEpoch,
      content: null,
      insight: ["Key insight one", "Key insight two"],
      nextSteps: null,
      decision: null,
      done: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).toContain("  insight:");
    expect(output).toContain("    - Key insight one");
    expect(output).toContain("    - Key insight two");
    expect(output).not.toContain("  decision:");
  });

  // ticket 04 (spec D2): `insight` is one of the seven fields, not a stand-in
  // shown only while `decision` is empty. A summary that carries both renders
  // both — the old fallback silently swallowed whichever one arrived second.
  test("renders decision and insight together, neither suppressing the other", () => {
    const session: FormattedSession = {
      id: sessionRecord.id,
      title: sessionRecord.title,
      project: sessionRecord.project,
      createdAtEpoch: sessionRecord.createdAtEpoch,
      content: null,
      insight: ["The reusable conclusion"],
      nextSteps: null,
      decision: "- Decision line one\n- Decision line two",
      done: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).toContain("  decision:");
    expect(output).toContain("    - Decision line one");
    expect(output).toContain("    - Decision line two");
    expect(output).toContain("  insight:");
    expect(output).toContain("    - The reusable conclusion");
  });

  test("renders next field from nextSteps", () => {
    const session: FormattedSession = {
      id: sessionRecord.id,
      title: sessionRecord.title,
      project: sessionRecord.project,
      createdAtEpoch: sessionRecord.createdAtEpoch,
      content: null,
      insight: [],
      nextSteps: "Implement the fix before next session.",
      decision: null,
      done: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).toContain("  next: Implement the fix before next session.");
    expect(output).not.toContain("next_steps:");
  });

  test("renders only state without an embedded milestone timeline", () => {
    const session: FormattedSession = {
      id: sessionRecord.id,
      title: sessionRecord.title,
      project: sessionRecord.project,
      createdAtEpoch: sessionRecord.createdAtEpoch,
      content: "Some content.",
      insight: [],
      nextSteps: null,
      decision: null,
      done: null,
      reference: null,
      turnCount: 1,
      observationCount: 0,
    };
    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).not.toContain("shape signals");
    expect(output).not.toMatch(/── \d{4}-\d{2}-\d{2}/);
  });

  test("uses raw [T<n>] coordinates, renders fields in state-first order, and never renders the retired `current`", () => {
    // `current` is written straight into the (now dead) column, the way a
    // pre-ticket-04 row carries it: the renderer must not surface it.
    db.query(
      `UPDATE sessions
       SET content = ?,
           current = ?,
           next_steps = ?,
           decision = ?,
           done = ?,
           reference = ?
       WHERE id = ?`,
    ).run(
      "One-sentence arc overview.",
      "Retired current field must not render.",
      "Implement the bounded state renderer.",
      "- Active decision [T1]",
      "- Recent useful completion [T1]",
      "- /tmp/spec.md",
      sessionRecord.id,
    );
    const raw = getSession(db, sessionRecord.id)!;
    const formatted: FormattedSession = {
      id: raw.id,
      title: raw.title,
      project: raw.project,
      createdAtEpoch: raw.createdAtEpoch,
      content: raw.content,
      insight: [],
      nextSteps: raw.nextSteps,
      // Simulate context.ts's expanded value; injection must use raw storage.
      decision: '- Active decision [S1/T1] "expanded title"',
      done: '- Recent useful completion [S1/T1] "expanded title"',
      reference: raw.reference,
      turnCount: 1,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(formatted, raw);
    expect(output).toContain("[T1]");
    expect(output).not.toContain("[S1/T1]");
    const orderedLabels = [
      "  content:",
      "  next:",
      "  decision:",
      "  done:",
      "  reference:",
    ];
    const positions = orderedLabels.map((label) => output.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The retired field: stored, and rendered nowhere.
    expect(output).not.toContain("  current:");
    expect(output).not.toContain("Retired current field must not render.");
    expect(raw.current).toBe("Retired current field must not render.");
  });

  test("bounds an oversized legacy state to 2000 tokens while retaining content and next", () => {
    db.query(
      `UPDATE sessions
       SET content = ?,
           current = ?,
           next_steps = ?,
           decision = ?,
           done = ?,
           reference = ?
       WHERE id = ?`,
    ).run(
      "Legacy arc overview must survive.",
      "Retired field.",
      "Next action must survive.",
      `- ${"old decision ".repeat(2_000)}`,
      `- ${"old completion ".repeat(2_000)}`,
      `- ${"/very/old/path ".repeat(2_000)}`,
      sessionRecord.id,
    );
    const raw = getSession(db, sessionRecord.id)!;
    const formatted: FormattedSession = {
      id: raw.id,
      title: raw.title,
      project: raw.project,
      createdAtEpoch: raw.createdAtEpoch,
      content: raw.content,
      insight: [],
      nextSteps: raw.nextSteps,
      decision: raw.decision,
      done: raw.done,
      reference: raw.reference,
      turnCount: 1,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(formatted, raw);
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(2_000);
    expect(output).toContain("Legacy arc overview must survive.");
    expect(output).toContain("Next action must survive.");
  });

  test("drops oversized historical fields before truncating the working state", () => {
    const content = "arc state ".repeat(80);
    const nextSteps = "next action ".repeat(40);
    db.query(
      `UPDATE sessions
       SET content = ?,
           next_steps = ?,
           decision = ?
       WHERE id = ?`,
    ).run(
      content,
      nextSteps,
      `- ${"historical decision ".repeat(2_000)}`,
      sessionRecord.id,
    );
    const raw = getSession(db, sessionRecord.id)!;
    const formatted: FormattedSession = {
      id: raw.id,
      title: raw.title,
      project: raw.project,
      createdAtEpoch: raw.createdAtEpoch,
      content: raw.content,
      insight: [],
      nextSteps: raw.nextSteps,
      decision: raw.decision,
      done: raw.done,
      reference: raw.reference,
      turnCount: 1,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(formatted, raw);

    expect(output).toContain(`  content: ${content}`);
    expect(output).toContain(`  next: ${nextSteps}`);
    expect(output).toContain("state truncated; full summary");
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(2_000);
  });

  // ticket 04, requirement 6: whatever the shape of the overflow, a cut says
  // it was made. The pointer is the last line and is never the line dropped to
  // make room — cutting the announcement of a cut is the silent tail loss.
  test("every truncation announces itself, and the pointer survives an extreme budget", () => {
    const raw = getSession(db, sessionRecord.id)!;
    const formatted: FormattedSession = {
      id: raw.id,
      title: "T".repeat(4_000),
      project: raw.project,
      createdAtEpoch: raw.createdAtEpoch,
      content: "content ".repeat(3_000),
      insight: ["insight ".repeat(500)],
      nextSteps: "next ".repeat(2_000),
      decision: `- ${"decision ".repeat(3_000)}`,
      done: `- ${"done ".repeat(3_000)}`,
      reference: `- ${"reference ".repeat(3_000)}`,
      turnCount: 1,
      observationCount: 0,
    };

    for (const budget of [2_000, 200, 40, 5]) {
      const output = renderCurrentSessionStateOutput(formatted, raw, budget);
      expect(output.split("\n").at(-1)).toBe(
        `  … state truncated; full summary: recall(id="S${raw.id}")`,
      );
    }

    // Ticket 15 finding 9 (documented, not fixed): a budget below the
    // pointer's own token cost is a floor this function does not go beneath
    // — the returned text is longer than `budget` asked for. See
    // `renderBoundedSessionStateOutput`'s own doc comment in
    // mcp/session-output.ts. No production caller passes a budget this
    // small (hooks/session-injection.ts's real ceilings sit near the
    // 2,000-token default).
    const tinyBudgetOutput = renderCurrentSessionStateOutput(formatted, raw, 5);
    expect(estimateDiaryTokens(tinyBudgetOutput)).toBeGreaterThan(5);
  });

  test("renders untitled session when title is null", () => {
    const noTitleRecord = upsertSession(db, {
      contentSessionId: "no-title-session",
      project: "/test/project",
      title: null,
      content: null,
      insight: null,
      createdAtEpoch: 2000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const session: FormattedSession = {
      id: noTitleRecord.id,
      title: null,
      project: noTitleRecord.project,
      createdAtEpoch: noTitleRecord.createdAtEpoch,
      content: null,
      insight: [],
      nextSteps: null,
      decision: null,
      done: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, noTitleRecord);

    expect(output).toContain(`[S${noTitleRecord.id}] (untitled session)`);
  });

  test("keeps the untitled fallback when an oversized legacy state is bounded", () => {
    const noTitleRecord = upsertSession(db, {
      contentSessionId: "oversized-no-title-session",
      project: "/test/project",
      title: null,
      content: "x".repeat(20_000),
      insight: null,
      createdAtEpoch: 2000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const session: FormattedSession = {
      id: noTitleRecord.id,
      title: null,
      project: noTitleRecord.project,
      createdAtEpoch: noTitleRecord.createdAtEpoch,
      content: noTitleRecord.content,
      insight: [],
      nextSteps: null,
      decision: null,
      done: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, noTitleRecord);

    expect(output).toContain(`[S${noTitleRecord.id}] (untitled session)`);
    expect(output).not.toContain(`[S${noTitleRecord.id}] null`);
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(2_000);
  });

  test("renders state without looking up the session in the database", () => {
    const session: FormattedSession = {
      id: 99999,
      title: "Ghost session",
      project: "/test/project",
      createdAtEpoch: 1000,
      content: "Content.",
      insight: [],
      nextSteps: null,
      decision: null,
      done: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const fakeRecord: SessionRecord = {
      id: 99999,
      contentSessionId: "ghost",
      project: "/test/project",
      title: "Ghost",
      content: null,
      insight: null,
      nextSteps: null,
      decision: null,
      done: null,
      reference: null,
      lastCompactTurn: null,
      lastAgentSessionId: null,
      summaryUpdatedAtEpoch: null,
      createdAtEpoch: 1000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    };

    const output = renderCurrentSessionStateOutput(session, fakeRecord);
    expect(output).toContain("[S99999] Ghost session");
    expect(output).toContain("  content: Content.");
  });
});
