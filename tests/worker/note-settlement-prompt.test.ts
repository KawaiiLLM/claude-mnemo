import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { insertLane } from "../../src/db/lanes";
import { deriveSideTags, writeMemoryEdges } from "../../src/db/memory-edges";
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
import { DEFAULT_TURN_TOKEN_BUDGET } from "../../src/mcp/format";
import {
  MEMORY_RUBRIC_CONCEPTS_TEXT,
  MEMORY_RUBRIC_MAIN_ACTIONS_TEXT,
  renderMainAgentRubricBlock,
  renderMemoryRubricConceptsBlock,
} from "../../src/shared/memory-rubric";
import { MEMORY_TYPES } from "../../src/shared/type-vocabulary";
import { SETTLEMENT_NOTE_TOOL_DESCRIPTION } from "../../src/worker/note-settlement-sdk-query";
import { SETTLEMENT_LANE_ACTIONS } from "../../src/worker/note-settlement-membership-facade";
import {
  buildNoteSettlementContext,
  resolveSettlementWritableSet,
  type NoteSettlementContext,
} from "../../src/worker/note-settlement-context";
import {
  NOTE_SETTLEMENT_SYSTEM_PROMPT,
  renderNoteSettlementPrompt,
} from "../../src/worker/note-settlement-prompt";
import { renderEdgePassTeaching } from "../../src/worker/note-settlement-edge-pass-teaching";
import { buildSettlementWorklistRendering } from "../../src/worker/note-settlement-shape-numbers";
import {
  SETTLEMENT_ALLOWED_TOOLS,
  SETTLEMENT_NOTE_TOOL_DESCRIPTION,
} from "../../src/worker/note-settlement-sdk-query";
import {
  IMPRESSION_GOLDEN_SAMPLE_FULL,
  IMPRESSION_GOLDEN_SAMPLE_THIN,
  renderImpressionTeaching,
} from "../../src/worker/note-settlement-impression-teaching";
import { renderSettlementImpressionAdvisoryBlock } from "../../src/worker/note-settlement-impressions";
import { SETTLEMENT_ERA_CUTOFF_EPOCH } from "../support/settlement-config";
import { wordEdgeClass } from "../support/edge-row-fixtures";

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
    // Ticket 08: the worklist is no longer optional, because the rendering
    // without one WAS the single-pass prompt. These fixtures freeze nothing, so
    // they get the empty worklist a transition-only stage 1 leaves behind.
    buildSettlementWorklistRendering(database, context.job.id),
  );
}

describe("lane-impressions ticket 02 — the writing law AND the coordinates ship in the resume prompt", () => {
  test("the frozen teaching and both golden samples are present", () => {
    const prompt = renderPrompt();
    expect(prompt).toContain(renderImpressionTeaching());
    expect(prompt).toContain(IMPRESSION_GOLDEN_SAMPLE_FULL);
    expect(prompt).toContain(IMPRESSION_GOLDEN_SAMPLE_THIN);
  });

  test("the advisory block the dispatch computes reaches the prompt verbatim", () => {
    const sessionDbId = seedSession();
    const turnId = seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const advisory = renderSettlementImpressionAdvisoryBlock(db, job.id, new Set([turnId]));
    const prompt = renderNoteSettlementPrompt(
      context,
      resolveSettlementWritableSet(
        db,
        context,
        computeSettlementWritableTurnIds(db, context.reviewableTurnIds),
      ),
      buildSettlementWorklistRendering(db, job.id),
      advisory,
    );
    expect(prompt).toContain("## Impression containers you owe a judgment on");
    expect(prompt).toContain(advisory);
  });
});

/** A rendered prompt over a one-turn window, with whatever segments the test seeded first. */
function renderPrompt(): string {
  const sessionDbId = seedSession();
  seedTurn(sessionDbId, 1);
  const job = claimWindow(sessionDbId, 1, 1);
  const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
  return renderPromptFor(context);
}

/**
 * Lane-model-v12 ticket 15 (spec D3d): the Duties section is a CLOSED list,
 * and no segment verb is on it — the three membership verbs retired with that
 * ticket, so their teaching is gone from the prompt rather than contradicted
 * somewhere else in it: a prompt that still asked for a `propose` would be
 * asking for a schema rejection.
 *
 * TICKET 22 (user ruling 2026-08-26) moved the COUNT from two to three by
 * restoring SESSION FIELDS, the duty ticket 15 deleted while leaving its write
 * surface live. The closed-list property is what this describe pins, not the
 * number: the list is exactly {turn fields, lanes, session fields}, and a
 * segment is still not on it.
 */
describe("tickets 15/22 — the duties are exactly two, and none of them is a segment", () => {
  test("the preamble names the two, and says membership is a tags write rather than a further duty", () => {
    const prompt = renderPrompt();
    const duties = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("## Task roster"));

    // FINAL REVIEW, FINDING 1 left three: EDGES, a severed lane's disposition,
    // and the session's own fields. SETTLEMENT-GATE-TAXONOMY TICKET 06 removed
    // the middle one — `remember(justify)` retired with the gate it answered,
    // and this pass holds no lane tool at all — so the list is two.
    expect(duties).toContain(
      "Two things, and nothing else: the EDGES of the turns in your writable",
    );
    expect(duties).toContain("set, and this SESSION's own two fields.");
    expect(duties).toContain("it holds no lane tool at all.");
    // Exactly two numbered duties, and they are these two.
    expect([...duties.matchAll(/^\d+\. [A-Z]/gm)].map((match) => match[0])).toEqual([
      "1. T",
      "2. S",
    ]);
    expect(duties).toContain("1. TURN EDGES, via the `note` tool");
    expect(duties).toContain("2. SESSION FIELDS — this session's own `title` and `content`, via the");
    // The retired duty's own heading, absent — a re-add cannot pass quietly.
    expect(duties).not.toContain("A SEVERED LANE'S DISPOSITION");
  });

  test("the retired verbs and the proposal teaching are GONE from the prompt, not merely contradicted", () => {
    const prompt = renderPrompt();

    expect(prompt).not.toContain('action="propose"');
    expect(prompt).not.toContain('action="reassign"');
    expect(prompt).not.toContain('action="create"');
    expect(prompt).not.toContain('action="assign"');
    expect(prompt).not.toContain("PROPOSALS, via the `remember` tool");
    expect(prompt).not.toContain("TEXT-ONLY suggestion");
    expect(prompt).not.toContain("homeless turn may open its own proposal");
    expect(prompt).not.toContain("attaches it to this session");
    // The pre-ticket-05 wording stays gone too.
    expect(prompt).not.toContain("A SEGMENT IS ONE ARC");
    expect(prompt).not.toContain("SEGMENT LIFECYCLE");
    expect(prompt).not.toContain("TURN REVIEW");
    expect(prompt).not.toContain("RECONSTRUCTION");
  });

  // FINAL REVIEW, FINDING 1 left duty 2 one action wide (`justify`);
  // SETTLEMENT-GATE-TAXONOMY TICKET 06 took the action and the duty with it.
  // What this test pins is unchanged in kind: no lane VERB is taught anywhere
  // in this prompt, because teaching a verb the pass cannot call is how a run
  // learns to grind at a refusal it cannot read.
  test("no lane verb is taught to this pass at all, and the registry's own call shapes are absent", () => {
    const prompt = renderPrompt();

    expect(prompt).not.toContain("`justify`");
    expect(prompt).not.toContain("remember(justify");
    expect(prompt).not.toContain("`remember` tool");
    // The declaration criteria and every registry call shape: gone from the
    // WHOLE prompt.
    expect(prompt).not.toContain("`create`: `id` (an open");
    expect(prompt).not.toContain("`merge`: `id` + `tag` (the lane that goes away)");
    expect(prompt).not.toContain("`delete`: `id` + `tag`.");
    expect(prompt).not.toContain("判据 —— 一条被声明的泳道应当满足两条");
    expect(prompt).not.toContain("FORM LANES");
  });
});

