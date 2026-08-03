import { describe, expect, mock, test } from "bun:test";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { estimateDiaryTokens } from "../../src/diary/domain";
import { createMilestoneContextHandler } from "../../src/hooks/handlers/context-milestones";
import { MILESTONE_INJECTION_TOKEN_BUDGET } from "../../src/hooks/milestone-injection";
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

  test("bounds a long real milestone timeline at the injection budget", async () => {
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
    const injected = result.hookSpecificOutput!;
    const lines = injected.split("\n");

    // Measured on the WHOLE block, day frames included. This is the shape that
    // used to escape the budget: 31 day headers plus 31 `+N more` hints were
    // 2464 of 3053 tokens, and only render units could degrade, so the arc blew
    // its budget on scaffolding rather than content. Day frames degrade too now
    // (spec §D), which is why the anchors fit and the over-budget note — whose
    // only meaning is "the anchors alone do not fit" — must be absent.
    expect(estimateDiaryTokens(injected)).toBeLessThanOrEqual(
      MILESTONE_INJECTION_TOKEN_BUDGET,
    );
    expect(injected).not.toContain("⚠ over budget");

    // The days the fitter emptied are consecutive, so they cost ONE line, and
    // that line carries the run's date range and the summed count.
    const collapsed = lines.filter((line) =>
      /^── .+ · 0 kept · … \+\d+ more → timeline\(id="S1", view="turns"\) @ within T\d+\.\.T\d+ ──$/u
        .test(line),
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatch(
      /^── \d{4}-\d{2}-\d{2} \w{3}–\d{4}-\d{2}-\d{2} \w{3} · 0 kept · /u,
    );

    // Conservation: this fixture has no citations, so every one of its 120 turns
    // either renders as a row or is counted in some `+N more` — the collapsed
    // run's combined count included.
    const renderedRows = lines.filter((line) => /^ {3}(?:.{1,2} )?T\d+ /u.test(line));
    const hiddenTotal = lines
      .map((line) => line.match(/… \+(\d+) more/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .reduce((sum, match) => sum + Number(match[1]), 0);
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length + hiddenTotal).toBe(120);

    // Every rendered row keeps its full 90-character title: the budget removes
    // whole units, it never halves a title.
    for (const row of renderedRows) {
      const promptNumber = Number(row.match(/T(\d+)/)![1]);
      expect(row).toContain(`${"重大里程碑".repeat(18)} ${promptNumber}`);
    }
    expect(totalChanges(db)).toBe(before);
    db.close();
  });
});
