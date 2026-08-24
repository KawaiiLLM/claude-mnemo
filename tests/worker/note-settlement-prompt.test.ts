import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { writeMemoryEdges } from "../../src/db/memory-edges";
import {
  claimNextNoteSettlementJob,
  computeSettlementWritableTurnIds,
  enqueueNoteSettlementWindows,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { initializeSchema } from "../../src/db/schema";
import { attachSegmentToSession, createSegment } from "../../src/db/segments";
import { upsertSession } from "../../src/db/sessions";
import { claimWriterId } from "../../src/db/write-gate";
import { upsertShadowNote } from "../../src/db/shadow-notes";
import { renderRubricBlock } from "../../src/hooks/session-composition";
import { MEMORY_RUBRIC_TEXT, renderMemoryRubricBlock } from "../../src/shared/memory-rubric";
import { MEMORY_TYPES } from "../../src/shared/type-vocabulary";
import {
  buildNoteSettlementContext,
  resolveSettlementWritableSet,
  type NoteSettlementContext,
} from "../../src/worker/note-settlement-context";
import {
  NOTE_SETTLEMENT_SYSTEM_PROMPT,
  renderNoteSettlementPrompt,
} from "../../src/worker/note-settlement-prompt";
import { SETTLEMENT_ALLOWED_TOOLS } from "../../src/worker/note-settlement-sdk-query";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";

/**
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): what
 * the settlement prompt has to SAY now that duty 1 (grading), duty 2 (note
 * reconstruction) and `assign` are all gone — only PROPOSALS (floor 1, never
 * required) and RELATIONS remain, plus a bare segment ROSTER
 * (id/title only, ticket 15 dropped `topic` — never a segment's own fields).
 *
 * Every assertion here is a sentence the ticket names as a deliverable, so it
 * is pinned as a substring of the rendered prompt: the prompt IS the
 * mechanism, and a guard that only checked "some membership text exists"
 * would pass whether or not the rule survived a later edit.
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
    contentSessionId: "settlement-prompt-session",
    project: "/tmp/project-settlement-prompt",
    title: "settlement prompt fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  facets: { type?: string[]; tags?: string[] } = {},
): number {
  return db
    .query<{ id: number }, [number, number, string, string, number, string, string]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch, type, tags
       ) VALUES (?, ?, 'active', ?, ?, 2, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      `prompt ${promptNumber}`,
      `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
      JSON.stringify(facets.type ?? []),
      JSON.stringify(facets.tags ?? []),
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

/**
 * The dispatch's own render path, verbatim (tag-mandate ticket 06): compute
 * the immutable writable set from the context's base ids, resolve it to
 * addresses, render. Tests go through THIS rather than calling
 * `renderNoteSettlementPrompt` with a hand-built set, so a divergence between
 * the printed declaration and the set the gate enforces would fail here too.
 */
function renderPromptFor(context: NoteSettlementContext, database: Database = db): string {
  const writableTurnIds = computeSettlementWritableTurnIds(
    database,
    context.reviewableTurnIds,
  );
  return renderNoteSettlementPrompt(
    context,
    resolveSettlementWritableSet(database, context, writableTurnIds),
  );
}

/** A rendered prompt over a one-turn window, with whatever segments the test seeded first. */
function renderPrompt(): string {
  const sessionDbId = seedSession();
  seedTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);
  const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
  return renderPromptFor(context);
}

describe("duty 1 — proposals, never assign, never forced (ticket 05)", () => {
  test("the prompt states propose, the homeless-cluster criterion, and that a single turn may open one", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("PROPOSALS, via the `remember` tool");
    expect(prompt).toContain("action=\"propose\"");
    expect(prompt).toContain("this session's attached");
    expect(prompt).toContain("TEXT-ONLY suggestion");
    expect(prompt).toContain("creates NO segment");
    expect(prompt).toContain("never auto-adopted");
    expect(prompt).toContain("A single");
    expect(prompt).toContain("homeless turn may open its own proposal");
    expect(prompt).toContain("never required — a window may propose nothing");
    // `assign` and the retired arc-partition/body/lifecycle instructions
    // must be gone, not merely contradicted somewhere else in the prompt.
    expect(prompt).not.toContain("action=\"assign\"");
    expect(prompt).not.toContain("A SEGMENT IS ONE ARC");
    expect(prompt).not.toContain("SEGMENT LIFECYCLE");
    expect(prompt).not.toContain("noCandidateReason");
    // Duty 1 (grading) and duty 2 (reconstruction) left the prompt entirely.
    expect(prompt).not.toContain("TURN REVIEW");
    expect(prompt).not.toContain("RECONSTRUCTION");
    expect(prompt).not.toContain("tier:");
    expect(prompt).not.toContain("grade:");
  });
});

describe("commit is never gated on membership (ticket 05/06)", () => {
  test("the prompt states commit finishes the window regardless of whether anything was written", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("Call `commit` once you believe this window is done");
    expect(prompt).toContain("whether\n   or not you wrote anything");
    expect(prompt).toContain("always call it, even after a window where you wrote nothing");
    // The retired re-keyed gate's own wording must not survive.
    expect(prompt).not.toContain("attached segments — you");
    expect(prompt).not.toContain("membership call at all");
  });
});

describe("the segment roster (ticket 05) — id/title only, never a segment's own fields", () => {
  test("an unattached segment does not render, whatever its recency", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const notAttached = createSegment(db, { title: "elsewhere, never attached", nowEpoch: NOW });

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.segmentRoster).toEqual([]);

    const prompt = renderPromptFor(context);
    expect(prompt).toContain("(no segments attached to this session)");
    expect(prompt).not.toContain(`E${notAttached.id}`);
  });

  test("an attached segment renders id and title but NOT content/insight", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, {
      title: "fencing the claim",
      content: "the working state",
      insight: "a generation check beats a timestamp",
      nowEpoch: NOW - 4_000,
    });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW - 4_000);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.segmentRoster).toEqual([{ id: segment.id, title: "fencing the claim" }]);

    const prompt = renderPromptFor(context);
    const roster = prompt.slice(prompt.indexOf("## Segment roster"));
    expect(roster).toContain(`[E${segment.id}] fencing the claim`);
    // The old full-field render is gone — content/insight never reach this prompt.
    expect(roster).not.toContain("the working state");
    expect(roster).not.toContain("a generation check beats a timestamp");
    expect(prompt).not.toContain("content: the working state");
  });
});

