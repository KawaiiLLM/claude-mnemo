import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb } from "../../src/db/search";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  getSegment,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { capTurnRenderToTokenBudget, DEFAULT_TURN_TOKEN_BUDGET_COLLAPSED } from "../../src/mcp/format";
import { recallMemory } from "../../src/mcp/recall";
import {
  elideSegmentCardFields,
  MAX_ATTACHED_SESSION_ROWS,
  type SegmentCardFieldRows,
} from "../../src/mcp/segment-card";
import { estimateTokens } from "../../src/utils/token-estimate";

/**
 * Ticket 03 — the segment card, the turn field-set switch, `E<n>/T<m>`
 * ordinal addressing, per-turn/page token budgets, bare `recall()` leading
 * with segments, and the absence of election/tier data anywhere in a recall
 * render.
 */

// ---------------------------------------------------------------------------
// Field elision — the pure mechanism, tested directly (mutation target 1/3).
// ---------------------------------------------------------------------------

describe("elideSegmentCardFields", () => {
  test("drops the LARGEST field's rows before a smaller field's, even when the smaller field alone would need trimming", () => {
    // constraints: 4 rows x 1 token each = 4 tokens (the larger field).
    // goal: 1 row x 1 token = 1 token (the smaller field).
    const fields: SegmentCardFieldRows[] = [
      { field: "goal", rows: ["EEEE"] },
      { field: "constraints", rows: ["AAAA", "BBBB", "CCCC", "DDDD"] },
    ];

    const result = elideSegmentCardFields(fields, 3);
    const goal = result.find((entry) => entry.field === "goal")!;
    const constraints = result.find((entry) => entry.field === "constraints")!;

    // The smaller field is never touched while a larger one still has rows.
    expect(goal.droppedCount).toBe(0);
    expect(goal.keptRows).toEqual(["EEEE"]);
    // The larger field sheds rows OLDEST first (array order = storage order).
    expect(constraints.droppedCount).toBe(2);
    expect(constraints.keptRows).toEqual(["CCCC", "DDDD"]);
  });

  test("ties on size break by the fields' own declared order — the first-listed field trims first", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "goal", rows: ["AAAA"] },
      { field: "constraints", rows: ["BBBB"] },
    ];

    // Budget 1: exactly one row's worth of the total 2 tokens must go — the
    // tie is broken, not the whole set drained to zero.
    const result = elideSegmentCardFields(fields, 1);
    expect(result.find((entry) => entry.field === "goal")!.droppedCount).toBe(1);
    expect(result.find((entry) => entry.field === "constraints")!.droppedCount).toBe(0);
  });

  test("never drops below the budget once every field is exhausted, and never loops forever on a zero budget", () => {
    const fields: SegmentCardFieldRows[] = [{ field: "done", rows: ["one row"] }];
    const result = elideSegmentCardFields(fields, 0);
    expect(result[0]!.droppedCount).toBe(1);
    expect(result[0]!.keptRows).toEqual([]);
  });

  test("under budget, nothing is dropped at all", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "goal", rows: ["a", "b"] },
      { field: "decisions", rows: ["c"] },
    ];
    const result = elideSegmentCardFields(fields, 1000);
    expect(result.every((entry) => entry.droppedCount === 0)).toBe(true);
  });

  // ---- ticket 08: the summary layer (title/content/insight) now competes
  // in the SAME ladder as Working State, not a privileged, never-elided
  // layer rendered ahead of it. ----
  test("a summary-layer field (e.g. content) is evicted before a smaller Working State field, purely on size", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "content", rows: ["x".repeat(400)] }, // ~100 tokens, one row
      { field: "goal", rows: ["small goal row"] }, // a handful of tokens
    ];

    const result = elideSegmentCardFields(fields, 10);
    const content = result.find((entry) => entry.field === "content")!;
    const goal = result.find((entry) => entry.field === "goal")!;

    expect(content.droppedCount).toBe(1);
    expect(content.keptRows).toEqual([]);
    expect(goal.droppedCount).toBe(0);
    expect(goal.keptRows).toEqual(["small goal row"]);
  });

  test("the reverse also holds: a Working State field larger than a summary-layer field is the one that gives way", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "content", rows: ["short desc"] },
      {
        field: "decisions",
        rows: Array.from({ length: 20 }, (_, i) => `decision row ${i} ${"y".repeat(40)}`),
      },
    ];

    const result = elideSegmentCardFields(fields, 15);
    const content = result.find((entry) => entry.field === "content")!;
    const decisions = result.find((entry) => entry.field === "decisions")!;

    expect(content.droppedCount).toBe(0);
    expect(content.keptRows).toEqual(["short desc"]);
    expect(decisions.droppedCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-turn token budget cap — the pure mechanism (mutation target: the
// "keep the label, trim the tail" direction).
// ---------------------------------------------------------------------------

describe("capTurnRenderToTokenBudget", () => {
  test("keeps the label line even when the budget is too small for anything else", () => {
    const rendered = ["  - [S1][T1] a title", "    - desc: filler text here"].join("\n");
    const capped = capTurnRenderToTokenBudget(rendered, 1);
    expect(capped.split("\n")[0]).toBe("  - [S1][T1] a title");
    expect(capped).toContain("turn truncated to fit");
  });

  test("leaves a render under budget untouched", () => {
    const rendered = "  - [S1][T1] short";
    expect(capTurnRenderToTokenBudget(rendered, 1000)).toBe(rendered);
  });

  test("undefined budget means uncapped", () => {
    const rendered = "x".repeat(5000);
    expect(capTurnRenderToTokenBudget(rendered, undefined)).toBe(rendered);
  });
});

// ---------------------------------------------------------------------------
// The card at the MCP seam.
// ---------------------------------------------------------------------------

describe("recall(id=\"E<n>\") segment card", () => {
  let db: Database;
  let sessionId: number;
  let segmentId: number;
  const CUTOFF = 1_950_000_000;

  function makeTurn(
    promptNumber: number,
    options: { type?: string; title?: string; tags?: string[]; epoch?: number } = {},
  ): number {
    const id = db
      .query<{ id: number }, [number, number, string, string, string, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, type, title, tags, created_at_epoch,
           user_prompt, assistant_response, content, files_read, files_modified
         ) VALUES (?, ?, 'extracted', ?, ?, ?, ?, 'user prompt text',
                   'assistant response text', 'turn body', '[]', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.type ? JSON.stringify([options.type]) : "[]",
        options.title ?? `title ${promptNumber}`,
        JSON.stringify(options.tags ?? []),
        options.epoch ?? CUTOFF + promptNumber,
      )!.id;
    reindexTurnFromDb(db, id);
    return id;
  }

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-card",
      project: "/tmp/project",
      title: "Card session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const segment = createSegment(db, {
      title: "the segment card ships",
      type: ["implement"],
      tags: ["card"],
      nowEpoch: CUTOFF,
    });
    segmentId = segment.id;

    const t1 = makeTurn(1, { type: "research", title: "research the card", tags: ["card"] });
    const t2 = makeTurn(2, { type: "implement", title: "implement the card", tags: ["card"] });
    addSegmentMembers(db, segmentId, [t1, t2], CUTOFF);
    attachSegmentToSession(db, sessionId, segmentId, CUTOFF);
  });

  afterEach(() => {
    db.close();
  });

  test("collapsed header carries topic-free label, status, member count, created/last-edit/maintenance", () => {
    const output = recallMemory(db, { id: `E${segmentId}` });

    expect(output).toContain(`[E${segmentId}]`);
    expect(output).toContain("[open]");
    expect(output).toContain("2 turns");
    expect(output).toContain("created ");
    expect(output).toContain("last edit ");
    expect(output).toMatch(/maintenance \d+ turns? ago/);
  });

  test("tags and type render with per-member counts", () => {
    const output = recallMemory(db, { id: `E${segmentId}` });
    expect(output).toContain("#card×2");
    expect(output).toMatch(/🔍research×1/);
    expect(output).toMatch(/🔧implement×1/);
  });

  test("sessions section shows one line per attached session — member count and last-active, consulted-only marked", () => {
    const other = upsertSession(db, {
      contentSessionId: "session-consult-only",
      project: "/tmp/project",
      title: "Just consulting",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: CUTOFF + 5,
      completedAtEpoch: null,
    }).id;
    attachSegmentToSession(db, other, segmentId, CUTOFF);

    const output = recallMemory(db, { id: `E${segmentId}` });
    expect(output).toContain(`S${sessionId}`);
    expect(output).toMatch(new RegExp(`S${sessionId}[^\\n]*2 turns`));
    expect(output).toContain(`S${other}`);
    expect(output).toMatch(new RegExp(`S${other}[^\\n]*consulted only`));
  });

  test("collapsed shows per-field row counts and elides an over-budget field with the ellipsis at the top, newest rows kept", () => {
    // Grow `decisions` well past a tiny page budget: five distinct rows.
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "decisions",
        [`decision number ${index} with enough padding to cost real tokens ${"x".repeat(20)}`],
        CUTOFF + index,
      );
    }

    // Measure the card's own natural (unelided) size, then halve the budget —
    // robust to exactly how many tokens the header/labels cost (which this
    // test does not otherwise pin): the five ~20-token decision rows
    // dominate that size, so a halved budget reliably forces several of
    // them out while the much smaller header/label overhead survives whole.
    const fullOutput = recallMemory(db, { id: `E${segmentId}`, pageBudget: 100_000 });
    const pageBudget = Math.floor(estimateTokens(fullOutput) / 2);
    const output = recallMemory(db, { id: `E${segmentId}`, pageBudget });
    const decisionsBlock = output.split("- decisions:")[1]?.split(/- (goal|constraints|done|next_steps|reference):/)[0] ?? "";

    expect(decisionsBlock).toContain("5 rows");
    // Ellipsis sits at the TOP of the field.
    const ellipsisIndex = decisionsBlock.indexOf("… +");
    const newestRowIndex = decisionsBlock.indexOf("decision number 4");
    expect(ellipsisIndex).toBeGreaterThan(-1);
    expect(newestRowIndex).toBeGreaterThan(-1);
    expect(ellipsisIndex).toBeLessThan(newestRowIndex);
    // The newest row survives; an old one does not.
    expect(decisionsBlock).not.toContain("decision number 0");
  });

  // ---- ticket 08: no character-level truncate, summary layer joins the
  // elision ladder, attached-session rows are capped ----

  test("no character-level truncation: a long title survives whole under an ample budget (spec: the `truncate` knob retires)", () => {
    const longTitle = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    expect(longTitle.length).toBeGreaterThan(200); // would have hit the old 200-char DEFAULT_TRUNCATE
    const longSegment = createSegment(db, { title: longTitle, nowEpoch: CUTOFF });

    const output = recallMemory(db, { id: `E${longSegment.id}` });
    expect(output).toContain(longTitle);
    expect(output).not.toContain("…");
  });

  test("the summary layer competes on SIZE, not privilege — a big `content` yields to a small Working State row under tight budget", () => {
    const segment = createSegment(db, {
      title: "budget priority segment",
      content: "z".repeat(4000), // ~1000 tokens, dwarfs everything else on the card
      nowEpoch: CUTOFF,
    });
    appendSegmentWorkingStateRows(db, segment.id, "goal", ["ship the priority fix"], CUTOFF);

    // Big enough for the header + the tiny goal row, nowhere near big enough
    // to also carry the content blob.
    const output = recallMemory(db, { id: `E${segment.id}`, pageBudget: 100 });
    expect(output).toContain("ship the priority fix");
    expect(output).not.toContain("desc:");
    // Pre-ticket-08 behaviour: content rendered unconditionally, unelided,
    // ahead of Working State — this proves the reversal, not just that
    // *something* got cut.
  });

  test("attached-session rows are capped with overflow folded into a count — the header no longer grows unbounded with attachment count", () => {
    const extra = MAX_ATTACHED_SESSION_ROWS + 3;
    for (let index = 0; index < extra; index += 1) {
      const other = upsertSession(db, {
        contentSessionId: `session-overflow-${index}`,
        project: "/tmp/project",
        title: `Overflow session ${index}`,
        content: null,
        insight: null,
        nextSteps: null,
        createdAtEpoch: CUTOFF + index,
        updatedAtEpoch: CUTOFF + index,
        completedAtEpoch: null,
      }).id;
      attachSegmentToSession(db, other, segmentId, CUTOFF + index);
    }

    const output = recallMemory(db, { id: `E${segmentId}` });
    const sessionLines = output.split("\n").filter((line) => /^\s+- S\d+/.test(line));
    expect(sessionLines.length).toBe(MAX_ATTACHED_SESSION_ROWS);
    expect(output).toMatch(/… \+\d+ more sessions?/);
    // The cap keeps the FRESHEST rows, not merely five rows: with 8 overflow
    // sessions at ascending lastActive, the survivors are exactly the top
    // five (indices 3..7) and the colder tail folds into the count line.
    // An implementation that capped in attachment order (or sorted the wrong
    // way) passes the two counts above and fails here.
    expect(output).toContain("Overflow session 7");
    expect(output).toContain("Overflow session 3");
    expect(output).not.toContain("Overflow session 2");
  });

  test("mutation demo (ticket 08 checklist item 4): a large attachment count no longer starves the field budget to zero", () => {
    appendSegmentWorkingStateRows(db, segmentId, "goal", ["ship the fix"], CUTOFF);
    // 300 attachments comfortably exceeds the default 1000-token page budget
    // on their own if rendered uncapped (each row costs tens of tokens) —
    // large enough that the pre-fix behavior (one row per attachment, no
    // cap) reliably starves the field ladder to zero, not just "shrinks it".
    for (let index = 0; index < 300; index += 1) {
      const other = upsertSession(db, {
        contentSessionId: `session-mutate-${index}`,
        project: "/tmp/project",
        title: `Session ${index}`,
        content: null,
        insight: null,
        nextSteps: null,
        createdAtEpoch: CUTOFF + index,
        updatedAtEpoch: CUTOFF + index,
        completedAtEpoch: null,
      }).id;
      attachSegmentToSession(db, other, segmentId, CUTOFF + index);
    }

    const output = recallMemory(db, { id: `E${segmentId}` }); // default pageBudget: 1000
    expect(output).toContain("ship the fix");
  });

  test("expanded never elides — all rows render regardless of the page budget", () => {
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "decisions",
        [`decision number ${index}`],
        CUTOFF + index,
      );
    }

    const output = recallMemory(db, { id: `E${segmentId}`, depth: "expanded", pageBudget: 5 });
    for (let index = 0; index < 5; index += 1) {
      expect(output).toContain(`decision number ${index}`);
    }
    expect(output).not.toContain("… +");
  });

  test("expanded carries a member index in event order with each member's S/T home address", () => {
    const output = recallMemory(db, { id: `E${segmentId}`, depth: "expanded" });
    expect(output).toContain("member index");
    expect(output).toContain(`1. S${sessionId}/T1 "research the card"`);
    expect(output).toContain(`2. S${sessionId}/T2 "implement the card"`);
  });

  // ---- pagination stability (mutation target 2/3) ----

  test("page overflow paginates STABLY: page 2 deterministically re-fetches the un-elided card", () => {
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "decisions",
        [`decision number ${index}`],
        CUTOFF + index,
      );
    }

    const page1First = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20 });
    const page1Second = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20 });
    const page2First = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20, page: 2 });
    const page2Second = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20, page: 2 });

    // Page 1 is stable across repeated calls, and shows the ellipsis.
    expect(page1First).toBe(page1Second);
    expect(page1First).toContain("… +");

    // Page 2 is ALSO stable across repeated calls, and never drops a row —
    // recall is the lossless index.
    expect(page2First).toBe(page2Second);
    expect(page2First).not.toContain("… +");
    for (let index = 0; index < 5; index += 1) {
      expect(page2First).toContain(`decision number ${index}`);
    }
  });

  // ---- ordinal -> S/T mapping (mutation target 3/3) ----

  test("E<n>/T<m> ordinals follow EVENT order (creation time), not DB insertion order or anchor/rank order", () => {
    // t3 is created chronologically BEFORE t2 but inserted into the DB (and
    // thus assigned a turn id) AFTER it — event order must follow the
    // timestamp, never the id or insertion sequence.
    const t3 = makeTurn(3, { title: "earliest by clock, latest by id", epoch: CUTOFF - 500 });
    addSegmentMembers(db, segmentId, [t3], CUTOFF);

    const first = recallMemory(db, { id: `E${segmentId}/T1` });
    expect(first).toContain("earliest by clock, latest by id");

    const third = recallMemory(db, { id: `E${segmentId}/T3` });
    expect(third).toContain("implement the card");
  });

  test("an out-of-range ordinal reads as a miss, not a crash", () => {
    expect(recallMemory(db, { id: `E${segmentId}/T99` })).toContain("not found");
  });

  // ---- election/tier absence ----

  test("election/tier data appears nowhere in the card, at either depth", () => {
    const collapsed = recallMemory(db, { id: `E${segmentId}` });
    const expanded = recallMemory(db, { id: `E${segmentId}`, depth: "expanded" });
    for (const output of [collapsed, expanded]) {
      expect(output.toLowerCase()).not.toContain("election");
      expect(output.toLowerCase()).not.toContain("tier");
    }
  });
});

