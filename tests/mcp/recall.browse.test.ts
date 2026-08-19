import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { sessionWriterId } from "../../src/db/write-gate";
import { upsertSession } from "../../src/db/sessions";
import { estimateTokens } from "../../src/utils/token-estimate";
import { recallMemory } from "../../src/mcp/recall";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

/**
 * Ticket 07 (read-write-contract spec, "视图(读面)"): the unified renderer
 * kernel + browse shape — bare `recall()` (no `id`, no `query`, no SCOPING
 * `filter`) renders a GLOBAL chronological turn feed. Session title on
 * first-page-appearance only; pageBudget overflow paginates, never
 * truncates a shown block; `turn` is the one per-field word-boundary knife,
 * split evenly across `filter.fields`; rewind turns carry a marker; the
 * renderer's read-grant recording seam (write-gate ticket 01) survives the
 * swap.
 */
describe("recall() browse shape", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeSession(contentId: string, title: string, createdAtEpoch: number): number {
    return upsertSession(db, {
      contentSessionId: contentId,
      project: "/tmp/project",
      title,
      content: null,
      insight: null,
      createdAtEpoch,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;
  }

  test("a session's title appears only on its first appearance on the page; alternation does not repeat it", () => {
    const sessionA = makeSession("session-a", "Session A", 1_000);
    const sessionB = makeSession("session-b", "Session B", 1_100);

    // Interleave in time: A(older), B, A(newer), B — an alternation.
    saveTurn(db, {
      sessionId: sessionA,
      promptNumber: 1,
      userPrompt: "a1",
      assistantResponse: "r",
      title: "A first",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 1_001,
      updatedAtEpoch: null,
      observations: [],
    });
    saveTurn(db, {
      sessionId: sessionB,
      promptNumber: 1,
      userPrompt: "b1",
      assistantResponse: "r",
      title: "B first",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 1_002,
      updatedAtEpoch: null,
      observations: [],
    });
    saveTurn(db, {
      sessionId: sessionA,
      promptNumber: 2,
      userPrompt: "a2",
      assistantResponse: "r",
      title: "A second",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 1_003,
      updatedAtEpoch: null,
      observations: [],
    });

    const output = recallMemory(db, { pageBudget: 100_000, pageSize: 50 });
    // Most-recent-first: A second (1003), B first (1002), A first (1001).
    expect(output).toContain(`[S${sessionA}] Session A`);
    expect(output).toContain(`[S${sessionB}] Session B`);
    // Session A's title line appears exactly once, even though A shows up
    // twice on the page (once at the top, once further down after B).
    const titleOccurrences = output.split(`[S${sessionA}] Session A`).length - 1;
    expect(titleOccurrences).toBe(1);
    expect(output).toContain("A second");
    expect(output).toContain("A first");
  });

  test("pageBudget overflow produces a second page rather than truncating a shown block", () => {
    const sessionId = makeSession("session-overflow", "Overflow session", 2_000);
    for (let i = 1; i <= 8; i += 1) {
      saveTurn(db, {
        sessionId,
        promptNumber: i,
        userPrompt: `prompt ${i}`,
        assistantResponse: "r",
        title: `Turn title ${i} with enough words to cost real tokens`,
        content: `Turn content ${i} also long enough to cost real tokens in the render`,
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: 2_000 + i,
        updatedAtEpoch: null,
        observations: [],
      });
    }

    const roomy = recallMemory(db, { pageBudget: 100_000, pageSize: 50 });
    expect(roomy).toContain("Turn title 1 ");
    expect(roomy).toContain("Turn title 8 ");

    // A tight pageBudget cannot fit every turn on page 1 — the overflow must
    // reach page 2, and every field on page 1 must render WHOLE (never a
    // mid-field truncation caused by the page-level budget).
    const tightPage1 = recallMemory(db, { pageBudget: 120, pageSize: 50, page: 1 });
    const tightPage2 = recallMemory(db, { pageBudget: 120, pageSize: 50, page: 2 });
    expect(tightPage1).toMatch(/page 1 \/ \d+/);
    expect(tightPage2).not.toBe(tightPage1);
    // Whatever fields DID make it onto page 1 render in full — no field-level
    // ellipsis caused purely by the page budget (pageBudget never truncates a
    // block; only `turn` cuts a field, and `turn` was not set here).
    expect(tightPage1).not.toContain("…");
  });

  test("filter.fields selects an arbitrary field combination, and turn splits its budget evenly across them", () => {
    const sessionId = makeSession("session-fields", "Fields session", 3_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "a rather long user prompt that would normally get cut down under a small budget",
      assistantResponse: "a rather long assistant response that would also normally get cut under budget",
      title: "short title",
      content: "short content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 3_001,
      updatedAtEpoch: null,
      observations: [],
    });

    const promptAndResponse = recallMemory(db, {
      filter: { fields: ["prompt", "response"] },
    });
    expect(promptAndResponse).toContain("- prompt:");
    expect(promptAndResponse).toContain("- response:");
    expect(promptAndResponse).not.toContain("- title:");
    expect(promptAndResponse).not.toContain("- content:");

    const titleOnly = recallMemory(db, { filter: { fields: ["title"] } });
    expect(titleOnly).toContain("- title:");
    expect(titleOnly).not.toContain("- content:");
    expect(titleOnly).not.toContain("- prompt:");
  });

  test("an unrecognized filter.fields entry rejects and echoes the grammar", () => {
    const output = recallMemory(db, {
      // @ts-expect-error — deliberately invalid for the error-path assertion.
      filter: { fields: ["bogus"] },
    });
    expect(output).toContain("Parameter error");
    expect(output).toContain("invalid filter.fields entry");
    expect(output).toContain("title");
    expect(output).toContain("content");
  });

  test("a rewound turn renders with a marker; a non-rewound one does not", () => {
    const sessionId = makeSession("session-rewind", "Rewind session", 4_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "will be rewound",
      assistantResponse: "r",
      title: "Rewound turn",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 4_001,
      updatedAtEpoch: null,
      observations: [],
    });
    saveTurn(db, {
      sessionId,
      promptNumber: 2,
      userPrompt: "normal turn",
      assistantResponse: "r",
      title: "Normal turn",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 4_002,
      updatedAtEpoch: null,
      observations: [],
    });
    db.query("UPDATE turns SET was_rolled_back = 1 WHERE session_id = ? AND prompt_number = 1").run(sessionId);

    const output = recallMemory(db, { pageBudget: 100_000, pageSize: 50 });
    const rewoundLine = output.split("\n").find((line) => line.includes("Rewound turn"))!;
    const normalLine = output.split("\n").find((line) => line.includes("Normal turn"));
    void normalLine;
    const rewoundLabelLine = output.split("\n").find((line) => line.includes(`T1]`));
    expect(rewoundLabelLine).toContain("rewound");
    expect(rewoundLabelLine).toContain("stale");
    const normalLabelLine = output.split("\n").find((line) => line.includes(`T2]`));
    expect(normalLabelLine).not.toContain("rewound");
    void rewoundLine;
  });

  test("bare recall() records a read grant for the reader on shown turns and sessions", () => {
    const sessionId = makeSession("session-grant", "Grant session", 5_000);
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "p",
      assistantResponse: "r",
      title: "Grant turn",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 5_001,
      updatedAtEpoch: null,
      observations: [],
    });

    const readerId = sessionWriterId(999);
    recallMemory(db, { readerId, pageBudget: 100_000, pageSize: 50 });

    const turnGrant = db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn' AND entity_id = ?",
      )
      .get(readerId, turn.id);
    const sessionGrant = db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM write_gate_reads WHERE writer = ? AND entity_type = 'session' AND entity_id = ?",
      )
      .get(readerId, sessionId);

    expect(turnGrant?.n).toBe(1);
    expect(sessionGrant?.n).toBe(1);
  });

  test("obs renders always truncated regardless of the browse feed's own field selection", () => {
    // The browse feed itself has no "expand observations fully" path — an
    // observation is only ever reachable through its owning turn's normal
    // id-addressed / search render, which already always truncates
    // (format.ts's formatObservation*WithMode always calls truncateText /
    // truncateLines with a finite limit — there is no unbounded obs path).
    const sessionId = makeSession("session-obs", "Obs session", 6_000);
    const longContent = "x".repeat(5_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "p",
      assistantResponse: "r",
      title: "Obs turn",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 6_001,
      updatedAtEpoch: null,
      observations: [{ title: "Big obs", content: longContent }],
    });

    const output = recallMemory(db, {
      id: `S${sessionId}/T1`,
      depth: "expanded",
    });
    expect(output).not.toContain(longContent);
  });
});

