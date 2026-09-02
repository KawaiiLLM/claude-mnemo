import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import { initializeSchema } from "../../src/db/schema";
import { addSegmentMembers, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { checkFieldGate, checkRelationsGate, stampField } from "../../src/db/write-gate";
import {
  memoryFilterSchema,
  noteInputSchema,
  recallInputSchema,
  timelineInputSchema,
} from "../../src/mcp/definitions";
import {
  createTruncationSignal,
  renderNode,
  RENDER_INDENT_STEP,
  TURN_TITLE_RENDER_CAP_CHARS,
  type FormattedTurn,
  type TurnRenderFields,
} from "../../src/mcp/format";
import type { RecallTurnField } from "../../src/mcp/memory-filter";
import { recallMemory, recallMemoryDelivery } from "../../src/mcp/recall";
import { settlementTurnWriteInputSchema } from "../../src/worker/note-settlement-turn-facade";
import { estimateTokens } from "../../src/utils/token-estimate";

/**
 * SETTLEMENT-READ-ONCE TICKET 01 — ONE READ CONTRACT (spec D1 + D2).
 *
 * The route the settlement prompt teaches as primary is the task-scoped range,
 * and at HEAD it behaved unlike the plain session range in three ways at once:
 * it paginated by `pageSize` alone, it forwarded no `fieldBudgets`, and it
 * granted all-or-nothing at page end. On top of that, no route said WHICH
 * field a render had lost — the whole-turn ladder cut one line and dropped
 * every later one in silence — so the only safe repair for a suspicious render
 * was to read the batch again.
 *
 * Everything below is asserted through the real routes rather than by calling
 * the renderer's internals: the contract is a property of what a `recall` call
 * delivers and of what the ledger records for it, and a fixture that
 * stipulated either would pass over an implementation that never produced it.
 */
describe("the taught route honours the read contract (spec D1)", () => {
  const NOW = 1_800_000_000;
  const READER = "session:read-contract";

  let db: Database;
  let sessionId: number;
  let segmentId: number;
  const memberTurnIds: number[] = [];

  /** A prompt long enough that a 50-token budget must cut it. */
  const LONG_PROMPT = "prompt ".repeat(200).trim();

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    memberTurnIds.length = 0;
    sessionId = upsertSession(db, {
      contentSessionId: "read-contract",
      project: "/tmp/read-contract",
      title: "read contract session",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 1_000,
      updatedAtEpoch: NOW - 1_000,
      completedAtEpoch: null,
    }).id;
    segmentId = createSegment(db, {
      title: "the read contract task",
      type: ["implement"],
      tags: ["read-contract"],
      nowEpoch: NOW,
    }).id;
  });

  afterEach(() => db.close());

  function seedTurn(
    promptNumber: number,
    options: { title?: string; content?: string; prompt?: string; insight?: string } = {},
  ): number {
    return db
      .query<{ id: number }, [number, number, string, string, string, string | null]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, insight, tool_call_count, created_at_epoch, type, tags
         ) VALUES (?, ?, 'extracted', ?, 'an answer', ?, ?, ?, 0, ${NOW}, '[]', '[]')
         RETURNING id`,
      )
      .get(
        sessionId,
        promptNumber,
        options.prompt ?? "a prompt",
        options.title ?? `title ${promptNumber}`,
        options.content ?? "a short body",
        options.insight ?? null,
      )!.id;
  }

  function seedMembers(count: number, options: Parameters<typeof seedTurn>[1] = {}): void {
    for (let promptNumber = 1; promptNumber <= count; promptNumber += 1) {
      memberTurnIds.push(seedTurn(promptNumber, options));
    }
    addSegmentMembers(db, segmentId, memberTurnIds, NOW);
  }

  function rangeId(first: number, last: number): string {
    return `E${segmentId}/S${sessionId}/T${first}..S${sessionId}/T${last}`;
  }

  function grantedTurnIds(reader = READER): number[] {
    return db
      .query<{ entity_id: number }, [string]>(
        `SELECT entity_id FROM write_gate_reads
          WHERE writer = ? AND entity_type = 'turn' ORDER BY entity_id`,
      )
      .all(reader)
      .map((row) => row.entity_id);
  }

  /**
   * DEFECT 1a: `prompt:50` was parsed, accepted, and then never reached this
   * route's renderer. The settlement prompt has dictated that exact budget
   * since ticket 11 and has been silently ignored on the address it also
   * dictates.
   */
  test("prompt:50 is honoured on the task-scoped range", () => {
    seedMembers(2, { prompt: LONG_PROMPT });

    const budgeted = recallMemory(db, {
      id: rangeId(1, 2),
      filter: { fields: ["title", "prompt"], fieldBudgets: { prompt: 50 } },
      boundedFields: ["prompt"],
      turn: 5_000,
    });
    const unbudgeted = recallMemory(db, {
      id: rangeId(1, 2),
      filter: { fields: ["title", "prompt"] },
      turn: 5_000,
    });

    const promptLine = (text: string): string =>
      text.split("\n").find((line) => line.includes("- prompt:"))!;
    // The cut is real, and it is the budget's — not the whole-turn ladder's,
    // which `turn: 5000` leaves nothing for it to do.
    expect(estimateTokens(promptLine(budgeted))).toBeLessThan(70);
    expect(promptLine(budgeted)).toContain("…");
    expect(estimateTokens(promptLine(unbudgeted))).toBeGreaterThan(300);
    expect(promptLine(unbudgeted)).not.toContain("…");
  });

  /**
   * DEFECT 1b: the page boundary. `pageSize` alone let this route assemble a
   * page the 100K-character envelope would cut, which then lost every grant on
   * it — the route was capable of delivering nothing it could license.
   */
  test("the range packs its page by rendered cost, not by pageSize alone", () => {
    seedMembers(6, { content: "sentence ".repeat(400) });

    const byCount = recallMemory(db, {
      id: rangeId(1, 6),
      pageSize: 6,
      pageBudget: 1_000_000,
      turn: 5_000,
    });
    const byCost = recallMemory(db, {
      id: rangeId(1, 6),
      pageSize: 6,
      pageBudget: 2_000,
      turn: 5_000,
    });

    // One page, no header at all (a single page prints none): six members.
    expect(byCount).not.toContain("page 1 /");
    expect(byCount).toContain("T6 title 6");
    // Same pageSize, same members: the BUDGET is what closed the page early.
    expect(byCost).toMatch(/page 1 \/ [2-9]\d* \(total 6\)/);
    expect(byCost).not.toContain("T6 title 6");
  });

  /**
   * DEFECT 1c, and the one this ticket exists for. HEAD marked the whole page
   * at its last character, so one missing byte cost every member on it; a
   * settlement run that read fifteen turns and lost the sixteenth's tail could
   * write to none of them.
   */
  test("a member on a delivered page is granted; one whose block the envelope cut is not", () => {
    seedMembers(3);

    const delivery = recallMemoryDelivery(db, {
      id: rangeId(1, 3),
      pageSize: 3,
      readerId: READER,
      now: () => NOW,
    });
    // Cut one character short of the last member's block: the two members
    // before it were delivered whole and keep their grants.
    delivery.commitDelivered(delivery.text.length - 1);
    expect(grantedTurnIds()).toEqual([memberTurnIds[0]!, memberTurnIds[1]!]);

    const whole = recallMemoryDelivery(db, {
      id: rangeId(1, 3),
      pageSize: 3,
      readerId: READER,
      now: () => NOW,
    });
    whole.commitDelivered(whole.text.length);
    expect(grantedTurnIds()).toEqual(memberTurnIds);
  });
});

/**
 * `boundedFields` (spec D1): the INTENT half of the contract. Numeric budgets
 * stay numeric; one list carries the bit that says which cap is a contract
 * rather than a loss.
 */
describe("boundedFields is a recall input, subset-checked, and grants nothing (spec D1)", () => {
  const NOW = 1_800_000_000;

  let db: Database;
  let sessionId: number;
  let turnId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    initializeSchema(db);
    sessionId = upsertSession(db, {
      contentSessionId: "bounded-fields",
      project: "/tmp/bounded-fields",
      title: "bounded fields session",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 1_000,
      updatedAtEpoch: NOW - 1_000,
      completedAtEpoch: null,
    }).id;
    turnId = db
      .query<{ id: number }, [number]>(
        `INSERT INTO turns (
           session_id, prompt_number, status, user_prompt, assistant_response,
           title, content, tool_call_count, created_at_epoch, type, tags
         ) VALUES (?, 1, 'extracted', 'a prompt', 'an answer', 'a title', 'a body',
                   0, ${NOW}, '["implement"]', '["read-contract","topic:budgets"]')
         RETURNING id`,
      )
      .get(sessionId)!.id;
  });

  afterEach(() => db.close());

  test("it is NOT a member of the shared filter — timeline refuses it by name", () => {
    // The wire filter is shared verbatim by both tools, so the key must not be
    // on it at all; `.strict()` is what enforces that.
    expect(memoryFilterSchema.safeParse({ boundedFields: ["prompt"] }).success).toBe(false);
    expect(recallInputSchema.safeParse({ id: "S1/T1", boundedFields: ["prompt"] }).success).toBe(
      true,
    );

    const refused = timelineInputSchema.safeParse({ id: "S1", boundedFields: ["prompt"] });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error)).toContain("`boundedFields` is a `recall` input");
  });

  test("relations is refused BY NAME, with the reason rather than a grammar echo", () => {
    const refused = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "relations"], fieldBudgets: { relations: 100 } },
      boundedFields: ["relations"],
    });
    expect(refused).toContain('boundedFields must not name "relations"');
    expect(refused).toContain("still grants the edge write");
    // Absent from the legal enumeration too, so the MCP seam refuses it before
    // the runtime layer ever sees it.
    expect(
      recallInputSchema.safeParse({ id: "S1/T1", boundedFields: ["relations"] }).success,
    ).toBe(false);
  });

  test("the subset rule: a field not selected, and a field with no cap, are each refused naming it", () => {
    const notSelected = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content"], fieldBudgets: { prompt: 50 } },
      boundedFields: ["prompt"],
    });
    expect(notSelected).toContain('boundedFields entry "prompt" is not in filter.fields');

    const noCap = recallMemory(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "prompt"] },
      boundedFields: ["prompt"],
    });
    expect(noCap).toContain('has no filter.fieldBudgets["prompt"] cap');
  });

  /**
   * INTENT IS NOT A GRANT. "Do not nag me about this field's length" and "treat
   * this field as read whole" are different claims, and only the first is on
   * offer — a bounded read of `metadata` shortens the line carrying `type` and
   * `tags`, so it licenses no write to either.
   */
  test("a bounded metadata read that was shortened grants no tag write", () => {
    const reader = "session:bounded-metadata";
    stampField(db, "turn", turnId, "tags", "session:someone-else", NOW - 10);

    const delivery = recallMemoryDelivery(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "metadata"], fieldBudgets: { metadata: 3 } },
      boundedFields: ["metadata"],
      turn: 5_000,
      readerId: reader,
      now: () => NOW,
    });
    delivery.commitDelivered(delivery.text.length);
    // Bounded, so the reader is not nagged: no footer names it.
    expect(delivery.text).not.toContain("truncated:");

    const verdict = checkFieldGate(db, reader, "turn", turnId, "tags", "S1/T1", {
      requireCompleteRead: true,
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("incomplete-read");
  });
});

/**
 * THE FOUR STATES AND THE RESERVED FOOTER (spec D2). The renderer produces its
 * own per-field structure over the selected fields; only `cut` and `dropped`
 * reach the reader, and the line that reports them is paid for BEFORE the body
 * ladder runs — so a report can never cause the cut it reports.
 */
describe("per turn, per field: complete | bounded | cut | dropped (spec D2)", () => {
  const NOW = 1_800_000_000;
  const ALL_FIELDS: TurnRenderFields = new Set<RecallTurnField>([
    "title",
    "metadata",
    "content",
    "prompt",
    "insight",
    "relations",
  ]);

  /**
   * The reserve is the WORST case over the selected fields — every reportable
   * one named, plus `title cut`. This is the string, spelled out, so a change
   * to the vocabulary or to the arrangement has to be deliberate.
   */
  const WORST_CASE_FOOTER =
    "    truncated: title cut; metadata, content, prompt, insight, relations dropped";

  test("turn = label + worst-case footer, body allowance 0: the footer renders WHOLE and both costs are counted", () => {
    const turn: FormattedTurn = {
      id: 1,
      promptNumber: 7,
      title: "a title",
      metadata: "2026-09-02 · implement",
      content: "a body that has no room at all",
      promptPreview: "a prompt",
      insight: ["an insight"],
      relations: ["extends -> T4 (#a → #a)"],
      status: "extracted",
    };
    const label = "T7 a title [extracted]";
    const budget = estimateTokens(label) + estimateTokens(WORST_CASE_FOOTER);

    const rendered = renderNode(
      { type: "turn", value: turn },
      { fields: ALL_FIELDS, sessionId: 1, turnBudget: budget },
    );

    const lines = rendered.split("\n");
    expect(lines[0]).toBe(label);
    // Whole: not one character of the report was itself truncated.
    const footer = lines[lines.length - 1]!;
    expect(footer.trim().startsWith("truncated:")).toBe(true);
    expect(footer).not.toContain("…");
    expect(footer.trim()).toBe(
      "truncated: metadata, content, prompt, insight, relations dropped",
    );
    // BOTH costs are in the returned string, which is what page cost, the
    // envelope and every ledger end-offset are all measured from.
    expect(estimateTokens(rendered)).toBeGreaterThanOrEqual(estimateTokens(label));
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(budget);
  });

  test("a prompt over its cap is `bounded` with NO footer, and `cut` — named — without the declaration", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionId = upsertSession(db, {
      contentSessionId: "four-states",
      project: "/tmp/four-states",
      title: "four states session",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 1_000,
      updatedAtEpoch: NOW - 1_000,
      completedAtEpoch: null,
    }).id;
    db.query<unknown, [number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         title, content, tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, 1, 'extracted', '${"word ".repeat(400).trim()}', 'an answer',
                 'a title', 'a body', 0, ${NOW}, '[]', '[]')`,
    ).run(sessionId);

    const call = {
      id: `S${sessionId}/T1`,
      filter: {
        fields: ["title", "prompt"] as RecallTurnField[],
        fieldBudgets: { prompt: 50 },
      },
      turn: 5_000,
    };
    const bounded = recallMemory(db, { ...call, boundedFields: ["prompt"] });
    const required = recallMemory(db, call);

    // Same bytes of prompt in both — intent changes the REPORT, never the cut.
    expect(bounded.replace(/\n\s+truncated:.*/, "")).toBe(required.replace(/\n\s+truncated:.*/, ""));
    expect(bounded).not.toContain("truncated:");
    expect(required).toContain("truncated: prompt cut");
    db.close();
  });

  /**
   * The re-read rule the teaching states, executed: a footer that names
   * `relations dropped` is followed by ONE single-field re-read of that turn,
   * and that re-read is what earns the edge write.
   */
  test("a long content drops relations, the footer names it, and the single-field re-read grants", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const reader = "session:dropped-relations";
    const sessionId = upsertSession(db, {
      contentSessionId: "dropped-relations",
      project: "/tmp/dropped-relations",
      title: "dropped relations session",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 1_000,
      updatedAtEpoch: NOW - 1_000,
      completedAtEpoch: null,
    }).id;
    const seed = (promptNumber: number, content: string): number =>
      db
        .query<{ id: number }, [number, number, string]>(
          `INSERT INTO turns (
             session_id, prompt_number, status, user_prompt, assistant_response,
             title, content, tool_call_count, created_at_epoch, type, tags
           ) VALUES (?, ?, 'extracted', 'a prompt', 'an answer', 'a title', ?, 0,
                     ${NOW}, '[]', '[]')
           RETURNING id`,
        )
        .get(sessionId, promptNumber, content)!.id;

    const citing = seed(1, "sentence ".repeat(500));
    const cited = seed(2, "x");
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: citing },
          cited: { kind: "turn", id: cited },
          relation: "extends" as never,
          provenance: "asserted",
          tailTag: "",
          headTag: "",
        },
      ],
      NOW,
    );

    const first = recallMemoryDelivery(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["title", "content", "relations"] },
      turn: 200,
      readerId: reader,
      now: () => NOW,
    });
    first.commitDelivered(first.text.length);
    expect(first.text).toContain("relations dropped");
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(false);

    // THAT turn, THAT field, alone — the whole repair the footer licenses.
    const reread = recallMemoryDelivery(db, {
      id: `S${sessionId}/T1`,
      filter: { fields: ["relations"] },
      turn: 5_000,
      readerId: reader,
      now: () => NOW + 1,
    });
    reread.commitDelivered(reread.text.length);
    expect(reread.text).not.toContain("truncated:");
    expect(checkRelationsGate(db, reader, citing, "S1/T1").ok).toBe(true);
    db.close();
  });

  test("a field the response did NOT name was delivered whole — the footer is silent when nothing was lost", () => {
    const signal = createTruncationSignal();
    const rendered = renderNode(
      {
        type: "turn",
        value: {
          id: 2,
          promptNumber: 2,
          title: "a title",
          content: "a body",
          status: "extracted",
        },
      },
      { fields: ALL_FIELDS, sessionId: 1, turnBudget: 5_000, signal },
    );
    expect(rendered).not.toContain("truncated:");
    expect(signal.truncated).toBe(false);
  });
});