/**
 * TAG-MANDATE TICKET 06 — the PUSH channel is gone (spec "Settlement
 * surface", ruling [S15069/T1452]). This describe replaces the ticket-11
 * pair that pinned the opposite property (a window turn rendered through
 * recall's collapsed view, byte for byte): the section those tests read from
 * no longer exists.
 *
 * SCOPE NOTE, so the assertions below are read for what they are: the
 * `## Session summary` block is `recallMemory(id="S<n>")`, and a session card
 * carries a PAGE-BUDGETED preview of that session's own turn rows (address,
 * title, metadata, content) underneath the narrative. That preview predates
 * this ticket, is bounded by `pageBudget` rather than by the window, and
 * grants nothing (its `readerId` is null now). So "no turn content reaches
 * the prompt" would be a false assertion; what IS pinned is that the
 * WINDOW rendering — the unbounded per-writable-turn section, with its own
 * `[S<n>/T<n>]` fact line and its settlement-only annotations — is gone.
 */
describe("ticket 06 — the window rendering is gone; the prompt carries no turn content", () => {
  test("no `## Turns` section, no per-turn fact line, and the turn is writable anyway", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1, { type: ["implement"] });
    db.query<unknown, [number]>(
      "UPDATE turns SET title = 'implement+lease: fence the claim', content = 'Fenced it.' WHERE id = ?",
    ).run(turnId);
    const job = claimWindow(sessionDbId, 1, 1);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    expect(prompt).not.toContain("## Turns");
    // The retired heading's own framing, pinned absent so a future edit
    // cannot reintroduce the section under its old caption.
    expect(prompt).not.toContain("rendered identically");
    expect(prompt).not.toContain("equally citable and");
    // The retired renderer's own signature: a per-turn fact line addressed
    // `[S<n>/T<n>]`. Recall's own turn rows label `[T<n>]`, so this bracketed
    // SLASH form existed nowhere else and its absence is exact.
    expect(prompt).not.toContain(`[S${sessionDbId}/T1]`);

    // The turn is still WRITABLE — the set declares it. Rendering and
    // authorization came apart; the declaration is what survives.
    expect(prompt).toContain("WRITABLE SET:");
    expect(prompt).toContain(`S${sessionDbId}/T1`);
    expect(context.reviewableTurnIds.has(turnId)).toBe(true);
  });

  test("a settlement-written shadow note is not pushed either — insight and writer origin included", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    // A reconstruction an earlier settlement pass wrote. The retired
    // rendering carried its title/content plus two annotations recall has no
    // slot for; under pull the agent recalls the turn to see any of it.
    upsertShadowNote(db, {
      turnId,
      title: "fix+lease: reconstructed in hindsight",
      content: "What the earlier pass concluded.",
      insight: "the lease is the fence",
      writerOrigin: "settlement",
      nowEpoch: NOW - 500,
    });
    const job = claimWindow(sessionDbId, 1, 1);

    const prompt = renderPromptFor(
      buildNoteSettlementContext(db, job, { nowEpoch: NOW })!,
    );

    expect(prompt).not.toContain("fix+lease: reconstructed in hindsight");
    expect(prompt).not.toContain("What the earlier pass concluded.");
    expect(prompt).not.toContain("insight: the lease is the fence");
    expect(prompt).not.toContain("(note reconstructed by an earlier settlement pass)");
  });
});

/**
 * TAG-MANDATE TICKET 06 — the IMMUTABLE WRITABLE SET, printed (spec: "the
 * writable set is IMMUTABLE and declared"; ticket's checkbox 1, "prompt
 * carries the writable set verbatim").
 *
 * The load-bearing property is IDENTITY, not formatting: what the prompt
 * declares must be exactly what `computeSettlementWritableTurnIds` produced —
 * the same value the write facade's range check and the commit gate read.
 * These tests therefore compute the set the dispatch's way and assert every
 * member appears, rather than checking that "some addresses are printed".
 */
describe("ticket 06 — the writable set is declared, window first, in addresses", () => {
  test("window and declared-lookback groups are labelled, and every id in the computed set is printed", () => {
    const sessionDbId = seedSession();
    for (let promptNumber = 1; promptNumber <= 6; promptNumber += 1) {
      seedTurn(sessionDbId, promptNumber);
    }
    const job = claimWindow(sessionDbId, 4, 6);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context);

    // Ticket 07: Block A's WRITABLE SET is now the LAST thing in the
    // Procedure section (the old trailing "Reconcile what is stored..."
    // paragraph retired), so "## Duties" is the correct end boundary.
    const block = prompt.slice(prompt.indexOf("WRITABLE SET:"), prompt.indexOf("## Duties"));
    expect(block).toContain("window — settle these (3):");
    expect(block).toContain("declared lookback — equally writable (3):");
    // Window first, then the remainder — the order the agent works them.
    expect(block.indexOf("window — settle these")).toBeLessThan(
      block.indexOf("declared lookback"),
    );
    for (const promptNumber of [4, 5, 6]) {
      expect(block).toContain(`S${sessionDbId}/T${promptNumber}`);
    }

    // IDENTITY with the enforced set: same count, same members.
    const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);
    const set = resolveSettlementWritableSet(db, context, writableTurnIds);
    expect(set.window.length + set.lookback.length).toBe(writableTurnIds.size);
    for (const address of [...set.window, ...set.lookback]) {
      expect(block).toContain(address);
    }
  });

  test("a deadlock-guard closure id — never in this context's own turns — still prints, in the lookback group", () => {
    const sessionDbId = seedSession();
    const outside = seedTurn(sessionDbId, 1);
    const t9 = seedTurn(sessionDbId, 9);
    // T9 cites T1. T1 is far outside the window's own lookback (a 1-turn
    // window reaches back exactly one turn), so it enters the writable set
    // ONLY through the closure — and repairing T9's edge needs it writable.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t9 },
          cited: { kind: "turn", id: outside },
          relation: "extends",
          provenance: "asserted",
          tags: [],
        },
      ],
      NOW,
    );
    const job = claimWindow(sessionDbId, 9, 9);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;

    expect(context.reviewableTurnIds.has(outside)).toBe(false);
    const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);
    expect(writableTurnIds.has(outside)).toBe(true);

    const set = resolveSettlementWritableSet(db, context, writableTurnIds);
    expect(set.window).toEqual([`S${sessionDbId}/T9`]);
    expect(set.lookback).toContain(`S${sessionDbId}/T1`);
    expect(renderPromptFor(context)).toContain(`S${sessionDbId}/T1`);
  });
});