/**
 * Lane-model-v12 TICKET 22 (user ruling 2026-08-26: "session 结算也可以顺便维护
 * 了"). Ticket 15 deleted the session duty but not the write surface behind it
 * (`evaluateSettlementSessionWrite` still parses `note(session=…)` and writes
 * `["title", "content"]`), leaving a capability nothing instructed. This
 * describe pins the restoration and the ONE thing that must not come back with
 * it.
 */
describe("ticket 22 — settlement maintains this session's own fields again", () => {
  test("the session duty is its title and content, addressed by this session's own S-id", () => {
    const prompt = renderPrompt();
    const duties = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("## Task roster"));
    const duty3 = duties.slice(duties.indexOf("2. SESSION FIELDS"));

    // The duty exists, names BOTH fields (the ruling guessed "好像就一个
    // title"; the facade's own `sessionFields` is title + content), and is
    // ordered last.
    expect(duty3).toContain("2. SESSION FIELDS — this session's own `title` and `content`, via the");
    expect(duties.indexOf("1. TURN EDGES")).toBeLessThan(duties.indexOf("2. SESSION FIELDS"));

    // It addresses THIS session, by the same id the prompt's own header
    // declares — a duty naming some other session would be instructing a call
    // the facade refuses ("is not this dispatch's own session").
    const headerSessionId = prompt.match(/^# Settlement window S(\d+)\//m)?.[1];
    expect(headerSessionId).toBeDefined();
    expect(duty3).toContain(`\`note\` tool's \`session\` field (this session, "S${headerSessionId}")`);
    expect(duty3).toContain("instead of `turn`; those two fields only, and no other session's.");

    // The maintenance rules that make the duty followable rather than merely
    // present: what content is for, and when title is touched.
    expect(duty3).toContain("`content` is a CONVERSATIONAL increment");
    expect(duty3).toContain("never task state (that state belongs to the task, not the");
    expect(duty3).toContain("`title` is set only when it is still empty");
    expect(duty3).toContain("narratively new may skip this duty entirely.");

    // The prompt and the tool description state the same two fields — a duty
    // asking for a field the call refuses is the drift this pair prevents.
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).toContain(
      "On `session`: `title`/`content` only — type/tags/edges are refused.",
    );
  });

  test("the retired FALSE heading does not come back with the duty", () => {
    const prompt = renderPrompt();

    // Ticket 15 was right about this half: the session summary is NOT one of
    // the five SessionStart blocks (spec D3f leaves roster / segment cards /
    // rubric / persona), so the old parenthetical asserted something untrue
    // about who reads the field. The corrected heading stands.
    expect(prompt).toContain("## Session summary (this session's stored narrative)");
    expect(prompt).not.toContain(
      "## Session summary (the block the main agent is shown at SessionStart)",
    );
    // Absence of the CLAIM, not just of that exact heading string: no wording
    // anywhere in the prompt may tell this pass the summary is injected.
    expect(prompt).not.toContain("shown at SessionStart");
    expect(prompt).not.toContain("the block the main agent is shown");
  });
});

describe("commit is never gated on membership (ticket 05/06)", () => {
  test("the prompt states commit finishes the window regardless of whether anything was written", () => {
    const prompt = renderPrompt();

    // Ticket 15 moved the whole commit contract into the Duties PREAMBLE:
    // `commit` writes nothing, and a list of two writes is the wrong place for
    // it. Nothing about the contract itself changed.
    expect(prompt).toContain(
      "`commit` does not write anything itself — it verifies your job lease is",
    );
    expect(prompt).toContain(
      "needs an empty-handed `commit` to finish cleanly — for an already-settled",
    );
    expect(prompt).toContain("window that is the common case, not an error.");
    expect(prompt).not.toContain("4. COMMIT.");
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
    expect(prompt).toContain("(no tasks attached to this session)");
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
    // Ticket 15 added the segment's own TAG: membership is derived from it, so
    // an agent told to correct membership by writing a word has to be shown
    // the word. Everything else the old roster refused to carry stays refused.
    expect(context.segmentRoster).toEqual([
      { id: segment.id, title: "fencing the claim", tag: null, lanes: [] },
    ]);

    const prompt = renderPromptFor(context);
    const roster = prompt.slice(prompt.indexOf("## Task roster"));
    expect(roster).toContain(`[E${segment.id}] fencing the claim — tag: (unnamed)`);
    // The old full-field render is gone — content/insight never reach this prompt.
    expect(roster).not.toContain("the working state");
    expect(roster).not.toContain("a generation check beats a timestamp");
    expect(prompt).not.toContain("content: the working state");
  });

  /**
   * PEER REVIEW A5 — the roster carries the DECLARED LANE REGISTRY.
   *
   * Two closed vocabularies decide whether a `tags` write is legal, and the
   * settlement prompt used to name only one of them. The registry cannot be
   * recovered from anywhere else this agent can see: lane tags left the segment
   * card in lane-model-v12 ticket 18 for the MAIN agent's SessionStart roster
   * row, and a PROVISIONAL lane — 0 or 1 member, legal by construction — has no
   * edge for the lane checker to surface it through. Without the registry,
   * `remember(declare)`'s own "continue an existing lane first" instruction has
   * no readable input.
   */
  test("a PROVISIONAL lane — declared, zero members, zero edges — reaches the prompt by name", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, {
      title: "the container",
      tags: ["container"],
      nowEpoch: NOW - 4_000,
    });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW - 4_000);
    // Neither lane has a member turn or an edge; both are legal, and the
    // registry is the only thing that knows they exist.
    insertLane(db, segment.id, "write-gate", NOW - 3_000);
    insertLane(db, segment.id, "backfill", NOW - 3_000);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    // Registry order — alphabetical, a word list to pick from, not a feed.
    expect(context.segmentRoster).toEqual([
      {
        id: segment.id,
        title: "the container",
        tag: "container",
        lanes: ["backfill", "write-gate"],
      },
    ]);

    const prompt = renderPromptFor(context);
    const roster = prompt.slice(prompt.indexOf("## Task roster"));
    expect(roster).toContain(`[E${segment.id}] the container — tag: container`);
    expect(roster).toContain("declared lanes: backfill · write-gate");
  });

  test("a segment with no lane declared says so, rather than dropping the row", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const segment = createSegment(db, {
      title: "no lanes here",
      tags: ["lonely"],
      nowEpoch: NOW - 4_000,
    });
    attachSegmentToSession(db, sessionDbId, segment.id, NOW - 4_000);

    const prompt = renderPromptFor(buildNoteSettlementContext(db, job, { nowEpoch: NOW })!);
    expect(prompt.slice(prompt.indexOf("## Task roster"))).toContain(
      "declared lanes: (none declared yet)",
    );
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
          ...wordEdgeClass("extends"),
          provenance: "asserted",
          ...deriveSideTags([]),
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
 * MAIN-AGENT-EDGES TICKET 06 (spec D6; read-once D6 as rewritten) — THE
 * PROCEDURE IS THE SHARED EDGE PASS.
 *
 * Tag-mandate ticket 07's Block A (the writable set worked in chronological
 * ten-turn batches, three workstations per batch, a private open-thread
 * ledger, "do not call `lane_check` during the batch loop") and settlement-
 * ergonomics ticket 02's "before any edge write, run this call sequence"
 * bullet are RETIRED from the rendered prompt: each was a re-read the one
 * paginated read already pays for, and the ledger's DISPOSE step went with
 * the batches it summarised. What renders instead is the scope sentence (kept
 * byte-for-byte), one resume-specific read instruction, and the shared block
 * `renderEdgePassTeaching()` — pinned sentence by sentence in
 * `tests/worker/note-settlement-edge-pass-teaching.test.ts`. Here the pins
 * are the HOST's: the block is present verbatim inside `## Procedure`, and
 * the retired sentences are absent from the RENDERED text, not merely from
 * the source.
 */
