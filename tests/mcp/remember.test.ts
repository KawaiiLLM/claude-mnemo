import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getObservation, getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { searchMemory } from "../../src/db/search";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { rememberInputSchema } from "../../src/mcp/definitions";
import { recallMemory } from "../../src/mcp/recall";
import { bracketBareTurnReferences, rememberTool } from "../../src/mcp/remember";

describe("remember tool routing and validation", () => {
  let db: Database;
  let sessionId: number;
  let turnId: number;
  let observationId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    sessionId = upsertSession(db, {
      contentSessionId: "remember-session",
      project: "claude-mnemo",
      title: "Before update",
      content: "Initial session summary",
      insight: "- initial insight",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'active', ?, ?)",
    ).run(sessionId, 1, "Fix auth race", 120);

    turnId = db
      .query<{ id: number }, []>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(sessionId, 1)!.id;

    db.query(
      "INSERT INTO observations (turn_id, tool_name, tool_input, tool_result, status, created_at_epoch) VALUES (?, ?, ?, ?, 'pending', ?)",
    ).run(
      turnId,
      "Read",
      "{\"file_path\":\"src/auth.ts\"}",
      "file contents",
      130,
    );

    observationId = db
      .query<{ id: number }, []>("SELECT id FROM observations WHERE turn_id = ?")
      .get(turnId)!.id;
  });

  afterEach(() => {
    db.close();
  });

  test("public schema rejects removed parent-based remember arguments", () => {
    expect(() =>
      rememberInputSchema.parse({
        parent: `S${sessionId}`,
        prompt_number: 1,
        title: "No longer supported",
      }),
    ).toThrow();
  });

  test("updates an existing turn by T{id}", () => {
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Persists the extracted turn through its stable DB id.",
      insight: "- mutex added",
      type: "bugfix",
      tags: ["auth", "concurrency"],
    });

    const turn = getTurn(db, sessionId, 1)!;

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    expect(turn.status).toBe("extracted");
    expect(turn.title).toBe("Fix auth race");
    expect(turn.content).toBe(
      "Persists the extracted turn through its stable DB id.",
    );
  });

  test("supports explicit skipped and undone turn statuses by id", () => {
    const skipped = rememberTool(db, {
      id: `T${turnId}`,
      status: "skipped",
    });

    expect(skipped.content[0]?.text).toContain("status skipped");
    expect(getTurn(db, sessionId, 1)?.status).toBe("skipped");

    const undone = rememberTool(db, {
      id: `T${turnId}`,
      status: "undone",
    });

    expect(undone.content[0]?.text).toContain("status undone");
    expect(getTurn(db, sessionId, 1)?.status).toBe("undone");
  });

  test("updates an existing observation by O{id}", () => {
    const result = rememberTool(db, {
      id: `O${observationId}`,
      title: "Read auth module",
      content: "Examined the token refresh flow and locking behavior.",
    });

    const observation = getObservation(db, observationId)!;

    expect(result.content[0]?.text).toContain(`Updated observation O${observationId}`);
    expect(observation.title).toBe("Read auth module");
    expect(observation.content).toBe(
      "Examined the token refresh flow and locking behavior.",
    );
  });

  test("rejects legacy observation fields on the O{id} route", () => {
    const result = rememberTool(db, {
      id: `O${observationId}`,
      title: "Read auth module",
      insight: "- legacy insight" as never,
    });

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain(
      "observation remember only accepts title, content, and status.",
    );
  });

  test("rejects session-only summary fields on the O{id} route", () => {
    const result = rememberTool(db, {
      id: `O${observationId}`,
      title: "Read auth module",
      decision: "should be rejected" as never,
    });

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain(
      "observation remember only accepts title, content, and status.",
    );
    // The observation must be left untouched (no silent partial write).
    expect(getObservation(db, observationId)?.title).toBeNull();
  });

  test("rejects unsupported observation statuses", () => {
    const result = rememberTool(db, {
      id: `O${observationId}`,
      status: "active" as never,
    });

    expect(result.content[0]?.text).toContain("Parameter error:");
    expect(result.content[0]?.text).toContain("observation remember");
  });

  test("removes skipped observations and finalized skipped or undone turns from FTS", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Persists the extracted turn through its stable DB id.",
      insight: "- mutex added",
      type: "bugfix",
      tags: ["auth", "concurrency"],
    });
    rememberTool(db, {
      id: `O${observationId}`,
      title: "Read auth module",
      content: "Examined the token refresh flow and locking behavior.",
    });

    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
        )
        .get(turnId)?.count,
    ).toBe(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
        )
        .get(observationId)?.count,
    ).toBe(1);

    rememberTool(db, {
      id: `T${turnId}`,
      status: "undone",
    });
    rememberTool(db, {
      id: `O${observationId}`,
      status: "skipped",
    });

    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
        )
        .get(turnId)?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM memory_fts WHERE layer = 'observation' AND source_id = ?",
        )
        .get(observationId)?.count,
    ).toBe(0);
  });

  test("rewrites the whole session summary by S{id}", () => {
    const result = rememberTool(db, {
      id: `S${sessionId}`,
      title: "After update",
      content: "Updated session summary",
      decision: "Chose a mutex over a channel [T1]",
      done: "Shipped the auth fix [T1]",
      current: "Awaiting review",
      next_steps: "Ship the follow-up cleanup",
      reference: "",
    });

    const session = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain(`Updated session ${sessionId}`);
    expect(session.title).toBe("After update");
    expect(session.content).toBe("Updated session summary");
    expect(session.decision).toBe("Chose a mutex over a channel [T1]");
    expect(session.done).toBe("Shipped the auth fix [T1]");
    expect(session.current).toBe("Awaiting review");
    expect(session.nextSteps).toBe("Ship the follow-up cleanup");
    // Empty fields persist as NULL so read-side legacy fallback stays uniform.
    expect(session.reference).toBeNull();
    expect(session.summaryUpdatedAtEpoch).toBeGreaterThanOrEqual(110);
  });

  test("rejects a partial session summary and leaves the row untouched (all-or-nothing)", () => {
    const before = getSession(db, sessionId)!;

    const result = rememberTool(db, {
      id: `S${sessionId}`,
      title: "Only a title",
      content: "Only content",
      next_steps: "Only next",
      // decision / done / current / reference omitted
    });

    const after = getSession(db, sessionId)!;

    expect(result.content[0]?.text).toContain("Parameter error");
    expect(result.content[0]?.text).toContain("decision");
    // No partial write: the prior summary survives intact.
    expect(after.title).toBe(before.title);
    expect(after.content).toBe(before.content);
    expect(after.summaryUpdatedAtEpoch).toBe(before.summaryUpdatedAtEpoch);
  });

  test("indexes the new summary fields into FTS so recall can find them (D8)", () => {
    rememberTool(db, {
      id: `S${sessionId}`,
      title: "Auth work",
      content: "Session about the auth refactor",
      decision: "Adopted the quorumlock strategy for refresh",
      done: "Migrated the schema",
      current: "Reviewing",
      next_steps: "Ship it",
      reference: "",
    });

    // A distinctive word that lives only in `decision` must hit the session.
    const hits = searchMemory(db, {
      scope: "sessions",
      query: "quorumlock",
    });

    expect(hits.map((hit) => hit.sourceId)).toContain(sessionId);
  });

  test("legacy session with insight + next_steps keeps insight searchable (D8 no regression)", () => {
    // Old-shape session: insight set, next_steps set, no new fields. The
    // legacy `insight` must still land in FTS (next_steps must not suppress it).
    const legacyId = upsertSession(db, {
      contentSessionId: "legacy-fts",
      project: "claude-mnemo",
      title: "Legacy",
      content: "Legacy session",
      insight: "- distinctiveinsightword captured here",
      nextSteps: "follow up later",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;

    const hits = searchMemory(db, {
      scope: "sessions",
      query: "distinctiveinsightword",
    });

    expect(hits.map((hit) => hit.sourceId)).toContain(legacyId);
  });

  test("a rewrite with empty decision clears stale legacy insight (no fallback leak)", () => {
    // The fixture session carries a legacy insight from the old schema.
    expect(getSession(db, sessionId)!.insight).toBe("- initial insight");

    // A whole rewrite with an empty decision is valid. It must clear insight so
    // the decision-empty read fallback does not resurface the stale value.
    rememberTool(db, {
      id: `S${sessionId}`,
      title: "Reworked",
      content: "Session reworked under the new model",
      decision: "",
      done: "Did the thing",
      current: "Stable",
      next_steps: "Next",
      reference: "",
    });

    expect(getSession(db, sessionId)!.insight).toBeNull();

    const expanded = recallMemory(db, {
      id: `S${sessionId}`,
      depth: "expanded",
    });
    expect(expanded).not.toContain("initial insight");
    expect(expanded).toContain("Did the thing");
  });

  test("always advances summaryUpdatedAtEpoch on a successful rewrite (D5)", () => {
    const before = getSession(db, sessionId)!;

    // Re-supply byte-identical fields — the epoch must STILL advance so a
    // stale-forced refresh clears the staleness reminder (no livelock).
    rememberTool(db, {
      id: `S${sessionId}`,
      title: before.title ?? "",
      content: before.content ?? "",
      decision: before.decision ?? "",
      done: before.done ?? "",
      current: before.current ?? "",
      next_steps: before.nextSteps ?? "",
      reference: before.reference ?? "",
    });

    const after = getSession(db, sessionId)!;

    expect(after.summaryUpdatedAtEpoch ?? 0).toBeGreaterThan(
      before.summaryUpdatedAtEpoch ?? 0,
    );
  });

  test("does not create extra observations while updating O{id}", () => {
    rememberTool(db, {
      id: `O${observationId}`,
      title: "Updated observation",
      content: "Updated through routed observation remember.",
    });

    expect(getObservationsForTurn(db, turnId)).toHaveLength(1);
  });

  test("type/tags-only turn remember yields skipped, not extracted (no phantom)", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      type: "bugfix",
      tags: ["auth"],
    });

    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.status).toBe("skipped");
  });

  test("turn remember with a title yields extracted status", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      type: "bugfix",
    });

    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.status).toBe("extracted");
  });

  test("turn remember brackets a bare predecessor id woven into content", () => {
    // Seed an earlier turn (lower DB id) and a later one; the later turn's
    // content names the earlier by bare id, as the agent tends to mid-sentence.
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'active', ?, ?)",
    ).run(sessionId, 2, "Revert it", 140);
    const laterId = db
      .query<{ id: number }, []>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(sessionId, 2)!.id;

    rememberTool(db, {
      id: `T${laterId}`,
      title: "Revert the inversion",
      content: `Reverted the fg inversion from T${turnId} due to arrow contamination.`,
      type: "bugfix",
    });

    expect(getTurn(db, sessionId, 2)?.content).toBe(
      `Reverted the fg inversion from [T${turnId}] due to arrow contamination.`,
    );
  });

  test("turn remember leaves a cross-session / non-existent bare id untouched", () => {
    // The turn being written (prompt 2, this session).
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'active', ?, ?)",
    ).run(sessionId, 2, "Mention another session", 140);
    const laterId = db
      .query<{ id: number }, []>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(sessionId, 2)!.id;

    // A turn in a DIFFERENT session — a bare mention of its id must NOT bracket,
    // even though numerically it is below the current turn id.
    const otherSessionId = upsertSession(db, {
      contentSessionId: "other-session",
      project: "claude-mnemo",
      title: "Other",
      content: "Other session",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: null,
    }).id;
    db.query(
      "INSERT INTO turns (session_id, prompt_number, status, user_prompt, created_at_epoch) VALUES (?, ?, 'active', ?, ?)",
    ).run(otherSessionId, 1, "Elsewhere", 150);
    const otherTurnId = db
      .query<{ id: number }, []>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(otherSessionId, 1)!.id;

    rememberTool(db, {
      id: `T${laterId}`,
      title: "Unrelated work",
      content: `Incidental mention of T${otherTurnId} and a forward T999999 ref.`,
      type: "change",
    });

    // Cross-session id and non-existent forward id both stay bare.
    expect(getTurn(db, sessionId, 2)?.content).toBe(
      `Incidental mention of T${otherTurnId} and a forward T999999 ref.`,
    );
  });
});