/**
 * TAG-MANDATE TICKET 07 — Block A's batched procedure (spec: revision 7 of
 * `.scratch/tag-mandate/issues/06-prompt-text.md`), replacing ticket 06's
 * per-window STEP-0-COVERAGE framing wholesale: the writable set is now
 * worked in chronological ten-turn batches, each running three workstations
 * in order (TURN AUDIT, CONTENT CANDIDATES, BACK-LINK).
 *
 * Every assertion is a substring of the AUTHORED text (Block A), pinned
 * inside the Procedure section rather than anywhere in the prompt: the
 * batch loop is worthless if it drifts out of the place the agent reads
 * before judging.
 */
describe("ticket 07 — Block A teaches the batched workstations, and timeline licenses nothing", () => {
  function procedureText(prompt: string): string {
    return prompt.slice(prompt.indexOf("## Procedure"), prompt.indexOf("## Duties"));
  }

  test("the scope sentence states immutability and the gate's refusal", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("Your scope is the WRITABLE SET printed below");
    expect(procedure).toContain("It is immutable — reading never widens it, and every");
    expect(procedure).toContain("write must land inside it; the gate refuses the rest and names why.");
  });

  test("batches are ten chronological turns, and batch/window/lookback labels are never topology", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("Work the WHOLE writable set in chronological batches of ten turns (the");
    expect(procedure).toContain("last batch may be smaller). Batches bound working memory, nothing else:");
    expect(procedure).toContain("window and lookback labels and batch boundaries are never thread, lane,");
    expect(procedure).toContain("phase or convergence boundaries. Do not call `lane_check` during the");
    expect(procedure).toContain("batch loop.");
  });

  test("reading is the write license throughout, and timeline licenses nothing", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("Reading is your write license throughout: a whole-field");
    expect(procedure).toContain("`write` over another writer's text requires your own untruncated read of");
    expect(procedure).toContain("that field, and `timeline` licenses nothing.");
  });

  // T1466 (finding P1-4)'s own root cause carries forward: explicit `fields`
  // REPLACE recall's defaults, so BATCH STEP 1's field list and the sentence
  // naming what must have been seen are pinned together.
  test("BATCH STEP 1 names the recall call's fields, the re-read rule, and the note-less-turn read", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("BATCH STEP 1 — TURN AUDIT. Recall every turn of this batch with");
    expect(procedure).toContain(
      '`filter={fields:["title","metadata","content","insight","relations"]}`;',
    );
    expect(procedure).toContain("re-read any truncated field with a bigger `turn` budget, and read a turn");
    expect(procedure).toContain("carrying no note with `prompt` and `response` added — the raw exchange is");
    expect(procedure).toContain("what you judge it by, and a field never delivered licenses nothing.");
  });

  test("BATCH STEP 1 audits every turn independently against note, type and membership criteria", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("EVERY turn independently, whether or not anything flags it: does the note");
    expect(procedure).toContain("misread its turn; does the type honor the Ruling supplement (a user");
    expect(procedure).toContain("ruling or veto that landed here adds `design` or `correction`, and");
    expect(procedure).toContain("`discuss` cannot remain); does membership match content against the");
    expect(procedure).toContain("roster (homeless is legal by itself — reassign only when one destination");
    expect(procedure).toContain("is obvious from content, never from adjacency, a shared project noun or");
    expect(procedure).toContain("a checker warning). Turn-local corrections — notes, type, tags,");
    expect(procedure).toContain("membership — may land now.");
  });

  test("BATCH STEP 2 records claim-level candidates only, writing no relation yet", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("BATCH STEP 2 — CONTENT CANDIDATES. Without consulting the stored edge");
    expect(procedure).toContain("words, identify the claim-level links wholly visible in this batch. Add");
    expect(procedure).toContain("each to a private open-thread ledger: at least two turn addresses, the");
    expect(procedure).toContain("claim link, a phase hypothesis, its current frontier. Shared topic,");
    expect(procedure).toContain("adjacency and state-only turns are never candidates; there is no target");
    expect(procedure).toContain("count, and an empty batch ledger is valid. Record candidates only —");
    expect(procedure).toContain("write no relation, no lane tag, no `indexes` yet.");
  });

  test("BATCH STEP 3 back-links against the ledger's own frontiers, never every earlier turn", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("BATCH STEP 3 — BACK-LINK. Compare this batch against the ledger's open");
    expect(procedure).toContain("frontiers, the batch's own explicit predecessor language, and any prior");
    expect(procedure).toContain("terminus this content explicitly continues or corrects — never against");
    expect(procedure).toContain("every earlier turn. Follow predecessor language across window, lookback");
    expect(procedure).toContain("and batch boundaries; when it points outside the writable set, read that");
    expect(procedure).toContain("endpoint for judgment even though it stays unwritable. A membership");
    expect(procedure).toContain("break never proves a content thread absent. Targeted re-reads collect");
    expect(procedure).toContain("any historical relations or full tag sets the final write gate will");
    expect(procedure).toContain("require — the ledger itself licenses nothing. Update the ledger; do not");
    expect(procedure).toContain("finalize the graph.");
  });

  // ABSENCE pin (ticket 07, retired teaching #1): the old per-window
  // STEP-0-COVERAGE framing and its trailing "Reconcile what is stored..."
  // SUPPLY/CORRECT/RETRACT paragraph are both gone, replaced whole by the
  // batched workstations above — pinned so a future merge cannot resurrect
  // either half independently.
  test("the retired STEP 0 framing and the 'Reconcile what is stored' opener are both gone", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).not.toContain("STEP 0 — COVERAGE");
    expect(procedure).not.toContain("page through EVERY turn of the");
    expect(procedure).not.toContain('recall(id="S<s>/T<a>..T<b>"');
    expect(procedure).not.toContain("Turns outside the set may be read freely");
    expect(procedure).not.toContain("Reconcile what is stored");
    expect(procedure).not.toContain("SUPPLY what is missing");
    expect(procedure).not.toContain("CORRECT what is wrong");
    expect(procedure).not.toContain("RETRACT what is false");
  });
});

/**
 * TAG-MANDATE TICKET 06 — the edges bullet (authored Block B) is the prompt's
 * half of "the mandate reaches every teaching surface" (spec). Two things
 * the retired bullet did not say and the write gate now enforces: the entry
 * FORMS, and extends/narrows being tagged-form-ONLY. Pinned inside duty 2,
 * where the agent reads them, rather than anywhere in the prompt.
 */
