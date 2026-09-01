import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import {
  claimNextNoteSettlementJob,
  computeSettlementWritableTurnIds,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { updateTurnById } from "../../src/db/turns";
import {
  buildNoteSettlementContext,
  resolveSettlementWritableSet,
  type NoteSettlementContext,
} from "../../src/worker/note-settlement-context";
import {
  IMPRESSION_GOLDEN_SAMPLE_FULL,
  IMPRESSION_GOLDEN_SAMPLE_THIN,
  renderImpressionTeaching,
} from "../../src/worker/note-settlement-impression-teaching";
import { renderNoteSettlementUnifiedPrompt } from "../../src/worker/note-settlement-unified-prompt";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * Teaching-repairs ticket 09 (spec Rev 5 §Implementation "Roster annotation"
 * + "Teaching repairs") — needle tests over the UNIFIED prompt's own rendered
 * body (ticket 03's module), the primary teaching surface these four
 * frictions are repaired against. Each `describe` below pins one of the
 * ticket's four numbered items; the prompt-pin idiom (a substring of the
 * rendered text) is the same discipline `note-settlement-prompt.test.ts`
 * uses for its own verbatim/needle guards — the mechanism IS the prompt, so
 * a passing test here means the run actually sees the sentence.
 */

const NOW = 1_800_000_000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function seedSession(): number {
  return upsertSession(db, {
    contentSessionId: "unified-prompt-teaching-session",
    project: "/tmp/project-unified-prompt-teaching",
    title: "unified prompt teaching-repairs fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(sessionDbId: number, promptNumber: number): number {
  return db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 2, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;
}

function claimWindow(sessionDbId: number, start: number, end: number): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [{ sessionId: sessionDbId, windowStart: start, windowEnd: end, triggerType: "consecutive" }],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

/** The dispatch's own render path: compute the writable set, resolve it, render — never a hand-built set. */
function renderPromptFor(context: NoteSettlementContext): string {
  const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);
  return renderNoteSettlementUnifiedPrompt(context, resolveSettlementWritableSet(db, context, writableTurnIds));
}

describe("lane-impressions ticket 02 — the writing law ships in the prompt", () => {
  test("the frozen teaching and both golden samples are in the unified prompt", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    void turnId;
    const prompt = renderPromptFor(context);
    expect(prompt).toContain(renderImpressionTeaching());
    expect(prompt).toContain(IMPRESSION_GOLDEN_SAMPLE_FULL);
    expect(prompt).toContain(IMPRESSION_GOLDEN_SAMPLE_THIN);
  });

  test("the prompt asserts NOTHING about the per-container coordinates — they do not exist yet", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const prompt = renderPromptFor(
      buildNoteSettlementContext(db, job, { nowEpoch: NOW })!,
    );
    expect(prompt).not.toContain("impression containers you owe a judgment on");
  });
});

describe("ticket 09 item 1 — roster annotation, sourced from the write-face predicates", () => {
  test("a compact marker, a rolled-back turn and a skipped turn each show their bracket marker; a live turn shows none", () => {
    const sessionDbId = seedSession();
    const live = seedTurn(sessionDbId, 1);
    const skipped = seedTurn(sessionDbId, 2);
    const rolledBack = seedTurn(sessionDbId, 3);
    const compact = seedTurn(sessionDbId, 4);
    updateTurnById(db, skipped, { status: "skipped" });
    updateTurnById(db, rolledBack, { wasRolledBack: true });
    updateTurnById(db, compact, { type: ["compact"] });
    void live;

    const job = claimWindow(sessionDbId, 1, 4);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    expect(prompt).toContain(`S${sessionDbId}/T1,`);
    expect(prompt).not.toContain(`S${sessionDbId}/T1 [`);
    expect(prompt).toContain(`S${sessionDbId}/T2 [skipped]`);
    expect(prompt).toContain(`S${sessionDbId}/T3 [rolled-back]`);
    expect(prompt).toContain(`S${sessionDbId}/T4 [compact]`);
    // States that no duty applies to an annotated address (spec: "stating no
    // duty applies to them") — the legend sentence, present because at least
    // one address needed it.
    expect(prompt).toContain("no duty in this prompt applies to it");
  });

  test("a window with nothing non-writable prints no legend sentence", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    expect(prompt).not.toContain("no duty in this prompt applies to it");
  });
});

describe("ticket 09 item 2 — the finalize and commit duty paragraphs state the 1000-character cap", () => {
  test("FINALIZE's own duty text states the cap and the concrete refusal target", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    const finalizeDuty = prompt.slice(prompt.indexOf("8. FINALIZE."));
    expect(finalizeDuty.slice(0, 600)).toContain("capped at 1000 characters");
    expect(finalizeDuty.slice(0, 600)).toContain("shorten below ~800");
  });

  test("commit's own duty text states the cap and the concrete refusal target", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    const commitDuty = prompt.slice(prompt.indexOf("9. Write this session's own"));
    expect(commitDuty.slice(0, 700)).toContain("capped at 1000 characters");
    expect(commitDuty.slice(0, 700)).toContain("shorten below ~800");
  });
});