describe("bracketBareTurnReferences", () => {
  // Stand-in for the DB-aware predicate: accept anything below 4300 as a valid
  // predecessor. The same-session / prompt_number / existence logic is exercised
  // end-to-end by the rememberTool integration tests above.
  const isPred = (id: number) => id < 4300;

  test("unwraps a parenthesized bare id into brackets", () => {
    expect(bracketBareTurnReferences("inversion (T4243) caused", isPred)).toBe(
      "inversion [T4243] caused",
    );
  });

  test("brackets a bare id woven mid-sentence", () => {
    expect(bracketBareTurnReferences("reverted in T4244 due", isPred)).toBe(
      "reverted in [T4244] due",
    );
  });

  test("brackets multiple bare ids in one pass", () => {
    expect(
      bracketBareTurnReferences("from T4243 and (T4244)", isPred),
    ).toBe("from [T4243] and [T4244]");
  });

  test("inserts a space when the id abuts non-space text (comma)", () => {
    expect(bracketBareTurnReferences("balance,T4243 ok", isPred)).toBe(
      "balance, [T4243] ok",
    );
  });

  test("leaves an id the predicate rejects untouched", () => {
    // self / forward / cross-session / missing all surface as predicate=false
    expect(bracketBareTurnReferences("this is T4300 itself", isPred)).toBe(
      "this is T4300 itself",
    );
    expect(bracketBareTurnReferences("see T9999 later", isPred)).toBe(
      "see T9999 later",
    );
    expect(bracketBareTurnReferences("ref (T4243) here", () => false)).toBe(
      "ref (T4243) here",
    );
  });

  test("never double-brackets an already-bracketed id", () => {
    expect(bracketBareTurnReferences("see [T4243] ok", isPred)).toBe(
      "see [T4243] ok",
    );
  });

  test("skips a digit run glued into a larger token", () => {
    expect(bracketBareTurnReferences("fooT123bar baseline", isPred)).toBe(
      "fooT123bar baseline",
    );
  });

  test("no-ops on empty content", () => {
    expect(bracketBareTurnReferences("", () => true)).toBe("");
  });
});
