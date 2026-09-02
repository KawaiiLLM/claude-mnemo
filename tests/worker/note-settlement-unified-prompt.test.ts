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
import { UNIFIED_NOTE_TOOL_DESCRIPTION } from "../../src/worker/note-settlement-sdk-query";
import {
  SETTLEMENT_READ_FIELD_BUDGETS,
  SETTLEMENT_READ_PAGE_BUDGET,
  SETTLEMENT_READ_TURN_BUDGET,
  SETTLEMENT_READ_TURNS_PER_PAGE,
} from "../../src/worker/note-settlement-read-budgets";
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

    const finalizeDuty = prompt.slice(prompt.indexOf("9. FINALIZE."));
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
      prompt.indexOf("1. READ the writable set ONCE"),
      prompt.indexOf("2. For each turn, do the TURN-SCOPE work"),
    );
    // SETTLEMENT-READ-ONCE TICKET 01 amended what this duty asks for, not
    // that it asks: the field list became the union BOTH stages read, the
    // budgets became measured numbers rendered from
    // `note-settlement-read-budgets.ts`, and `pageSize` is now raised so that
    // COST decides the page boundary rather than a turn count.
    expect(step1).toContain("`pageSize` raised well above its default of 10");
    expect(step1).toContain(
      '`filter={fields:["title","metadata","content","prompt","insight","relations"],',
    );
    expect(step1).toContain(
      "fieldBudgets:{metadata:30,content:360,prompt:50,insight:100,relations:800}}`",
    );
    expect(step1).toContain('`boundedFields:["prompt"]`');
    expect(step1).toContain("`turn:1625`");
    expect(step1).toContain("`pageBudget:23000`");
    expect(step1).toContain("50 tokens of the user's own opening");
  });

  test("step 1 teaches the yield-repair idiom: one targeted re-read of the yielded address, metadata suffices for type/tags", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    const step1 = prompt.slice(
      prompt.indexOf("1. READ the writable set ONCE"),
      prompt.indexOf("2. For each turn, do the TURN-SCOPE work"),
    );
    expect(step1).toContain("YIELD-REPAIR: a write refused");
    expect(step1).toContain("the one address that needs it — re-read");
    expect(step1).toContain("THAT address alone, never the whole batch again");
    expect(step1).toContain("the `metadata` field carries both");
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
      prompt.indexOf("1. READ the writable set ONCE"),
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

/**
 * SETTLEMENT-READ-ONCE TICKET 04 (spec D3, "Stage 1 is topic-first"). The
 * topic pass is no longer a per-turn write loop: after the one read it lists
 * the window's topics, declares the lane a topic has none for, tags that
 * topic's turns in ONE batch call (ticket 02's membership primitive), corrects
 * the few turns the audit caught with a per-turn `note`, and finalizes.
 *
 * Pinned the same way ticket 09 and first-settlement-feedback ticket 01 pinned
 * theirs — a needle on the rendered text, scoped to the step or duty that owns
 * it, so a passing test means the run actually sees the sentence where it
 * needs it. The `not.toContain` block is the other half: a retired sentence
 * that is merely unreachable in the source still ships if it renders.
 */
describe("settlement-read-once ticket 04 — stage 1 works topic-first", () => {
  function prompt(): string {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    return renderPromptFor(context);
  }

  test("the procedure states the order: read+audit → topics and lanes → batch tag → corrections → finalize", () => {
    const text = prompt();

    const step2 = text.slice(
      text.indexOf("2. For each turn, do the TURN-SCOPE work"),
      text.indexOf("3. Only once the whole set has been read"),
    );
    // D3: the audit is a duty of the READ, edits are the exception.
    expect(step2).toContain("THE AUDIT IS A DUTY OF THE READ");
    expect(step2).toContain("in the one pass that sees it");
    expect(step2).toContain("Most turns are sound and take no");
    expect(step2).toContain("EDITS ARE THE EXCEPTION, not the shape of this pass");

    const step3 = text.slice(
      text.indexOf("3. Only once the whole set has been read"),
      text.indexOf("4. WRITE, in this order"),
    );
    expect(step3).toContain("LIST the topics this window");
    expect(step3).toContain(
      "DECLARE a lane for",
    );
    expect(step3).toContain("every line no declared lane is a synonym for");

    const step4 = text.slice(
      text.indexOf("4. WRITE, in this order"),
      text.indexOf("PHASE 2 — EDGE PASS"),
    );
    expect(step4).toContain("ONE batch tag call per topic (duty 7)");
    expect(step4).toContain("then the");
    expect(step4).toContain("per-turn `note` corrections your audit caught (duty 8), then `finalize`");
    expect(step4).toContain("(duty 9)");
    expect(step4).toContain("Declaring comes BEFORE tagging");
    expect(step4).toContain("the corrections come AFTER the batch");

    // The order is also the ORDER OF THE STEPS, not only of the sentences.
    expect(text.indexOf("3. Only once the whole set has been read")).toBeGreaterThan(
      text.indexOf("2. For each turn, do the TURN-SCOPE work"),
    );
    expect(text.indexOf("4. WRITE, in this order")).toBeGreaterThan(
      text.indexOf("3. Only once the whole set has been read"),
    );
  });

  test("duty 5 puts the declaration before any tag names the lane", () => {
    const text = prompt();
    const duty5 = text.slice(
      text.indexOf("5. CREATE the lanes the remaining lines need"),
      text.indexOf("6. DISPOSE the homeless"),
    );
    // The settlement facade's OWN shape — `id="E<n>"` plus `tag`. Its
    // `resolveOpenSegment` refuses a lane address, and it has no `members`
    // parameter, so the spec's public-`remember` form is not taught here.
    expect(duty5).toContain('`remember(create, id="E<n>",');
    expect(duty5).toContain("tag=…)`");
    expect(duty5).toContain("BEFORE");
    expect(duty5).toContain("anything is tagged with that word");
    expect(duty5).toContain("the batch write in duty 7 refuses an");
    expect(duty5).toContain("undeclared word");
  });

  test("duty 7 teaches the batch tag write: one call per topic, additive, all-or-nothing", () => {
    const text = prompt();
    const duty7 = text.slice(
      text.indexOf("7. TAG each topic's turns in ONE call"),
      text.indexOf("8. CORRECT what the audit caught"),
    );
    expect(duty7).toContain('`note(turns:["S<a>/T<b>", …],');
    expect(duty7).toContain('task:"E<n>", addTags:["<lane>"])`');
    expect(duty7).toContain("one call per topic");
    expect(duty7).toContain("The write is ADDITIVE");
    expect(duty7).toContain("the task's own");
    expect(duty7).toContain("tag rides along onto a member that lacks it");
    expect(duty7).toContain("ALL-OR-NOTHING");
    expect(duty7).toContain("a single repair call fixes the batch");
  });

  test("duty 7 states multi-lane membership and judges each membership on the PRINCIPAL result", () => {
    const text = prompt();
    const duty7 = text.slice(
      text.indexOf("7. TAG each topic's turns in ONE call"),
      text.indexOf("8. CORRECT what the audit caught"),
    );
    expect(duty7).toContain("A TURN MAY BELONG TO SEVERAL LANES");
    expect(duty7).toContain("named in BOTH calls");
    expect(duty7).toContain("the union is the outcome");
    expect(duty7).toContain("nothing to reconcile afterwards");
    // Each membership judged separately, on the same test.
    expect(duty7).toContain("Judge each");
    expect(duty7).toContain("membership on its own");
    expect(duty7).toContain("PRINCIPAL");
    expect(duty7).toContain("result serve that topic");
    expect(duty7).toContain("does the turn merely MENTION it");
    expect(duty7).toContain("tagging by mention is over-tagging");
  });

  test("duty 8 makes the per-turn note the correction and removal path, and warns that it runs after the batch", () => {
    const text = prompt();
    const duty8 = text.slice(
      text.indexOf("8. CORRECT what the audit caught"),
      text.indexOf("9. FINALIZE."),
    );
    expect(duty8).toContain("one `note` per turn — the exception, not");
    expect(duty8).toContain("the pass");
    expect(duty8).toContain("ONE call carrying all of them together");
    expect(duty8).toContain("must LEAVE a lane");
    expect(duty8).toContain("the batch write only ever ADDS");
    expect(duty8).toContain("REPLACEMENT");
    expect(duty8).toContain("SEMANTICS");
    expect(duty8).toContain("a lane word you");
    expect(duty8).toContain("leave out is REMOVED");
    expect(duty8).toContain("That is how a mis-filed turn leaves a lane");
    // The hazard the new order creates, stated where it bites.
    expect(duty8).toContain("These");
    expect(duty8).toContain("calls run AFTER duty 7");
    expect(duty8).toContain("must restate the lane");
    expect(duty8).toContain("words the batch just added; leaving one out un-files the turn");
  });

  test("the `note` tool's own description names the batch write as the lane-assignment path", () => {
    // The prompt teaches the ORDER; the tool description is where a writer
    // composing the call looks. A description that still presented the
    // whole-set `tags` write as the way lanes are assigned would teach the
    // retired shape at the point of use.
    expect(UNIFIED_NOTE_TOOL_DESCRIPTION).toContain("LANES ARE ASSIGNED IN BATCHES");
    expect(UNIFIED_NOTE_TOOL_DESCRIPTION).toContain(
      'note(turns:[…], task:"E<n>", addTags:[…])',
    );
    expect(UNIFIED_NOTE_TOOL_DESCRIPTION).toContain("tags one topic's turns in ONE call");
    expect(UNIFIED_NOTE_TOOL_DESCRIPTION).toContain("additive, all-or-nothing");
    expect(UNIFIED_NOTE_TOOL_DESCRIPTION).toContain(
      "a turn serving two topics is simply named in both calls",
    );
    expect(UNIFIED_NOTE_TOOL_DESCRIPTION).toContain(
      "A per-turn `tags` write is the CORRECTION and REMOVAL path instead",
    );
  });

  test("the retired per-turn projection and the batches-of-ten read are gone from the rendered prompt", () => {
    const text = prompt();
    expect(text).not.toContain("one `note` call per turn whose tags change");
    expect(text).not.toContain("WRITE the final projection");
    expect(text).not.toContain("written whole rather than patched");
    expect(text).not.toContain("batches of ten");
    expect(text).not.toContain("Batches bound working memory");
    expect(text).not.toContain("a full batch, or the whole writable set");
  });
});

/**
 * SETTLEMENT-READ-ONCE TICKET 01 (spec D1 + D2) — THE READ STEP IS ONE READ.
 *
 * Every sentence pinned here is a rule a tool now enforces and the text now
 * states. The two that matter most are the ones the run cannot infer:
 *
 *   - re-read ONLY what the footer named, that turn, that field. Before the
 *     footer existed there was nothing to name, so "re-read the batch" was the
 *     only safe repair and the run paid for it every time it suspected a cut;
 *   - `relations` is the asymmetry. Its gate asks for DELIVERY, not for
 *     completeness (spec D0), so a CUT set already licenses the edge write and
 *     a DROPPED one does not. A run that treated them alike would either buy a
 *     round trip it did not owe, or write an edge off a set it never saw.
 */
describe("settlement-read-once ticket 01 — step 1 reads once and names its cuts", () => {
  function stepOne(): string {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);
    return prompt.slice(
      prompt.indexOf("1. READ the writable set ONCE"),
      prompt.indexOf("2. For each turn, do the TURN-SCOPE work"),
    );
  }

  test("it asks for the union both stages need, in the fewest pages, at the measured budgets", () => {
    const step1 = stepOne();

    expect(step1).toContain("READ the writable set ONCE, in as few pages as the envelope allows");
    expect(step1).toContain("One field list serves BOTH stages");
    expect(step1).toContain(
      '`filter={fields:["title","metadata","content","prompt","insight","relations"],',
    );
    // The numbers are rendered from `note-settlement-read-budgets.ts`, so this
    // pin also catches a budget moved in the module without a re-measurement.
    expect(step1).toContain(
      `fieldBudgets:{metadata:${SETTLEMENT_READ_FIELD_BUDGETS.metadata},` +
        `content:${SETTLEMENT_READ_FIELD_BUDGETS.content},` +
        `prompt:${SETTLEMENT_READ_FIELD_BUDGETS.prompt},` +
        `insight:${SETTLEMENT_READ_FIELD_BUDGETS.insight},` +
        `relations:${SETTLEMENT_READ_FIELD_BUDGETS.relations}}}\``,
    );
    expect(step1).toContain(`\`turn:${SETTLEMENT_READ_TURN_BUDGET}\``);
    expect(step1).toContain(`\`pageBudget:${SETTLEMENT_READ_PAGE_BUDGET}\``);
    expect(step1).toContain(`${SETTLEMENT_READ_TURNS_PER_PAGE} turns fit`);
  });

  test("it names `prompt` as the one BOUNDED field, and says the other caps are required whole", () => {
    const step1 = stepOne();

    expect(step1).toContain('`boundedFields:["prompt"]`');
    expect(step1).toContain("`prompt` is the one BOUNDED field");
    expect(step1).toContain("Reaching that cap is");
    expect(step1).toContain("the contract, so the response never flags it");
    expect(step1).toContain("Every OTHER budgeted field");
    expect(step1).toContain("is required whole");
  });

  test("it states the re-read rule: that turn, that field, and nothing the footer did not name", () => {
    const step1 = stepOne();

    expect(step1).toContain("RE-READ ONLY WHAT THE RESPONSE NAMED");
    expect(step1).toContain("`truncated: <field> cut; <field> dropped`");
    expect(step1).toContain("Re-read that ONE turn with `fields:[<that field>]`");
    expect(step1).toContain("never the batch again");
    expect(step1).toContain("A field absent from the footer was");
    expect(step1).toContain("delivered whole");
    expect(step1).toContain("a BOUNDED field never appears there at all");
  });

  test("it draws D0's line: a CUT relations needs no re-read, a DROPPED one must be read once", () => {
    const step1 = stepOne();

    expect(step1).toContain("RELATIONS ARE THE ONE ASYMMETRY");
    expect(step1).toContain("a `relations` reported CUT needs no");
    expect(step1).toContain("re-read before you write an edge on that turn");
    expect(step1).toContain("A `relations` reported DROPPED was never");
    expect(step1).toContain("shown, so read that turn's `relations` once before writing any edge");
  });
});
