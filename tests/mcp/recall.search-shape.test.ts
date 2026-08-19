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

  // Ticket 03 (view-render-repair): pageBudget is a PAGE-level token budget
  // on the search shape — overflow starts the next page instead of packing
  // every hit into page 1.
  function seedSplitHits(term: string, baseEpoch: number): number {
    const sessionId = makeSession(`session-${term}`, `Session ${term}`, baseEpoch);
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      saveTurn(db, {
        sessionId,
        promptNumber,
        userPrompt: "p",
        assistantResponse: "r",
        title: `Hit ${promptNumber} for ${term}`,
        content: `${term} result number ${promptNumber} padded with enough surrounding words to carry real token weight in a rendered row`,
        insight: null,
        filesRead: [],
        filesModified: [],
        createdAtEpoch: baseEpoch + promptNumber,
        updatedAtEpoch: null,
        observations: [],
      });
    }
    return sessionId;
  }

  test("a small pageBudget splits search hits across pages; a generous one does not", () => {
    seedSplitHits("splitterm", 9_000);
    // A single page renders no page header at all; the split announces itself.
    const generous = recallMemory(db, { query: "splitterm", pageBudget: 4_000 });
    expect(generous).not.toContain("page 1 /");
    const tight = recallMemory(db, { query: "splitterm", pageBudget: 60 });
    expect(tight).toContain("page 1 /");
    expect(tight).not.toContain("page 1 / 1");
  });

  // The hazard the grant-COUNT tests cannot see: `write_gate_reads` upserts
  // on its (writer, entity, id) key, so a probe that re-records a delivered
  // entity is invisible. What a probe CAN corrupt is scope — trial renders
  // touch candidate hits that land on LATER pages, and with a readerId they
  // would grant entities the caller never received: write permission without
  // a read. Granted turns must therefore be exactly the delivered rows.
  test("budget probing grants nothing beyond the delivered page", () => {
    seedSplitHits("probeterm", 9_500);
    const readerId = sessionWriterId(77);
    const out = recallMemory(db, { query: "probeterm", pageBudget: 60, readerId });
    expect(out).not.toContain("page 1 / 1");

    const deliveredRows = (out.match(/\[T\d+\]/g) ?? []).length;
    expect(deliveredRows).toBeGreaterThan(0);
    expect(deliveredRows).toBeLessThan(6);

    const grantedTurns = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM write_gate_reads WHERE writer = ? AND entity_type = 'turn'",
      )
      .get(readerId)!.n;
    expect(grantedTurns).toBe(deliveredRows);
  });
});

/**
 * Ticket 04 (view-render-repair spec, "命中即展示"): a search hit landing in
 * a turn's PROMPT text renders that row's `- prompt: ` field line (bolded +
 * neighborhood, same machinery as `content`); a sibling row whose match
 * landed elsewhere renders none. `prompt` stays out of the default field set
 * — it surfaces per row as the evidence that ranked the row, not as a
 * standing field. An explicit `filter.fields` including `prompt` still wins
 * unconditionally (caller override).
 */
describe("recall(query=...) search shape — matched-field prompt line (ticket 04)", () => {
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

  // Score order means the two turns can render in either sequence — this
  // isolates the substring between one turn's own bracketed address and the
  // next, order-independent, rather than assuming a fixed [T1] then [T2].
  function turnBlock(output: string, address: string): string {
    const start = output.indexOf(address);
    expect(start).toBeGreaterThan(-1);
    const after = output.slice(start + address.length);
    const nextTurn = after.search(/\[T\d+\]/);
    return nextTurn === -1 ? after : after.slice(0, nextTurn);
  }

  test("a prompt-text hit renders that row's prompt line; a sibling row without a prompt match renders none", () => {
    const sessionId = makeSession("session-prompt-match", "Prompt match session", 10_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "how do I fix the flumox timeout error",
      assistantResponse: "r",
      title: "Investigate the failure",
      content: "Looked at the stack trace and the logs",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 10_001,
      updatedAtEpoch: null,
      observations: [],
    });
    saveTurn(db, {
      sessionId,
      promptNumber: 2,
      userPrompt: "totally unrelated question",
      assistantResponse: "r",
      title: "Flumox handling notes",
      content: "Added flumox handling to the pipeline",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 10_002,
      updatedAtEpoch: null,
      observations: [],
    });

    const output = recallMemory(db, { query: "flumox" });

    const promptLineCount = (output.match(/- prompt:/g) ?? []).length;
    expect(promptLineCount).toBe(1);

    const t1Block = turnBlock(output, "[T1]");
    const t2Block = turnBlock(output, "[T2]");
    expect(t1Block).toContain("- prompt:");
    expect(t1Block).toContain("**flumox**");
    expect(t2Block).not.toContain("- prompt:");
  });

  test("a content-only hit renders no prompt line anywhere", () => {
    const sessionId = makeSession("session-content-only", "Content only session", 11_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "please look into this for me",
      assistantResponse: "r",
      title: "Zanther investigation",
      content: "The zanther subsystem is misbehaving under load",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 11_001,
      updatedAtEpoch: null,
      observations: [],
    });

    const output = recallMemory(db, { query: "zanther" });
    expect(output).toContain("**zanther**");
    expect(output).not.toContain("- prompt:");
  });

  test("filter.fields including prompt still renders it on every row, matched or not (caller override)", () => {
    const sessionId = makeSession("session-explicit-fields", "Explicit fields session", 12_000);
    saveTurn(db, {
      sessionId,
      promptNumber: 1,
      userPrompt: "the grombus prompt itself",
      assistantResponse: "r",
      title: "Grombus turn one",
      content: "content mentions grombus too",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 12_001,
      updatedAtEpoch: null,
      observations: [],
    });
    saveTurn(db, {
      sessionId,
      promptNumber: 2,
      userPrompt: "an unrelated line with no hit text",
      assistantResponse: "r",
      title: "Grombus turn two",
      content: "also mentions grombus",
      insight: null,
      filesRead: [],
      filesModified: [],
      createdAtEpoch: 12_002,
      updatedAtEpoch: null,
      observations: [],
    });

    const output = recallMemory(db, {
      query: "grombus",
      filter: { session: sessionId, fields: ["title", "content", "prompt"] },
    });

    // Both rows render the field, even though only T1's own prompt text
    // contains the query term — explicit `filter.fields` is unconditional.
    const promptLineCount = (output.match(/- prompt:/g) ?? []).length;
    expect(promptLineCount).toBe(2);
  });
});
