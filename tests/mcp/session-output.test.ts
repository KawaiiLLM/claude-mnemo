import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { getSession, upsertSession, type SessionRecord } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import {
  renderCurrentSessionOutput,
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
      current: null,
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
      current: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).toContain("  content: Test session content description.");
  });

  test("renders legacy insight bullets when decision is absent", () => {
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
      current: null,
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

  test("renders decision bullets (4-space indent) and skips insight fallback", () => {
    const session: FormattedSession = {
      id: sessionRecord.id,
      title: sessionRecord.title,
      project: sessionRecord.project,
      createdAtEpoch: sessionRecord.createdAtEpoch,
      content: null,
      insight: ["Should not appear"],
      nextSteps: null,
      decision: "- Decision line one\n- Decision line two",
      done: null,
      current: null,
      reference: null,
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).toContain("  decision:");
    expect(output).toContain("    - Decision line one");
    expect(output).toContain("    - Decision line two");
    expect(output).not.toContain("  insight:");
    expect(output).not.toContain("Should not appear");
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
      current: null,
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
      current: null,
      reference: null,
      turnCount: 1,
      observationCount: 0,
    };
    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).not.toContain("shape signals");
    expect(output).not.toMatch(/── \d{4}-\d{2}-\d{2}/);
  });

  test("renders the worker re-prime from state, the arc skeleton, and a bare recent index", () => {
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
      current: null,
      reference: null,
      turnCount: 1,
      observationCount: 0,
    };
    db.query(
      `INSERT INTO turns (
         session_id, prompt_number, status, title, content, insight,
         significance_grade, created_at_epoch
       ) VALUES
         (?, 1, 'extracted', 'Task origin', 'Why the task exists', '- Success means green', 4, 200),
         (?, 2, 'extracted', 'Design anchor', 'Architecture changed', '- Use the new boundary', 3, 201),
         (?, 3, 'extracted', 'Routine progress', 'OLD DESCRIBED INDEX DETAIL', NULL, 1, 202)`,
    ).run(sessionRecord.id, sessionRecord.id, sessionRecord.id);

    const output = renderCurrentSessionOutput(db, session, sessionRecord, {
      taskCausalityEraCutoffEpoch: 200,
    });

    expect(output).toContain(`[S${sessionRecord.id}] Test session title`);
    expect(output).toContain("Live G4 foundations:");
    expect(output).toContain("[dbid:T1] G4 Task origin");
    expect(output).toContain("Live G3 anchors:");
    expect(output).toContain("[dbid:T2] G3 Design anchor");
    expect(output).toContain("Recent turns (bare index):");
    expect(output).toContain("[dbid:T3] G1 Routine progress");
    expect(output).not.toContain("OLD DESCRIBED INDEX DETAIL");
    expect(output).not.toContain("shape signals");
    expect(output).not.toMatch(/── \d{4}-\d{2}-\d{2}/);
  });

  test("uses raw [T<n>] coordinates and renders fields in state-first order", () => {
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
      "Current work is ticket 02.",
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
      current: raw.current,
      reference: raw.reference,
      turnCount: 1,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(formatted, raw);
    expect(output).toContain("[T1]");
    expect(output).not.toContain("[S1/T1]");
    const orderedLabels = [
      "  content:",
      "  current:",
      "  next:",
      "  decision:",
      "  done:",
      "  reference:",
    ];
    const positions = orderedLabels.map((label) => output.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("bounds an oversized legacy state to 2000 tokens while retaining current and next", () => {
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
      "Legacy arc overview.",
      "Current state must survive.",
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
      current: raw.current,
      reference: raw.reference,
      turnCount: 1,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(formatted, raw);
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(2_000);
    expect(output).toContain("Current state must survive.");
    expect(output).toContain("Next action must survive.");
  });

  test("drops oversized historical fields before truncating current state", () => {
    const content = "arc state ".repeat(80);
    const current = "current state ".repeat(60);
    const nextSteps = "next action ".repeat(40);
    db.query(
      `UPDATE sessions
       SET content = ?,
           current = ?,
           next_steps = ?,
           decision = ?
       WHERE id = ?`,
    ).run(
      content,
      current,
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
      current: raw.current,
      reference: raw.reference,
      turnCount: 1,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(formatted, raw);

    expect(output).toContain(`  content: ${content}`);
    expect(output).toContain(`  current: ${current}`);
    expect(output).toContain(`  next: ${nextSteps}`);
    expect(output).toContain("state truncated; full summary");
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(2_000);
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
      current: null,
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
      current: null,
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
      current: null,
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
      current: null,
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
