import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { recallInputSchema } from "../../src/mcp/definitions";
import { recallMemory } from "../../src/mcp/recall";
import { resolveTranscriptPath } from "../../src/shared/paths";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

describe("recallMemory", () => {
  let db: Database;
  let baselineSessionId: number;
  let authSessionId: number;
  let authObservationId: number;
  let bigSessionId: number;
  let floodSessionId: number;
  let observationIds: number[] = [];

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const baseline = upsertSession(db, {
      contentSessionId: "session-1",
      project: "claude-mnemo",
      title: "Auth baseline",
      content: "Initial auth investigation",
      insight: "- baseline captured",
      createdAtEpoch: 100,
      updatedAtEpoch: 110,
      completedAtEpoch: 120,
    });
    baselineSessionId = baseline.id;

    const authSession = upsertSession(db, {
      contentSessionId: "session-2",
      project: "claude-mnemo",
      title: "Auth race fix",
      content: "Fixes the refresh race",
      insight: "- mutex avoids overlap",
      nextSteps: "verify refresh under load",
      createdAtEpoch: 86_600,
      updatedAtEpoch: 86_610,
      completedAtEpoch: 86_620,
    });
    authSessionId = authSession.id;

    saveTurn(db, {
      sessionId: authSession.id,
      promptNumber: 1,
      userPrompt: "Why am I getting 401 errors?",
      assistantResponse: "There is a race condition in token refresh.",
      title: "Diagnose auth race",
      content: "Refresh overlap diagnosed",
      insight: "- concurrent refreshes collide",
      type: "bugfix",
      filesRead: ["src/auth.ts"],
      filesModified: ["src/auth.ts", "tests/auth.test.ts"],
      createdAtEpoch: 86_630,
      updatedAtEpoch: 86_640,
      observations: [
        {
          title: "Auth mutex",
          content: "Guards refresh",
        },
        {
          title: "Add regression test",
          content: "Protects overlap path",
        },
      ],
    });

    db
      .query(
        "UPDATE turns SET transcript_line_start = ? WHERE session_id = ? AND prompt_number = ?",
      )
      .run(4, authSession.id, 1);

    saveTurn(db, {
      sessionId: authSession.id,
      promptNumber: 2,
      userPrompt: "Any follow-up?",
      assistantResponse: "No line anchor yet.",
      title: "Follow-up",
      content: "Legacy turn id remains unchanged",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 86_650,
      updatedAtEpoch: 86_660,
      observations: [],
    });

    const authTurn = getTurn(db, authSession.id, 1)!;
    authObservationId = getObservationsForTurn(db, authTurn.id)[0]!.id;

    const bigSession = upsertSession(db, {
      contentSessionId: "session-big",
      project: "claude-mnemo",
      title: "Large timeline",
      content: "For omission coverage",
      insight: null,
      createdAtEpoch: 172_800,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    bigSessionId = bigSession.id;

    const insertTurn = db.query(`
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let promptNumber = 1; promptNumber <= 60; promptNumber += 1) {
      const status =
        promptNumber === 12
          ? "pending"
          : promptNumber === 20
            ? "stale"
            : "extracted";

      insertTurn.run(
        bigSession.id,
        promptNumber,
        status,
        `Prompt ${promptNumber}`,
        `Response ${promptNumber}`,
        `Turn ${promptNumber}`,
        `Description ${promptNumber}`,
        null,
        JSON.stringify([]),
        JSON.stringify([]),
        0,
        172_800 + promptNumber,
        172_800 + promptNumber,
      );
    }

    const observationSession = upsertSession(db, {
      contentSessionId: "session-observations",
      project: "claude-mnemo",
      title: "Observation flood",
      content: "For direct observation omission coverage",
      insight: null,
      createdAtEpoch: 259_200,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    floodSessionId = observationSession.id;

    saveTurn(db, {
      sessionId: observationSession.id,
      promptNumber: 1,
      userPrompt: "Collect many observations",
      assistantResponse: "Collected many observations.",
      title: "Observation flood",
      content: "Many observations",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 259_210,
      updatedAtEpoch: 259_220,
      observations: Array.from({ length: 60 }, (_, index) => ({
        title: `Observation ${index + 1}`,
        content: `Description ${index + 1}`,
      })),
    });

    const floodTurn = getTurn(db, observationSession.id, 1)!;
    observationIds = getObservationsForTurn(db, floodTurn.id).map(
      (observation) => observation.id,
    );
  });

  afterEach(() => {
    db.close();
  });

  test("accepts only the simplified public recall parameters", () => {
    expect(() =>
      recallInputSchema.parse({
        id: "S1/T1",
        query: "type:bugfix auth",
        time: "1970-01-01",
        depth: "expanded",
        page: 1,
        pageSize: 5,
        truncate: 200,
      }),
    ).not.toThrow();

    expect(recallInputSchema.safeParse({ session: authSessionId }).success).toBe(false);
    expect(recallInputSchema.safeParse({ view: "sessions" }).success).toBe(false);
    expect(recallInputSchema.safeParse({ project: "claude-mnemo" }).success).toBe(false);
  });

  test("defaults to session listing and intersects time filters", () => {
    const defaultOutput = recallMemory(db, {});
    const filteredOutput = recallMemory(db, {
      time: "1970-01-02",
    });

    expect(defaultOutput).not.toContain("page 1 / 1 (total 4)");
    expect(defaultOutput).toContain(`[S${bigSessionId}] Large timeline`);
    expect(defaultOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(filteredOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(filteredOutput).not.toContain(`[S${bigSessionId}] Large timeline`);
    expect(filteredOutput).not.toContain(`[S${baselineSessionId}] Auth baseline`);
  });

  test("applies page offsets to routed turn lists", () => {
    const output = recallMemory(db, {
      id: `S${bigSessionId}/T11..20`,
      page: 2,
      pageSize: 3,
    });

    expect(output).toContain("page 2 / 4 (total 10)");
    expect(output).toContain("[T14] Turn 14");
    expect(output).toContain("[T16] Turn 16");
    expect(output).not.toContain("[T13] Turn 13");
    expect(output).not.toContain("[T17] Turn 17");
  });

  test("routes simplified ids for session, turn, and observation detail", () => {
    const sessionOutput = recallMemory(db, {
      id: `S${authSessionId}`,
      depth: "expanded",
    });
    const turnOutput = recallMemory(db, {
      id: `S${authSessionId}/T1`,
      depth: "expanded",
    });
    const observationOutput = recallMemory(db, {
      id: `O${authObservationId}`,
      depth: "expanded",
    });

    expect(sessionOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(sessionOutput).toContain(
      `raw: ${resolveTranscriptPath("claude-mnemo", "session-2")}`,
    );
    expect(sessionOutput).toContain("[T1:L4] Diagnose auth race");
    expect(sessionOutput).not.toContain('prompt: "Why am I getting 401 errors?"');
    expect(sessionOutput).not.toContain("[O1] Auth mutex");

    expect(turnOutput).toContain(`[T1:L4] Diagnose auth race`);
    expect(turnOutput).toContain('prompt: "Why am I getting 401 errors?"');
    expect(turnOutput).toContain("[O1] Auth mutex");

    expect(observationOutput).toContain(`[O${authObservationId}] Auth mutex`);
    expect(observationOutput).toContain("desc: Guards refresh");
  });

  test("renders anchored and legacy turn ids in routed turn listings", () => {
    const output = recallMemory(db, {
      id: `S${authSessionId}/T1..2`,
      depth: "collapsed",
    });

    expect(output).toContain(`[S${authSessionId}][T1:L4] Diagnose auth race`);
    expect(output).toContain(`[S${authSessionId}][T2] Follow-up`);
  });

  test("honors truncate when expanding a turn", () => {
    saveTurn(db, {
      sessionId: authSessionId,
      promptNumber: 99,
      userPrompt: "p".repeat(300),
      assistantResponse: "r".repeat(300),
      title: "Long turn",
      content: "c".repeat(300),
      insight: null,
      type: "change",
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 90_000,
      updatedAtEpoch: 90_001,
      observations: [],
    });

    const shortOutput = recallMemory(db, {
      id: `S${authSessionId}/T99`,
      depth: "expanded",
      truncate: 40,
    });
    const longOutput = recallMemory(db, {
      id: `S${authSessionId}/T99`,
      depth: "expanded",
      truncate: 2000,
    });

    expect(shortOutput).toContain("p".repeat(40));
    expect(shortOutput).not.toContain("p".repeat(120));
    expect(longOutput).toContain("p".repeat(120));
    expect(longOutput).toContain("r".repeat(120));
  });

  test("omits jsonlPath from collapsed session output", () => {
    const output = recallMemory(db, {
      id: `S${authSessionId}`,
      depth: "collapsed",
    });

    expect(output).not.toContain(".jsonl");
    expect(output).not.toContain("raw:");
  });

  test("supports wildcard and range ids with stable observation identity", () => {
    const turnsOutput = recallMemory(db, {
      id: `S${bigSessionId}/T11..20`,
    });
    const observationsOutput = recallMemory(db, {
      id: `S${authSessionId}/T1/O*`,
      depth: "expanded",
    });
    const sessionObservationsOutput = recallMemory(db, {
      id: `S${floodSessionId}/T*/O*`,
      depth: "collapsed",
      pageSize: 60,
    });

    expect(turnsOutput).toContain(`[S${bigSessionId}] Large timeline`);
    expect(turnsOutput).not.toContain("page 1 / 1 (total 10)");
    expect(turnsOutput).toContain("[T12] Turn 12");
    expect(turnsOutput).toContain("[T20] Turn 20");
    expect(turnsOutput).not.toContain("[T10] Turn 10");

    expect(observationsOutput).toContain(`[O${authObservationId}] Auth mutex`);
    expect(observationsOutput).toContain("desc: Guards refresh");
    expect(observationsOutput).toContain("[T1:L4] Diagnose auth race");
    expect(sessionObservationsOutput).not.toContain("page 1 / 1 (total 60)");
    expect(sessionObservationsOutput).toContain(`[S${floodSessionId}] Observation flood`);
    expect(sessionObservationsOutput).toContain("[T1] Observation flood");
    expect(sessionObservationsOutput).toContain("[O");
    expect(recallMemory(db, { id: `S${authSessionId}/T1/O${authObservationId}` })).toContain(
      "invalid id selector",
    );
  });

  test("renders mixed query results with prefix filters and time", () => {
    const typeQuery = recallMemory(db, {
      query: "type:bugfix",
      depth: "expanded",
    });
    const timeScopedQuery = recallMemory(db, {
      query: "auth",
      time: "1970-01-02",
      pageSize: 1,
    });

    expect(typeQuery).toContain(`[S${authSessionId}] Auth race fix`);
    expect(typeQuery).toContain(`[S${authSessionId}][T1:L4] Diagnose auth race`);

    const hitCount = (timeScopedQuery.match(/\n- \[/g) ?? []).length + (timeScopedQuery.startsWith("- [") ? 1 : 0);
    expect(hitCount).toBe(1);
    expect(timeScopedQuery).toContain("Auth");
  });

  test("applies page offsets to direct observation browsing", () => {
    const output = recallMemory(db, {
      id: `S${floodSessionId}/T1/O*`,
      depth: "collapsed",
      page: 2,
      pageSize: 3,
    });

    expect(output).toContain("page 2 / 20 (total 60)");
    expect(output).toContain("[O6] Observation 4");
    expect(output).toContain("[O8] Observation 6");
    expect(output).not.toContain("[O5] Observation 3");
    expect(output).not.toContain("[O9] Observation 7");
    expect(output).toContain("[S");
  });

  test("defaults expanded turn listings to pageSize 10", () => {
    const output = recallMemory(db, {
      id: `S${bigSessionId}/T*`,
      depth: "expanded",
    });

    expect(output).toContain("page 1 / 6 (total 60)");
    expect(output).toContain("[T1] Turn 1");
    expect(output).toContain("[T10] Turn 10");
    expect(output).not.toContain("[T11] Turn 11");
  });

  test("caps child previews at 5 with +N more markers", () => {
    const sessionOutput = recallMemory(db, {
      id: `S${bigSessionId}`,
      depth: "expanded",
    });
    const turnOutput = recallMemory(db, {
      id: `S${floodSessionId}/T1`,
      depth: "expanded",
    });

    expect(sessionOutput).toContain("[T1] Turn 1");
    expect(sessionOutput).toContain("[T5] Turn 5");
    expect(sessionOutput).not.toContain("[T6] Turn 6");
    expect(sessionOutput).toContain("+55 more");

    expect(turnOutput).toContain("[O3] Observation 1");
    expect(turnOutput).toContain("[O7] Observation 5");
    expect(turnOutput).not.toContain("[O8] Observation 6");
    expect(turnOutput).toContain("+55 more");
  });

  test("rejects invalid time and unparseable ids", () => {
    expect(recallMemory(db, { time: "yesterday" })).toContain("Parameter error:");
    expect(recallMemory(db, { id: "Z9" })).toContain("Parameter error:");
  });

  test("global T<n> route resolves a turn by DB id (worker recall fallback)", () => {
    const lateSession = upsertSession(db, {
      contentSessionId: "session-late",
      project: "claude-mnemo",
      title: "Late session",
      content: "A session created after several others",
      insight: null,
      createdAtEpoch: 90_000,
      updatedAtEpoch: 90_010,
      completedAtEpoch: null,
    });

    const turn = saveTurn(db, {
      sessionId: lateSession.id,
      promptNumber: 1,
      userPrompt: "What broke the build?",
      assistantResponse: "A missing import.",
      title: "Diagnose build break",
      content: "Tracked the failure to a missing import.",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 90_001,
      updatedAtEpoch: 90_002,
      observations: [],
    });

    // The DB id is global and far past this session's prompt_number 1.
    expect(turn.id).toBeGreaterThan(1);
    expect(turn.id).not.toBe(turn.promptNumber);

    // Worker style: the same T<n> DB id it uses for remember().
    const byDbId = recallMemory(db, {
      id: `T${turn.id}`,
      depth: "expanded",
    });
    // Main-agent style: session-scoped prompt_number.
    const byPromptNumber = recallMemory(db, {
      id: `S${lateSession.id}/T${turn.promptNumber}`,
      depth: "expanded",
    });

    expect(byDbId).toContain("Diagnose build break");
    expect(byPromptNumber).toContain("Diagnose build break");
  });

  test("recall rejects a tag: filter (removed with durable memory)", () => {
    expect(recallMemory(db, { query: "tag:feedback" })).toContain("Parameter error");
  });

  test("S/T stays prompt_number-scoped and never falls back to a DB id", () => {
    // Adopted/resumed sessions can start at high prompt numbers, so a turn's DB
    // id and prompt_number diverge. S/T must address prompt_number only.
    const adopted = upsertSession(db, {
      contentSessionId: "session-adopted",
      project: "claude-mnemo",
      title: "Adopted session",
      content: "Resumed mid-stream",
      insight: null,
      createdAtEpoch: 91_000,
      updatedAtEpoch: 91_010,
      completedAtEpoch: null,
    });

    const turn = saveTurn(db, {
      sessionId: adopted.id,
      promptNumber: 48,
      userPrompt: "Resume work",
      assistantResponse: "Resumed.",
      title: "Resumed adopted turn",
      content: "Picked up the adopted session.",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 91_001,
      updatedAtEpoch: 91_002,
      observations: [],
    });
    expect(turn.id).not.toBe(48);

    // Passing the DB id as if it were a prompt number must NOT resolve — S/T is
    // prompt_number-scoped, with no DB-id fallback.
    expect(
      recallMemory(db, { id: `S${adopted.id}/T${turn.id}`, depth: "expanded" }),
    ).not.toContain("Resumed adopted turn");
    // The real prompt_number resolves through S/T.
    expect(
      recallMemory(db, { id: `S${adopted.id}/T48`, depth: "expanded" }),
    ).toContain("Resumed adopted turn");
    // The global T<dbid> route resolves it for the worker.
    expect(
      recallMemory(db, { id: `T${turn.id}`, depth: "expanded" }),
    ).toContain("Resumed adopted turn");
  });

  test("surfaces a Chinese prompt-only match though the collapsed snippet stays English", () => {
    const session = upsertSession(db, {
      contentSessionId: "session-prompt-only",
      project: "claude-mnemo",
      title: "Browser plugin login",
      content: "English summary",
      insight: null,
      createdAtEpoch: 900_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "怎么用 浏览器插件 同步 cookie",
      assistantResponse: "Use CookieCloud.",
      title: "Cookie sync setup",
      content: "English turn summary",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 900_010,
      updatedAtEpoch: 900_020,
      observations: [],
    });

    const output = recallMemory(db, { query: "浏览器插件" });

    // Findability is met: the turn's session surfaces.
    expect(output).toContain(`[S${session.id}`);
    expect(output).toContain("Cookie sync setup");
    // Accepted limitation: the visible snippet is the English summary, not the
    // matched Chinese prompt fragment (snippet() preview deferred).
    expect(output).not.toContain("浏览器插件");
  });

  test("recall search totals exclude memory-layer FTS rows (null session_id)", () => {
    // A stray memory-layer FTS row must not render or inflate the page total.
    db.query(
      `INSERT INTO memory_fts (layer, source_id, title, content, extra)
         VALUES ('memory', 9999, 'mem hit', 'auth refresh memory', '')`,
    ).run();
    // Use pageSize:1 so the page header (which contains "total N") is always emitted.
    const output = recallMemory(db, { query: "auth", pageSize: 1 });
    expect(output).not.toContain("M9999");
    expect(output).not.toContain("mem hit");
    expect(output).not.toContain("9999");
    // total in the page header must reflect only real session/turn/observation hits
    const totalMatch = output.match(/total (\d+)/);
    expect(totalMatch).not.toBeNull();
    const total = Number(totalMatch![1]);
    // Without the filter the total would be inflated by the memory-layer row;
    // with the filter it must equal the number of actual session/turn/observation hits.
    // authSession contributes at least one hit, memory-layer row contributes zero.
    expect(total).toBeGreaterThan(0);
    // Verify total is consistent with what renders (no extra phantom count from FTS layer)
    const pageCountMatch = output.match(/page 1 \/ (\d+)/);
    expect(pageCountMatch).not.toBeNull();
    const pageCount = Number(pageCountMatch![1]);
    expect(pageCount).toBe(total); // pageSize:1 => pageCount === total
  });

  test("session: filter scopes a full-text search to one session", () => {
    // 'auth' matches BOTH the baseline session and the auth-race session.
    const unscoped = recallMemory(db, { query: "auth", pageSize: 50 });
    expect(unscoped).toContain(`[S${baselineSessionId}] Auth baseline`);
    expect(unscoped).toContain(`[S${authSessionId}] Auth race fix`);

    // session:S<id> narrows the same query to a single session.
    const scoped = recallMemory(db, {
      query: `auth session:S${authSessionId}`,
      pageSize: 50,
    });
    expect(scoped).toContain(`[S${authSessionId}] Auth race fix`);
    expect(scoped).not.toContain(`[S${baselineSessionId}] Auth baseline`);
  });

  test("session: filter accepts a bare numeric id without the S prefix", () => {
    const scoped = recallMemory(db, {
      query: `auth session:${authSessionId}`,
      pageSize: 50,
    });
    expect(scoped).toContain(`[S${authSessionId}] Auth race fix`);
    expect(scoped).not.toContain(`[S${baselineSessionId}] Auth baseline`);
  });

  test("session: filter drops a malformed id instead of searching it as text", () => {
    // A non-numeric session: token must be ignored, not applied as a filter and
    // not OR'd into the FTS query — so the search behaves like a plain `auth`.
    const output = recallMemory(db, { query: "auth session:abc", pageSize: 50 });
    expect(output).toContain(`[S${authSessionId}] Auth race fix`);
    expect(output).toContain(`[S${baselineSessionId}] Auth baseline`);
  });
});

describe("fork-lineage breadcrumb in recall", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("forked session shows breadcrumb with fork turn in header (collapsed)", () => {
    // Parent session
    const parent = upsertSession(db, {
      contentSessionId: "parent-session",
      project: "test-project",
      title: "Parent session",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    // Insert a turn in parent at promptNumber=3
    const parentTurnId = db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', ?)
         RETURNING id`,
      )
      .get(parent.id, 3, 1_001)!.id;

    // Child (forked) session
    const child = upsertSession(db, {
      contentSessionId: "child-session",
      project: "test-project",
      title: "Child session",
      content: null,
      insight: null,
      createdAtEpoch: 2_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    // Set parent_session_id on child
    db.query("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(
      parent.id,
      child.id,
    );

    // Insert child's first turn with parent_turn_id pointing to parent's T3
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, parent_turn_id, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?)`,
    ).run(child.id, 1, parentTurnId, 2_001);

    const output = recallMemory(db, { id: `S${child.id}`, depth: "collapsed" });

    expect(output).toContain(`continues from S${parent.id} (forked at T3)`);
  });

  test("forked session shows breadcrumb in expanded recall header", () => {
    const parent = upsertSession(db, {
      contentSessionId: "parent-exp",
      project: "test-project",
      title: "Parent exp",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const parentTurnId = db
      .query<{ id: number }, [number, number, string, number]>(
        `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
         VALUES (?, ?, 'extracted', ?)
         RETURNING id`,
      )
      .get(parent.id, 7, 1_001)!.id;

    const child = upsertSession(db, {
      contentSessionId: "child-exp",
      project: "test-project",
      title: "Child exp",
      content: null,
      insight: null,
      createdAtEpoch: 2_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(
      parent.id,
      child.id,
    );

    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, parent_turn_id, created_at_epoch)
       VALUES (?, ?, 'extracted', ?, ?)`,
    ).run(child.id, 1, parentTurnId, 2_001);

    const output = recallMemory(db, { id: `S${child.id}`, depth: "expanded" });

    expect(output).toContain(`continues from S${parent.id} (forked at T7)`);
  });

  test("non-forked session shows no breadcrumb", () => {
    const session = upsertSession(db, {
      contentSessionId: "standalone",
      project: "test-project",
      title: "Standalone session",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const output = recallMemory(db, { id: `S${session.id}`, depth: "collapsed" });

    expect(output).not.toContain("continues from");
  });

  test("null-tolerant: breadcrumb shows parent without fork turn when parent_turn_id is null", () => {
    const parent = upsertSession(db, {
      contentSessionId: "parent-null-tol",
      project: "test-project",
      title: "Parent null-tol",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const child = upsertSession(db, {
      contentSessionId: "child-null-tol",
      project: "test-project",
      title: "Child null-tol",
      content: null,
      insight: null,
      createdAtEpoch: 2_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(
      parent.id,
      child.id,
    );

    // First turn with NULL parent_turn_id
    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, created_at_epoch)
       VALUES (?, ?, 'extracted', ?)`,
    ).run(child.id, 1, 2_001);

    const output = recallMemory(db, { id: `S${child.id}`, depth: "collapsed" });

    expect(output).toContain(`continues from S${parent.id}`);
    expect(output).not.toContain("forked at");
  });

  test("null-tolerant: breadcrumb shows parent-only when child has no turns", () => {
    const parent = upsertSession(db, {
      contentSessionId: "parent-no-turns",
      project: "test-project",
      title: "Parent no-turns",
      content: null,
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const child = upsertSession(db, {
      contentSessionId: "child-no-turns",
      project: "test-project",
      title: "Child no-turns",
      content: null,
      insight: null,
      createdAtEpoch: 2_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(
      parent.id,
      child.id,
    );

    // No turns inserted for child

    const output = recallMemory(db, { id: `S${child.id}`, depth: "collapsed" });

    expect(output).toContain(`continues from S${parent.id}`);
    expect(output).not.toContain("forked at");
  });

  test("non-merge: project query for child returns only child turns, not parent turns", () => {
    const parent = upsertSession(db, {
      contentSessionId: "parent-no-merge",
      project: "myproject",
      title: "Parent no-merge",
      content: "parent content for search",
      insight: null,
      createdAtEpoch: 1_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, title, content, type, tags, files_read, files_modified, created_at_epoch)
       VALUES (?, ?, 'extracted', 'Parent turn title', 'parent turn content', 'discovery', '[]', '[]', '[]', ?)`,
    ).run(parent.id, 1, 1_001);

    const parentTurnId = db
      .query<{ id: number }, [number, number]>(
        "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
      )
      .get(parent.id, 1)!.id;

    const child = upsertSession(db, {
      contentSessionId: "child-no-merge",
      project: "myproject",
      title: "Child no-merge",
      content: "child content for search",
      insight: null,
      createdAtEpoch: 2_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    db.query("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(
      parent.id,
      child.id,
    );

    db.query(
      `INSERT INTO turns (session_id, prompt_number, status, title, content, type, tags, files_read, files_modified, parent_turn_id, created_at_epoch)
       VALUES (?, ?, 'extracted', 'Child turn title', 'child turn content', 'discovery', '[]', '[]', '[]', ?, ?)`,
    ).run(child.id, 1, parentTurnId, 2_001);

    // Re-index child session for FTS
    const { indexSessionToFTS } = require("../../src/db/search");
    const { getTurn: getTurnFn, getTurnsForSession: getSessionTurns } = require("../../src/db/turns");
    const { indexTurnToFTS } = require("../../src/db/search");
    const childTurn = getTurnFn(db, child.id, 1)!;
    indexTurnToFTS(db, childTurn);

    // Single-session query: only child's turns in body, not parent's
    const output = recallMemory(db, { id: `S${child.id}`, depth: "expanded" });

    // The breadcrumb naming the parent is OK
    expect(output).toContain(`continues from S${parent.id}`);
    // But parent's turn title must not appear in the result body
    expect(output).not.toContain("Parent turn title");
    // Child's own turn must appear
    expect(output).toContain("Child turn title");
  });
});