describe("ticket 06 — the edges bullet teaches the tag mandate and the lane procedure", () => {
  function edgesBullet(prompt: string): string {
    return prompt.slice(
      prompt.indexOf("   - edges: `note`'s"),
      prompt.indexOf("   - `type` and `tags` are the two fields"),
    );
  }

  test("both entry forms, the tagged-only rule for extends/narrows, and the subset invariant", () => {
    const bullet = edgesBullet(renderPrompt());

    expect(bullet).toContain('An entry is a bare address ("S15069/T7") — an');
    expect(bullet).toContain("UNTAGGED edge acting on the cited turn itself");
    expect(bullet).toContain('`{ "turn": "S15069/T7", "tags": ["lane-tag"] }` acting on the named');
    expect(bullet).toContain("LANE.");
    // THE MANDATE.
    expect(bullet).toContain("extends/narrows accept ONLY the tagged form: continuation names");
    expect(bullet).toContain("its line.");
    // The subset invariant, with its write ORDER — member tags first, or the
    // edge write is refused by the gate for a reason the agent cannot see.
    expect(bullet).toContain("An edge's tags must already sit on BOTH endpoint turns' own");
    expect(bullet).toContain("tags — write the member turns' tags first, then the edge.");
  });

  // T1466 (RB hand-off): the relations gate is enforced in `db/write-gate.ts`
  // (`checkRelationsGate`) and refuses an edge write from a run that never
  // read the citing turn's current relation set. Ticket 07: the read now
  // comes from BATCH STEP 1's own audit rather than a "Step 0" label, and a
  // stale one (a turn audited in an earlier batch, edited since) is re-read,
  // never guessed.
  test("an edge write is taught to need the citing turn's current relations read", () => {
    const bullet = edgesBullet(renderPrompt());

    expect(bullet).toContain("An edge write");
    expect(bullet).toContain("also needs your own current read of the citing turn's RELATIONS — the");
    expect(bullet).toContain("batch audits earn it, your own writes keep it current, and a");
    expect(bullet).toContain("stale one is re-read, never guessed.");
  });

  // Ticket 07: the old seven-step PER-THREAD procedure is gone, replaced by
  // a five-step procedure that runs ONCE, after the last batch, over the
  // ledger BATCH STEP 2/3 built.
  test("the five relation steps are present and ordered, ending in check-and-repair", () => {
    const bullet = edgesBullet(renderPrompt());

    const steps = [
      "1. DISPOSE every ledger candidate:",
      "2. FORM LANES across all batches:",
      "3. JUDGE AND WRITE.",
      "4. DECLARE CONVERGENCE.",
      "5. CHECK AND REPAIR.",
    ];
    let cursor = -1;
    for (const step of steps) {
      const at = bullet.indexOf(step);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }

    expect(bullet).toContain("All relation writes happen HERE, after the last batch, in five steps:");
    // DISPOSE: uncertainty is OPEN, never CONVERGED — the trial's own root
    // cause for premature closure.
    expect(bullet).toContain("Uncertainty is OPEN, never CONVERGED.");
    // JUDGE AND WRITE: the stored word is evidence of nothing; the claim
    // test re-runs fresh every time.
    expect(bullet).toContain("ignore the stored relation word and run the claim test as if no");
    expect(bullet).toContain("edge existed — the old word is evidence of nothing.");
    // DECLARE CONVERGENCE: stopping, a batch ending, or an existing
    // declaration are never closure evidence on their own.
    expect(bullet).toContain("Work merely stopping, a batch ending, or an existing declaration is");
    expect(bullet).toContain("never closure evidence — producing the declaration is your job, and");
    // CHECK AND REPAIR is the whole reason a settlement window meets E1 at
    // all — repairs repeat step 3, never a fresh work plan.
    expect(bullet).toContain("ERRORS are a repair queue for the graph you already");
    expect(bullet).toContain("judged, never the work plan; every repair repeats step 3.");
  });

  // T1466 (finding P2-5): the routing for a turn that TESTED the cited claim
  // carries forward into JUDGE AND WRITE (step 3 of the new five) — a
  // verification must never fall back to `extends`, the nearest neighbour a
  // model reaches for.
  test("JUDGE AND WRITE routes a check this turn produced to verifies/refutes, never extends", () => {
    const bullet = edgesBullet(renderPrompt());

    expect(bullet).toContain("a check");
    expect(bullet).toContain("THIS turn produced, for or against the cited");
    expect(bullet).toContain("conclusion, is verifies or refutes, never extends;");
  });
});

/**
 * TAG-MANDATE TICKET 07 — the COMMIT CONTRACT (authored Block C, revision 7),
 * appended to duty 4. It is the one fact a caller must hold at the moment of
 * calling `commit`, and it is stated in two places on purpose (here and the
 * tool's own description, `note-settlement-sdk-query.ts`) — the description
 * is what survives into every retry, the prompt is what is read before the
 * first try.
 */
describe("ticket 07 — Block C: the commit paragraph carries the gate contract", () => {
  test("refusal condition, the free retry, out-of-scope errors, and one successful commit", () => {
    const prompt = renderPrompt();
    const duty4 = prompt.slice(prompt.indexOf("4. COMMIT."), prompt.indexOf("## Segment roster"));

    expect(duty4).toContain("`commit` is REFUSED while any ERROR `lane_check` reports anchors inside");
    expect(duty4).toContain("your writable set — the refusal lists exactly the rows to repair, and a");
    expect(duty4).toContain("refusal costs no attempt. Errors anchored outside your set belong to");
    expect(duty4).toContain("other windows and never block you. The job ends only through ONE");
    expect(duty4).toContain("SUCCESSFUL commit: a refusal is repaired and retried, and certainty that");
    expect(duty4).toContain("nothing changed still requires an empty-handed successful commit.");
  });

  // ABSENCE pin (ticket 07, retired teaching #2): the old "call lane_check
  // early" advice is gone from the commit paragraph — Block A now forbids
  // calling it during the batch loop, and Block B's own step 5 (CHECK AND
  // REPAIR) is where it belongs instead.
  test("the retired 'call lane_check early' sentence is gone", () => {
    const prompt = renderPrompt();
    const duty4 = prompt.slice(prompt.indexOf("4. COMMIT."), prompt.indexOf("## Segment roster"));

    expect(duty4).not.toContain("Call `lane_check` early");
    expect(duty4).not.toContain("its WARNINGS inform judgment and never block.");
  });
});

/**
 * TAG-MANDATE TICKET 07 — the Duties preamble's own commit phrase (revision
 * 7's integration note, not one of Blocks A-D but authored the same way): a
 * gate REFUSAL is still a `commit` call, so "exactly one `commit`" let a run
 * read its own refusal as the one commit it was allowed and stop there.
 */