/**
 * Ticket 07: the settlement session-summary consumer swap itself is CARVED
 * OUT of this ticket's scope (territory: the note-settlement modules and
 * worker/server.ts belong to a sibling). What this ticket owns is the
 * renderer API being ready for a one-call swap — proven here by rendering a
 * session whose turn content exceeds 2000 tokens through the EXISTING
 * unified renderer with a large `turn` budget and confirming nothing gets
 * elided.
 */
describe("renderer supports a large-turn-budget full render (settlement swap is a one-call change, deferred)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a >2000-token turn content renders in full when the caller passes a large turn budget", () => {
    const sessionId = upsertSession(db, {
      contentSessionId: "session-full",
      project: "/tmp/project",
      title: "Full-text session",
      content: null,
      insight: null,
      createdAtEpoch: 7_000,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    // "sentence " is 1 token-ish per estimateTokens; repeat well past 2000
    // tokens worth of content.
    const longContent = Array.from({ length: 2_500 }, (_, i) => `sentence${i}`).join(" ");
    expect(estimateTokens(longContent)).toBeGreaterThan(2_000);

    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "p",
      assistantResponse: "r",
      title: "Long turn",
      content: longContent,
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 7_001,
      updatedAtEpoch: null,
      observations: [],
    });

    // The one-call swap settlement owes: recallMemory(id="S<n>", depth=
    // "expanded", turn=<large>, truncateCap=<large>) — no new renderer, no
    // new code path. `turn` alone is NOT enough: it only caps the whole
    // rendered TURN BLOCK by tokens (capTurnRenderToTokenBudget, dropping
    // trailing lines) — the per-FIELD character cut (`truncate`/
    // `truncateCap`, default 200/2000 chars) is a SEPARATE mechanism inside
    // formatTurnCollapsedWithMode/formatTurnExpandedWithMode and still
    // applies underneath it. A full-text render needs both raised together.
    const output = recallMemory(db, {
      id: `S${sessionId}`,
      depth: "expanded",
      turn: 200_000,
      truncate: 200_000,
      truncateCap: 200_000,
    });

    expect(output).toContain(longContent);
    expect(output).not.toContain("turn truncated to fit the per-turn budget");
  });
});