describe("ticket 09 item 3 — the topic-word duty states the phase-token ban with family examples", () => {
  test("duty 2 (topic words) names the phase-token ban and two concrete family examples", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    const topicDuty = prompt.slice(
      prompt.indexOf("2. SUPPLY the missing topic words."),
      prompt.indexOf("3. DRAFT every topic line"),
    );
    expect(topicDuty).toContain("NO PHASE WORD");
    // Two concrete family examples (the ticket's own acceptance wording),
    // the same vocabulary `phaseBearingNameRefusal`/`findPhaseToken`
    // (shared/topic-tag.ts) refuse a lane name by.
    expect(topicDuty).toContain('"design"');
    expect(topicDuty).toContain('"review"');
    // The identical register the runtime refusal itself uses — never a
    // paraphrased law.
    expect(topicDuty).toContain("is the phase axis and a topic word is the subject axis");
  });
});

describe("ticket 09 item 4 — the read procedure teaches pageSize/turn and the yield-repair idiom", () => {
  // AMENDMENT (per-field-recall-budgets ticket 11): this needle followed the
  // prompt text's own amendment — `fieldBudgets: { prompt: 50 }` replaces the
  // old field-order approximation now that recall's `filter.fieldBudgets`
  // (USER RULING S15069/T2106) makes the `prompt` clip an exact,
  // order-independent contract instead of one. See the doc comment on
  // `renderNoteSettlementUnifiedPrompt` (note-settlement-unified-prompt.ts)
  // for the full rationale.
  test("step 1 recommends raising pageSize (the existing parameter) and names fieldBudgets for the prompt clip", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    const step1 = prompt.slice(
      prompt.indexOf("1. READ the writable set in chronological batches"),
      prompt.indexOf("2. For each turn, do the TURN-SCOPE work"),
    );
    expect(step1).toContain("raise `pageSize` above");
    expect(step1).toContain("its default of 10");
    expect(step1).toContain(
      '`filter={fields:["title","metadata","content","prompt"],',
    );
    expect(step1).toContain("fieldBudgets:{prompt:50}}` with `turn` raised to roughly 280");
    expect(step1).toContain("AT MOST 50 tokens");
  });

  test("step 1 teaches the yield-repair idiom: one targeted re-read of the yielded address, metadata suffices for type/tags", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    const step1 = prompt.slice(
      prompt.indexOf("1. READ the writable set in chronological batches"),
      prompt.indexOf("2. For each turn, do the TURN-SCOPE work"),
    );
    expect(step1).toContain("YIELD-REPAIR: a write refused");
    expect(step1).toContain("the one address that needs it — re-read");
    expect(step1).toContain("THAT address alone, never the whole batch again");
    expect(step1).toContain("the default `metadata` field already carries both");
  });
});

/**
 * FIRST-SETTLEMENT-FEEDBACK TICKET 01 (user ruling S15069/T2367). Two
 * additions, each a rule the tools already enforce that this prompt never
 * stated, each anchored to a cost a production run under 0.29.0 actually
 * paid. Pinned the same way ticket 09 pinned its four: a needle on the
 * rendered text, scoped to the step that owns the duty, so a passing test
 * means the run actually sees the sentence at the point it needs it.
 */
describe("first-settlement-feedback ticket 01 — the read step names the ADDRESS", () => {
  test("step 1 teaches the task's event-order range, the plain session-range fallback, and refuses filter.session as a window read", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    const step1 = prompt.slice(
      prompt.indexOf("1. READ the writable set in chronological batches"),
      prompt.indexOf("2. For each turn, do the TURN-SCOPE work"),
    );
    // Job 170's first tool call obeyed every part of this step that existed
    // — fields, fieldBudgets, pageSize — and still cost 6m10s, because the
    // step never said which address to pass.
    expect(step1).toContain("ADDRESS THE BATCH, NEVER SEARCH FOR IT");
    expect(step1).toContain('`id="E<n>/S<a>/T<b>..S<c>/T<d>"`');
    // The range is segment-scoped and refuses a window turn that is not a
    // member — job 170 hit exactly that and had to re-address.
    expect(step1).toContain('"S<n>/T<m> is not a member of E<n>"');
    expect(step1).toContain('`id="S<n>/T<a>..<b>"`');
    // The route that was actually taken, named as what it is.
    expect(step1).toContain("`filter.session` with no `id` is a WHOLE-SESSION SEARCH");
    expect(step1).toContain("before it can return page 1");
  });
});

describe("first-settlement-feedback ticket 01 — the edge pass places the edge AT WRITE", () => {
  test("step 6 names the two-sided form, the both-or-neither rule, and E6 as the cost of a bare address", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    const step6 = prompt.slice(
      prompt.indexOf("6. Work the worklist lane by lane"),
      prompt.indexOf("7. Run ONE crossing pass"),
    );
    // Job 171 wrote 66 bare edges, took 39 E6 errors on its first
    // `lane_check`, and spent ~80 tool calls retracting and re-adding them.
    expect(step6).toContain("PLACE EVERY EDGE AT WRITE");
    expect(step6).toContain("`{turn, tailTag, headTag}` in the call that writes it");
    expect(step6).toContain("`tailTag` the lane THIS turn writes from");
    expect(step6).toContain("both sides or neither");
    expect(step6).toContain("A bare address writes a DRAFT");
    expect(step6).toContain("E6 ERROR that blocks your");
    expect(step6).toContain("retract-and-re-add round");
  });
});