describe("main-agent-edges ticket 06 — the procedure is the shared edge pass, and Block A's batch loop is gone", () => {
  function procedureText(prompt: string): string {
    return prompt.slice(prompt.indexOf("## Procedure"), prompt.indexOf("## Duties"));
  }

  test("the scope sentence states immutability and the gate's refusal", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("Your scope is the WRITABLE SET printed below");
    expect(procedure).toContain("It is immutable — reading never widens it, and every");
    expect(procedure).toContain("write must land inside it; the gate refuses the rest and names why.");
  });

  test("the resume read is ONE sweep over the writable set plus the context delta, and reading is still the write license", () => {
    const procedure = procedureText(renderPrompt());

    expect(procedure).toContain("This dispatch resumes a job whose stage-1 transition has already landed");
    expect(procedure).toContain("read the writable set below TOGETHER WITH the worklist's context delta as");
    expect(procedure).toContain("one paginated sweep");
    expect(procedure).toContain("Reading is your write license throughout: a whole-field `write`");
    expect(procedure).toContain("over another writer's text requires your own untruncated read of that");
    expect(procedure).toContain("field, and `timeline` licenses nothing.");
  });

  test("the shared edge-pass block renders verbatim inside the procedure, before the writable set", () => {
    const prompt = renderPrompt();
    const procedure = procedureText(prompt);
    const block = renderEdgePassTeaching();

    expect(procedure).toContain(block);
    expect(procedure.indexOf(block)).toBeLessThan(procedure.indexOf("WRITABLE SET:"));
    expect(procedure.indexOf("WRITABLE SET:")).toBeLessThan(procedure.indexOf("YOUR WORKLIST"));
  });

  test("the batch loop, the ledger and the per-edge relations read are absent from the rendered prompt", () => {
    const prompt = renderPrompt();
    for (const retired of [
      "batches of ten",
      "Batches bound working memory",
      "Do not call `lane_check` during the",
      "batch loop.",
      "BATCH STEP 1",
      "BATCH STEP 2",
      "BATCH STEP 3",
      "Recall every turn of this batch with",
      "private open-thread ledger",
      "Update the ledger",
      "before any edge write, run this call sequence",
      "read the citing turn's own edges with an EXPLICIT, large `turn`",
      "turn=2000)",
      "DISPOSE every ledger candidate",
      "JUDGE AND WRITE",
      "CHECK AND REPAIR",
      "All relation writes happen HERE, after the last batch",
    ]) {
      expect({ retired, present: prompt.includes(retired) }).toEqual({ retired, present: false });
    }
    // The fan-out lane route stays absent from the WHOLE prompt (settlement-
    // ergonomics ticket 02's one surviving absence pin): it takes no budget
    // parameter and is a candidate to blow the tool-result cap.
    expect(prompt).not.toContain("E<n>/L*");
    expect(prompt).not.toContain("/L*");
  });

  // ABSENCE pin (ticket 07, retired teaching #1): the old per-window
  // STEP-0-COVERAGE framing and its trailing "Reconcile what is stored..."
  // SUPPLY/CORRECT/RETRACT paragraph are both gone — pinned so a future merge
  // cannot resurrect either half independently.
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
 * MAIN-AGENT-EDGES TICKET 06 — duty 1 states the CALL SHAPES and the two
 * `lane_check`-warning teachings, and nothing the shared block already says.
 *
 * Tag-mandate ticket 06's edges bullet (a DRAFT that "does NOT survive
 * `commit`", the two-sided `{turn, tailTag, headTag}` placement, "each PLACED
 * side is checked against ITS OWN endpoint", DRAFT RECONCILIATION, and the
 * five-step pass) taught the stored-side model the resolver (spec D2) retired.
 * Pinned inside duty 1, where the agent reads them.
 */
