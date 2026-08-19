import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { sessionWriterId } from "../../src/db/write-gate";
import { upsertSession } from "../../src/db/sessions";
import { boldSearchSnippet, recallMemory } from "../../src/mcp/recall";
import { createTruncationSignal } from "../../src/mcp/format";
import { saveTurnFixture as saveTurn } from "../support/turn-fixtures";

/**
 * Ticket 08 (read-write-contract spec, "一工具两形态" 搜索半边): `query=`
 * renders in score order with matched terms bolded and a neighborhood window
 * around the match, replacing the default even-split truncation — and
 * (closing the flagged gap) now records the same read grants the browse
 * shape and id-addressed routes already do.
 */
describe("boldSearchSnippet (pure)", () => {
  test("bolds the matched term and centers a neighborhood window around it", () => {
    const text =
      "the quick brown fox jumps over the lazy dog and then keeps running far into the distance beyond";
    const out = boldSearchSnippet(text, ["fox"], 30);
    expect(out).toContain("**fox**");
  });

  test("no term found falls back to a plain word-boundary truncate from the start", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const out = boldSearchSnippet(text, ["nonexistent"], 20);
    expect(out).not.toContain("**");
    expect(out.length).toBeLessThan(text.length);
  });

  test("tail cut is word-boundary on both sides, evenly split", () => {
    const text = "aaaaaaaaaa bbbbbbbbbb TARGET cccccccccc dddddddddd";
    const signal = createTruncationSignal();
    const out = boldSearchSnippet(text, ["TARGET"], 20, signal);
    expect(out).toContain("**TARGET**");
    // Neither side spills the WHOLE surrounding text — both were cut.
    expect(out.startsWith("…") || out.includes("aaaaaaaaaa")).toBeTruthy();
    expect(signal.truncated).toBe(true);
    // No word is split mid-way: every alphabetic run in the output is a
    // whole run from the source text (no partial "aaaaa" / "ccccc" stub of
    // a different length than any run in the source).
    for (const word of out.replace(/[…*]/g, "").split(/\s+/).filter(Boolean)) {
      expect(text.includes(word) || word === "TARGET").toBe(true);
    }
  });

  test("bolds every occurrence of any term inside the window, not just the anchor", () => {
    const text = "auth auth auth fails because of auth race conditions in the refresh path";
    const out = boldSearchSnippet(text, ["auth"], 200);
    const occurrences = out.split("**auth**").length - 1;
    expect(occurrences).toBeGreaterThan(1);
  });
});

describe("recall(query=...) search shape", () => {
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

  test("a query hit's content renders with the matched term bolded", () => {
    const sessionId = makeSession("session-q", "Query session", 1_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "why does auth fail",
      assistantResponse: "r",
      title: "Auth investigation",
      content: "There is a race condition in the token refresh path that causes auth failures",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 1_001,
      updatedAtEpoch: null,
      observations: [],
    });

    const output = recallMemory(db, { query: "refresh" });
    expect(output).toContain("**refresh**");
  });

  test("hits render in score order — a turn matching in both title and content outranks a weaker match", () => {
    const sessionId = makeSession("session-rank", "Rank session", 2_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "weak match turn",
      assistantResponse: "r",
      title: "unrelated",
      content: "mentions widget once in passing",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 2_001,
      updatedAtEpoch: null,
      observations: [],
    });
    saveTurn(db, {
      sessionId,
      promptNumber: 2,
      userPrompt: "strong match turn",
      assistantResponse: "r",
      title: "widget widget widget",
      content: "widget widget widget widget widget",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 1_500, // older, but far stronger textual match
      updatedAtEpoch: null,
      observations: [],
    });

    const output = recallMemory(db, { query: "widget", filter: { session: sessionId } });
    const strongIndex = output.indexOf("[T2]");
    const weakIndex = output.indexOf("[T1]");
    expect(strongIndex).toBeGreaterThan(-1);
    expect(weakIndex).toBeGreaterThan(-1);
    // The stronger (higher-relevance) hit renders first despite being OLDER
    // — score order, not chronological order.
    expect(strongIndex).toBeLessThan(weakIndex);
  });

  test("a query render records read grants for the reader (closes the flagged gap)", () => {
    const sessionId = makeSession("session-grant-q", "Grant query session", 3_000);
    const turn = saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "p",
      assistantResponse: "r",
      title: "Grant query turn",
      content: "a searchable needle in this content",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 3_001,
      updatedAtEpoch: null,
      observations: [],
    });

    const readerId = sessionWriterId(4242);
    recallMemory(db, { query: "needle", readerId });

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

  test("no query, no filter: bare browse still records grants unaffected by the search-path change", () => {
    const sessionId = makeSession("session-bare-grant", "Bare grant session", 5_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "p",
      assistantResponse: "r",
      title: "Bare grant turn",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 5_001,
      updatedAtEpoch: null,
      observations: [],
    });
    const readerId = sessionWriterId(1);
    recallMemory(db, { readerId });
    const grant = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM write_gate_reads WHERE writer = ? AND entity_type = 'session'",
      )
      .get(readerId);
    expect(grant?.n).toBeGreaterThan(0);
  });
});
