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

// ownership-and-note-cadence spec, "session 字段" ([S15069/T910]-[T913]):
// decision/done/next_steps/reference/insight retire from this renderer
// unconditionally — title and content are the session's only two remaining
// semantic fields, on every reader, legacy row or not. This supersedes
// ticket 04/D2's rendering of the six fields (see the old fixtures below,
// preserved only where they still exercise a live mechanism: the token
// budget / truncation-pointer ladder).
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
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, sessionRecord);

    expect(output).toContain("  content: Test session content description.");
  });

  test("never renders decision/done/next/reference/insight, even when raw storage still carries them from a pre-retirement write", () => {
    // Written straight into the (now dead-for-rendering) columns, the way a
    // pre-[S15069/T910] row carries them: the renderer must not surface any
    // of the six.
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
      turnCount: 1,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(formatted, raw);

    expect(output).toContain("One-sentence arc overview.");
    expect(output).not.toContain("  current:");
    expect(output).not.toContain("  next:");
    expect(output).not.toContain("  decision:");
    expect(output).not.toContain("  done:");
    expect(output).not.toContain("  reference:");
    expect(output).not.toContain("insight:");
    expect(output).not.toContain("Retired current field must not render.");
    expect(output).not.toContain("Implement the bounded state renderer.");
    expect(output).not.toContain("Active decision");
    expect(output).not.toContain("Recent useful completion");
    expect(output).not.toContain("/tmp/spec.md");
    // Stored, and rendered nowhere.
    expect(raw.current).toBe("Retired current field must not render.");
    expect(raw.decision).toBe("- Active decision [T1]");
  });

  test("bounds an oversized legacy content field to 2000 tokens", () => {
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
      `Legacy arc overview must survive. ${"content filler ".repeat(2_000)}`,
      "Retired field.",
      "Next action must not survive (retired).",
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
      turnCount: 1,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(formatted, raw);
    expect(estimateDiaryTokens(output)).toBeLessThanOrEqual(2_000);
    expect(output).toContain("Legacy arc overview must survive.");
    expect(output).not.toContain("Next action must not survive");
  });

  // ownership-and-note-cadence spec: whatever the shape of the overflow, a cut
  // says it was made. The pointer is the last line and is never the line
  // dropped to make room — cutting the announcement of a cut is the silent
  // tail loss (ticket 04, requirement 6, still true with content as the only
  // field left to cut).
  test("every truncation announces itself, and the pointer survives an extreme budget", () => {
    const raw = getSession(db, sessionRecord.id)!;
    const formatted: FormattedSession = {
      id: raw.id,
      title: "T".repeat(4_000),
      project: raw.project,
      createdAtEpoch: raw.createdAtEpoch,
      content: "content ".repeat(3_000),
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
      turnCount: 0,
      observationCount: 0,
    };

    const output = renderCurrentSessionStateOutput(session, noTitleRecord);

    expect(output).toContain(`[S${noTitleRecord.id}] (untitled session)`);
  });

  test("keeps the untitled fallback when an oversized legacy content is bounded", () => {
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
      turnCount: 0,
      observationCount: 0,
    };

    const fakeRecord: SessionRecord = {
      id: 99999,
      contentSessionId: "ghost",
      project: "/test/project",
      transcriptPath: null,
      title: "Ghost",
      content: null,
      insight: null,
      nextSteps: null,
      decision: null,
      done: null,
      current: null,
      reference: null,
      lastCompactTurn: null,
      summaryUpdatedAtEpoch: null,
      scanCursorByteOffset: 0,
      scanCursorLine: 0,
      parentSessionId: null,
      lineageStatus: "unchecked",
      createdAtEpoch: 1000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    };

    const output = renderCurrentSessionStateOutput(session, fakeRecord);
    expect(output).toContain("[S99999] Ghost session");
    expect(output).toContain("  content: Content.");
  });
});
