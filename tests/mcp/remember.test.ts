import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { getTurnCitations } from "../../src/db/citations";
import { createDatabase } from "../../src/db/database";
import { getObservation, getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { searchMemory } from "../../src/db/search";
import { getSession, upsertSession } from "../../src/db/sessions";
import { getTurn, getTurnById } from "../../src/db/turns";
import { estimateDiaryTokens } from "../../src/diary/domain";
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

  test("public schema accepts grades 0-4 and rejects out-of-range grades", () => {
    expect(
      rememberInputSchema.parse({
        id: `T${turnId}`,
        grade: 4,
        regrade: { id: `T${turnId}`, grade: 0 },
      }),
    ).toEqual({
      id: `T${turnId}`,
      grade: 4,
      regrade: { id: `T${turnId}`, grade: 0 },
    });
    expect(() =>
      rememberInputSchema.parse({ id: `T${turnId}`, grade: -1 }),
    ).toThrow();
    expect(() =>
      rememberInputSchema.parse({ id: `T${turnId}`, grade: 5 }),
    ).toThrow();
    expect(() =>
      rememberInputSchema.parse({
        id: `T${turnId}`,
        grade: 2,
        regrade: { id: `T${turnId}`, grade: 1.5 },
      }),
    ).toThrow();
  });

  test("public schema distinguishes an explicit null (clear) from an absent field (omit) on grade/title/content/insight (D10)", () => {
    // Explicit null parses through — the clear expression the ticket adds.
    const cleared = rememberInputSchema.parse({
      id: `T${turnId}`,
      grade: null,
      title: null,
      content: null,
      insight: null,
    });
    expect(cleared).toEqual({
      id: `T${turnId}`,
      grade: null,
      title: null,
      content: null,
      insight: null,
    });
    for (const key of ["grade", "title", "content", "insight"] as const) {
      expect(Object.prototype.hasOwnProperty.call(cleared, key)).toBe(true);
      expect(cleared[key]).toBeNull();
    }

    // Omitting the same fields leaves them absent from the parsed object —
    // never coerced to null, which would collapse omit into clear.
    const omitted = rememberInputSchema.parse({ id: `T${turnId}` });
    for (const key of ["grade", "title", "content", "insight"] as const) {
      expect(Object.prototype.hasOwnProperty.call(omitted, key)).toBe(false);
      expect(omitted[key]).toBeUndefined();
    }
  });

  // Multi-valued since ticket 02 (spec B5): `type` has no separate null-clear
  // value the way grade/title/content/insight do — `[]` already means "no
  // type" (spec B7), so it is both the empty state and the explicit clear.
  test("public schema treats an empty type array as a clear, omission as leave-alone", () => {
    const cleared = rememberInputSchema.parse({ id: `T${turnId}`, type: [] });
    expect(cleared.type).toEqual([]);

    const omitted = rememberInputSchema.parse({ id: `T${turnId}` });
    expect(Object.prototype.hasOwnProperty.call(omitted, "type")).toBe(false);
    expect(omitted.type).toBeUndefined();
  });

  test("updates an existing turn by T{id}", () => {
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Persists the extracted turn through its stable DB id.",
      insight: "- mutex added",
      type: ["fix"],
      tags: ["auth", "concurrency"],
      grade: 2,
    });

    const turn = getTurn(db, sessionId, 1)!;

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    expect(turn.status).toBe("extracted");
    expect(turn.title).toBe("Fix auth race");
    expect(turn.content).toBe(
      "Persists the extracted turn through its stable DB id.",
    );
    expect(turn.significanceGrade).toBe(2);
  });

  test("regrades an earlier turn without changing its other fields", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Earlier estimate",
      content: "Recorded the initial estimate.",
      insight: "- initial",
      type: ["research"],
      tags: ["estimate"],
      grade: 2,
    });
    const currentTurnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, created_at_epoch
         ) VALUES (?, 2, 'active', 'Correct the estimate', 140)
         RETURNING id`,
      )
      .get(sessionId)!.id;
    const before = getTurn(db, sessionId, 1)!;

    const result = rememberTool(db, {
      id: `T${currentTurnId}`,
      title: "Corrected estimate",
      content: `Evidence disproved [T${turnId}].`,
      type: ["research"],
      tags: ["correction", "estimate"],
      grade: 2,
      regrade: { id: `T${turnId}`, grade: 1 },
    });

    const after = getTurn(db, sessionId, 1)!;
    expect(result.content[0]?.text).toContain(`Regraded turn T${turnId} to 1`);
    expect(after).toEqual({
      ...before,
      significanceGrade: 1,
    });
    expect(getTurn(db, sessionId, 2)?.significanceGrade).toBe(2);
  });

  test("supports explicit skipped and undone turn statuses by id", () => {
    const skipped = rememberTool(db, {
      id: `T${turnId}`,
      status: "skipped",
      grade: 0,
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

  test("keeps skipped observations and undone turns in FTS, with the originals intact", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Persists the extracted turn through its stable DB id.",
      insight: "- mutex added",
      type: ["fix"],
      tags: ["auth", "concurrency"],
      grade: 2,
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

    // FTS ingest is decoupled from status (spec D11): a terminal status changes
    // what a reader is SHOWN, never whether the text can be found.
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

  test("rejects an over-budget rendered state with per-field token details, then accepts a trimmed rewrite", () => {
    const before = getSession(db, sessionId)!;
    const oversizedDecision = `- ${"历史决策".repeat(900)}`;
    const rejected = rememberTool(db, {
      id: `S${sessionId}`,
      title: "Oversized state",
      content: "One-sentence arc overview.",
      decision: oversizedDecision,
      done: `- ${"历史完成".repeat(900)}`,
      current: "Implementation is in progress.",
      next_steps: "Trim historical fields and retry.",
      reference: "- /tmp/spec.md",
    });

    const error = rejected.content[0]?.text ?? "";
    expect(error).toContain("Parameter error:");
    expect(error).toContain("rendered state exceeds 2000 tokens");
    for (const field of [
      "title=",
      "content=",
      "current=",
      "next_steps=",
      "decision=",
      "done=",
      "reference=",
      "total=",
    ]) {
      expect(error).toContain(field);
    }
    expect(getSession(db, sessionId)).toEqual(before);

    const accepted = rememberTool(db, {
      id: `S${sessionId}`,
      title: "Trimmed state",
      content: "One-sentence arc overview.",
      decision: "- Active decision [T1]",
      done: "- Recent useful completion [T1]",
      current: "Implementation is in progress.",
      next_steps: "Run the next ticket.",
      reference: "- /tmp/spec.md",
    });
    expect(accepted.content[0]?.text).toContain(`Updated session ${sessionId}`);
    const updated = getSession(db, sessionId)!;
    expect(
      estimateDiaryTokens(
        [
          `[S${updated.id}] ${updated.title}`,
          `  content: ${updated.content}`,
          `  current: ${updated.current}`,
          `  next: ${updated.nextSteps}`,
          `  decision:\n    ${updated.decision}`,
          `  done:\n    ${updated.done}`,
          `  reference:\n    ${updated.reference}`,
        ].join("\n"),
      ),
    ).toBeLessThanOrEqual(2_000);
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

  test("session remember decodes HTML entities in decision (single pass)", () => {
    rememberTool(db, {
      id: `S${sessionId}`,
      title: "Auth work",
      content: "Session about the auth refactor",
      decision: "Reverted the change from T&lt;n&gt; due to a regression",
      done: "Shipped the fix",
      current: "Reviewing",
      next_steps: "Ship it",
      reference: "",
    });

    const session = getSession(db, sessionId)!;
    expect(session.decision).toBe(
      "Reverted the change from T<n> due to a regression",
    );
  });

  test("session remember decodes &amp;lt; to &lt; without double-decoding to <", () => {
    rememberTool(db, {
      id: `S${sessionId}`,
      title: "Auth work",
      content: "Session about the auth refactor",
      decision: "Literal entity in the wild: &amp;lt;",
      done: "Shipped the fix",
      current: "Reviewing",
      next_steps: "Ship it",
      reference: "",
    });

    const session = getSession(db, sessionId)!;
    expect(session.decision).toBe("Literal entity in the wild: &lt;");
  });

  test("turn remember decodes HTML entities before bracketing bare turn references", () => {
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
      content: `Reverted the fg inversion from T&lt;${turnId}&gt; and bare T${turnId} due to arrow contamination.`,
      type: ["fix"],
      grade: 2,
    });

    // The entity-wrapped form decodes to a bracket-shaped string that never
    // matches the bare-id pattern (its digits are wrapped in literal `<`/`>`,
    // not left bare), so only the genuinely bare `T<id>` mention gets bracketed.
    expect(getTurn(db, sessionId, 2)?.content).toBe(
      `Reverted the fg inversion from T<${turnId}> and bare [T${turnId}] due to arrow contamination.`,
    );
  });

  test("turn remember decodes HTML entities in tags elements", () => {
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Persists the extracted turn.",
      type: ["fix"],
      tags: ["a&amp;b", "rolled-back"],
      grade: 2,
    });

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.tags).toContain("a&b");
    expect(turn.tags).toContain("rolled-back");
  });

  // Peer review item 3 on ticket 02 (spec B6): the migration stripped every
  // EXISTING `topic:`-prefixed tag once; nothing stopped a caller writing the
  // prefix straight back in until this check landed — this test used to
  // expect `topic:a&b` to persist (see the HTML-entity-decode test above,
  // which used it incidentally and is now rewritten to a bare tag).
  test("a topic:-prefixed tag is rejected with a readable parameter error, and nothing is stored (spec B6)", () => {
    const before = getTurn(db, sessionId, 1);
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      tags: ["topic:estimate"],
      grade: 2,
    });

    expect(result.content[0]?.text).toContain("Parameter error");
    expect(result.content[0]?.text).toContain("topic:estimate");
    expect(result.content[0]?.text).toContain("retired");
    // Nothing lands — not the title, not the retired tag.
    expect(getTurn(db, sessionId, 1)).toEqual(before);
  });

  // D5a (peer review item 2): `remember.tags` used to route through
  // `mergeTags`, so `tags: ["b"]` over a stored `["a"]` appended instead of
  // replacing, and `tags: []` merged to a no-op and cleared nothing. `note`
  // already routed through `replaceTags`; this proves `remember` now matches
  // it — present replaces the stored list whole, absent leaves it alone.
  test("remember tags overwrite the stored list whole rather than merging, and an explicit [] clears it (D5a)", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      tags: ["a"],
      grade: 2,
    });
    expect(getTurn(db, sessionId, 1)!.tags).toEqual(["a"]);

    const overwritten = rememberTool(db, { id: `T${turnId}`, tags: ["b"] });
    expect(overwritten.content[0]?.text).toContain(`Updated turn T${turnId}`);
    expect(getTurn(db, sessionId, 1)!.tags).toEqual(["b"]);

    const cleared = rememberTool(db, { id: `T${turnId}`, tags: [] });
    expect(cleared.content[0]?.text).toContain(`Updated turn T${turnId}`);
    expect(getTurn(db, sessionId, 1)!.tags).toEqual([]);

    // Omitting `tags` entirely leaves the stored value alone.
    rememberTool(db, { id: `T${turnId}`, tags: ["c"] });
    rememberTool(db, { id: `T${turnId}`, grade: 3 });
    expect(getTurn(db, sessionId, 1)!.tags).toEqual(["c"]);
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
      type: ["fix"],
      tags: ["auth"],
      grade: 0,
    });

    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.status).toBe("skipped");
  });

  test("tags-only turn remember preserves an extracted turn status", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Initial extracted content.",
      type: ["fix"],
      grade: 2,
    });

    rememberTool(db, {
      id: `T${turnId}`,
      tags: ["rolled-back"],
    });

    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.status).toBe("extracted");
    expect(turn.title).toBe("Fix auth race");
    expect(turn.content).toBe("Initial extracted content.");
    expect(turn.tags).toContain("rolled-back");
  });

  test("a grade-only patch leaves title, content, type, and tags exactly as they were (D10)", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Initial extracted content.",
      type: ["fix"],
      tags: ["auth"],
      grade: 2,
    });

    const result = rememberTool(db, { id: `T${turnId}`, grade: 3 });

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.significanceGrade).toBe(3);
    expect(turn.title).toBe("Fix auth race");
    expect(turn.content).toBe("Initial extracted content.");
    expect(turn.type).toEqual(["fix"]);
    expect(turn.tags).toEqual(["auth"]);
  });

  test("an explicit null clears grade; an explicit [] clears type — both distinguishable from omitting them (D10)", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Initial extracted content.",
      type: ["fix"],
      grade: 2,
    });

    // Omitting grade/type leaves them as they were …
    rememberTool(db, { id: `T${turnId}`, content: "Still investigating." });
    expect(getTurn(db, sessionId, 1)!.significanceGrade).toBe(2);
    expect(getTurn(db, sessionId, 1)!.type).toEqual(["fix"]);

    // … an explicit null clears grade, an explicit [] clears type (spec B7:
    // [] already means "no type", so it is type's own clear expression), and
    // nothing else on the row moves.
    const result = rememberTool(db, {
      id: `T${turnId}`,
      grade: null,
      type: [],
    });

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.significanceGrade).toBeNull();
    expect(turn.type).toEqual([]);
    expect(turn.title).toBe("Fix auth race");
    expect(turn.content).toBe("Still investigating.");
  });

  test("an explicit null also clears title, content, and insight, distinct from omitting them", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      content: "Initial extracted content.",
      insight: "- mutex added",
      type: ["fix"],
      grade: 2,
    });

    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: null,
      content: null,
      insight: null,
    });

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    const turn = getTurn(db, sessionId, 1)!;
    expect(turn.title).toBeNull();
    expect(turn.content).toBeNull();
    expect(turn.insight).toBeNull();
    // Fields not mentioned in the clearing call are untouched.
    expect(turn.type).toEqual(["fix"]);
    expect(turn.significanceGrade).toBe(2);
  });

  test("an out-of-range grade is rejected by the tool call itself, not just the public schema", () => {
    const before = getTurn(db, sessionId, 1);
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      grade: 7 as never,
    });

    expect(result.content[0]?.text).toContain("Parameter error");
    expect(result.content[0]?.text).toContain(
      "grade must be an integer from 0 through 4",
    );
    expect(getTurn(db, sessionId, 1)).toEqual(before);
  });

  test("an unrecognised type is rejected rather than written", () => {
    const before = getTurn(db, sessionId, 1);
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      type: ["bugfix"],
      grade: 2,
    });

    expect(result.content[0]?.text).toContain("Parameter error");
    // Peer review item 5: routed through the SAME normalizer `note` already
    // uses (normalizeTypeValues), which throws "unknown type value: …"
    // rather than the bespoke wording the old, separate validator used.
    expect(result.content[0]?.text).toContain("unknown type value: bugfix");
    // Nothing lands — not the title, not the bad word.
    expect(getTurn(db, sessionId, 1)).toEqual(before);
  });

  test("a recognised type is written normally", () => {
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      type: ["fix"],
      grade: 2,
    });

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    expect(getTurn(db, sessionId, 1)!.type).toEqual(["fix"]);
  });

  // Peer review item 5: `note` already de-duplicated a repeated type value
  // through `normalizeTypeValues`; `remember` only validated the vocabulary
  // and stored the raw (possibly repeated) list. Both now route through the
  // same normalizer.
  test("a repeated type value de-duplicates, order-preserving, same as note", () => {
    const result = rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      type: ["fix", "review", "fix"],
      grade: 2,
    });

    expect(result.content[0]?.text).toContain(`Updated turn T${turnId}`);
    expect(getTurn(db, sessionId, 1)!.type).toEqual(["fix", "review"]);
  });

  test("turn remember with a title yields extracted status", () => {
    rememberTool(db, {
      id: `T${turnId}`,
      title: "Fix auth race",
      type: ["fix"],
      grade: 2,
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
      type: ["fix"],
      grade: 2,
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
      type: ["implement"],
      grade: 1,
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

describe("remember cites (structured citation edges)", () => {
  let db: Database;
  let sessionId: number;
  let turnIds: number[];

  const insertTurn = (promptNumber: number, status = "extracted"): number =>
    db
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, title, significance_grade, created_at_epoch
         ) VALUES (?, ?, ?, 'prompt', 'seed title', 2, 100) RETURNING id`,
      )
      .get(sessionId, promptNumber, status)!.id;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "remember-cites",
      project: "claude-mnemo",
      title: "cites",
      insight: null,
      createdAtEpoch: 100,
      updatedAtEpoch: 100,
      completedAtEpoch: null,
    }).id;
    turnIds = [1, 2, 3, 4].map((promptNumber) => insertTurn(promptNumber));
  });

  afterEach(() => {
    db.close();
  });

  test("writes the edge set and records the flag", () => {
    const result = rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "Locked the slicing axis",
      content: "Reverses the volume-anchoring decision.",
      grade: 3,
      cites: [
        { id: turnIds[0]!, relation: "supersedes" },
        { id: turnIds[1]!, relation: "evidence-for" },
      ],
    });

    expect(result.content[0]?.text).toContain("Recorded 2 citation(s).");
    expect(
      getTurnCitations(db, turnIds[2]!).map((edge) => [
        edge.citedTurnId,
        edge.relation,
      ]),
    ).toEqual([
      [turnIds[0]!, "supersedes"],
      [turnIds[1]!, "evidence-for"],
    ]);
    expect(getTurnById(db, turnIds[2]!)?.citesRecorded).toBe(true);
  });

  test("replace-set: a resend replaces the previous edge set whole", () => {
    rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "First pass",
      grade: 3,
      cites: [{ id: turnIds[0]!, relation: "evidence-for" }],
    });
    rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "Second pass",
      grade: 3,
      cites: [{ id: turnIds[1]!, relation: "depends-on" }],
    });

    expect(
      getTurnCitations(db, turnIds[2]!).map((edge) => edge.citedTurnId),
    ).toEqual([turnIds[1]!]);
  });

  test("an omitted cites field leaves the edge set alone", () => {
    rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "First pass",
      grade: 3,
      cites: [{ id: turnIds[0]!, relation: "evidence-for" }],
    });
    const result = rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "Retitled only",
      grade: 3,
    });

    expect(result.content[0]?.text).not.toContain("citation(s)");
    expect(
      getTurnCitations(db, turnIds[2]!).map((edge) => edge.citedTurnId),
    ).toEqual([turnIds[0]!]);
    expect(getTurnById(db, turnIds[2]!)?.citesRecorded).toBe(true);
  });

  test("an explicit empty array clears the edges and still records the flag", () => {
    rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "First pass",
      grade: 3,
      cites: [{ id: turnIds[0]!, relation: "evidence-for" }],
    });
    const result = rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "Cites nothing after all",
      grade: 3,
      cites: [],
    });

    expect(result.content[0]?.text).toContain("Recorded 0 citation(s).");
    expect(getTurnCitations(db, turnIds[2]!)).toEqual([]);
    expect(getTurnById(db, turnIds[2]!)?.citesRecorded).toBe(true);
  });

  test("drops unresolvable ids with a log line and writes the rest", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = rememberTool(db, {
        id: `T${turnIds[2]!}`,
        title: "Cites a typo",
        grade: 3,
        cites: [
          { id: turnIds[0]!, relation: "evidence-for" },
          { id: 987_654, relation: "supersedes" },
        ],
      });

      expect(result.content[0]?.text).toContain("Recorded 1 citation(s).");
      expect(result.content[0]?.text).toContain("Dropped unresolvable: T987654.");
      expect(warn.mock.calls.at(0)?.[0]).toContain("987654");
      expect(
        getTurnCitations(db, turnIds[2]!).map((edge) => edge.citedTurnId),
      ).toEqual([turnIds[0]!]);
    } finally {
      warn.mockRestore();
    }
  });

  test("de-duplicates repeated edges", () => {
    const result = rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "Says it twice",
      grade: 3,
      cites: [
        { id: turnIds[0]!, relation: "evidence-for" },
        { id: turnIds[0]!, relation: "evidence-for" },
      ],
    });

    expect(result.content[0]?.text).toContain("Recorded 1 citation(s).");
    expect(getTurnCitations(db, turnIds[2]!)).toHaveLength(1);
  });

  test("drops invalid ids per edge and writes the valid remainder", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // One call carrying every class of semantically invalid id the schema
      // deliberately lets through: non-positive, dangling, self.
      const result = rememberTool(db, {
        id: `T${turnIds[2]!}`,
        title: "One good cite among the bad",
        grade: 3,
        cites: [
          { id: 0, relation: "evidence-for" },
          { id: 987_654, relation: "evidence-for" },
          { id: turnIds[2]!, relation: "supersedes" },
          { id: turnIds[0]!, relation: "depends-on" },
        ],
      });

      expect(result.content[0]?.text).toContain("Recorded 1 citation(s).");
      expect(result.content[0]?.text).toContain(
        `Dropped unresolvable: T0, T987654, T${turnIds[2]!}.`,
      );
      expect(
        getTurnCitations(db, turnIds[2]!).map((edge) => [
          edge.citedTurnId,
          edge.relation,
        ]),
      ).toEqual([[turnIds[0]!, "depends-on"]]);
      expect(getTurnById(db, turnIds[2]!)?.citesRecorded).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("a failed edge insert rolls back the turn update and restores the prior edge set", () => {
    rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "First pass",
      grade: 3,
      cites: [{ id: turnIds[0]!, relation: "evidence-for" }],
    });
    const before = getTurnById(db, turnIds[2]!)!;
    const victimBefore = getTurnById(db, turnIds[0]!)!;

    // Fail the edge insert mid-write; the turn update that already ran, the
    // regrade that would follow, and the DELETE half of the replace-set must all
    // disappear — a cleared edge set is as wrong as a half-written one.
    db.exec(`
      CREATE TRIGGER block_citation BEFORE INSERT ON memory_edges
      WHEN NEW.cited_kind = 'turn' AND NEW.cited_id = ${turnIds[1]!}
      BEGIN SELECT RAISE(ABORT, 'citation write blocked'); END;
    `);

    expect(() =>
      rememberTool(db, {
        id: `T${turnIds[2]!}`,
        title: "Never lands",
        content: "Never lands either.",
        grade: 4,
        cites: [{ id: turnIds[1]!, relation: "evidence-for" }],
        regrade: { id: `T${turnIds[0]!}`, grade: 0 },
      }),
    ).toThrow();

    expect(getTurnById(db, turnIds[2]!)).toEqual(before);
    expect(getTurnById(db, turnIds[0]!)).toEqual(victimBefore);
    expect(
      getTurnCitations(db, turnIds[2]!).map((edge) => edge.citedTurnId),
    ).toEqual([turnIds[0]!]);
  });

  test("rolls back after the nested regrade has already executed", () => {
    rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "First pass",
      grade: 3,
      cites: [{ id: turnIds[0]!, relation: "evidence-for" }],
    });
    const before = getTurnById(db, turnIds[2]!)!;
    const victimBefore = getTurnById(db, turnIds[0]!)!;

    // AFTER UPDATE: the regrade's row change is applied and visible to the
    // trigger before it aborts, so the failure lands strictly after the nested
    // regrade ran — the other half of the "one transaction" claim.
    db.exec(`
      CREATE TRIGGER block_after_regrade AFTER UPDATE ON turns
      WHEN NEW.id = ${turnIds[0]!} AND NEW.significance_grade = 0
      BEGIN SELECT RAISE(ABORT, 'regrade blocked'); END;
    `);

    expect(() =>
      rememberTool(db, {
        id: `T${turnIds[2]!}`,
        title: "Never lands",
        grade: 4,
        cites: [{ id: turnIds[1]!, relation: "depends-on" }],
        regrade: { id: `T${turnIds[0]!}`, grade: 0 },
      }),
    ).toThrow();

    expect(getTurnById(db, turnIds[2]!)).toEqual(before);
    expect(getTurnById(db, turnIds[0]!)).toEqual(victimBefore);
    expect(
      getTurnCitations(db, turnIds[2]!).map((edge) => edge.citedTurnId),
    ).toEqual([turnIds[0]!]);
  });

  test("aborts the whole write when the regrade target vanishes after validation", () => {
    // The regrade target is validated before BEGIN; this trigger deletes it as
    // soon as the transaction touches the citing turn, standing in for another
    // connection winning that race. Nothing may commit.
    db.exec(`
      CREATE TRIGGER vanish_regrade_target AFTER UPDATE ON turns
      WHEN NEW.id = ${turnIds[2]!} AND NEW.title = 'Races a delete'
      BEGIN DELETE FROM turns WHERE id = ${turnIds[0]!}; END;
    `);
    const before = getTurnById(db, turnIds[2]!)!;

    const result = rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "Races a delete",
      grade: 3,
      cites: [{ id: turnIds[1]!, relation: "evidence-for" }],
      regrade: { id: `T${turnIds[0]!}`, grade: 1 },
    });

    expect(result.content[0]?.text).toContain(
      `regrade target T${turnIds[0]!} no longer exists`,
    );
    expect(getTurnById(db, turnIds[2]!)).toEqual(before);
    // The delete itself was part of the aborted transaction.
    expect(getTurnById(db, turnIds[0]!)).not.toBeNull();
    expect(getTurnCitations(db, turnIds[2]!)).toEqual([]);
  });

  test("records edges alongside a nested regrade in the same call", () => {
    const result = rememberTool(db, {
      id: `T${turnIds[2]!}`,
      title: "Reverses the earlier call",
      grade: 3,
      cites: [{ id: turnIds[0]!, relation: "supersedes" }],
      regrade: { id: `T${turnIds[0]!}`, grade: 1 },
    });

    expect(result.content[0]?.text).toContain(
      `Regraded turn T${turnIds[0]!} to 1.`,
    );
    expect(result.content[0]?.text).toContain("Recorded 1 citation(s).");
    expect(getTurnById(db, turnIds[0]!)?.significanceGrade).toBe(1);
    expect(getTurnCitations(db, turnIds[2]!)).toHaveLength(1);
  });

  test("public schema enforces the strict cites element shape", () => {
    expect(
      rememberInputSchema.parse({
        id: "T1",
        cites: [{ id: 8501, relation: "supersedes" }],
      }),
    ).toEqual({ id: "T1", cites: [{ id: 8501, relation: "supersedes" }] });

    // A wrong TYPE rejects the call …
    for (const cites of [
      [{ id: 8501, relation: "supersedes", note: "why" }],
      [{ id: "T8501", relation: "supersedes" }],
      [{ id: 8501.5, relation: "supersedes" }],
      [{ id: 8501, relation: "mentions" }],
      [{ id: 8501 }],
      [{ relation: "supersedes" }],
      [8501],
    ]) {
      expect(() => rememberInputSchema.parse({ id: "T1", cites })).toThrow();
    }

    // … but a merely INVALID integer id passes the shape gate and is dropped
    // per edge downstream, so one bad id cannot discard the good ones.
    expect(() =>
      rememberInputSchema.parse({
        id: "T1",
        cites: [
          { id: 0, relation: "supersedes" },
          { id: -3, relation: "evidence-for" },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects cites on the observation and session routes", () => {
    const observationId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO observations (turn_id, tool_name, status, created_at_epoch)
         VALUES (?, 'Read', 'pending', 100) RETURNING id`,
      )
      .get(turnIds[0]!)!.id;

    expect(
      rememberTool(db, {
        id: `O${observationId}`,
        cites: [{ id: turnIds[0]!, relation: "evidence-for" }],
      }).content[0]?.text,
    ).toContain("Parameter error");
    expect(
      rememberTool(db, {
        id: `S${sessionId}`,
        title: "t",
        content: "c",
        decision: "d",
        done: "d",
        current: "c",
        next_steps: "n",
        reference: "r",
        cites: [{ id: turnIds[0]!, relation: "evidence-for" }],
      }).content[0]?.text,
    ).toContain("does not accept grade, regrade, or cites");
  });
});
