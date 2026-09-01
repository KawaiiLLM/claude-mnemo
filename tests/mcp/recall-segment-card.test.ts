import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { reindexTurnFromDb } from "../../src/db/search";
import {
  addSegmentMembers,
  appendSegmentWorkingStateRows,
  attachSegmentToSession,
  createSegment,
  getSegment,
  setSegmentTag,
} from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { getTurn } from "../../src/db/turns";
import { capRenderToTokenBudget, DEFAULT_TURN_TOKEN_BUDGET, NAVIGATION_LEGEND } from "../../src/mcp/format";
import { WORKER_TOOL_RESULT_MAX_CHARS } from "../../src/mcp/handlers";
import { recallMemory } from "../../src/mcp/recall";
import {
  elideSegmentCardFields,
  MAX_ATTACHED_SESSION_ROWS,
  type SegmentCardFieldRows,
} from "../../src/mcp/segment-card";
import { estimateTokens } from "../../src/utils/token-estimate";
import { LARGE_WORKING_STATE_ROW_COUNT, seedLargeWorkingStateField } from "../support/large-corpus";

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
    const fields: SegmentCardFieldRows[] = [{ field: "reference", rows: ["one row"] }];
    const result = elideSegmentCardFields(fields, 0);
    expect(result[0]!.droppedCount).toBe(1);
    expect(result[0]!.keptRows).toEqual([]);
  });

  test("under budget, nothing is dropped at all", () => {
    const fields: SegmentCardFieldRows[] = [
      { field: "goal", rows: ["a", "b"] },
      { field: "reference", rows: ["c"] },
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
        field: "constraints",
        rows: Array.from({ length: 20 }, (_, i) => `decision row ${i} ${"y".repeat(40)}`),
      },
    ];

    const result = elideSegmentCardFields(fields, 15);
    const content = result.find((entry) => entry.field === "content")!;
    const decisions = result.find((entry) => entry.field === "constraints")!;

    expect(content.droppedCount).toBe(0);
    expect(content.keptRows).toEqual(["short desc"]);
    expect(decisions.droppedCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-turn token budget cap — the pure mechanism (mutation target: the
// "keep the label, trim the tail" direction).
// ---------------------------------------------------------------------------

describe("capRenderToTokenBudget", () => {
  test("keeps the label line even when the budget is too small for anything else", () => {
    const rendered = ["  - [S1][T1] a title", "    - desc: filler text here"].join("\n");
    const capped = capRenderToTokenBudget(rendered, 1);
    expect(capped.split("\n")[0]).toBe("  - [S1][T1] a title");
    expect(capped.split("\n").some((line) => line.trim() === "…")).toBe(true);
  });

  test("leaves a render under budget untouched", () => {
    const rendered = "  - [S1][T1] short";
    expect(capRenderToTokenBudget(rendered, 1000)).toBe(rendered);
  });

  test("undefined budget means uncapped", () => {
    const rendered = "x".repeat(5000);
    expect(capRenderToTokenBudget(rendered, undefined)).toBe(rendered);
  });

  // Ticket 01 (render-boilerplate-trim spec, item 1): the ONE corner the
  // marker still earns its keep on. Budget = label (1 token) + the second
  // line WHOLE (2 tokens) + the marker itself exactly — the loop then hits a
  // THIRD line with zero tokens left, drops it whole, and never touches the
  // second line's own text (no inline cut, no "…" glued onto it). Without
  // the marker line, the second line surviving whole while the third
  // vanishes would leave nothing in the kept text to show a cut happened at
  // all.
  //
  // Whitespace-runs-price-as-one-token ticket 14 re-prices the marker itself:
  // `TURN_BUDGET_TRUNCATION_MARKER` is `"  …"`, whose leading TWO spaces are
  // now a single flat-priced run instead of `2 * 1/4`, which (combined with
  // the ellipsis's own 1/4) rounds the marker up from 1 token to 2. The old
  // 8-nines third line no longer isolates this corner: at the old total (5
  // tokens including both newlines) the new marker price makes "everything
  // fits whole" and "second line whole, third dropped" land on the SAME
  // budget (5), so `capRenderToTokenBudget`'s own whole-render early-exit
  // wins and nothing gets cut at all — re-measured empirically (no budget
  // reproduced the corner against the old fixture). Widening the third line
  // to 12 nines (3 tokens, costlier than the 2-token marker) reopens the gap:
  // budget 5 = 1 (label) + 2 (second line whole) + 2 (marker), and the total
  // render (6 tokens) no longer fits under it.
  //
  // RED-GREEN: this fails if the `remaining <= 0` branch's
  // `kept.push(TURN_BUDGET_TRUNCATION_MARKER)` is deleted — the result would
  // then be `"H\n22222222"`, with no line satisfying `line.trim() === "…"`.
  test("the dropped-whole-lines corner: a fully-kept last line still gets the bare marker line", () => {
    const rendered = ["H", "22222222", "999999999999"].join("\n");
    const capped = capRenderToTokenBudget(rendered, 5);
    const lines = capped.split("\n");

    expect(lines).toEqual(["H", "22222222", "  …"]);
    // The kept content line is whole — no ellipsis glued onto it by a
    // word-boundary cut. Only the marker's OWN line carries "…".
    expect(lines[1]).toBe("22222222");
    expect(lines[1]).not.toContain("…");
    // The dropped line leaves no trace at all — not even a partial digit.
    expect(capped).not.toContain("9");
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

  // [S15069/T1022] — the E60 regression: a whole-project segment folds
  // hundreds of tags into one facet line that, unbudgeted, ate the entire
  // page and starved the field ladder to zero visible rows. The facet line
  // takes the same item knife as every other rendered unit; counts sort
  // descending, so the cut keeps the high-signal words. Page 2 stays whole.
  // Ticket 14 (lane-model-v12 spec D3f): the tag/type HISTOGRAM rows are gone
  // — they rendered the members' historical distribution, which under this
  // model reads as a vocabulary and is not one. The flood they were knifed for
  // therefore cannot reach the card at all: no amount of member tags produces
  // a header row now, and the freed budget goes to the field ladder.
  test("no member-tag flood can reach the card any more — the histogram rows are gone", () => {
    const turnIds: number[] = [];
    for (let promptNumber = 3; promptNumber < 120; promptNumber += 1) {
      turnIds.push(
        makeTurn(promptNumber, {
          tags: [`flood-${promptNumber}-${"x".repeat(12)}`, `also-${promptNumber}`],
        }),
      );
    }
    addSegmentMembers(db, segmentId, turnIds, CUTOFF);
    appendSegmentWorkingStateRows(db, segmentId, "goal", ["the goal survives the flood"], CUTOFF);

    const pageOne = recallMemory(db, { id: `E${segmentId}` });
    expect(pageOne).not.toContain("- tags:");
    expect(pageOne).not.toContain("- type:");
    expect(pageOne).not.toContain("flood-3-");
    expect(pageOne).toContain("the goal survives the flood");

    // Page 2 renders every row whole and still has no histogram to render.
    const pageTwo = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    expect(pageTwo).not.toContain("- tags:");
    expect(pageTwo).not.toContain("- type:");
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

  // Ticket 14 (spec D3f): the segment's OWN tag moves into the card header —
  // it is one of the two legal sources a `tags` write may draw from, and the
  // one that decides membership, yet it appeared nowhere on the card before.
  test("the header carries the segment's own tag, and no histogram row survives", () => {
    setSegmentTag(db, segmentId, "card-container", CUTOFF);
    const output = recallMemory(db, { id: `E${segmentId}` });
    const header = output.split("\n")[0]!;
    expect(header).toContain(`[E${segmentId}]`);
    expect(header).toContain("#card-container");
    expect(output).not.toContain("- tags:");
    expect(output).not.toContain("- type:");
  });

  test("an unnamed segment says so in the header rather than saying nothing", () => {
    const unnamed = createSegment(db, { title: "no name yet", nowEpoch: CUTOFF });
    const output = recallMemory(db, { id: `E${unnamed.id}` });
    expect(output.split("\n")[0]!).toContain("#(unnamed)");
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

    // Spec 金样例: the card's `- sessions:` row is a BARE id list — the
    // per-session turn count / last-active / consulted-only annotations were
    // the card's second rendering of facts each session states for itself.
    const output = recallMemory(db, { id: `E${segmentId}` });
    const sessionsLine = output
      .split("\n")
      .find((line) => line.trimStart().startsWith("- sessions:"))!;
    expect(sessionsLine).toContain(`S${sessionId}`);
    expect(sessionsLine).toContain(`S${other}`);
    expect(output).not.toContain("consulted only");
    expect(output).not.toContain("last active");
  });

  test("collapsed shows per-field row counts and elides an over-budget field with the ellipsis at the top, newest rows kept", () => {
    // Grow `decisions` well past a tiny page budget: five distinct rows.
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "constraints",
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
    const decisionsBlock = output.split("- constraints:")[1]?.split(/- (goal|reference):/)[0] ?? "";

    // Spec 金样例: a field that HOLDS rows names itself and lets the rows
    // speak; only a 0-row field states a count.
    expect(decisionsBlock).not.toContain("5 rows");
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
    const overflowIds: number[] = [];
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
      overflowIds.push(other);
      attachSegmentToSession(db, other, segmentId, CUTOFF + index);
    }

    const output = recallMemory(db, { id: `E${segmentId}` });
    const sessionsLine = output
      .split("\n")
      .find((line) => line.trimStart().startsWith("- sessions:"))!;
    const ids = sessionsLine
      .slice(sessionsLine.indexOf(":") + 1)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("S"));
    expect(ids.length).toBe(MAX_ATTACHED_SESSION_ROWS);
    expect(sessionsLine).toMatch(/\+\d+ more/);
    // The cap keeps the FRESHEST ids, not merely five: with 8 overflow
    // sessions at ascending lastActive, the survivors are the top five and
    // the colder tail folds into the count. An implementation that capped in
    // attachment order (or sorted the wrong way) passes the count above and
    // fails here.
    expect(ids).toContain(`S${overflowIds[overflowIds.length - 1]}`);
    expect(ids).not.toContain(`S${overflowIds[0]}`);
    expect(output).not.toContain("Overflow session 2");
  });

  test("ticket 12 nudge half retired (ticket 13): the header states the bare maintenance distance, no suffix, even 20+ turns since the last edit", () => {
    // The fixture already carries 2 member turns after the segment's last
    // edit; 20 more takes the attached session's distance to 22. The card
    // header used to draw a "consider a maintenance pass" suffix here — that
    // function moved to the universal 20-turn `remember` check on the
    // UserPromptSubmit channel (hooks/note-reminder.ts), which reaches every
    // session, not just one with this card already in view.
    for (let prompt = 3; prompt <= 22; prompt += 1) {
      makeTurn(prompt);
    }
    const output = recallMemory(db, { id: `E${segmentId}` });
    expect(output).toContain("maintenance 22 turns ago");
    expect(output).not.toContain("consider a maintenance pass");
  });

  test("maintenance distance is the busiest attached session's distance, not the sum (ticket 14 #10)", () => {
    const other = upsertSession(db, {
      contentSessionId: "maintenance-max-session",
      project: "/tmp/project",
      title: "Second attached session",
      content: null,
      insight: null,
      nextSteps: null,
      createdAtEpoch: CUTOFF,
      updatedAtEpoch: CUTOFF,
      completedAtEpoch: null,
    }).id;
    attachSegmentToSession(db, other, segmentId, CUTOFF);
    const main = sessionId;
    sessionId = other;
    for (let prompt = 1; prompt <= 25; prompt += 1) {
      makeTurn(prompt);
    }
    sessionId = main;

    const output = recallMemory(db, { id: `E${segmentId}` });
    // main: 2 turns since the last edit; other: 25. The sum (27) made the
    // figure incomparable to the 10/20 thresholds the receipt counts in
    // single-session units; the max is that same unit.
    expect(output).toMatch(/maintenance 25 turns ago/);
    expect(output).not.toMatch(/maintenance 27 turns/);
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

  test("page 2 never elides — every row renders in full when they fit one page", () => {
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "constraints",
        [`decision number ${index}`],
        CUTOFF + index,
      );
    }

    const output = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    for (let index = 0; index < 5; index += 1) {
      expect(output).toContain(`decision number ${index}`);
    }
    // No elision ellipsis — this is the "… +N earlier" marker page 1's own
    // elision ladder prints, never the page-overflow continuation footer.
    expect(output).not.toContain("… +");
  });

  // bounded-read-surfaces ticket 01. `lane_check`'s own trap (`6e668da`):
  // the upper-bound assertion and the pagination assertion must be
  // INDEPENDENT — a fixture small enough that page 2 already fits one page
  // makes both green even with pagination entirely dead. `rows` here (400,
  // `seedLargeWorkingStateField`) is sized so the default `pageBudget` (1000
  // tokens) genuinely forces page 2 into several pages.
  describe("page >= 2 overflow pagination (bounded-read-surfaces ticket 01)", () => {
    let rows: string[];

    beforeEach(() => {
      rows = seedLargeWorkingStateField(db, segmentId, "constraints", CUTOFF);
    });

    test("PAGINATION is alive: page 2 shows only SOME rows, names the next call, and page 3 covers the rest — no row is truncated", () => {
      const page2 = recallMemory(db, { id: `E${segmentId}`, page: 2 });
      const shownOnPage2 = rows.filter((row) => page2.includes(row));
      // Real pagination, not a coincidence of small content: something was
      // excluded from page 2.
      expect(shownOnPage2.length).toBeGreaterThan(0);
      expect(shownOnPage2.length).toBeLessThan(rows.length);
      // The continuation hint names the EXACT next call (lane_check's own
      // shape, copied rather than reinvented).
      expect(page2).toContain(`recall(id="E${segmentId}", page=3)`);

      const page3 = recallMemory(db, { id: `E${segmentId}`, page: 3 });
      const shownOnPage3 = rows.filter((row) => page3.includes(row));
      expect(shownOnPage3.length).toBeGreaterThan(0);

      // Every row this fixture wrote is reachable, whole, walking the pages
      // in order — recall never truncates a block, it only pages one out.
      const coveredSoFar = new Set([...shownOnPage2, ...shownOnPage3]);
      let page = 4;
      while (coveredSoFar.size < rows.length && page < LARGE_WORKING_STATE_ROW_COUNT) {
        const next = recallMemory(db, { id: `E${segmentId}`, page });
        for (const row of rows) {
          if (next.includes(row)) {
            coveredSoFar.add(row);
          }
        }
        page += 1;
      }
      for (const row of rows) {
        expect(coveredSoFar.has(row)).toBe(true);
      }
    });

    test("the UPPER BOUND holds independently: the default call's byte count stays under the worker tool-result cap", () => {
      const page2 = recallMemory(db, { id: `E${segmentId}`, page: 2 });
      expect(page2.length).toBeLessThan(WORKER_TOOL_RESULT_MAX_CHARS);
    });
  });

  test("page 2 carries a member index in event order with each member's S/T home address", () => {
    const output = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    expect(output).toContain("member index");
    expect(output).toContain(`1. S${sessionId}/T1 "research the card"`);
    expect(output).toContain(`2. S${sessionId}/T2 "implement the card"`);
  });

  test("a note-less member's index line is the bare address — its raw prompt never leaks (ticket 03)", () => {
    // The retired fallback (`turn?.title ?? turn?.userPrompt ?? "untitled"`)
    // was a third copy of the label fallback ticket 02 removed from
    // format.ts/recall.ts; this pins the sweep.
    const noteless = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, title, tags, created_at_epoch,
           user_prompt, assistant_response, files_read, files_modified
         ) VALUES (?, 3, 'extracted', NULL, '[]', ?,
                   'SECRET-RAW-PROMPT-WORDS', 'a response', '[]', '[]')
         RETURNING id`,
      )
      .get(sessionId, CUTOFF + 3)!.id;
    addSegmentMembers(db, segmentId, [noteless], CUTOFF);

    const output = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    expect(output).toContain(`3. S${sessionId}/T3`);
    expect(output).not.toContain("SECRET-RAW-PROMPT-WORDS");
    expect(output).not.toContain("untitled");
  });

  // ---- pagination stability (mutation target 2/3) ----

  test("page overflow paginates STABLY: page 2 deterministically re-fetches the un-elided card", () => {
    for (let index = 0; index < 5; index += 1) {
      appendSegmentWorkingStateRows(
        db,
        segmentId,
        "constraints",
        [`decision number ${index}`],
        CUTOFF + index,
      );
    }

    const page1First = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20 });
    const page1Second = recallMemory(db, { id: `E${segmentId}`, pageBudget: 20 });
    // A budget generous enough that these 5 short rows fit page 2 in ONE
    // call — this test is about REPEAT-CALL determinism, not overflow itself
    // (see "page >= 2 overflow pagination" above for a fixture that
    // genuinely spans several pages under the DEFAULT budget).
    const page2Budget = 1000;
    const page2First = recallMemory(db, { id: `E${segmentId}`, pageBudget: page2Budget, page: 2 });
    const page2Second = recallMemory(db, { id: `E${segmentId}`, pageBudget: page2Budget, page: 2 });

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

  // ---- S/T address -> event order resolution (mutation target 3/3) ----

  test("E<n>/S<a>/T<b> addresses one segment member by its ordinary S/T address", () => {
    const first = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T1` });
    expect(first).toContain("research the card");

    const second = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T2` });
    expect(second).toContain("implement the card");
  });

  test("an E<n>/S<a>/T<b>..S<c>/T<d> range follows EVENT order (creation time), not DB insertion order or prompt-number order", () => {
    // t3 is created chronologically BEFORE t1/t2 but inserted into the DB
    // (and thus assigned a turn id, and a HIGHER prompt number) after them —
    // event order must follow the timestamp, never the id, insertion
    // sequence, or prompt-number magnitude. Its event-order position is now
    // BEFORE t1/t2 despite T3 > T1/T2 as raw prompt numbers, so a range
    // named "T3..T2" (descending in prompt-number terms) must still resolve
    // to the ordinal-ascending span that covers all three.
    const t3 = makeTurn(3, { title: "earliest by clock, latest by id", epoch: CUTOFF - 500 });
    addSegmentMembers(db, segmentId, [t3], CUTOFF);

    const output = recallMemory(db, {
      id: `E${segmentId}/S${sessionId}/T3..S${sessionId}/T2`,
    });
    expect(output).toContain("earliest by clock, latest by id");
    expect(output).toContain("research the card");
    expect(output).toContain("implement the card");
  });

  test("the retired E<n>/T<m> ordinal form refuses, naming the new grammar — not a silent reinterpretation, not a miss", () => {
    const output = recallMemory(db, { id: `E${segmentId}/T99` });
    expect(output).toContain("retired");
    expect(output).not.toContain("not found");
  });

  test("an E<n>/S<a>/T<b> address naming a turn outside the segment refuses, naming it — not a crash", () => {
    const output = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T99` });
    expect(output).toContain(`S${sessionId}/T99`);
    expect(output).toContain("not a member");
  });

  // ---- election/tier absence ----

  test("election/tier data appears nowhere in the card, at either page", () => {
    const collapsed = recallMemory(db, { id: `E${segmentId}` });
    const expanded = recallMemory(db, { id: `E${segmentId}`, page: 2 });
    for (const output of [collapsed, expanded]) {
      expect(output.toLowerCase()).not.toContain("election");
      expect(output.toLowerCase()).not.toContain("tier");
    }
  });

  // Edge-read-surface spec, ticket 01: the `E<n>/T<m>` member-listing route
  // builds its own `FormattedTurn` (`segment-card.ts`'s
  // `renderSegmentMembersByOrdinal`) rather than going through
  // `recall.ts`'s `buildTurnView` — this pins that it wires `relations` the
  // same way, off by default.
  test("a segment member's relations render only when filter.fields requests them", () => {
    const t3 = makeTurn(3, { title: "third turn" });
    addSegmentMembers(db, segmentId, [t3], CUTOFF);
    const t1Id = getTurn(db, sessionId, 1)!.id;
    const t3Id = getTurn(db, sessionId, 3)!.id;
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t3Id },
          cited: { kind: "turn", id: t1Id },
          relation: "extends",
          provenance: "asserted",
          ...deriveSideTags(["seg-tag"]),
        },
      ],
      CUTOFF,
    );

    const unrequested = recallMemory(db, { id: `E${segmentId}/S${sessionId}/T3` });
    expect(unrequested).not.toContain("-extends->");

    const requested = recallMemory(db, {
      id: `E${segmentId}/S${sessionId}/T3`,
      filter: { fields: ["title", "relations"] },
    });
    // Fork-tree spec (ticket 12): the root's own address opens the field,
    // its one out-edge continues the same line.
    expect(requested).toContain(`S${sessionId}/T3 -extends-> T1 {seg-tag}`);
  });

  // ---- lane-model-v12 ticket 18 (ruling [S15069/T1670]): the card carries no
  // VOCABULARY. Its `- lanes:` row left the card (interim home: the roster;
  // since frontier-injection ticket 03 the vocabulary renders as the frontier
  // digest lines), joining the two histogram rows ticket 14 retired; what is
  // left describes this segment's STATE (goal / constraints / decisions /
  // next_steps). ----

  test("declared lanes put no vocabulary row on the card — not on page 1, not on the un-elided page 2", () => {
    insertLane(db, segmentId, "write-gate", CUTOFF);
    insertLane(db, segmentId, "lane-model", CUTOFF);

    for (const page of [1, 2]) {
      const output = recallMemory(db, { id: `E${segmentId}`, page });
      expect(output.split("\n").some((line) => line.trimStart().startsWith("- lanes:"))).toBe(false);
      expect(output).not.toContain("write-gate");
      expect(output).not.toContain("lane-model");
    }
  });

  // The freed budget's destination, pinned as an observable property rather
  // than a comment: declaring lanes changes NOTHING on the card, so nothing on
  // the card competes with the field ladder for what the retired rows used to
  // spend. Any re-introduction of a lane row — at any budget, in any shape —
  // fails this.
  test("a 63-lane segment's card is byte-identical to the same segment with no lanes declared", () => {
    appendSegmentWorkingStateRows(db, segmentId, "goal", ["ship the vocabulary move"], CUTOFF);
    const beforeAnyLane = recallMemory(db, { id: `E${segmentId}` });

    for (let index = 0; index < 63; index += 1) {
      insertLane(db, segmentId, `lane-tag-${index.toString().padStart(3, "0")}`, CUTOFF);
    }

    expect(recallMemory(db, { id: `E${segmentId}` })).toBe(beforeAnyLane);
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

  test("the default field set is exactly title + content — no prompt, no insight, no response", () => {
    // Spec 金样例 补充: "其他字段槽位（默认只有content）". The prompt bullet
    // left the default with the row redesign — the row label already falls
    // back to the prompt when no title exists, so the bullet only ever
    // restated what the reader had.
    const output = recallMemory(db, { id: `S${sessionId}/T1` });
    expect(output).toContain("the note title");
    expect(output).toContain("the note content");
    expect(output).not.toContain("the raw user prompt");
    expect(output).not.toContain("the raw assistant response");
    expect(output).not.toContain("a lesson learned");
  });

  test("filter.fields adds insight and response on top of the default field set", () => {
    const output = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content", "prompt", "response", "insight"] },
    });
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
    expect(capped.split("\n").some((line) => line.trim() === "…")).toBe(true);
    expect(capped.length).toBeLessThan(uncapped.length);
  });

  test("defaults to a card-scale cap without an explicit `turn` — no char knob left to lift it", () => {
    const output = recallMemory(db, { id: `S${sessionId}/T1` });
    expect(output.split("\n").some((line) => line.trim() === "…")).toBe(true);
    // Measure the capped BLOCK alone — `recallMemory` appends the one
    // response-wide navigation legend on top, which is not part of the
    // per-item budget this test is pinning.
    const withoutLegend = output.replace(`\n\n${NAVIGATION_LEGEND}`, "");
    expect(estimateTokens(withoutLegend)).toBeLessThan(DEFAULT_TURN_TOKEN_BUDGET + 20);
  });

  // Ticket 11: `expanded`'s "default uncapped" retired along with `depth` —
  // there is no more uncapped state (spec: every node kind always has a
  // finite per-item budget). Widening `filter.fields` alone does NOT widen
  // the budget; a caller after more content raises `turn` too.
  test("widening filter.fields alone does not lift the cap — turn must be raised explicitly", () => {
    const widerFields = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content", "prompt", "response", "insight"] },
    });
    const widerFieldsWithoutLegend = widerFields.replace(`\n\n${NAVIGATION_LEGEND}`, "");
    expect(estimateTokens(widerFieldsWithoutLegend)).toBeLessThan(DEFAULT_TURN_TOKEN_BUDGET + 20);

    const longContent = "a very long note body ".repeat(80);
    const raisedBudget = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content", "prompt", "response", "insight"] },
      turn: 2000,
    });
    // Well past DEFAULT_TURN_TOKEN_BUDGET (150) worth of content survives —
    // proof it was the raised `turn` budget, not `filter.fields`, that let
    // it through.
    expect(raisedBudget).toContain(longContent.trim().slice(0, 1000));
    expect(estimateTokens(raisedBudget)).toBeGreaterThan(DEFAULT_TURN_TOKEN_BUDGET * 2);
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