/**
 * THE RENDER-SIDE TITLE CAP (spec D1). The label is the one line no budget can
 * reach, so the structural overhead the turn budget is derived from had no
 * ceiling until this cap existed. It is a RENDER bound: no write face refuses a
 * long title, because a render's arithmetic is not a reason to add an
 * eligibility predicate to the product.
 */
describe("the title is capped at render, reported, and unconstrained at write (spec D1)", () => {
  test("a label past the cap is cut with the truncation mark and reported `title cut`", () => {
    const long = "T".repeat(TURN_TITLE_RENDER_CAP_CHARS + 40);
    const rendered = renderNode(
      {
        type: "turn",
        value: { id: 3, promptNumber: 3, title: long, content: "a body" },
      },
      {
        indent: RENDER_INDENT_STEP,
        fields: new Set<RecallTurnField>(["title", "content"]),
        sessionId: 1,
        turnBudget: 5_000,
      },
    );

    const label = rendered.split("\n")[0]!;
    expect(label).toContain("T".repeat(TURN_TITLE_RENDER_CAP_CHARS));
    expect(label).not.toContain("T".repeat(TURN_TITLE_RENDER_CAP_CHARS + 1));
    expect(label).toContain("…");
    expect(rendered).toContain("truncated: title cut");
  });

  test("a title exactly at the cap is not cut, and nothing is reported", () => {
    const rendered = renderNode(
      {
        type: "turn",
        value: {
          id: 4,
          promptNumber: 4,
          title: "T".repeat(TURN_TITLE_RENDER_CAP_CHARS),
          content: "a body",
        },
      },
      {
        fields: new Set<RecallTurnField>(["title", "content"]),
        sessionId: 1,
        turnBudget: 5_000,
      },
    );
    expect(rendered).not.toContain("…");
    expect(rendered).not.toContain("truncated:");
  });

  test("neither `note` schema refuses a title longer than the render cap", () => {
    const long = "t".repeat(TURN_TITLE_RENDER_CAP_CHARS + 100);
    expect(noteInputSchema.safeParse({ turn: "S1/T1", title: long }).success).toBe(true);
    expect(
      settlementTurnWriteInputSchema.safeParse({ turn: "S1/T1", title: long }).success,
    ).toBe(true);
  });
});