describe("ticket 07 — the Duties preamble states one SUCCESSFUL commit, and a refusal is not it", () => {
  test("the preamble carries the amended phrase, and the retired phrasing is gone", () => {
    const prompt = renderPrompt();
    const duties = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("The lease is checked"));

    expect(duties).toContain("by one SUCCESSFUL `commit`; a refusal is not that commit, once you");
    expect(duties).toContain("believe there is nothing further to add.");
    expect(duties).not.toContain("exactly one `commit`");
  });
});

/**
 * Ticket 11 (edge-ownership-impl, "统一 Memory Rubric") — the hash guard
 * this ticket's own checklist names: the settlement prompt and the
 * SessionStart injection (`hooks/session-composition.ts`'s
 * `renderRubricBlock`, ticket 14: its own block, no longer shared with the
 * roster) must render the rubric byte-identical.
 * Exercised HERE, against a real settlement prompt (this file's own
 * fixture), rather than only comparing each side to the shared constant in
 * isolation — a future edit that wrapped one side differently would still
 * fail this specific cross-check.
 */
describe("ticket 11 — the Memory Rubric renders byte-identical in both consumers", () => {
  test("the settlement prompt embeds the exact same rubric block SessionStart injects", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const sessionDbId = upsertSession(db, {
      contentSessionId: "rubric-hash-session",
      project: "/tmp/project-rubric-hash",
      title: "rubric hash fixture",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;
    db.query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, 1, 'active', ?, ?, 1, ?) RETURNING id`,
    ).get(sessionDbId, "prompt 1", "response 1", NOW - 1_000);

    enqueueNoteSettlementWindows(
      db,
      [{ sessionId: sessionDbId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000)!;
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context, db);

    const sessionStartBlock = renderRubricBlock();
    const rubricOnly = renderMemoryRubricBlock();

    // The settlement prompt carries the SAME rendered rubric block…
    expect(prompt).toContain(rubricOnly);
    // …and so does the SessionStart injection's OWN rubric block (ticket 14:
    // no longer cohabiting with the roster, but the rubric substring itself
    // is identical).
    expect(sessionStartBlock).toContain(rubricOnly);
    // Byte-for-byte: extract each consumer's own copy and compare.
    const promptRubric = prompt.slice(
      prompt.indexOf("<mnemo-memory-rubric"),
      prompt.indexOf("</mnemo-memory-rubric>") + "</mnemo-memory-rubric>".length,
    );
    const sessionStartRubric = sessionStartBlock.slice(
      sessionStartBlock.indexOf("<mnemo-memory-rubric"),
      sessionStartBlock.indexOf("</mnemo-memory-rubric>") + "</mnemo-memory-rubric>".length,
    );
    expect(promptRubric).toBe(sessionStartRubric);
    expect(promptRubric).toBe(rubricOnly);
    expect(promptRubric).toContain(MEMORY_RUBRIC_TEXT);

    db.close();
  });

  test("duty 3 (SESSION NARRATIVE, ticket 09) instructs the session-addressed note call, distinct from duty 4 (COMMIT)", () => {
    const db = createDatabase(":memory:");
    initializeSchema(db);
    const seededSessionId = upsertSession(db, {
      contentSessionId: "duty-3-session",
      project: "/tmp/project-duty-3",
      title: "duty 3 fixture",
      content: null,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;
    db.query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, 1, 'active', ?, ?, 1, ?) RETURNING id`,
    ).get(seededSessionId, "prompt 1", "response 1", NOW - 1_000);
    enqueueNoteSettlementWindows(
      db,
      [{ sessionId: seededSessionId, windowStart: 1, windowEnd: 1, triggerType: "consecutive" }],
      NOW,
      SETTLEMENT_ERA_CUTOFF_EPOCH,
    );
    const job = claimNextNoteSettlementJob(db, seededSessionId, NOW, NOW * 1000)!;
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const prompt = renderPromptFor(context, db);

    expect(prompt).toContain("SESSION NARRATIVE");
    expect(prompt).toContain(`"S${seededSessionId}"`);
    expect(prompt).toContain("never task");
    expect(prompt).toContain("still empty");
    expect(prompt.indexOf("SESSION NARRATIVE")).toBeLessThan(prompt.indexOf("4. COMMIT"));

    // Ticket 07 (write-mode-edit-semantics spec D12): the prompt teaches the
    // SHARED mode vocabulary for both write duties, and no longer teaches the
    // difference it used to ("there is no append here") — that difference no
    // longer exists.
    expect(prompt).toContain('mode.<field>: "write"');
    expect(prompt).toContain('{ mode: "edit", oldString, newString }');
    expect(prompt.toLowerCase()).not.toContain("no append");

    // Ticket 07, Block D1: appended to this same duty — a run may narrate
    // only writes that actually landed, never an inferred count or a
    // `lane_check` range claimed fully conforming without a receipt.
    expect(prompt).toContain(
      "Narrate only writes that actually landed in this run: never infer counts",
    );
    expect(prompt).toContain("or claim a range fully conforming from `lane_check` — use successful");
    expect(prompt).toContain("tool receipts, or omit the claim.");
    expect(prompt.indexOf("narratively new may skip this duty entirely.")).toBeLessThan(
      prompt.indexOf("Narrate only writes that actually landed"),
    );
    expect(prompt.indexOf("Narrate only writes that actually landed")).toBeLessThan(
      prompt.indexOf("4. COMMIT"),
    );

    db.close();
  });
});

/**
 * Ticket 04 ([S15069/T963]): lookback = window size. Tag-mandate ticket 06
 * kept the SIZING rule and retired the rendering it used to feed — so the
 * same fixture now proves the scope reaches T26-T75 by reading the DECLARED
 * writable set rather than a rendered turn section.
 */
