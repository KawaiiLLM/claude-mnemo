import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { getObservationsForTurn } from "../../src/db/observations";
import { initializeSchema } from "../../src/db/schema";
import {
  getSessionByContentId,
  updateSessionFields,
  upsertSession,
} from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { recallInputSchema } from "../../src/mcp/definitions";
import { NAVIGATION_LEGEND } from "../../src/mcp/format";
import { recallMemory } from "../../src/mcp/recall";
import { buildTimelineView } from "../../src/mcp/timeline";
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
      tags: ["rolled-back", "topic:auth-race"],
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
        // ticket 04: `query` is pure FTS text now — no in-string dialect.
        query: "auth",
        // ticket 11: `filter.fields` is the field-selection surface now —
        // `view` (the depth switch) has retired, see below.
        filter: { type: "bugfix", time: "1970-01-01", fields: ["title", "content"] },
        page: 1,
        pageSize: 5,
      }),
    ).not.toThrow();

    expect(recallInputSchema.safeParse({ session: authSessionId }).success).toBe(false);
    expect(recallInputSchema.safeParse({ view: "sessions" }).success).toBe(false);
    expect(recallInputSchema.safeParse({ project: "claude-mnemo" }).success).toBe(false);
    // ticket 04/11: `truncate` and `view` (the collapsed/expanded depth
    // switch) both retired from the public surface.
    expect(recallInputSchema.safeParse({ id: "S1", truncate: 200 }).success).toBe(false);
    expect(recallInputSchema.safeParse({ id: "S1", view: "expanded" }).success).toBe(false);
  });

  // Ticket 07 (read-write-contract spec, "视图(读面)"): bare recall() now
  // browses a GLOBAL chronological turn feed (spec user story 16) rather
  // than listing every session in full — see tests/mcp/recall.browse.test.ts
  // for the shape's own dedicated coverage (session-title-on-first-
  // appearance, pageBudget overflow → pagination, field selection).
  test("bare recall() leads with the most recent turns; time filter still narrows via the search path", () => {
    const defaultOutput = recallMemory(db, {});
    const filteredOutput = recallMemory(db, {
      filter: { time: "1970-01-02" },
    });

    // bigSession's turns were created after authSession's — the browse
    // shape's default page leads with them.
    expect(defaultOutput).toContain(`[S${bigSessionId}] Large timeline`);

    // Nothing is dropped, only paginated (spec: "溢出→分页,绝不截断整块") — a
    // generous pageBudget/pageSize reaches every turn, including the older one.
    const wideOutput = recallMemory(db, { pageBudget: 1_000_000, pageSize: 200 });
    expect(wideOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(wideOutput).toContain(`[S${bigSessionId}] Large timeline`);

    // `filter.time` still forces the (unchanged) search path — its own
    // recency/session-grouped rendering is untouched by the browse redesign.
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
    // Ticket 11: `depth` retired — a session-DETAIL route always shows its
    // raw pointer and a turn preview now (no more collapsed/expanded toggle
    // to suppress it); `filter.fields` is what widens a turn's own field set
    // beyond the default (title/content/prompt).
    const sessionOutput = recallMemory(db, {
      id: `S${authSessionId}`,
    });
    const turnOutput = recallMemory(db, {
      id: `S${authSessionId}/T1`,
      filter: { fields: ["title", "content", "prompt", "observations"] },
    });
    const observationOutput = recallMemory(db, {
      id: `O${authObservationId}`,
    });

    expect(sessionOutput).toContain(`[S${authSessionId}] Auth race fix`);
    expect(sessionOutput).toContain(
      `raw: ${resolveTranscriptPath("claude-mnemo", "session-2")}`,
    );
    expect(sessionOutput).toContain("[T1] Diagnose auth race");
    // The default field set is title+content now (spec 金样例 补充: "默认只有
    // content"), so the prompt bullet is opt-in — `filter.fields` is the one
    // way to ask for it.
    expect(sessionOutput).not.toContain("prompt:");
    expect(sessionOutput).not.toContain("[O1] Auth mutex");

    expect(turnOutput).toContain(`[T1] Diagnose auth race`);
    expect(
      recallMemory(db, {
        id: `S${authSessionId}/T1`,
        filter: { fields: ["title", "prompt"] },
      }),
    ).toContain('- prompt: "Why am I getting 401 errors?"');
    expect(turnOutput).toContain("[O1] Auth mutex");

    expect(observationOutput).toContain(`[O${authObservationId}] Auth mutex`);
    expect(observationOutput).toContain("- content: Guards refresh");

    // Ticket 01 (render-boilerplate-trim spec, item 2): a session-ADDRESSED
    // call keeps its full render, including the session's own `- content:`
    // line; a turn-addressed call's session ANCESTOR header drops it — the
    // reader asked about the turn, not the session's narrative.
    expect(sessionOutput).toContain("- content: Fixes the refresh race");
    expect(turnOutput).not.toContain("Fixes the refresh race");
    expect(turnOutput).toContain("- content: Refresh overlap diagnosed");
  });

  // Ticket 01 (render-boilerplate-trim spec, item 2): the OTHER turn-addressed
  // shape besides an id selector — a full-text query whose hits include turn
  // rows within a session. The session-ONLY hit (matched on its own
  // title/content, no turn/observation hit) is not an ancestor of anything
  // and keeps its content; the turn-hit session header above matched turn
  // rows is an ancestor and drops it.
  test("a turn-level query hit's session ancestor drops content; a session-only hit keeps it", () => {
    const session = upsertSession(db, {
      contentSessionId: "session-ancestor-trim",
      project: "claude-mnemo",
      title: "Ancestor trim probe",
      content: "SESSION_NARRATIVE_MARKER never belongs on a turn hit's ancestor line",
      insight: null,
      createdAtEpoch: 95_000,
      updatedAtEpoch: 95_010,
      completedAtEpoch: null,
    });
    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "ANCESTOR_TRIM_QUERY_TERM shows up in the prompt",
      assistantResponse: "response",
      title: "Turn hit for ancestor trim",
      content: "turn body",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 95_001,
      updatedAtEpoch: 95_002,
      observations: [],
    });

    const turnHit = recallMemory(db, { query: "ANCESTOR_TRIM_QUERY_TERM" });
    expect(turnHit).toContain(`[S${session.id}]`);
    expect(turnHit).toContain("Turn hit for ancestor trim");
    expect(turnHit).not.toContain("SESSION_NARRATIVE_MARKER");

    const sessionOnlyHit = recallMemory(db, { query: "SESSION_NARRATIVE_MARKER" });
    expect(sessionOnlyHit).toContain("SESSION_NARRATIVE_MARKER");
  });

  test("prefers a session's recorded transcript path over the cwd-derived one", () => {
    // Registered under alpha, later cd'ed to beta: `project` follows the cwd,
    // the transcript file does not move.
    const recorded =
      "/Users/me/.claude/projects/-Users-me-alpha/session-drift.jsonl";
    const drifted = upsertSession(db, {
      contentSessionId: "session-drift",
      project: "/Users/me/beta",
      transcriptPath: recorded,
      title: "Drifted session",
      insight: null,
      createdAtEpoch: 90_000,
      updatedAtEpoch: 90_010,
      completedAtEpoch: null,
    });

    expect(
      recallMemory(db, { id: `S${drifted.id}`, depth: "expanded" }),
    ).toContain(`raw: ${recorded}`);
  });

  test("falls back to deriving the transcript path when the session has none", () => {
    expect(getSessionByContentId(db, "session-2")?.transcriptPath).toBeNull();

    expect(
      recallMemory(db, { id: `S${authSessionId}`, depth: "expanded" }),
    ).toContain(`raw: ${resolveTranscriptPath("claude-mnemo", "session-2")}`);
  });

  test("renders anchored and legacy turn ids in routed turn listings", () => {
    const output = recallMemory(db, {
      id: `S${authSessionId}/T1..2`,
      depth: "collapsed",
    });

    expect(output).toContain(`[T1] Diagnose auth race`);
    expect(output).toContain("[T2] Follow-up");
  });

  // [S15069/T1021]: `T1..T2` ≡ `T1..2` — remember's interval grammar writes the
  // repeated letter, so one session working both surfaces writes both shapes.
  // A repeated letter of the WRONG kind is still a parse error, not a range.
  test("a range's second endpoint may repeat the kind letter; a foreign letter still rejects", () => {
    const natural = recallMemory(db, {
      id: `S${authSessionId}/T1..T2`,
      depth: "collapsed",
    });
    expect(natural).toContain(`[T1] Diagnose auth race`);
    expect(natural).toContain("[T2] Follow-up");

    expect(
      recallMemory(db, { id: `S${authSessionId}/T1..O2`, depth: "collapsed" }),
    ).toContain("invalid id selector");
  });

  // Ticket 11 (read-write-contract spec, "视图(读面)"): the char `truncate`/
  // `truncateCap` knobs retired outright — field cutting is driven ONLY by
  // the `turn` token budget now, word-boundary. Same content at two
  // different `turn` budgets must render different cuts, with no char-count
  // parameter involved anywhere in the call.
  test("same content at two different turn budgets renders different word-boundary cuts, with no char-count knob", () => {
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

    const smallBudgetOutput = recallMemory(db, {
      id: `S${authSessionId}/T99`,
      filter: { fields: ["title", "content", "prompt", "response"] },
      turn: 20,
    });
    const bigBudgetOutput = recallMemory(db, {
      id: `S${authSessionId}/T99`,
      filter: { fields: ["title", "content", "prompt", "response"] },
      turn: 400,
    });

    // The bigger budget shows strictly more of the SAME field — a longer
    // run of "p" — never a different mechanism, never a char-count knob (no
    // `truncate`/`truncateCap` appears in either call above).
    expect(bigBudgetOutput).toContain("p".repeat(120));
    expect(smallBudgetOutput).not.toContain("p".repeat(120));
    expect(smallBudgetOutput).toContain("…");
  });

  test("a session-DETAIL route always includes the raw jsonlPath pointer (ticket 11: no more depth toggle to suppress it)", () => {
    const output = recallMemory(db, {
      id: `S${authSessionId}`,
    });

    expect(output).toContain(".jsonl");
    expect(output).toContain("raw:");
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
    expect(observationsOutput).toContain("- content: Guards refresh");
    expect(observationsOutput).toContain("[T1] Diagnose auth race");
    expect(sessionObservationsOutput).not.toContain("page 1 / 1 (total 60)");
    expect(sessionObservationsOutput).toContain(`[S${floodSessionId}] Observation flood`);
    expect(sessionObservationsOutput).toContain("[T1] Observation flood");
    expect(sessionObservationsOutput).toContain("[O");
    expect(recallMemory(db, { id: `S${authSessionId}/T1/O${authObservationId}` })).toContain(
      "invalid id selector",
    );
  });

  test("renders mixed query results with the structured filter and time", () => {
    const typeQuery = recallMemory(db, {
      filter: { type: "bugfix" },
      depth: "expanded",
    });
    const timeScopedQuery = recallMemory(db, {
      query: "auth",
      filter: { time: "1970-01-02" },
      pageSize: 1,
    });

    expect(typeQuery).toContain(`[S${authSessionId}] Auth race fix`);
    expect(typeQuery).toContain(`[T1] Diagnose auth race`);

    const hitCount =
      (timeScopedQuery.match(/\n\[S/g) ?? []).length +
      (timeScopedQuery.startsWith("[S") ? 1 : 0);
    expect(hitCount).toBe(1);
    expect(timeScopedQuery).toContain("Auth");
  });

  // Ticket 04 (spec "Tools"): the prefix dialect is CUT, not aliased — a
  // query containing old `type:`/`tag:` syntax searches those literal
  // characters, with no hidden filtering.
  test("a query containing old prefix syntax searches it as literal text — no hidden filtering", () => {
    // Neither session's stored text contains the literal string "type:bugfix"
    // anywhere, so a query of exactly that string must find NOTHING — if the
    // dialect were still silently parsed as a `type` filter (the pre-ticket-04
    // behavior), this would instead return the auth-race turn (type=bugfix),
    // the way the OLD "renders mixed query results" test used to assert.
    const output = recallMemory(db, { query: "type:bugfix" });
    expect(output).not.toContain("Diagnose auth race");
    expect(output).not.toContain(`[S${authSessionId}]`);

    // The same holds for every prefix the old dialect used to strip —
    // `tag:`/`file:`/`session:`/`project:` — none of them narrow the search
    // any more; each is now indistinguishable from any other literal text
    // that happens not to be stored anywhere.
    for (const dialectQuery of [
      "tag:rolled-back",
      "file:auth.ts",
      "session:1",
      "project:claude-mnemo",
    ]) {
      const dialectOutput = recallMemory(db, { query: dialectQuery });
      expect(dialectOutput).not.toContain("Diagnose auth race");
      expect(dialectOutput).not.toContain(`[S${authSessionId}]`);
    }
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
      filter: { fields: ["title", "content", "observations"] },
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
    expect(recallMemory(db, { filter: { time: "yesterday" } })).toContain(
      "Parameter error:",
    );
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

  test("worker audience appends dbid:T<dbid> to matched turns (query + id routes)", () => {
    // A dedicated session whose prompt_number is high so the DB id and the
    // prompt_number provably diverge — the token must carry the DB id, not T<promptNumber>.
    const driverSession = upsertSession(db, {
      contentSessionId: "session-driver",
      project: "claude-mnemo",
      title: "Driver session",
      content: "Holds a citable driver turn",
      insight: null,
      createdAtEpoch: 92_000,
      updatedAtEpoch: 92_010,
      completedAtEpoch: null,
    });
    const driverTurn = saveTurn(db, {
      sessionId: driverSession.id,
      promptNumber: 57,
      userPrompt: "Why did retention regress?",
      assistantResponse: "Window too wide.",
      title: "Driver discovery turn",
      content: "Retention regressed because the window was too wide.",
      insight: null,
      type: "discovery",
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 92_001,
      updatedAtEpoch: 92_002,
      observations: [],
    });
    expect(driverTurn.id).not.toBe(driverTurn.promptNumber);

    // query= route (the recall(query=...) path the extractor uses to find a driver).
    const byQuery = recallMemory(db, {
      filter: { type: "discovery" },
      includeDbTurnIds: true,
    });
    // The token carries the DB id, NOT the prompt number.
    expect(byQuery).toContain(`dbid:T${driverTurn.id}`);
    // The DB-id token rides alongside the existing prompt-number label, not in
    // place of it.
    expect(byQuery).toContain(`[T${driverTurn.promptNumber}] Driver discovery turn`);

    // S/T id route also surfaces the DB id under worker audience.
    const byPromptId = recallMemory(db, {
      id: `S${driverSession.id}/T${driverTurn.promptNumber}`,
      depth: "expanded",
      includeDbTurnIds: true,
    });
    expect(byPromptId).toContain(`dbid:T${driverTurn.id}`);
  });

  test("main audience (default) keeps prompt-number labels and emits no dbid: token", () => {
    // Regression on the existing public form pinned around line 369 (`[S...][T<prompt_number>]`).
    const byQuery = recallMemory(db, { filter: { type: "bugfix" } });
    expect(byQuery).toContain(`[T1] Diagnose auth race`);
    expect(byQuery).not.toContain("dbid:");

    const byPromptId = recallMemory(db, {
      id: `S${authSessionId}/T1`,
      depth: "expanded",
    });
    expect(byPromptId).not.toContain("dbid:");
  });

  test("filter.tag matches a bare role tag", () => {
    const byRole = recallMemory(db, { filter: { tag: "rolled-back" } });
    expect(byRole).toContain(`[S${authSessionId}]`);
    expect(byRole).toContain("Diagnose auth race");
  });

  test("filter.tag matches a topic:-prefixed tag, exact element only", () => {
    expect(recallMemory(db, { filter: { tag: "topic:auth-race" } })).toContain(
      "Diagnose auth race",
    );
    // The match is anchored to a whole array element: a prefix must NOT match.
    expect(recallMemory(db, { filter: { tag: "topic:auth" } })).not.toContain(
      "Diagnose auth race",
    );
  });

  test("recall rejects a query/filter combination that parses to no criteria", () => {
    // A whitespace-only query with no filter member set must not silently
    // degrade to an unfiltered search that surfaces recent sessions as false
    // hits.
    expect(recallMemory(db, { query: "   " })).toContain("Parameter error");
    // ...but a filter criterion alongside that same degenerate query still
    // searches — a filter member alone is a real criterion.
    expect(
      recallMemory(db, { query: "   ", filter: { tag: "rolled-back" } }),
    ).not.toContain("Parameter error");
    // A filter alone (no query at all) is likewise a real criterion, not an
    // empty search — ticket 04's "filter alone still searches" extension of
    // the old "query alone" rule.
    expect(recallMemory(db, { filter: { tag: "rolled-back" } })).not.toContain(
      "Parameter error",
    );
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

  test("surfaces a Chinese prompt-only match, and now shows the matched prompt without a fields override (ticket 04, closes the flagged gap)", () => {
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
    // Ticket 04 (view-render-repair, spec "命中即展示" — closes ticket 01's
    // flagged gap): `prompt` is still out of the DEFAULT field set
    // (title+content), but a search hit landing in the prompt text now
    // renders that row's own `- prompt:` line — bolded evidence — without
    // needing an explicit `filter.fields` override.
    expect(output).toContain("**浏览器插件**");
    expect(
      recallMemory(db, { query: "浏览器插件", filter: { fields: ["title", "prompt"] } }),
    ).toContain("**浏览器插件**");
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

  // Ticket 14 (P2-5 fix, spec "搜索加粗覆盖全部被索引字段"): a search hit's
  // TITLE now bolds a matched query term too, not just `content` — these
  // session titles both contain "auth", so they render `**Auth** ...`.
  test("filter.session scopes a full-text search to one session", () => {
    // 'auth' matches BOTH the baseline session and the auth-race session.
    const unscoped = recallMemory(db, { query: "auth", pageSize: 50 });
    expect(unscoped).toContain(`[S${baselineSessionId}] **Auth** baseline`);
    expect(unscoped).toContain(`[S${authSessionId}] **Auth** race fix`);

    // filter.session narrows the same query to a single session — "S<id>" form.
    const scoped = recallMemory(db, {
      query: "auth",
      filter: { session: `S${authSessionId}` },
      pageSize: 50,
    });
    expect(scoped).toContain(`[S${authSessionId}] **Auth** race fix`);
    expect(scoped).not.toContain(`[S${baselineSessionId}] **Auth** baseline`);
  });

  test("filter.session accepts a bare numeric id, string or number, without the S prefix", () => {
    const scopedByString = recallMemory(db, {
      query: "auth",
      filter: { session: `${authSessionId}` },
      pageSize: 50,
    });
    const scopedByNumber = recallMemory(db, {
      query: "auth",
      filter: { session: authSessionId },
      pageSize: 50,
    });
    for (const scoped of [scopedByString, scopedByNumber]) {
      expect(scoped).toContain(`[S${authSessionId}] **Auth** race fix`);
      expect(scoped).not.toContain(`[S${baselineSessionId}] **Auth** baseline`);
    }
  });

  // Ticket 04: a malformed `filter.session` is a hard parameter error now —
  // the structured filter has no in-text position to silently drop a bad
  // token FROM, unlike the retired dialect's `session:abc` token.
  test("a malformed filter.session is a parameter error, and plain text never sees the old dialect", () => {
    const rejected = recallMemory(db, {
      query: "auth",
      filter: { session: "abc" },
      pageSize: 50,
    });
    expect(rejected).toContain("Parameter error:");

    // Literal dialect-shaped text with no `filter` at all is just text now —
    // it does not narrow to one session (proving `session:` is no longer
    // parsed out of `query`).
    const output = recallMemory(db, { query: "auth session:abc", pageSize: 50 });
    expect(output).toContain(`[S${authSessionId}] **Auth** race fix`);
    expect(output).toContain(`[S${baselineSessionId}] **Auth** baseline`);
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
       VALUES (?, ?, 'extracted', 'Parent turn title', 'parent turn content', '["discovery"]', '[]', '[]', '[]', ?)`,
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
       VALUES (?, ?, 'extracted', 'Child turn title', 'child turn content', '["discovery"]', '[]', '[]', '[]', ?, ?)`,
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

describe("recall navigation legend (spec D1)", () => {
  let db: Database;
  const ERA = 500_000;

  afterEach(() => {
    db.close();
  });

  test("many truncated fields in one expanded render show the legend exactly once", () => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    // Session created just BEFORE the era cutoff: ticket 09's session-field
    // era gate (below the turn's own gate) must not blank this session's
    // `content` and swallow the truncation this test is checking for. The
    // turn stays at/after the cutoff so its own era-gated (mechanical
    // observation) rendering — the thing this test actually exercises — is
    // unaffected.
    const session = upsertSession(db, {
      contentSessionId: "legend-many-fields",
      project: "claude-mnemo",
      title: "Legend coverage",
      content: "s".repeat(500),
      insight: null,
      createdAtEpoch: ERA - 1,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "p".repeat(500),
      assistantResponse: "r".repeat(500),
      title: "Long turn",
      content: "c".repeat(500),
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: ERA + 10,
      updatedAtEpoch: ERA + 10,
      // Era-side observations (no title): each contributes two more
      // truncatable fields (in/out). Only the first 5 render (DEFAULT_PREVIEW_
      // COUNT), which is still enough to prove the legend does not scale with
      // field count.
      observations: Array.from({ length: 6 }, (_, index) => ({
        toolName: "Bash",
        toolInput: `i${index}-`.repeat(100),
        toolResult: `o${index}-`.repeat(100),
      })),
    });

    // Ticket 11: the old per-field 200-char cap (uniform across every field)
    // retired along with `depth`/`truncate` — cutting is now a per-NODE
    // token budget (`turn`), applied independently to the session header
    // AND the turn block this route renders. A small explicit budget still
    // cuts BOTH nodes (proving the legend's "response-scoped, not
    // per-field" property survives the mechanism change) without needing to
    // pin an exact per-field character count that no longer exists.
    const output = recallMemory(db, {
      id: `S${session.id}/T1`,
      filter: { fields: ["title", "content", "prompt", "response", "observations"] },
      turn: 40,
      eraCutoffEpoch: ERA,
    });

    // Both nodes actually got cut — the session header's own desc line AND
    // the turn block — each carrying the one ellipsis every read surface
    // ends a cut with.
    const ellipsisOccurrences = output.split("…").length - 1;
    expect(ellipsisOccurrences).toBeGreaterThanOrEqual(2);

    // One navigation sentence for the WHOLE response, not one per field — the
    // old scheme repeated it once per truncated field (75 times on a real
    // 49-observation turn, per the spec's measurement).
    const legendOccurrences = output.split(NAVIGATION_LEGEND).length - 1;
    expect(legendOccurrences).toBe(1);
  });

  test("no legend when nothing in the response was truncated", () => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "legend-nothing-truncated",
      project: "claude-mnemo",
      title: "Short and sweet",
      content: "short description",
      insight: null,
      createdAtEpoch: ERA,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    saveTurn(db, {
      sessionId: session.id,
      promptNumber: 1,
      userPrompt: "short prompt",
      assistantResponse: "short response",
      title: "Short turn",
      content: "short content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: ERA + 10,
      updatedAtEpoch: ERA + 10,
      observations: [{ title: "Small observation", content: "small" }],
    });

    const output = recallMemory(db, {
      id: `S${session.id}/T1`,
      depth: "expanded",
    });

    expect(output).not.toContain("Legend:");
    expect(output).not.toContain(NAVIGATION_LEGEND);
  });
});

// ownership-and-note-cadence spec, "session 字段" ([S15069/T910]-[T913]):
// insight/next_steps/decision/done/reference retire from recall's session
// rendering UNCONDITIONALLY — superseding the older era-gated partial
// retirement (semantic-container ticket 09, which used to keep rendering
// them on a pre-cutoff/legacy session). `content` keeps its EXISTING,
// era-gated read path untouched (this ticket does not touch any write path):
// a pre-cutoff session still renders `content`; a post-cutoff session does
// not, same as before. `eraCutoffEpoch: null` (the product default and the
// rollback value) leaves every session on the legacy path for `content`,
// same invariant `turns` already rely on — it has no bearing on the six
// retired fields, which never render regardless.
describe("session semantic fields retire ([S15069/T910]-[T913]); content keeps its era gate (ticket 09)", () => {
  let db: Database;
  const ERA = 500_000;

  afterEach(() => {
    db.close();
  });

  function seedSessionWithFields(contentSessionId: string, createdAtEpoch: number): number {
    const session = upsertSession(db, {
      contentSessionId,
      project: "claude-mnemo",
      title: "Ticket 09 fixture",
      content: "The summary layer's compressed view",
      insight: "- a lesson worth keeping",
      nextSteps: "pick up where this left off",
      createdAtEpoch,
      updatedAtEpoch: createdAtEpoch,
      completedAtEpoch: null,
    });
    updateSessionFields(
      db,
      session.id,
      {
        decision: "- the call landed [T1]",
        done: "- shipped the fix",
        reference: "- docs/plans/redesign.md",
      },
      createdAtEpoch,
    );
    return session.id;
  }

  test("a pre-cutoff (legacy) session renders content but none of the six retired fields", () => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = seedSessionWithFields("ticket09-legacy", ERA - 100);

    const output = recallMemory(db, {
      id: `S${sessionId}`,
      depth: "expanded",
      eraCutoffEpoch: ERA,
    });

    // content keeps its existing (era-gated) read path: a pre-cutoff session
    // still renders it.
    expect(output).toContain("- content: The summary layer's compressed view");
    // insight/decision/done/next/reference retire unconditionally — legacy
    // row or not, still sitting in storage (seedSessionWithFields wrote all
    // of them) but rendered nowhere.
    expect(output).not.toContain("a lesson worth keeping");
    expect(output).not.toContain("- decision:");
    expect(output).not.toContain("the call landed");
    expect(output).not.toContain("- done:");
    expect(output).not.toContain("shipped the fix");
    expect(output).not.toContain("next:");
    expect(output).not.toContain("- reference:");
    expect(output).not.toContain("redesign.md");
  });

  test("a post-cutoff (new) session renders title + stats only, no dead fields", () => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = seedSessionWithFields("ticket09-new", ERA + 100);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "prompt",
      assistantResponse: "response",
      title: "A turn",
      content: "turn content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: ERA + 110,
      updatedAtEpoch: ERA + 110,
      observations: [],
    });

    const output = recallMemory(db, {
      id: `S${sessionId}`,
      depth: "expanded",
      eraCutoffEpoch: ERA,
    });

    expect(output).toContain("Ticket 09 fixture");
    // Count badges are retired everywhere (spec 金样例: "无计数徽章").
    expect(output).not.toContain("💬");
    // The turn's own `content` still renders — only the SESSION's six
    // retired fields are gated.
    expect(output).toContain("- content: turn content");
    // None of the six retired session fields leak through, even though they
    // are still sitting in storage (seedSessionWithFields wrote all of them).
    expect(output).not.toContain("The summary layer's compressed view");
    expect(output).not.toContain("a lesson worth keeping");
    expect(output).not.toContain("- decision:");
    expect(output).not.toContain("the call landed");
    expect(output).not.toContain("- done:");
    expect(output).not.toContain("shipped the fix");
    expect(output).not.toContain("next:");
    expect(output).not.toContain("- reference:");
    expect(output).not.toContain("redesign.md");
  });

  test("collapsed (list) rendering also drops a post-cutoff session's content line", () => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    seedSessionWithFields("ticket09-collapsed", ERA + 100);

    const output = recallMemory(db, {
      query: "Ticket 09",
      depth: "collapsed",
      eraCutoffEpoch: ERA,
    });

    // Ticket 14 (P2-5 fix): the title now bolds matched query terms too.
    expect(output).toContain("**Ticket** **09** fixture");
    expect(output).not.toContain("desc:");
  });

  test("no eraCutoffEpoch configured (product default) still renders content, never the six retired fields", () => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    // A session "created" far in the future still renders its `content`
    // when no operator has set a cutoff — null must mean "every session is
    // legacy" for content's era gate, the same rollback-safe default the
    // turn-level era gate uses. The six retired fields stay gone regardless.
    const sessionId = seedSessionWithFields("ticket09-no-cutoff", ERA + 100);

    const output = recallMemory(db, {
      id: `S${sessionId}`,
      depth: "expanded",
    });

    expect(output).toContain("- content: The summary layer's compressed view");
    expect(output).not.toContain("- shipped the fix");
    expect(output).not.toContain("- decision:");
    expect(output).not.toContain("next:");
  });
});

// Ticket 04 (spec "Tools"): "the same filter object produces the same
// subset semantics on both tools" — recall's `S<n>/T*` id-route AND-composes
// `filter` exactly the way timeline's window does (both consume the shared
// `turnMatchesFilter` in mcp/memory-filter.ts). This suite proves the id
// side of that AND-composition on recall directly, and cross-checks the
// exact same fixture against timeline's turn table.
describe("filter unification (ticket 04): recall's id route AND-composes filter, same as timeline", () => {
  let db: Database;
  let sessionId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);

    const session = upsertSession(db, {
      contentSessionId: "session-filter-unification",
      project: "claude-mnemo",
      title: "Filter unification fixture",
      insight: null,
      createdAtEpoch: 500_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    sessionId = session.id;

    const rows: Array<[number, string, string]> = [
      [1, "discovery", "auth"],
      [2, "decision", "auth"],
      [3, "discovery", "billing"],
      [4, "decision", "billing"],
    ];
    for (const [promptNumber, type, tag] of rows) {
      saveTurn(db, {
        sessionId,
        promptNumber,
        userPrompt: `prompt ${promptNumber}`,
        assistantResponse: `response ${promptNumber}`,
        title: `turn ${promptNumber}`,
        content: `content ${promptNumber}`,
        insight: null,
        type,
        tags: [tag],
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 500_000 + promptNumber,
        updatedAtEpoch: 500_000 + promptNumber,
        observations: [],
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  test("filter.type AND-composes with the S<n>/T* id route", () => {
    const output = recallMemory(db, {
      id: `S${sessionId}/T*`,
      filter: { type: "decision" },
    });

    expect(output).toContain("turn 2");
    expect(output).toContain("turn 4");
    expect(output).not.toContain("turn 1");
    expect(output).not.toContain("turn 3");
  });

  // Mutation-style proof: two filter members together admit strictly fewer
  // turns than either alone (AND, never OR) — same shape as the timeline
  // suite's own proof, run here against recall's id route instead.
  test("filter.type + filter.tag together narrow further than either alone", () => {
    const typeOnly = recallMemory(db, {
      id: `S${sessionId}/T*`,
      filter: { type: "decision" },
    });
    const both = recallMemory(db, {
      id: `S${sessionId}/T*`,
      filter: { type: "decision", tag: "auth" },
    });

    expect(typeOnly).toContain("turn 4"); // decision/billing — admitted by type alone
    expect(both).not.toContain("turn 4"); // excluded once tag also applies
    expect(both).toContain("turn 2"); // decision AND auth
  });

  // The acceptance criterion itself: recall and timeline, given the SAME
  // filter over the SAME session, agree on which turns survive.
  test("recall's S<n>/T* route and timeline's turn view agree on the same filter", () => {
    const filter = { type: "decision" as const };

    const recallOutput = recallMemory(db, { id: `S${sessionId}/T*`, filter });
    const timelineView = buildTimelineView(db, {
      id: `S${sessionId}`,
      view: "turns",
      filter,
    });
    const timelinePrompts = timelineView.windowTurns
      .map((turn) => turn.promptNumber)
      .sort((a, b) => a - b);

    expect(timelinePrompts).toEqual([2, 4]);
    expect(recallOutput).toContain("turn 2");
    expect(recallOutput).toContain("turn 4");
    expect(recallOutput).not.toContain("turn 1");
    expect(recallOutput).not.toContain("turn 3");
  });
});
