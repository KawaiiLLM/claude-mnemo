import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession, type SessionRecord } from "../../src/db/sessions";
import { renderCurrentSessionOutput } from "../../src/mcp/session-output";
import type { FormattedSession } from "../../src/mcp/format";

describe("renderCurrentSessionOutput", () => {
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

    const output = renderCurrentSessionOutput(db, session, sessionRecord);

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

    const output = renderCurrentSessionOutput(db, session, sessionRecord);

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

    const output = renderCurrentSessionOutput(db, session, sessionRecord);

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

    const output = renderCurrentSessionOutput(db, session, sessionRecord);

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

    const output = renderCurrentSessionOutput(db, session, sessionRecord);

    expect(output).toContain("  next: Implement the fix before next session.");
    expect(output).not.toContain("next_steps:");
  });

  test("builds a milestone context timeline and leaves view out of render options", () => {
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
    const timelineView = { sessionId: sessionRecord.id };
    const buildContextTimelineView = mock(
      (_db: Database, _sessionId: number, _view: "milestones") => timelineView as never,
    );
    const renderTimeline = mock(
      (_view: never, _options: { promptCap?: number; showEarlierHint?: boolean }) =>
        "rendered milestone timeline",
    );

    const output = renderCurrentSessionOutput(db, session, sessionRecord, {
      buildContextTimelineView,
      renderTimeline,
    });

    expect(buildContextTimelineView).toHaveBeenCalledWith(
      db,
      sessionRecord.id,
      "milestones",
    );
    expect(renderTimeline).toHaveBeenCalledWith(timelineView, {
      promptCap: 80,
      showEarlierHint: true,
    });
    expect(renderTimeline.mock.calls[0]?.[1]).not.toHaveProperty("milestones");
    expect(renderTimeline.mock.calls[0]?.[1]).not.toHaveProperty("phases");
    expect(output).toContain("rendered milestone timeline");
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

    const output = renderCurrentSessionOutput(db, session, noTitleRecord);

    expect(output).toContain(`[S${noTitleRecord.id}] (untitled session)`);
  });

  test("is resilient when timeline rendering throws", () => {
    // Pass an invalid session record id so buildContextTimelineView might
    // throw or return empty; either way the function must not propagate.
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

    // Should not throw; content lines still present
    expect(() => renderCurrentSessionOutput(db, session, fakeRecord)).not.toThrow();
    const output = renderCurrentSessionOutput(db, session, fakeRecord);
    expect(output).toContain("[S99999] Ghost session");
    expect(output).toContain("  content: Content.");
  });
});