describe("ticket 04 — lookback scales with the window; ticket 06 declares it instead of rendering it", () => {
  test("a 25-turn window declares 25 preceding turns plus its own 25, 50 in total", () => {
    const sessionDbId = seedSession();
    // 75 turns total: 1-50 lookback material, 51-75 the window itself. A
    // 25-turn window's default lookback is exactly its own size (25), so it
    // should reach back to prompt 26, not further (turns 1-25 stay out of
    // reach) and not less (turn 50 must be included).
    for (let promptNumber = 1; promptNumber <= 75; promptNumber += 1) {
      seedTurn(sessionDbId, promptNumber);
    }
    const job = claimWindow(sessionDbId, 51, 75);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    expect(context.windowTurns).toHaveLength(25);
    expect(context.priorTurns).toHaveLength(25);
    expect(context.priorTurns[0]!.promptNumber).toBe(26);
    expect(context.priorTurns.at(-1)!.promptNumber).toBe(50);
    expect(context.windowTurns[0]!.promptNumber).toBe(51);
    expect(context.windowTurns.at(-1)!.promptNumber).toBe(75);
    // reviewableTurnIds is exactly the 50 in-scope turns — no more, no less.
    expect(context.reviewableTurnIds.size).toBe(50);

    const prompt = renderPromptFor(context);
    // The two retired section captions, and the unified one that replaced
    // them, are all gone: there is no turn section at all any more.
    expect(prompt).not.toContain("## Turns");
    expect(prompt).not.toContain("Preceding turns");
    expect(prompt).not.toContain("Window turns (settle exactly these)");

    const block = prompt.slice(
      prompt.indexOf("WRITABLE SET:"),
      prompt.indexOf("## Duties"),
    );
    expect(block).toContain("window — settle these (25):");
    expect(block).toContain("declared lookback — equally writable (25):");
    for (let promptNumber = 26; promptNumber <= 75; promptNumber += 1) {
      expect(block).toContain(`S${sessionDbId}/T${promptNumber}`);
    }
    // T25 is out of reach — and the check has to be anchored, since
    // "S1/T25" is a prefix of "S1/T250" and of nothing else here.
    expect(block).not.toMatch(new RegExp(`S${sessionDbId}/T25(?![0-9])`));
  });
});

/**
 * Ticket 04 (edge-mechanism-revision D7): the settlement-specific half of the
 * prompt. Four things the shared rubric cannot say, plus the two retirements
 * whose WORDING must not outlive them.
 */
describe("ticket 04 — the settlement prompt's own four sections (D7)", () => {
  test("task framing, authority, procedure and commit are all present, in that order", () => {
    const prompt = renderPrompt();

    // Hindsight task frame: check OR rebuild; a backfill window rebuilds from
    // zero (the acceptance criterion's own words).
    expect(prompt).toContain("HINDSIGHT pass over this window");
    expect(prompt).toContain("Check or rebuild the notes");
    expect(prompt).toContain("rebuild FROM ZERO");
    // Authority statement.
    expect(prompt).toContain("## Your authority");
    expect(prompt).toContain("main agent's own write surface");
    // Procedure (ticket 07): the batched workstations replaced the old
    // supply/correct/retract triad — see the Block A describe below for the
    // full pin set.
    expect(prompt).toContain("## Procedure");
    expect(prompt).toContain("Work the WHOLE writable set in chronological batches of ten turns");
    expect(prompt).toContain("BATCH STEP 1 — TURN AUDIT");
    expect(prompt).toContain("BATCH STEP 2 — CONTENT CANDIDATES");
    expect(prompt).toContain("BATCH STEP 3 — BACK-LINK");
    // Commit as the terminal check, last.
    expect(prompt.indexOf("## Your task")).toBeLessThan(prompt.indexOf("## Your authority"));
    expect(prompt.indexOf("## Your authority")).toBeLessThan(prompt.indexOf("## Procedure"));
    expect(prompt.indexOf("## Procedure")).toBeLessThan(prompt.indexOf("4. COMMIT"));
  });

  test("the shared rubric block is still what the prompt teaches judgment from", () => {
    const prompt = renderPrompt();

    // The hash guard's own block, byte-identical with the SessionStart
    // injection's (pinned in full by the describe above this one).
    expect(prompt).toContain(renderMemoryRubricBlock());
    expect(prompt).toContain('hash="');
  });
});

/**
 * Ticket 01 (semantic-conformance spec, ruling [S15069/T1396]): the
 * RECONCILIATION duty's preamble states the two-branch split — MISSING or
 * NON-CONFORMING annotations are re-annotated from scratch, exactly as a
 * first writer would judge them today; CONFORMING annotations keep the
 * existing check/correct/supplement discipline. Job 76 left 82/96
 * legacy-typed turns untouched because the old prompt read them as
 * keepable standing content once a window was "already written" — every
 * assertion below is pinned as a substring INSIDE duty 2 itself (not
 * merely present somewhere in the prompt), because the ticket's own
 * deliverable is duty 2's framing, not a free-floating sentence.
 */
describe("ticket 01 — RECONCILIATION states re-annotate-non-conforming / check-correct-supplement-conforming", () => {
  function duty2Text(prompt: string): string {
    return prompt.slice(
      prompt.indexOf("2. RECONCILIATION"),
      prompt.indexOf("   - notes: `note` with `turn` plus `title`"),
    );
  }

  test("the MISSING/NON-CONFORMING branch: re-annotate from scratch, as a first writer would, not a correction", () => {
    const prompt = renderPrompt();
    const duty2 = duty2Text(prompt);

    expect(duty2).toContain("MISSING");
    expect(duty2).toContain("NON-CONFORMING");
    expect(duty2).toContain("RE-ANNOTATED FROM SCRATCH");
    expect(duty2).toContain("as a first writer would today");
    expect(duty2).toContain("the old word being retired IS the nonconformity");
    expect(duty2).toContain("not a mistake to");
  });

  test("the CONFORMING branch keeps the existing check/correct/supplement discipline", () => {
    const prompt = renderPrompt();
    const duty2 = duty2Text(prompt);

    expect(duty2).toContain("CONFORMING");
    expect(duty2).toContain("keeps the ordinary discipline");
    expect(duty2).toContain(
      "correct the explicit, supplement what is missing, leave doubt alone",
    );
  });

  test("the closed vocabulary is NAMED as the conformance test for `type`, not restated", () => {
    const prompt = renderPrompt();
    const duty2 = duty2Text(prompt);

    expect(duty2).toContain("conformance means every word is a member of the closed vocabulary");
    // Pointer discipline: duty 2's OWN prose never repeats the word list or
    // its definitions — those stay the Rubric's one copy. (The words do
    // appear elsewhere in the full prompt, inside the injected Rubric
    // block itself — this checks duty 2's own added prose only.)
    for (const word of MEMORY_TYPES) {
      expect(duty2).not.toContain(`"${word}"`);
    }
  });

  test("the split is uniform across window kinds — no backfill/check special-casing", () => {
    const prompt = renderPrompt();
    const duty2 = duty2Text(prompt);

    expect(duty2).toContain("follows the SAME rule on every window, backfill or check");
    // The pre-era gate (`allow_pre_era`) and its wording live entirely in
    // the worker's job-claiming path (db/note-settlement.ts, server.ts),
    // never in this prompt — nothing here special-cases it, so there is
    // nothing to name or exclude.
    expect(prompt).not.toContain("pre-era");
    expect(prompt).not.toContain("allow_pre_era");
  });
});