// ---------------------------------------------------------------------------
// Turn field-set switch — applies across every recall turn render.
// ---------------------------------------------------------------------------

describe("turn field-set switch (collapsed = prompt/title/content; expanded adds insight/response/observations)", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 1_960_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-fieldset",
      project: "/tmp/project",
      title: "Field-set session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    db.query<unknown, unknown[]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, title, content, insight, tags,
         created_at_epoch, user_prompt, assistant_response,
         files_read, files_modified
       ) VALUES (?, 1, 'extracted', 'the note title', 'the note content',
                 '- a lesson learned', '[]', ?, 'the raw user prompt',
                 'the raw assistant response', '[]', '[]')`,
    ).run(sessionId, CUTOFF + 1);
  });

  afterEach(() => {
    db.close();
  });

  test("collapsed carries exactly prompt/title/content — no insight, no response", () => {
    const output = recallMemory(db, { id: `S${sessionId}/T1` });
    expect(output).toContain("the note title");
    expect(output).toContain("the note content");
    expect(output).toContain("the raw user prompt");
    expect(output).not.toContain("the raw assistant response");
    expect(output).not.toContain("a lesson learned");
  });

  test("expanded adds insight and response on top of the collapsed field set", () => {
    const output = recallMemory(db, { id: `S${sessionId}/T1`, depth: "expanded" });
    expect(output).toContain("the note title");
    expect(output).toContain("the note content");
    expect(output).toContain("the raw user prompt");
    expect(output).toContain("the raw assistant response");
    expect(output).toContain("a lesson learned");
    // The prompt line appears exactly once, never duplicated between the
    // embedded collapsed block and expanded's own detail block.
    expect(output.split('prompt: "the raw user prompt"').length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-turn budget caps a rendered turn.
// ---------------------------------------------------------------------------

describe("per-turn token budget (`turn` param)", () => {
  let db: Database;
  let sessionId: number;
  const CUTOFF = 1_970_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "session-turnbudget",
      project: "/tmp/project",
      title: "Turn budget session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    }).id;

    const longContent = "a very long note body ".repeat(80);
    db.query<unknown, unknown[]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, title, content, tags,
         created_at_epoch, user_prompt, assistant_response,
         files_read, files_modified
       ) VALUES (?, 1, 'extracted', 'long turn', ?, '[]', ?, 'a prompt',
                 'a response', '[]', '[]')`,
    ).run(sessionId, longContent, CUTOFF + 1);
  });

  afterEach(() => {
    db.close();
  });

  test("an explicit `turn` budget caps the rendered turn and says so", () => {
    const uncapped = recallMemory(db, { id: `S${sessionId}/T1` });
    const capped = recallMemory(db, { id: `S${sessionId}/T1`, turn: 5 });

    expect(estimateTokens(uncapped)).toBeGreaterThan(5);
    expect(capped).toContain("long turn"); // the label always survives
    expect(capped).toContain("turn truncated to fit");
    expect(capped.length).toBeLessThan(uncapped.length);
  });

  test("collapsed defaults to a card-scale cap without an explicit `turn`", () => {
    // `truncate: 2000` lifts the CHARACTER-level cap out of the way (the
    // stored content is ~1840 chars, under the 2000 cap) so what remains to
    // explain any cut is the NEW per-turn TOKEN budget's own default.
    const output = recallMemory(db, { id: `S${sessionId}/T1`, truncate: 2000 });
    expect(output).toContain("turn truncated to fit");
    expect(estimateTokens(output)).toBeLessThan(DEFAULT_TURN_TOKEN_BUDGET_COLLAPSED + 20);
  });

  test("expanded defaults to uncapped — the same long content survives at truncate: 2000", () => {
    const longContent = "a very long note body ".repeat(80);
    const output = recallMemory(db, {
      id: `S${sessionId}/T1`,
      depth: "expanded",
      truncate: 2000,
    });
    // Well past DEFAULT_TURN_TOKEN_BUDGET_COLLAPSED (150) worth of content
    // survives — proof nothing capped it — because expanded's default is
    // uncapped, per spec "Budgets".
    expect(output).toContain(longContent.trim().slice(0, 1000));
    expect(estimateTokens(output)).toBeGreaterThan(DEFAULT_TURN_TOKEN_BUDGET_COLLAPSED * 2);
  });
});

// ---------------------------------------------------------------------------
// Bare recall() leads with segments.
// ---------------------------------------------------------------------------

describe("bare recall() leads with segments", () => {
  let db: Database;
  const CUTOFF = 1_980_000_000;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test("a segment appears before any session in the bare listing", () => {
    upsertSession(db, {
      contentSessionId: "session-bare",
      project: "/tmp/project",
      title: "A plain session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });
    const segment = createSegment(db, {
      title: "the bare-listing segment",
      nowEpoch: CUTOFF,
    });

    const output = recallMemory(db, {});
    const segmentIndex = output.indexOf(`[E${segment.id}]`);
    const sessionIndex = output.indexOf("A plain session");

    expect(segmentIndex).toBeGreaterThan(-1);
    expect(sessionIndex).toBeGreaterThan(-1);
    expect(segmentIndex).toBeLessThan(sessionIndex);
  });

  test("no segments in the database: bare recall() falls back to sessions only, unchanged", () => {
    upsertSession(db, {
      contentSessionId: "session-only",
      project: "/tmp/project",
      title: "Only a session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: null,
      completedAtEpoch: null,
    });

    const output = recallMemory(db, {});
    expect(output).toContain("Only a session");
    expect(output).not.toContain("── segments");
  });
});
