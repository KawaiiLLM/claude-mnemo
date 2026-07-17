import { describe, expect, mock, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import { createMilestoneContextHandler } from "../../src/hooks/handlers/context-milestones";
import type { NormalizedHookInput } from "../../src/hooks/types";

function sessionStartInput(sessionId: string): NormalizedHookInput {
  return {
    eventName: "SessionStart",
    source: "resume",
    sessionId,
    cwd: "/projects/milestones",
    stopHookActive: false,
    raw: {},
  };
}

function totalChanges(db: ReturnType<typeof createDatabase>): number {
  return db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count;
}

describe("createMilestoneContextHandler", () => {
  test("is silent for a session with no turns and performs no DB writes", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    upsertSession(db, {
      contentSessionId: "empty-milestones",
      project: "/projects/milestones",
      title: "Empty milestones",
      insight: null,
      createdAtEpoch: 1_700_000_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const render = mock(() => "must not render");
    const before = totalChanges(db);

    const result = await createMilestoneContextHandler({
      db,
      renderMilestoneInjection: render,
    })(sessionStartInput("empty-milestones"));

    expect(result).toEqual({ continue: true });
    expect(render).not.toHaveBeenCalled();
    expect(totalChanges(db)).toBe(before);
    db.close();
  });

  test("renders the current session timeline and performs no DB writes", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const session = upsertSession(db, {
      contentSessionId: "milestone-history",
      project: "/projects/milestones",
      title: "Milestone history",
      insight: null,
      createdAtEpoch: 1_700_000_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        title,
        type,
        created_at_epoch
      ) VALUES (?, 1, 'extracted', 'ship it', 'done', 'Shipped', 'feature', ?)`,
    ).run(session.id, 1_700_000_060);
    const render = mock((_db, sessionId: number) => `milestones for S${sessionId}`);
    const before = totalChanges(db);

    const result = await createMilestoneContextHandler({
      db,
      renderMilestoneInjection: render,
    })(sessionStartInput("milestone-history"));

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: `milestones for S${session.id}`,
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(totalChanges(db)).toBe(before);
    db.close();
  });

  test("bounds a long real milestone timeline and points to timeline()", async () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const session = upsertSession(db, {
      contentSessionId: "long-milestone-history",
      project: "/projects/milestones",
      title: "Long milestone history",
      insight: null,
      createdAtEpoch: 1_700_000_000,
      updatedAtEpoch: 1_702_600_000,
      completedAtEpoch: null,
    });
    const insert = db.query(
      `INSERT INTO turns (
        session_id,
        prompt_number,
        status,
        user_prompt,
        assistant_response,
        title,
        type,
        tool_call_count,
        created_at_epoch
      ) VALUES (?, ?, 'extracted', ?, 'done', ?, ?, 20, ?)`,
    );
    for (let promptNumber = 1; promptNumber <= 120; promptNumber += 1) {
      insert.run(
        session.id,
        promptNumber,
        `prompt ${promptNumber}`,
        `${"重大里程碑".repeat(18)} ${promptNumber}`,
        promptNumber % 2 === 0 ? "decision" : "feature",
        1_700_000_000 + promptNumber * 21_600,
      );
    }
    const before = totalChanges(db);

    const result = await createMilestoneContextHandler({ db })(
      sessionStartInput("long-milestone-history"),
    );

    expect(result.hookSpecificOutput).toBeDefined();
    expect(estimateDiaryTokens(result.hookSpecificOutput!)).toBeLessThanOrEqual(
      2_000,
    );
    expect(result.hookSpecificOutput).toContain('timeline(id="S1")');
    expect(result.hookSpecificOutput).toContain("T1");
    const renderedMilestoneTitles = result.hookSpecificOutput!
      .split("\n")
      .filter((line) => /^\s+(?:(?:🚫|↩️|🏁)\s+)?T\d+\s+\S+\s+/.test(line))
      .map((line) =>
        line.replace(/^\s+(?:(?:🚫|↩️|🏁)\s+)?T\d+\s+\S+\s+/, "")
      );
    expect(renderedMilestoneTitles.length).toBeGreaterThan(0);
    expect(
      renderedMilestoneTitles.every((title) => [...title].length <= 51),
    ).toBe(true);
    expect(totalChanges(db)).toBe(before);
    db.close();
  });
});