/**
 * ticket 07 (spec "settlement agent — batched procedure"): `lane_check`
 * moves OUT of the Procedure section entirely — Block A now forbids calling
 * it during the batch loop, and it is instead the last of Block B's five
 * relation steps (CHECK AND REPAIR, pinned by the edges-bullet describe
 * above). rubric-v10 ticket 06's old advisory sentence (a Procedure-area
 * call the agent might make once, after its own first pass) retires with
 * the per-window shape it belonged to.
 */
describe("ticket 07 — lane_check is forbidden inside the batch loop; the check lands in Block B instead", () => {
  test("the procedure forbids calling lane_check during the batch loop", () => {
    const prompt = renderPrompt();
    const procedure = prompt.slice(prompt.indexOf("## Procedure"), prompt.indexOf("## Duties"));

    expect(procedure).toContain("Do not call `lane_check` during the");
    expect(procedure).toContain("batch loop.");
  });

  // ABSENCE pin: the retired per-window advisory sentence and the retired
  // supply/correct/propose routing phrase it used must not survive.
  test("the retired per-window lane_check advisory sentence is gone", () => {
    const prompt = renderPrompt();
    const procedure = prompt.slice(prompt.indexOf("## Procedure"), prompt.indexOf("## Duties"));

    expect(procedure).not.toContain("this window's own scope and route");
    expect(procedure).not.toContain("supply/correct/propose");
    expect(procedure).not.toContain("never a write obligation on its own");
  });

  test("no pre-existence fence and no differential wording survives anywhere", () => {
    const prompt = renderPrompt();

    // The retired C7 fence.
    expect(prompt).not.toContain("must already be a pair that existed");
    expect(prompt).not.toContain("before this run started");
    expect(prompt).not.toContain("not eligible for a relation");
    // The retired "settlement is the surface that lacks things" framing.
    expect(prompt.toLowerCase()).not.toContain("no append");
    expect(prompt).not.toContain("no longer settlement's to write");
    expect(prompt).not.toContain("the main agent is the note's sole writer");
    expect(prompt).not.toContain("RE-CHECK, not a first write");
  });

  // Tag-mandate ticket 06: the retraction mirrors are no longer ENUMERATED
  // (`retractOverride/retractNarrows/…`, derived from `EDGE_RELATIONS`). The
  // authored edges bullet states them as a PATTERN plus the one fact the
  // enumeration never carried — that they still accept bare addresses, which
  // is what keeps a legacy untagged row deletable at all once the assertion
  // side went tagged-only. Both halves pinned.
  test("the prompt teaches the retraction mirrors and the membership create verb", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("The\n     `retract<Relation>` mirrors delete one row each and still accept bare");
    expect(prompt).toContain("addresses (legacy rows stay deletable)");
    expect(prompt).toContain('`action="create"`');
    expect(prompt).toContain("joining an existing segment beats opening");
  });

  // Indexes-rescope ticket 04: the edge vocabulary this prompt states named
  // `indexes`, and the rejection examples beside it named a check that law 2
  // retired (an out-of-branch collects target no longer fails anything). Both
  // halves are still pinned — the word must appear, and no retired word may
  // survive in the prose around it, where it would teach settlement to avoid
  // legal calls. Ticket 06 note: the word list is authored prose now rather
  // than a render of `EDGE_RELATIONS`, so this test is the guard that a
  // vocabulary change actually reached the bullet.
  test("the prompt speaks indexes and states no retired rejection", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("indexes");
    // The authored bullet's own field list, exact — a relation dropped from
    // it (or a retired one re-added) fails here.
    expect(prompt).toContain(
      "`note`'s override/narrows/extends/consume/indexes/grounds/\n     verifies/refutes fields",
    );
    expect(prompt).not.toContain("collects");
    expect(prompt).not.toContain("out-of-branch");
  });

  // The prompt sends settlement to the rubric BY SECTION NAME, and those names
  // are prose on this side and a heading on the other — nothing linked them.
  // The v6 full-English ruling renamed the headings while this prompt kept
  // pointing at 关系/归属, so for three releases it named sections the rubric no
  // longer had: a reader following the pointer finds nothing and falls back to
  // instinct, which is the silent half of a teaching bug. Every section this
  // prompt names must exist as a real heading.
  test("every rubric section the prompt points at is a real heading in the rubric", () => {
    const prompt = renderPrompt();
    const headings = [...MEMORY_RUBRIC_TEXT.matchAll(/^## (\S+)/gm)].map(
      (match) => match[1],
    );
    expect(headings.length).toBeGreaterThan(0);

    // Only the two pointer FORMS the prompt uses to send a reader to a
    // heading — "the Rubric's <X> section" / "the Rubric's own <X> checklist".
    // Prose that merely names the rubric ("shared with the main agent's…") is
    // not a pointer and must not be swept in.
    const referenced = [
      ...prompt.matchAll(/Memory Rubric'?s(?: own)? (\S+) (?:section|checklist)/g),
    ].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(0);

    for (const name of referenced) {
      expect(headings).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// The stitch (read-write-contract, ticket 07's deferred half): the session
// summary renders through the UNIFIED renderer at sole-writer budgets, and
// that render is itself the read grant the narrative write consumes.
// ---------------------------------------------------------------------------

describe("stitch — the session summary is the unified renderer's full-document view", () => {
  test("a >2000-token narrative renders whole, and the render grants the session to the claim writer", () => {
    const longContent = Array.from({ length: 2_500 }, (_, i) => `sentence${i}`).join(" ");
    const sessionDbId = upsertSession(db, {
      contentSessionId: "settlement-stitch-session",
      project: "/tmp/project-settlement-stitch",
      title: "stitch fixture",
      content: longContent,
      insight: null,
      createdAtEpoch: NOW - 10_000,
      updatedAtEpoch: NOW - 10_000,
      completedAtEpoch: null,
    }).id;
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;

    // Whole document, no elision marker, no recall pointer the settlement
    // agent could not follow anyway.
    expect(context.sessionStateRendering).toContain("sentence2499");
    expect(context.sessionStateRendering).not.toContain("state truncated");

    const grant = db
      .query<{ count: number }, [string, number]>(
        "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = ? AND entity_type = 'session' AND entity_id = ?",
      )
      .get(claimWriterId(job.id, job.claimGeneration), sessionDbId);
    expect(grant?.count).toBe(1);
  });
});

/**
 * ticket 07, Block D2: the output tail's old no-op exemption clause
 * ("(or if you are certain there is nothing to do)") retires — a REFUSED
 * `commit` is still a commit call, so that wording let a run treat its own
 * refusal as the exit. The replacement restates Block C's own rule at the
 * output boundary: certainty that nothing changed still requires an
 * empty-handed successful commit.
 */
describe("ticket 07 — Block D2 replaces the output tail's no-op exemption clause", () => {
  function outputText(prompt: string): string {
    return prompt.slice(prompt.indexOf("## Output"));
  }

  test("commit succeeds unconditionally before the short-reply rule, and certainty still requires a commit", () => {
    const output = outputText(renderPrompt());

    expect(output).toContain("After `commit` succeeds, ");
    expect(output).toContain("a short final reply is enough — no JSON, no schema. Certainty that ");
    expect(output).toContain("nothing changed still requires an empty-handed successful commit.");
  });

  // ABSENCE pin (ticket 07, retired teaching #3): the no-op commit
  // exemption clause is gone, so a future merge cannot resurrect the
  // reading that let a run skip `commit` entirely.
  test("the retired no-op commit exemption clause is gone", () => {
    const output = outputText(renderPrompt());

    expect(output).not.toContain("or if you are certain there is nothing to do");
  });
});

describe("ticket 06/07 — the authored text integrates VERBATIM, every word (acceptance guard)", () => {
  // The blocks in .scratch/tag-mandate/issues/06-prompt-text.md are the main
  // agent's personally authored settlement teaching (ruling T1452: never
  // delegated, never paraphrased). The sampled-substring pins above cannot
  // catch a one-word drift between pins — this guard word-normalizes both
  // sides and requires each block to appear as ONE contiguous word sequence
  // in the rendered prompt. Same .scratch-fixture precedent as the
  // rubric-v10 golden.
  const words = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");

  function readAuthoredSections(): string[] {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const authored = readFileSync(
      new URL("../../.scratch/tag-mandate/issues/06-prompt-text.md", import.meta.url),
      "utf8",
    );
    return authored.split(/^## Block /m).slice(1);
  }

  test("revision 7 authors exactly four blocks (A, B, C, D)", () => {
    expect(readAuthoredSections().length).toBe(4);
  });

  test("blocks A, B and C each appear as contiguous word sequences", () => {
    const sections = readAuthoredSections().slice(0, 3);
    const prompt = words(renderPrompt());
    for (const section of sections) {
      // Drop the heading line and, for block A, the placeholder tail.
      const body = section
        .slice(section.indexOf("\n") + 1)
        .replace(/WRITABLE SET:\s*\{WRITABLE_SET\}\s*$/m, "")
        .trim();
      expect(body.length).toBeGreaterThan(0);
      const needle = words(body);
      expect(prompt.includes(needle)).toBe(true);
    }
  });

  // Block D packages TWO separate insertion points (D1 into duty 3, D2
  // replacing the output tail) under one heading, so — unlike A/B/C — its
  // own body is never one contiguous span in the rendered prompt. Each
  // sentence is extracted and checked as its own contiguous word sequence
  // instead; the "D1, appended to..." / "D2, replacing..." labels are
  // integration notes, never prompt text, so they are excluded on purpose.
  test("block D's two sentences (D1, D2) each appear as contiguous word sequences", () => {
    const dSection = readAuthoredSections()[3]!;
    const d1Match = dSection.match(
      /D1, appended to the session-narrative duty:\n\n([\s\S]*?)\n\nD2,/,
    );
    const d2Match = dSection.match(
      /D2, replacing the output tail's exemption clause:\n\n([\s\S]*)$/,
    );
    expect(d1Match).not.toBeNull();
    expect(d2Match).not.toBeNull();

    const prompt = words(renderPrompt());
    expect(prompt.includes(words(d1Match![1]!.trim()))).toBe(true);
    expect(prompt.includes(words(d2Match![1]!.trim()))).toBe(true);
  });
});

/**
 * Ticket 01, light-review-repairs (peer P1-1): the system half's "Work
 * entirely through the ... tools" sentence used to name only
 * remember/note/commit — three of the six tools the child process is actually
 * registered with (`SETTLEMENT_ALLOWED_TOOLS`, note-settlement-sdk-query.ts).
 * Since system instructions win over the user half, a compliant agent could
 * refuse the very `recall` (Block A, every batch) and `lane_check` (Block B
 * step 5) calls the user half now mandates.
 *
 * The guard: mechanically extract every backtick-quoted, single-word token
 * from the RENDERED USER HALF that is also a real registered tool name (the
 * same `SETTLEMENT_ALLOWED_TOOLS` list, not a hand-copied one), then assert
 * each one is a member of the system sentence's own slash-separated
 * allowlist. This is what makes the two contracts unable to drift apart
 * silently again: widen what the user half instructs calling without
 * widening the system sentence, and this test goes red.
 */
describe("ticket 01 (peer P1-1) — cross-contract superset guard: system sentence permits every tool the user half instructs calling", () => {
  const KNOWN_TOOL_NAMES = new Set(
    SETTLEMENT_ALLOWED_TOOLS.map((name) => name.replace("mcp__mnemo__", "")),
  );

  /** Every backtick-quoted single word that is also a real registered tool name. */
  function extractInstructedToolNames(text: string): Set<string> {
    const found = new Set<string>();
    for (const match of text.matchAll(/`([a-zA-Z_]+)`/g)) {
      if (KNOWN_TOOL_NAMES.has(match[1]!)) {
        found.add(match[1]!);
      }
    }
    return found;
  }

  test("the extraction itself still finds every registered tool (guards the guard against silently degrading)", () => {
    const calledTools = extractInstructedToolNames(renderPrompt());
    expect(calledTools).toEqual(KNOWN_TOOL_NAMES);
  });

  test("every tool the user half instructs calling, by name, is in the system sentence's allowlist", () => {
    const calledTools = extractInstructedToolNames(renderPrompt());
    expect(calledTools.size).toBeGreaterThan(0);

    const allowlistMatch = NOTE_SETTLEMENT_SYSTEM_PROMPT.match(
      /Work entirely through the ([a-zA-Z_/]+) tools/,
    );
    expect(allowlistMatch).not.toBeNull();
    const allowlistedTools = new Set(allowlistMatch![1]!.split("/"));

    // Superset, not equality: a tool the system half permits but the user
    // half happens not to name in this fixture is not a contract violation.
    for (const tool of calledTools) {
      expect(allowlistedTools.has(tool)).toBe(true);
    }
  });

  test("the system sentence's allowlist is exactly the six registered tools", () => {
    const allowlistMatch = NOTE_SETTLEMENT_SYSTEM_PROMPT.match(
      /Work entirely through the ([a-zA-Z_/]+) tools/,
    );
    expect(allowlistMatch).not.toBeNull();
    const allowlistedTools = new Set(allowlistMatch![1]!.split("/"));
    expect(allowlistedTools).toEqual(KNOWN_TOOL_NAMES);
  });
});