describe("main-agent-edges ticket 06 — duty 1 teaches the bare entry, the coverage bit, `declare` and pair-addressed retraction", () => {
  function dutyOne(prompt: string): string {
    return prompt.slice(
      prompt.indexOf("1. TURN EDGES, via the `note` tool"),
      prompt.indexOf("2. SESSION FIELDS"),
    );
  }

  test("the duty names the three acts and defers the class judgment to the rubric", () => {
    const duty = dutyOne(renderPrompt());

    expect(duty).toContain("the DECLARE, FILL and REVIEW acts");
    expect(duty).toContain("the procedure above describes");
    expect(duty).toContain("Rubric's **三个关系类** entry above; this prompt states only the");
    expect(duty).toContain("call shape");
  });

  test("a lane side is the endpoint's own lane set, and an undeclarable side is a fact about the partition", () => {
    const duty = dutyOne(renderPrompt());

    expect(duty).toContain("a lane side is what an endpoint's own lane set decides");
    expect(duty).toContain("A side you cannot declare");
    expect(duty).toContain("since a lane's identity is (task, tag)");
    expect(duty).toContain("is a fact about the partition, not a tags write to make: leave the");
    expect(duty).toContain("side to derive, or retract the row.");
    expect(duty).not.toContain("write the member turns' tags first");
  });

  test("the entry forms are the ones the tool accepts: bare address, coverage on correct, declare riding the call", () => {
    const duty = dutyOne(renderPrompt());

    expect(duty).toContain("`note`'s correct/verify/use fields — the three-class");
    expect(duty).toContain('An entry is a bare address ("S15069/T7"); a `correct`');
    expect(duty).toContain('"coverage": "full" }` or `"partial"`. A `correct` without it is');
    expect(duty).toContain("refused naming the missing bit; a `verify` or `use` carrying one is");
    expect(duty).toContain("refused too.");
    expect(duty).toContain("`declare` entries ride the same call, after the edges it");
    expect(duty).toContain("writes, and are the only way a stored side moves");
    // The retired forms must not come back.
    expect(duty).not.toContain("a DRAFT");
    expect(duty).not.toContain("both sides UNSETTLED");
    expect(duty).not.toContain('"tailTag": "a", "headTag": "b"');
    expect(duty).not.toContain("does NOT survive `commit`");
    expect(duty).not.toContain("checked against ITS OWN endpoint");
    expect(duty).not.toContain('"tags": ["lane-tag"]');
    expect(duty).not.toContain("UNTAGGED edge acting on the cited turn itself");
  });

  test("retraction is taught by pair with the mirror's class as precondition", () => {
    const duty = dutyOne(renderPrompt());

    expect(duty).toContain("The `retractCorrect`/`retractVerify`/`retractUse`");
    expect(duty).toContain("mirrors delete the addressed PAIR's row, with the mirror's own class");
    expect(duty).toContain("as the precondition — a pair now carrying a different class refuses,");
    expect(duty).toContain("naming it.");
    expect(duty).not.toContain("addressed placement's row of that CLASS");
    expect(duty).not.toContain("legacy rows stay deletable");
  });

  test("the prompt's shape words agree with the settlement tool's own contract", () => {
    const duty = dutyOne(renderPrompt());
    for (const word of ["`declare`", "coverage", "retractCorrect"]) {
      expect({ word, inContract: SETTLEMENT_NOTE_TOOL_DESCRIPTION.includes(word) }).toEqual({
        word,
        inContract: true,
      });
      expect({ word, inPrompt: duty.includes(word) }).toEqual({ word, inPrompt: true });
    }
    // And the retired shapes appear in NEITHER.
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain('"tags": ["lane-tag"]');
    expect(SETTLEMENT_NOTE_TOOL_DESCRIPTION).not.toContain("{turn, tailTag, headTag}");
    expect(duty).not.toContain("{turn, tailTag, headTag}");
  });

  test("lane_check is the review's repair queue, and every repair is a declare or a retraction", () => {
    const duty = dutyOne(renderPrompt());

    expect(duty).toContain("after your first complete pass, call `lane_check`. ERRORS are a");
    expect(duty).toContain("repair queue for the graph you already judged, never the work plan;");
    expect(duty).toContain("every repair is a `declare` entry or a retraction. WARNINGS inform");
    expect(duty).toContain("the topology review and never compel a write.");
  });

  // lane-model-v12 ticket 04 deleted the lane-shape error class (E5), so the
  // review states no one-source/one-sink law at all. Its two earlier readings
  // — "a fork opens a BRANCH" and "a fork is a shape error (E5)" — stay retired.
  test("no lane-shape law — a fork is neither a branch nor an error", () => {
    const duty = dutyOne(renderPrompt());

    expect(duty).toContain("A lane's shape is no");
    expect(duty).toContain("longer policed");
    expect(duty).toContain("fresh, independently declared tag.");
    expect(duty).not.toContain("opens a BRANCH");
    expect(duty).not.toContain("proper-superset tag set rooted at the parent node");
    expect(duty).not.toContain("(E5)");
    expect(duty).not.toContain("one source, one sink");
    expect(duty).not.toContain("FORM LANES");
  });

  test("the two lane_check-warning teachings survive: the severed lane and phase connectivity", () => {
    const duty = dutyOne(renderPrompt());

    expect(duty).toContain("IT BLOCKS NOTHING and there is no disposition to file.");
    expect(duty).toContain("A GENUINE STITCH SELF-EVIDENCES");
    expect(duty).toContain("leave the fracture standing and commit");
    expect(duty).toContain("A landing turn (implement/fix/refactor) should be traceable");
    expect(duty).toContain("EDGE FIRST: prefer writing the edge that already exists in");
    expect(duty).toContain("`typeReason` on the `note` call");
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
    // Ticket 15: Block C moved from the numbered COMMIT duty into the Duties
    // preamble, bytes unchanged — `commit` writes nothing, so it states its
    // terminal contract where the two write duties are introduced.
    const preamble = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("The lease is checked"));

    expect(preamble).toContain("`commit` is REFUSED while any ERROR `lane_check` reports anchors inside");
    expect(preamble).toContain("your writable set — the refusal lists exactly the rows to repair, and a");
    expect(preamble).toContain("refusal costs no attempt. Errors anchored outside your set belong to");
    expect(preamble).toContain("other windows and never block you. The job ends only through ONE");
    expect(preamble).toContain("SUCCESSFUL commit: a refusal is repaired and retried, and certainty that");
    expect(preamble).toContain("nothing changed still requires an empty-handed successful commit.");
  });

  // ABSENCE pin (ticket 07, retired teaching #2): the old "call lane_check
  // early" advice is gone from the commit paragraph — Block A now forbids
  // calling it during the batch loop, and Block B's own step 5 (CHECK AND
  // REPAIR) is where it belongs instead.
  test("the retired 'call lane_check early' sentence is gone", () => {
    const prompt = renderPrompt();
    const preamble = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("The lease is checked"));

    expect(preamble).not.toContain("Call `lane_check` early");
    expect(preamble).not.toContain("its WARNINGS inform judgment and never block.");
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
 * Ticket 11 (edge-ownership-impl, "统一 Memory Rubric"), re-aimed by
 * lane-model-v12 ticket 12: the two consumers must share the CONCEPTS half
 * byte-for-byte, and must NOT share the rest. The main agent's slot carries
 * concepts + its own action principles in one block; the settlement prompt
 * carries concepts alone and states its own actions in `## Duties`. Exercised
 * HERE, against a real settlement prompt (this file's own fixture), rather
 * than only comparing each side to the shared constant in isolation — a future
 * edit that wrapped one side differently would still fail this cross-check.
 */
describe("ticket 12 — the CONCEPTS half renders byte-identical in both consumers, and only that half", () => {
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

    // The settlement prompt carries the concepts-only block whole…
    expect(prompt).toContain(renderMemoryRubricConceptsBlock());
    // …and the SessionStart slot is exactly the two-half block.
    expect(sessionStartBlock).toBe(renderMainAgentRubricBlock());

    // Byte-for-byte on the SHARED half: extract each consumer's own copy of
    // the concepts text and compare those, not the wrappers — the wrappers
    // legitimately differ now (`actions="…"` rides only on the main agent's).
    const promptRubric = prompt.slice(
      prompt.indexOf("<mnemo-memory-rubric"),
      prompt.indexOf("</mnemo-memory-rubric>") + "</mnemo-memory-rubric>".length,
    );
    expect(promptRubric).toContain(MEMORY_RUBRIC_CONCEPTS_TEXT);
    expect(sessionStartBlock).toContain(MEMORY_RUBRIC_CONCEPTS_TEXT);

    // The half that must NOT cross: the main agent's action principles are
    // imperatives about keeping per-turn notes, which is not this pass's job.
    expect(prompt).not.toContain(MEMORY_RUBRIC_MAIN_ACTIONS_TEXT);
    expect(prompt).not.toContain("## 记录 —— 管好每一轮");
    expect(promptRubric).not.toContain("actions=");

    db.close();
  });

  /**
   * Ticket 15 retired the session duty and MOVED Block D1's honesty rule out
   * of it, into the Output tail — its rule is about the narration this run
   * produces, not about the session field. Ticket 22 restored the duty (as
   * SESSION FIELDS, pinned by its own describe below) and deliberately did NOT
   * take D1 back with it: a reporting rule inside a write duty is where it was
   * misfiled in the first place.
   *
   * So what this test pins is the SEPARATION — D1 lives in the Output tail,
   * after `## Output` and before the closing paragraph — plus the retired
   * wording that must not return with the duty (`SESSION NARRATIVE` as a duty
   * heading, and the "no append" framing the shared mode vocabulary replaced).
   */
  test("Block D1's honesty rule stays in the Output tail, not inside the restored session duty", () => {
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

    expect(prompt).not.toContain("SESSION NARRATIVE");

    // The mode vocabulary is still taught — duty 3's session fields use it,
    // and it is the same two words every other write in this system takes.
    // (Duty 1's prose bullets went with the turn-scope duties, final review
    // finding 1, so duty 3 is where the vocabulary is now stated.)
    expect(prompt).toContain('mode.<field>');
    expect(prompt).toContain('{ mode: "edit", oldString, newString }');
    expect(prompt.toLowerCase()).not.toContain("no append");

    // Block D1, verbatim, now in the Output tail.
    expect(prompt).toContain(
      "Narrate only writes that actually landed in this run: never infer counts",
    );
    expect(prompt).toContain("or claim a range fully conforming from `lane_check` — use successful");
    expect(prompt).toContain("tool receipts, or omit the claim.");
    expect(prompt.indexOf("## Output")).toBeLessThan(
      prompt.indexOf("Narrate only writes that actually landed"),
    );
    expect(prompt.indexOf("Narrate only writes that actually landed")).toBeLessThan(
      prompt.indexOf("Make your `note` tool calls as you decide them"),
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

    // Hindsight task frame. RE-REVIEW ROUND, FINDING 1: it used to say "check
    // or rebuild the NOTES" and to send a backfill window to "rebuild FROM
    // ZERO" — both leftovers of the single-pass era, both contradicted by the
    // authority paragraph below and now by the `note` tool itself, which
    // refuses a turn's prose/type/tags from this stage. The frame states the
    // edge work instead, and the pins below hold that it does not relapse.
    expect(prompt).toContain("HINDSIGHT pass over this window");
    // main-agent-edges ticket 05 (spec D3/D6): the frame no longer says this
    // pass WRITES the window's edges from nothing. The writing side records
    // what it used, corrected or verified as it goes, and this pass declares,
    // fills and reviews. The originating sentence is pinned absent.
    expect(prompt).toContain("Each turn's writer already");
    expect(prompt).toContain("recorded the edges it knew about");
    expect(prompt).toContain("DECLARE the lane side");
    expect(prompt).toContain("FILL the edges that were");
    expect(prompt).toContain("REVIEW what stands");
    expect(prompt).not.toContain("Write the EDGES between the");
    expect(prompt).not.toContain("Check or rebuild the notes");
    expect(prompt).not.toContain("rebuild FROM ZERO");
    // Authority statement.
    expect(prompt).toContain("## Your authority");
    expect(prompt).toContain("Your pen is the EDGES of the turns in your writable set");
    // Procedure (main-agent-edges ticket 06): the shared edge pass replaced
    // ticket 07's batched workstations — see the ticket 06 describe above for
    // the full pin set.
    expect(prompt).toContain("## Procedure");
    expect(prompt).toContain("THE EDGE PASS — DECLARE, FILL, REVIEW.");
    expect(prompt).toContain("READ ONCE.");
    expect(prompt).not.toContain("Work the WHOLE writable set in chronological batches of ten turns");
    expect(prompt).not.toContain("BATCH STEP");
    // Commit as the terminal check, last.
    expect(prompt.indexOf("## Your task")).toBeLessThan(prompt.indexOf("## Your authority"));
    expect(prompt.indexOf("## Your authority")).toBeLessThan(prompt.indexOf("## Procedure"));
    // Ticket 15: `commit`'s contract sits in the Duties preamble now, which is
    // still after the procedure — the ORDER this test pins is unchanged.
    expect(prompt.indexOf("## Procedure")).toBeLessThan(prompt.indexOf("## Duties"));
    expect(prompt.indexOf("## Duties")).toBeLessThan(
      prompt.indexOf("2. SESSION FIELDS"),
    );
  });

  test("the shared concepts block is still what the prompt teaches judgment from", () => {
    const prompt = renderPrompt();

    // The shared half, byte-identical with the SessionStart injection's
    // (pinned in full by the describe above this one).
    expect(prompt).toContain(renderMemoryRubricConceptsBlock());
    expect(prompt).toContain('concepts="');
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
/**
 * FINAL REVIEW, FINDING 1: the RECONCILIATION teaching — MISSING /
 * NON-CONFORMING re-annotated from scratch, CONFORMING checked and
 * supplemented — is a TURN-SCOPE duty, and turn scope is stage 1's whole
 * subject. It moved with the duty (stage 1's own prompt states it as that
 * pass's duty 1, in its own words); what this file pins now is that it did not
 * stay behind, because a pass taught to re-annotate every note re-runs the
 * window the split exists to have run once.
 */
describe("the turn-scope reconciliation teaching left with the duty", () => {
  test("no re-annotation branch, no conformance test, no type/tags criteria", () => {
    const prompt = renderPrompt();

    expect(prompt).not.toContain("RE-ANNOTATED FROM SCRATCH");
    expect(prompt).not.toContain("NON-CONFORMING");
    expect(prompt).not.toContain("conformance means every word is a member of the closed vocabulary");
    expect(prompt).not.toContain("correct the explicit, supplement what is missing, leave doubt alone");
    // Duty 1 is edges, and it says out loud that the other fields are settled.
    expect(prompt).toContain("1. TURN EDGES, via the `note` tool");
    expect(prompt).toContain("none of them is yours this pass: the first pass audited them and");
    // The pre-era gate lives in the worker's job-claiming path, never here.
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
describe("ticket 07 — lane_check lands in the review, and the retired procedure wording stays gone", () => {
  // MAIN-AGENT-EDGES TICKET 06: the batch loop is gone, so there is no loop
  // to forbid `lane_check` inside; the call is taught once, in the REVIEW.
  test("lane_check is taught in the review, after the first complete pass", () => {
    const prompt = renderPrompt();
    const procedure = prompt.slice(prompt.indexOf("## Procedure"), prompt.indexOf("## Duties"));

    expect(procedure).not.toContain("Do not call `lane_check` during the");
    expect(procedure).toContain("Then `lane_check`: E6 and E4");
    expect(prompt).toContain("after your first complete pass, call `lane_check`");
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
  test("the prompt teaches the retraction mirrors", () => {
    const prompt = renderPrompt();

    // main-agent-edges ticket 03 (T2432 P1): a retraction addresses the PAIR
    // and the mirror's class is a precondition; "the addressed placement's
    // row" and "legacy rows stay deletable" described the retired identity
    // (side tags left the address, the wordless rows are deleted at cutover).
    expect(prompt).toContain("The `retractCorrect`/`retractVerify`/`retractUse`");
    expect(prompt).toContain("mirrors delete the addressed PAIR's row, with the mirror's own class");
    expect(prompt).toContain("as the precondition");
    expect(prompt).not.toContain("addressed placement's row of that CLASS");
    expect(prompt).not.toContain("legacy rows stay deletable");
    // Ticket 15: the membership `create` verb this test used to pin alongside
    // them retired, and the roster advice it carried went with it.
    expect(prompt).not.toContain('`action="create"`');
    expect(prompt).not.toContain("joining an existing segment beats opening");
  });

  // Indexes-rescope ticket 04: the edge vocabulary this prompt states named
  // `indexes`, and the rejection examples beside it named a check that law 2
  // retired (an out-of-branch collects target no longer fails anything). Both
  // halves are still pinned — the word must appear, and no retired word may
  // survive in the prose around it, where it would teach settlement to avoid
  // legal calls. Ticket 06 note: the word list is authored prose now rather
  // than a render of `EDGE_RELATIONS`, so this test is the guard that a
  // vocabulary change actually reached the bullet.
  test("the prompt speaks the three classes and states no retired rejection", () => {
    const prompt = renderPrompt();

    // The authored bullet's own field list, exact — a class dropped from it
    // (or a retired word re-added) fails here.
    expect(prompt).toContain("`note`'s correct/verify/use fields — the three-class");
    expect(prompt).toContain('or `"partial"`. A `correct` without it is');
    expect(prompt).toContain("refused naming the missing bit");
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
  // Lane-model-v12 ticket 12 changed the shape a pointer has to take. v12's
  // concepts text has NO `## ` headings at all — it is a list of bolded
  // ENTRIES (`**type**`, `**tags**`, `**段**`) — so the old "the Rubric's
  // Segments section" form would resolve to nothing on every reading, which is
  // exactly the silent teaching bug this test was written for. The pointer form
  // is now "the Memory Rubric's **<entry>** entry", and the label set comes
  // from the concepts text itself.
  test("every rubric entry the prompt points at is a real entry in the concepts half", () => {
    const prompt = renderPrompt();
    const entries = new Set(
      [...MEMORY_RUBRIC_CONCEPTS_TEXT.matchAll(/\*\*([^*\n]+)\*\*/g)].map((match) => match[1]!),
    );
    expect(entries.size).toBeGreaterThan(0);

    const referenced = [...prompt.matchAll(/\*\*([^*\n]+)\*\* entr(?:y|ies)/g)].map(
      (match) => match[1]!,
    );
    expect(referenced.length).toBeGreaterThan(0);

    for (const name of referenced) {
      expect([...entries], `the prompt points at a rubric entry that does not exist: ${name}`)
        .toContain(name);
    }

    // And the retired pointer FORM must not come back: a `## `-heading pointer
    // cannot resolve against a document with no headings.
    expect(prompt).not.toMatch(/Memory Rubric'?s(?: own)? \S+ (?:section|checklist)/);
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
      .get(claimWriterId(job.id, job.claimGeneration, job.stage), sessionDbId);
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

  // Lane-declaration ticket 08 hand-amended three spans inside Block B (see
  // note-settlement-prompt.ts's own "LANE-DECLARATION TICKET 08'S AMENDMENT"
  // comment), so Block B is EXCLUDED here — indices 0 and 2 only (A and C),
  // which stay untouched, byte-for-byte, from the tag-mandate archive. Block
  // B gets its own test below, which applies the SAME three amendments to
  // the archived text before checking for a contiguous match, so a future
  // edit to either side (the archive or the prompt) that lets them drift
  // apart in an UNAMENDED span still fails here.
  test("block C appears as a contiguous word sequence", () => {
    const section = readAuthoredSections()[2]!;
    const body = section.slice(section.indexOf("\n") + 1).trim();
    expect(body.length).toBeGreaterThan(0);
    expect(words(renderPrompt()).includes(words(body))).toBe(true);
  });

  // MAIN-AGENT-EDGES TICKET 06: the Block A and Block B guards are RETIRED.
  // Both blocks described the stored-side model — ten-turn batches and a
  // ledger (A), the two-sided draft-and-E6 placement and the five-step pass
  // (B) — and the rendered prompt no longer carries either; the procedure is
  // the shared `renderEdgePassTeaching()` block, pinned sentence by sentence
  // in `tests/worker/note-settlement-edge-pass-teaching.test.ts`, and the
  // archive's two blocks stay in `.scratch/tag-mandate/issues/06-prompt-text.md`
  // as history. Blocks C and D still ship verbatim and are still guarded.

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

  /**
   * The sentence used to be EXACTLY this pass's registered set, then stopped
   * being: ONE system prompt is handed to BOTH dispatches
   * (note-settlement-dispatch.ts passes `NOTE_SETTLEMENT_SYSTEM_PROMPT`
   * whichever mode the child resolves), and settlement-gate-taxonomy ticket 06
   * removed `remember` from the EDGE-only pass while the unified dispatch's
   * TOPIC pass kept it for `create`/`delete`.
   *
   * LANE-IMPRESSIONS TICKET 10 closed that divergence from the other side:
   * `remember` is registered on this pass again, for the one action the edge
   * pass owns (`impression`). So the sentence and this pass's registered set
   * agree once more, and the assertion is back to the equality it was written
   * to make.
   *
   * PRE-EXISTING AND NOT TOUCHED HERE: the sentence also omits `finalize`,
   * which the unified dispatch registers. That gap predates this ticket and
   * fixing it is a change to the unified pass's teaching, not to this one's.
   */
  test("the system sentence permits every tool this pass registers, `remember` included again", () => {
    const allowlistMatch = NOTE_SETTLEMENT_SYSTEM_PROMPT.match(
      /Work entirely through the ([a-zA-Z_/]+) tools/,
    );
    expect(allowlistMatch).not.toBeNull();
    const allowlistedTools = new Set(allowlistMatch![1]!.split("/"));
    for (const tool of KNOWN_TOOL_NAMES) {
      expect(allowlistedTools.has(tool)).toBe(true);
    }
    expect(KNOWN_TOOL_NAMES.has("remember")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lane-model-v12 ticket 12 — the SETTLEMENT ACTIONS half.
//
// The third artifact of the rubric split. It is not a file and not an exported
// constant: it lives inside this prompt's own `## Duties` checklist, seated in
// the duty that acts on it. Source:
// `.scratch/lane-model-v12/rubric-v12-settlement.md`.
//
// The ticket's own checkbox is "一条测试断言它只出现在结算侧" — so every pin
// below is a PAIR: present here, absent from the SessionStart injection the
// main agent gets. The main agent declares no lanes, counts no cross-lane
// coupling and judges no lane topology, so a copy reaching it would be
// instructions addressed to someone else.
// ---------------------------------------------------------------------------

describe("ticket 12 — the settlement action half is in the duties, and only on this side", () => {
  // FINAL REVIEW, FINDING 1: the DECLARATION CRITERIA and the `delete`
  // cleanup rule left this prompt with the duty they governed — declaring and
  // removing lanes is stage 1's act, and this pass has no verb for either.
  // What stays is the half that governs THIS pass's own work: the one
  // principle a warning is reviewed against, and the coupling count that
  // answers "should these two lanes have been one" (which this pass answers in
  // its final reply, never with a merge).
  //
  // ONE-EDGE-PER-CLAIM TICKET 15: the second PRINCIPLE, 最小连通, retired —
  // subsumed by the unified edge-declaration law, pinned in the JUDGE AND
  // WRITE guard test above (block B's amendment chain) rather than here.
  const SETTLEMENT_ONLY = [
    // The one surviving PRINCIPLE, reviewed against in the check-and-repair
    // step.
    "原则(判断性,不强制):",
    "- 连通性:一条泳道的任意两个成员,应该通过两侧 tag 同为该泳道",
    // The three-group COUPLING count, and its explicit refusal to invent a
    // threshold — the input to "should these two lanes have been one".
    "耦合:跨泳道的边按三组分别计数,不产出机器判决 ——",
    // relation-vocabulary-v13 ticket 02 re-wrapped these two lines with the
    // three classes; the SENTENCE is unchanged.
    "「较少」没有分母也没有阈值,把三个数摆出来由人判断,不要",
    "发明一个门限。",
  ];

  test("every settlement-only rule is in the prompt", () => {
    const prompt = renderPrompt();
    for (const rule of SETTLEMENT_ONLY) {
      expect(prompt, `settlement prompt should state: ${rule}`).toContain(rule);
    }
  });

  test("no settlement-only rule reaches the main agent's injection", () => {
    const injected = renderRubricBlock();
    for (const rule of SETTLEMENT_ONLY) {
      expect(injected, `SessionStart must not carry: ${rule}`).not.toContain(rule);
    }
  });

  test("the settlement half sits INSIDE the Duties checklist, not as a fourth section", () => {
    const prompt = renderPrompt();
    const duties = prompt.slice(prompt.indexOf("## Duties"), prompt.indexOf("## Task roster"));
    for (const rule of SETTLEMENT_ONLY) {
      expect(duties, `should be inside ## Duties: ${rule}`).toContain(rule);
    }
    // The principles sit in the relation finalization pass — next to the call
    // they govern, which is the whole reason this half is not a separate
    // injected block — and so before the session-fields duty (ticket 06: the
    // lane-disposition duty that used to sit between them is retired).
    expect(duties.indexOf("原则(判断性,不强制):")).toBeLessThan(
      duties.indexOf("2. SESSION FIELDS"),
    );
  });

  // The source file's 写入规则 section is deliberately NOT copied in: this
  // prompt and the relation describes already state all three of its rules, and
  // a second copy is the drift shape the single-home discipline exists to
  // prevent. Pinned as an absence so a later "completeness" pass does not
  // re-add it without noticing there was already a home.
  test("the source's 写入规则 section is not duplicated into the prompt", () => {
    const prompt = renderPrompt();
    expect(prompt).not.toContain("身份是 `(任务, tag)`,不是裸 tag");
    expect(prompt).not.toContain("泳道 tag 与任务自身的策展 tag 不得同名");
    // …because the fact that survives this pass's own duties is already here,
    // in English: a lane's identity is (task, tag), stated where an edge side
    // is placed. The registry's own refusals left with the registry verbs.
    expect(prompt).toContain("since a lane's identity is (task, tag)");
  });
});

// ---------------------------------------------------------------------------
// Lane-model-v12 ticket 21 — the settlement half of ONE membership policy, and
// the memory policy ticket 12 left behind.
//
// The ruling (user, 2026-08-26) is about the MAIN agent: no fitting segment or
// lane tag, ask with AskUserQuestion, never mint silently. This pass is
// HEADLESS, so its half of the same rule is the other one — leave the field
// empty and leave the opening of a container to the side that can ask.
//
// What is deliberately NOT changed by that: duty 2 still declares lanes. The
// two acts share a verb and are not the same act — a lane declared because the
// content shows a separable, sustainable sub-task (the 判据 in duty 2) is
// hindsight this pass alone has and a standing user ruling ([S15069/T1547],
// "lanes are settlement's outright") assigns it here; a lane minted because a
// turn found no tag to carry is the thing this ruling forbids. Every pin below
// is on the second, and the first is pinned as a SURVIVAL so a later reading of
// "settlement must not mint" cannot quietly take duty 2 with it.
// ---------------------------------------------------------------------------

/**
 * Ticket 21's ruling was about the settlement half of the ask-before-create
 * rule: this pass is headless, so where the main agent asks the user, it must
 * leave the field empty. FINAL REVIEW, FINDING 1 settles the same question one
 * level up — this pass has no membership write and no lane verb at all, so
 * there is nothing left to leave empty and nothing to be tempted into
 * creating. What survives is the half that still applies: the ask itself never
 * reaches a headless surface.
 */
describe("ticket 21 — the create temptation is gone with the verbs themselves", () => {
  test("no membership bullet, no declaration criteria, no registry verb", () => {
    const prompt = renderPrompt();

    expect(prompt).not.toContain("membership lives in `tags`, and nowhere else");
    expect(prompt).not.toContain("Both tiers are one vocabulary and one rule");
    expect(prompt).not.toContain("Never open a task or declare a");
    expect(prompt).not.toContain("判据 —— 一条被声明的泳道应当满足两条");
    // And the reason, stated where it now belongs: the lanes are stage 1's.
    // Ticket 06 moved the sentence from the retired duty-2 bullet into the
    // Duties preamble, where it now also states that no lane tool exists here.
    expect(prompt).toContain("lane registry is not a third: stage 1 declared the lanes");
    expect(prompt).toContain("it holds no lane tool at all.");
  });

  test("the ask itself never reaches this headless surface", () => {
    const prompt = renderPrompt();
    expect(prompt).not.toContain("AskUserQuestion");
    // Nor the main agent's own imperative, which arrives only inside the
    // ACTION half — a half this prompt does not render.
    expect(prompt).not.toContain("不要静默新建");
    expect(prompt).not.toContain(MEMORY_RUBRIC_MAIN_ACTIONS_TEXT);
  });


  // Ticket 12 sent the rubric's whole ACTION half to the main agent and left
  // this pass calling `recall`/`timeline` with no read policy at all. The peer
  // (B4) flagged the reason it cannot simply be copied: "only read when memory
  // could change the present judgment" is selective, and this pass is REQUIRED
  // to review its whole writable set. So the prompt states the BOUNDARY.
  test("the memory policy is present and draws the selective/mandatory boundary", () => {
    const prompt = renderPrompt();
    expect(prompt).toContain("## Memory policy");

    const policy = prompt.slice(
      prompt.indexOf("## Memory policy"),
      prompt.indexOf("## Procedure"),
    );
    // Selective — and explicitly about ranging OUTSIDE the window.
    expect(policy).toContain("Reading MEMORY is SELECTIVE");
    expect(policy).toContain("could");
    expect(policy).toContain("change a judgment you are about to make");
    // Mandatory — and explicitly exempted from the selective rule.
    expect(policy).toContain("Reviewing THIS WINDOW'S WRITABLE SET is not that");
    expect(policy).toContain("the selective rule");
    expect(policy).toContain("never applies to it");
    expect(policy).toContain(
      "every address printed below is audited, whether or",
    );
    expect(policy).toContain("cover it, and it is exhaustive");
    // The materialization rule, transferred in substance.
    expect(policy).toContain("comes from your own `recall` of that turn, never from a summary");
  });

  test("the policy sits between the authority statement and the procedure", () => {
    const prompt = renderPrompt();
    expect(prompt.indexOf("## Your authority")).toBeLessThan(
      prompt.indexOf("## Memory policy"),
    );
    expect(prompt.indexOf("## Memory policy")).toBeLessThan(prompt.indexOf("## Procedure"));
  });

  // The main agent's generalized heuristic must NOT be what landed here: a
  // reader who meets it inside a prompt whose whole scope statement is "work
  // the WHOLE writable set" has two rules and no boundary between them.
  test("the main agent's unqualified selective sentence is not copied in", () => {
    const prompt = renderPrompt();
    expect(prompt).not.toContain("只在记忆可能改变当前判断时才去读");
    expect(prompt).not.toContain("材料化的时刻必须回原文");
  });
});

describe("the rendered prompt's lane-action inventory", () => {
  // This prompt was the THIRD teacher of settlement's `action` enum (peer
  // review [S15069/T1772]): the tuple, the tool description and this prompt
  // were three independent literals, and that is how `remember(declare)`
  // outlived the verb it named. SETTLEMENT-GATE-TAXONOMY TICKET 06 removed the
  // third teacher entirely — this pass has no `remember` tool, so it teaches
  // no lane action at all, live or retired. The remaining two are still
  // equated in tests/shared/tag-mandate-teaching-surfaces.
  //
  // The drift guard is therefore inverted rather than deleted: it goes red the
  // moment ANY lane verb, including a live one, reappears in this prompt —
  // which is exactly the event that would put a third literal back.
  test("names NO lane action at all — live or retired", () => {
    const prompt = renderPrompt();
    for (const action of SETTLEMENT_LANE_ACTIONS) {
      expect(prompt).not.toContain(`\`${action}\``);
    }
    // MAIN-AGENT-EDGES TICKET 06: `declare` is `note`'s own live entry field
    // again (ticket 03, spec D4) and the prompt teaches it as such; the
    // RETIRED lane verb is the `remember(declare)` form, pinned absent below.
    for (const retired of ["justify", "undeclare", "propose", "reassign", "assign"]) {
      expect(prompt).not.toContain(`\`${retired}\``);
    }
    expect(prompt).not.toContain("remember(declare");
    expect(prompt).not.toContain('action: "declare"');
  });
});

/**
 * STAGED SETTLEMENT TICKET 07 — the stage-2 teaching.
 *
 * Every assertion is on the THIRD parameter's presence or absence, because
 * that is the real distinction: a job that never transitioned has no frozen
 * judgment, so instructing it about a worklist, three debts and a preview lag
 * would teach duties it cannot have. The rendering itself is a plain value
 * here — `buildSettlementWorklistRendering`'s own DB read is pinned at the
 * sdk-query seam, where the snapshots it reads actually exist.
 */
describe("staged settlement ticket 07 — the stage-2 duties are taught only when a transition froze them", () => {
  const worklist = {
    lanes: [
      { address: "E9/#alpha", memberAddresses: ["S3/T1", "S3/T2"] },
      { address: "E9/#beta", memberAddresses: ["S3/T4"] },
    ],
    debts: [{ edgeId: 41, removedLaneTag: "gamma", citingAddress: "S3/T7" }],
    homeless: [
      { label: "an orphan line", reason: "no attached task covers it", memberAddresses: ["S3/T5"] },
    ],
    // main-agent-edges ticket 06: the two read deltas the transition froze.
    writableDelta: ["S3/T7"],
    contextDelta: ["S3/T2", "S3/T9"],
  };

  function renderStageTwoPrompt(): string {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);
    return renderNoteSettlementPrompt(
      context,
      resolveSettlementWritableSet(db, context, writableTurnIds),
      worklist,
    );
  }

  test("the frame names the split, forbids revisiting stage 1's judgment, and states the five stage-2 acts", () => {
    const prompt = renderStageTwoPrompt();

    expect(prompt).toContain("You are the SECOND of two passes");
    expect(prompt).toContain("this pass does not revisit them");
    expect(prompt).toContain("not re-name a lane");
    expect(prompt).toContain("worklist below rather than by anything you might derive");
    expect(prompt).toContain("ONE crossing pass");
    expect(prompt).toContain("at the commit");
  });

  test("the worklist is declared with its lanes, frozen members, debts and homeless dispositions", () => {
    const prompt = renderStageTwoPrompt();

    expect(prompt).toContain("YOUR WORKLIST (frozen by the stage-1 transition");
    expect(prompt).toContain("read, never re-derived");
    expect(prompt).toContain("E9/#alpha (2):");
    expect(prompt).toContain("S3/T1, S3/T2");
    expect(prompt).toContain("E9/#beta (1):");
    expect(prompt).toContain('edge #41: S3/T7 still names the removed lane "gamma"');
    expect(prompt).toContain('"an orphan line" — no attached task covers it');
    expect(prompt).toContain("a turn that joined after the transition is not one");
    // main-agent-edges ticket 06: the two read deltas print with the worklist,
    // each labelled with its authority.
    expect(prompt).toContain("writable delta — relations only, not in the initial set (1):");
    expect(prompt).toContain("context delta — read-only, one hop, not in the initial set (2):");
    expect(prompt).toContain("S3/T2, S3/T9");
  });

  // MAIN-AGENT-EDGES TICKET 06: TWO handover debts, not three. DRAFT
  // RECONCILIATION went with the draft (one pair, one row; a blank side is
  // legal where the endpoint's lane set decides it), and the homeless
  // retraction no longer claims "the bare citation comes back" — ticket 03
  // deleted `restoreBareRowsForEmptiedPairs`, so that sentence was FALSE at
  // HEAD and this test's old `toContain("the bare citation")` pinned it.
  test("the two edge debts are taught by name: debt discharge and homeless retraction — and the draft one is gone", () => {
    const prompt = renderStageTwoPrompt();

    expect(prompt).toContain("DEBT DISCHARGE. Each entry of the writable delta is a citing turn whose");
    expect(prompt).toContain("Your authority over that citing turn is RELATIONS ONLY");
    expect(prompt).toContain("declare the side, or retract the row");
    expect(prompt).toContain("HOMELESS RETRACTION, with cause");
    expect(prompt).toContain("The retraction records itself");
    expect(prompt).not.toContain("DRAFT RECONCILIATION");
    expect(prompt).not.toContain("THE PLACED ROW");
    expect(prompt).not.toContain("the bare citation");
    expect(prompt).not.toContain("comes back");
  });

  // TICKET 17 (round-3 peer P0-1): E3 stopped blocking the stage-2 terminal
  // commit for EVERY provenance, not only a removed-side citer — the
  // teaching here generalizes with it (addendum folded in by ticket 15).
  // SETTLEMENT-GATE-TAXONOMY TICKET 04 INVERTS THE FIRST HALF. The preview lag
  // is GONE — one rule builds both lists — so a prompt that still taught "the
  // two surfaces disagree, believe the gate" would be teaching a divergence
  // the code no longer has, and a run taught it keeps behaving under it. The
  // E3 half is untouched: the class is still not this pass's debt.
  test("the two surfaces are taught as AGREEING, and E3 is taught as shown-but-not-blocking", () => {
    const prompt = renderStageTwoPrompt();

    expect(prompt).not.toContain("One disagreement between the two surfaces is expected");
    expect(prompt).not.toContain("the preview lists more than the gate refuses over");
    expect(prompt).toContain("THE TWO SURFACES AGREE, by construction");
    expect(prompt).toContain("An E3 anywhere in your writable set");
    expect(prompt).toContain("is NOT this pass's debt");
    expect(prompt).toContain("a note field no edge pass holds the pen for");
    expect(prompt).toContain("the NEXT window's stage-1 debt, reached");
    expect(prompt).toContain("under");
    expect(prompt).toContain("as a finding this run cannot repair");
    expect(prompt).toContain("Do not chase it, and do not retype a turn to silence it.");
    expect(prompt).toContain("E4 and E6 anchored on that same turn ARE yours");
  });

  // TICKET 04's other half of the same teaching: the warnings header is now
  // TRUE, and the severed lane — the one warning `commit` used to refuse over
  // — is named as blocking nothing, with both round-trip-buying moves
  // explicitly withdrawn.
  //
  // TICKET 06: the third withdrawn move, "`justify` IS NEVER REQUIRED", is
  // gone from the prompt along with the verb and the duty it sat in. The
  // teaching that survives is the one that still describes a decision the run
  // can make — leave the fracture standing — and the withdrawal is now
  // asserted as an ABSENCE of the word anywhere in this prompt, which is a
  // stronger statement than a sentence saying not to use it.
  test("the severed lane is taught as a warning that blocks nothing, and no disposition verb is taught at all", () => {
    const prompt = renderStageTwoPrompt();

    expect(prompt).toContain("EVERYTHING UNDER `lane_check`'s WARNINGS HEADER BLOCKS NOTHING");
    expect(prompt).toContain("IT BLOCKS NOTHING and there is no disposition to file.");
    expect(prompt).toContain("leave the fracture standing and commit");
    expect(prompt).not.toContain("justify");
    // The obligation this replaced must be GONE, not merely contradicted a few
    // lines later by a softer sentence.
    expect(prompt).not.toContain("`commit` REFUSES while");
  });

  test("the session narrative is stated as THIS pass's write, at this commit", () => {
    const prompt = renderStageTwoPrompt();

    expect(prompt).toContain("This is the pass that writes it.");
    expect(prompt).toContain("reached no");
    expect(prompt).toContain("as the last thing before you commit");
  });

  // TICKET 08 REVERSES ITS PREDECESSOR. Ticket 07 pinned the opposite claim
  // here — "without a transition behind it, none of the stage-2 teaching
  // renders at all" — because the un-worklisted rendering still had to serve a
  // job settled by the old single-pass flow. That flow is retired: the third
  // parameter is required, stage 2 is reachable only from a landed transition,
  // and a stage-1 pass that froze nothing froze an EMPTY worklist rather than
  // no worklist. So the frame is unconditional and this test pins that instead.
  test("an empty frozen worklist still renders the two-pass frame — the single-pass rendering is gone", () => {
    const prompt = renderPrompt();

    expect(prompt).toContain("You are the SECOND of two passes");
    expect(prompt).toContain("YOUR WORKLIST");
    expect(prompt).toContain("DEBT DISCHARGE");
    expect(prompt).toContain("HOMELESS RETRACTION");
    expect(prompt).toContain("This is the pass that writes it.");
    // And the empty lists say so in words, which a missing section could not.
    expect(prompt).toContain("lanes to work, in stage 1's own order (0)");
    expect(prompt).toContain("removed-side debts (0)");
    expect(prompt).toContain("homeless dispositions (0)");
    expect(prompt).toContain("writable delta — relations only, not in the initial set (0)");
    expect(prompt).toContain("context delta — read-only, one hop, not in the initial set (0)");
    // What survives unchanged: everything the pass has always taught.
    expect(prompt).toContain("## Duties");
    expect(prompt).toContain("THE EDGE PASS — DECLARE, FILL, REVIEW.");
  });
});
