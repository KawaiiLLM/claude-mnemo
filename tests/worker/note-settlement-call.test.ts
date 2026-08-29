import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "../../src/db/database";
import { ensureRecordedEraCutoff } from "../../src/db/era";
import { getLane } from "../../src/db/lanes";
import { initializeSchema } from "../../src/db/schema";
import { upsertSession } from "../../src/db/sessions";
import { upsertShadowNote, getShadowNote } from "../../src/db/shadow-notes";
import { getTurnById, updateTurnById } from "../../src/db/turns";
import {
  claimNextNoteSettlementJob,
  computeSettlementWritableTurnIds,
  enqueueBackfillNoteSettlementJob,
  enqueueNoteSettlementWindows,
  getNoteSettlementCursor,
  getNoteSettlementJob,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  type NoteSettlementJob,
} from "../../src/db/note-settlement";
import { createSegment, listOpenSegments } from "../../src/db/segments";
import { deriveSideTags, getOutgoingEdges, writeMemoryEdges } from "../../src/db/memory-edges";
import {
  buildNoteSettlementContext,
  resolveSettlementWritableSet,
  type NoteSettlementContext,
} from "../../src/worker/note-settlement-context";
import { renderNoteSettlementPrompt } from "../../src/worker/note-settlement-prompt";
import { buildSettlementWorklistRendering } from "../../src/worker/note-settlement-shape-numbers";
import { recallMemory } from "../../src/mcp/recall";
import {
  classifySettlementFailure,
  createNoteSettlementDispatch,
  type NoteSettlementQuery,
  type NoteSettlementQueryRequest,
  type NoteSettlementWindowMetrics,
} from "../../src/worker/note-settlement-dispatch";
import {
  createNoteSettlementScheduler,
  createTransitionOnlyStageOneDispatch,
} from "../../src/worker/note-settlement";
import {
  createSettlementDirectWriteEngine,
  type SettlementDirectWriteEngine,
} from "../../src/worker/note-settlement-direct-write";
import {
  evaluateSettlementTurnWrite,
  type SettlementTurnFacadeContext,
} from "../../src/worker/note-settlement-turn-facade";
import { claimWriterId, sessionWriterId, stampField } from "../../src/db/write-gate";
import { ERA_GRANT_COLUMN } from "../../src/segment-era";
import {
  SETTLEMENT_ENABLED_CONFIG,
  SETTLEMENT_ERA_CUTOFF_EPOCH,
} from "../support/settlement-config";

/**
 * The settlement call itself, tested at the worker seam: a fake window in a
 * real database, a STUBBED model reply, and assertions on the rows that
 * land. No network, no subprocess: the query seam is the injection point
 * precisely so the judgement quality (offline-eval territory) never enters a
 * unit test, while the transactional behaviour fully does.
 *
 * TICKET 05 (ownership-and-note-cadence spec, "settlement demolition"): duty
 * 2 (note reconstruction) is gone — every fixture turn now already carries a
 * genuine note (the main agent's, standing in for real ownership), because
 * there is no more "hole" for settlement to backfill. `assign` is gone from
 * `remember` — every scenario that used to exercise membership now uses
 * `propose`, or drops the membership call entirely (it was never required
 * even before this ticket, and is even less relevant now that the
 * completion gate has no membership-shaped reason to refuse). ADR-0004's
 * summary-flagging report (`db/note-settlement-summary-flags.ts`) is
 * deleted outright along with the segment-field reading it depended on.
 */

const NOW = 1_800_000_000;

let db: Database;

/** Ticket 14: one container per word these tests write into `tags`. */
const FIXTURE_TAG_CONTAINERS = ["lease", "settlement", "revised", "seam"] as const;

beforeEach(() => {
  db = createDatabase(":memory:");
  initializeSchema(db);
  // Ticket 14 (lane-model-v12 spec D3b/D3e): `tags` draws from a closed
  // vocabulary — a segment's ONE globally unique tag, or a lane declared in
  // that segment. These dispatch tests are about staging, commit and
  // durability, not about which words are legal, so each word they write is
  // made a container of its own here. A turn carrying one therefore also
  // becomes that container's member, which is the model, not a side effect.
  for (const tag of FIXTURE_TAG_CONTAINERS) {
    createSegment(db, { title: `${tag} container`, tags: [tag], nowEpoch: 100 });
  }
});

afterEach(() => {
  db.close();
});

/** The fixture container a given tag names — ticket 15's lane verbs address a SEGMENT, not a turn. */
function containerId(tag: (typeof FIXTURE_TAG_CONTAINERS)[number]): number {
  return db
    .query<{ id: number }, [string]>(
      "SELECT id FROM segments WHERE json_extract(tags, '$[0]') = ?",
    )
    .get(tag)!.id;
}

function seedSession(contentSessionId = "session-a"): number {
  return upsertSession(db, {
    contentSessionId,
    project: "/tmp/project-settlement-call",
    title: "settlement fixture",
    content: null,
    insight: null,
    createdAtEpoch: NOW - 10_000,
    updatedAtEpoch: NOW - 10_000,
    completedAtEpoch: null,
  }).id;
}

interface SeedTurnOptions {
  note?: { title: string; content: string } | null;
  userPrompt?: string;
  assistantResponse?: string;
}

function seedTurn(
  sessionDbId: number,
  promptNumber: number,
  options: SeedTurnOptions = {},
): number {
  const turnId = db
    .query<{ id: number }, [number, number, string, string, number]>(
      `INSERT INTO turns (
         session_id, prompt_number, status, user_prompt, assistant_response,
         tool_call_count, created_at_epoch
       ) VALUES (?, ?, 'active', ?, ?, 3, ?)
       RETURNING id`,
    )
    .get(
      sessionDbId,
      promptNumber,
      options.userPrompt ?? `prompt ${promptNumber}`,
      options.assistantResponse ?? `response ${promptNumber}`,
      NOW - 1_000 + promptNumber,
    )!.id;

  if (options.note) {
    upsertShadowNote(db, {
      turnId,
      title: options.note.title,
      content: options.note.content,
      nowEpoch: NOW - 900,
    });
  }

  return turnId;
}

function seedDebt(
  turnId: number,
  sessionDbId: number,
  promptNumber: number,
  status: "noted" | "skipped" | "pending",
  reason: string | null,
): void {
  db.query<unknown, [number, number, number, string, string | null, number, number]>(
    `INSERT INTO note_debt (
       turn_id, session_id, prompt_number, status, reason,
       opened_at_epoch, updated_at_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(turnId, sessionDbId, promptNumber, status, reason, NOW - 950, NOW - 950);
}

function classifyThrough(sessionDbId: number, promptNumber: number): void {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO note_debt_cursor (
       session_id, last_classified_prompt_number, updated_at_epoch
     ) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_classified_prompt_number = excluded.last_classified_prompt_number,
       updated_at_epoch = excluded.updated_at_epoch`,
  ).run(sessionDbId, promptNumber, NOW);
}

function claimWindow(
  sessionDbId: number,
  windowStart: number,
  windowEnd: number,
): NoteSettlementJob {
  enqueueNoteSettlementWindows(
    db,
    [
      {
        sessionId: sessionDbId,
        windowStart,
        windowEnd,
        triggerType: "consecutive",
      },
    ],
    NOW,
    SETTLEMENT_ERA_CUTOFF_EPOCH,
  );
  const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
  if (!job) {
    throw new Error("fixture failed to claim a settlement job");
  }
  return job;
}

interface Fixture {
  sessionDbId: number;
  turnIds: number[];
  job: NoteSettlementJob;
}

/**
 * Four turns, EVERY one already noted by the main agent (ticket 05: duty 2
 * is gone, so a realistic window has no "hole" left for settlement to
 * backfill — the main agent is the note's sole first-hand writer).
 */
function seedFourTurnWindow(): Fixture {
  const sessionDbId = seedSession();
  // The stubbed replies below cite `S1/...` literally, which is only the right
  // address if this fixture owns database id 1.
  if (sessionDbId !== 1) {
    throw new Error(`fixture expected session id 1, got ${sessionDbId}`);
  }
  const t1 = seedTurn(sessionDbId, 1, {
    note: { title: "design+settlement: window shape", content: "Chose windows." },
  });
  seedDebt(t1, sessionDbId, 1, "noted", null);
  const t2 = seedTurn(sessionDbId, 2, {
    note: { title: "research+lease: what the lease covers", content: "Explored the lease." },
  });
  seedDebt(t2, sessionDbId, 2, "noted", null);
  const t3 = seedTurn(sessionDbId, 3, {
    note: { title: "implement+settlement: lease fence", content: "Fenced it." },
  });
  seedDebt(t3, sessionDbId, 3, "noted", null);
  const t4 = seedTurn(sessionDbId, 4, {
    note: { title: "fix+lease: closed the gap", content: "Closed it." },
  });
  seedDebt(t4, sessionDbId, 4, "noted", null);
  classifyThrough(sessionDbId, 4);

  return { sessionDbId, turnIds: [t1, t2, t3, t4], job: claimWindow(sessionDbId, 1, 4) };
}

/**
 * A stub `runQuery` that writes and (optionally) commits through the REAL
 * direct-write engine — the same engine `note-settlement-sdk-query.ts` gives
 * the SDK subprocess — standing in for what its tool calls would do. Ticket 11
 * of edge-mechanism-revision deleted the staging engine this stub used to
 * drive; the substitution is faithful because the two exposed the same three
 * tools, and the live path had already been direct-write since the
 * read-write-contract batch. `build` receives the engine and the request the dispatch
 * actually sent — everything a real `note-settlement-sdk-query.ts` would
 * have used to build its own `SettlementTurnFacadeContext` — so a test can
 * stage/commit against the SAME job identity and scoping the dispatch
 * computed, without a network or a subprocess.
 */
function queryThatStages(
  build: (engine: SettlementDirectWriteEngine, request: NoteSettlementQueryRequest) => void,
): NoteSettlementQuery {
  return async (request) => {
    const context: SettlementTurnFacadeContext = {
      jobId: request.jobId,
      claimGeneration: request.claimGeneration,
      stage: request.stage,
      sessionId: request.sessionId,
      reviewableTurnIds: request.writableTurnIds,
      contextBuiltAtEpoch: request.contextBuiltAtEpoch,
    };
    const engine = createSettlementDirectWriteEngine({
      db,
      context,
      now: () => NOW,
      // era-grant-by-settlement ticket 02: the SAME window bounds the real
      // `note-settlement-sdk-query.ts` supplies, straight off the request —
      // this stub stands in for that seam faithfully rather than dropping
      // the field.
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
    });
    build(engine, request);
    // `commitMetrics` is `commit`'s own replay result, read the SAME way
    // `note-settlement-sdk-query.ts` reads it (once, after the model's "run"
    // — here, the synchronous `build` call above — has fully finished).
    return {
      text: "settlement run finished.",
      commitMetrics: engine.getLastCommitMetrics(),
    };
  };
}

function dispatchWith(
  runQuery: NoteSettlementQuery,
  metrics?: (value: NoteSettlementWindowMetrics) => void,
) {
  return createNoteSettlementDispatch({
    db,
    config: SETTLEMENT_ENABLED_CONFIG,
    now: () => NOW,
    runQuery,
    metrics,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
}

/** The dispatch's own render path (tag-mandate ticket 06) — see the identical helper in note-settlement-prompt.test.ts. */
function renderPromptFor(context: NoteSettlementContext): string {
  const writableTurnIds = computeSettlementWritableTurnIds(db, context.reviewableTurnIds);
  return renderNoteSettlementPrompt(
    context,
    resolveSettlementWritableSet(db, context, writableTurnIds),
    buildSettlementWorklistRendering(db, context.job.id),
  );
}

describe("settlement context assembly", () => {
  test("a window turn is an ADDRESS and nothing else (ticket 06: the rendering fields retired with the rendering)", () => {
    const fixture = seedFourTurnWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;

    for (const turn of context.windowTurns) {
      // Duty 2's retired hole/raw-material machinery (ticket 05)…
      expect(turn).not.toHaveProperty("kind");
      expect(turn).not.toHaveProperty("rawMaterial");
      // …and the push channel's own carrier fields (ticket 06). The context
      // is a scope declaration now; every fact about a turn reaches the agent
      // through its own `recall`.
      expect(turn).not.toHaveProperty("collapsedRendering");
      expect(turn).not.toHaveProperty("note");
      expect(turn).not.toHaveProperty("gapSeconds");
      expect(turn).not.toHaveProperty("filesModified");
      expect(Object.keys(turn).sort()).toEqual([
        "promptNumber",
        "ref",
        "sessionId",
        "turnId",
      ]);
    }
    expect(context).not.toHaveProperty("interiorHoles");

    const prompt = renderPromptFor(context);
    expect(prompt).not.toContain("## Turns");
    // The retired fact line's own vocabulary, pinned absent at the prompt.
    expect(prompt).not.toContain("kind=");
    expect(prompt).not.toContain("raw>");
    expect(prompt).not.toContain("type_draft=");
    expect(prompt).not.toContain("tag_draft=");
    expect(prompt).not.toContain("files_modified=");
    expect(prompt).not.toContain("(note reconstructed by an earlier settlement pass)");
  });

  test("grading and reconstruction left the prompt entirely; tickets 15/22 leave exactly three duties in order", () => {
    const fixture = seedFourTurnWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;
    const prompt = renderPromptFor(context);

    // The old absolute rubric AND the election-ranking rubric that replaced
    // it are both gone from the prompt now — settlement no longer grades at
    // all until a later ticket restores a rubric-driven duty.
    expect(prompt).not.toContain("Grade 4 — task origin or re-foundation");
    expect(prompt).not.toContain("How much does this task's future depend on this turn?");
    expect(prompt).not.toContain("Seats are CEILINGS");
    expect(prompt).not.toContain("TURN REVIEW");

    // Ticket 15 (spec D3d) collapsed the four-duty list to two: a turn's own
    // fields (edges included), then the lane registry. PROPOSALS retired with
    // `propose`, and COMMIT — which writes nothing — states its contract in
    // the Duties preamble instead. TICKET 22 then restored the third, SESSION
    // FIELDS, whose write surface ticket 15 had left live but uninstructed.
    // The ORDER is what this test pins.
    const turnFieldsIndex = prompt.indexOf("1. TURN FIELDS");
    const lanesIndex = prompt.indexOf("2. LANES,");
    const sessionFieldsIndex = prompt.indexOf("3. SESSION FIELDS");
    expect(turnFieldsIndex).toBeGreaterThan(-1);
    expect(lanesIndex).toBeGreaterThan(turnFieldsIndex);
    expect(sessionFieldsIndex).toBeGreaterThan(lanesIndex);
    expect(prompt).not.toContain("1. PROPOSALS");
    expect(prompt).not.toContain("4. COMMIT");
    expect(prompt).toContain("override");
    expect(prompt).toContain("consume");
  });

  // Ticket 08 (edge-ownership-impl, "settlement four-field check-and-
  // correct"): the old pre-ticket-01 four-question relation ladder
  // (supersedes-first) is DELETED from the prompt — judgment lives only in
  // the Memory Rubric now, and this duty is a pointer at it, not a second
  // restatement. What survives verbatim is the FORMAT facts a rubric pointer
  // cannot carry: the seven-word field list, its retraction mirrors, and the
  // phase rejection.
  //
  // Ticket 04 (edge-mechanism-revision D1/D7) re-judged the fence half: the
  // "pair must already exist" sentences this test used to pin are now pinned
  // as ABSENT, because the rule they taught is retired. An edge stands on its
  // own, so a prompt still teaching the fence would teach a refusal the code
  // no longer performs — the worst kind of drift, since the model would
  // silently stop attempting legal work.
  //
  // TAG-MANDATE TICKET 06: the bullet is authored prose now (Block B), and
  // it made ONE deliberate reversal of ticket 08's framing — the relation
  // WORD is no longer a bare pointer at the rubric, because the trial showed
  // a pointer alone produced zero lanes. Step 4's discriminator is in the
  // bullet, so the "pointer, not a ladder" assertions become the opposite
  // pin: the discriminator is present, and the RETIRED ladder is still
  // absent. What is unchanged is that judgment vocabulary lives in one place
  // — the bullet's step 4 is now that place for the relation WORD, and the
  // rubric remains it for everything else.
  test("the relation half carries step 4's discriminator, and no retired ladder or fence", () => {
    const fixture = seedFourTurnWindow();
    const context = buildNoteSettlementContext(db, fixture.job, {
      nowEpoch: NOW,
    })!;
    const prompt = renderPromptFor(context);

    // The retired four-question ladder must not survive anywhere in the
    // prompt, not merely be absent from duty 2's own text.
    expect(prompt).not.toContain("(1) Did the citing turn overturn it? -> supersedes.");
    expect(prompt).not.toContain(
      "(2) Did the citing turn test its claim, supporting or undermining it?",
    );
    expect(prompt).not.toContain("(4) None of the above -> no relation");
    expect(prompt).not.toContain('"used"');
    expect(prompt).not.toContain('"built on"');

    // Revision 7 (ticket 07): the discriminator lives in the finalization
    // pass's JUDGE AND WRITE step — every word mapped to the state of the
    // CITED CLAIM, prefixed by the repair-is-re-judgment rule, plus the
    // three non-evidences the trial mistook for extends.
    expect(prompt).toContain("3. JUDGE AND WRITE. For every candidate and every stock row you touch,");
    expect(prompt).toContain("ignore the stored relation word and run the claim test as if no");
    expect(prompt).toContain("edge existed — the old word is evidence of nothing. Still fully");
    expect(prompt).toContain("valid and built upon = extends; partly withdrawn or re-scoped =");
    expect(prompt).toContain("narrows; replaced, withdrawn or disproved outright = override;");
    // T1466 (finding P2-5), re-aimed by lane-model v12 ticket 02: a check
    // THIS turn produced routes to `verifies` when it SUPPORTS the cited
    // claim and to `override` when it does not — `refutes` is gone, and
    // `extends` is still named as the wrong reach.
    expect(prompt).toContain("merely used = consume; a check THIS turn produced that SUPPORTS the");
    expect(prompt).toContain("cited conclusion is verifies, never extends — one that goes against");
    expect(prompt).toContain("it is override; work this turn stands or falls with takes");
    expect(prompt).toContain("`grounds`. Shared topic,");
    expect(prompt).toContain("adjacency, or preserving lane shape are never extends evidence —");
    expect(prompt).toContain("One pair may carry several");
    expect(prompt).toContain("relations at once; a call carrying nothing but relations is valid.");
    expect(prompt).toContain(
      "`note`'s override/narrows/extends/consume/indexes/grounds/\n     verifies fields",
    );

    // The retired fence's own wording, pinned ABSENT — the rule is gone, so
    // the sentences that taught it must not survive anywhere in the prompt.
    expect(prompt).not.toContain("must already be a pair that existed");
    expect(prompt).not.toContain("before this run started");
    expect(prompt).not.toContain("you cannot invent a relation for a pair a call earlier");
  });
});

// ---------------------------------------------------------------------------
// TAG-MANDATE TICKET 06 (spec "Settlement surface"): THE GRANT UNIFICATION.
//
// This describe REPLACES ticket 04's pair, which pinned the opposite rule —
// the context render earning settlement its own read grant and complete-read
// fact. Under pull that channel is gone: the build shows the agent no turn,
// so it licenses no turn write, and the licence comes from the agent's own
// `recall` (the identical `recordReadGrants`/`recordFieldCompleteness` seam,
// the identical `claimWriterId` identity — no settlement carve-out anywhere
// in the gate).
//
// The tests run the REAL context build and a REAL `recallMemory` call, never
// a hand-recorded grant fixture, so the wiring cannot rot into a stub. The
// registered-tool half of the same property — that the SDK server's `recall`
// really passes this identity — is pinned in note-settlement-sdk-query.ts's
// own suite.
// ---------------------------------------------------------------------------

describe("ticket 06 — the context build grants only the session; recall earns the rest", () => {
  function settleContextFor(sessionDbId: number, job: NoteSettlementJob) {
    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    return {
      context,
      facade: {
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        stage: job.stage,
        sessionId: sessionDbId,
        reviewableTurnIds: context.reviewableTurnIds,
        contextBuiltAtEpoch: context.builtAtEpoch,
      } satisfies SettlementTurnFacadeContext,
    };
  }

  function grantRows(writer: string, entityType: "turn" | "session"): number {
    return (
      db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM write_gate_reads WHERE writer = ? AND entity_type = ?",
        )
        .get(writer, entityType)?.count ?? 0
    );
  }

  test("the build records the SESSION grant and not one turn grant or completeness fact", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1, { note: { title: "a short title", content: "A short conclusion." } });
    seedTurn(sessionDbId, 2, { note: { title: "another", content: "More." } });
    const job = claimWindow(sessionDbId, 2, 2);
    const writer = claimWriterId(job.id, job.claimGeneration, job.stage);

    const context = buildNoteSettlementContext(db, job, { nowEpoch: NOW })!;
    // The window and its lookback are in SCOPE…
    expect(context.reviewableTurnIds.size).toBe(2);
    // …and neither is READ. Scope and licence came apart.
    expect(grantRows(writer, "turn")).toBe(0);
    expect(grantRows(writer, "session")).toBe(1);
    const completeness = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM write_gate_field_completeness WHERE writer = ?",
      )
      .get(writer)?.count;
    expect(completeness).toBe(0);
  });

  /**
   * A note the agent's own `recall` actually SHOWS — i.e. promoted onto the
   * turn row, which is where an era-turn's agent-written note lives
   * (`promoteTurnFromNote`). The distinction is load-bearing for the two
   * tests below: recall renders the TURN ROW's title/content, so a note that
   * exists only in `shadow_notes` is not what a completeness fact from a
   * recall is a fact about.
   */
  function seedPromotedNote(turnId: number, title: string, content: string): void {
    db.query<unknown, [string, string, number]>(
      "UPDATE turns SET title = ?, content = ? WHERE id = ?",
    ).run(title, content, turnId);
    upsertShadowNote(db, { turnId, title, content, nowEpoch: NOW - 900 });
  }

  test("a whole-field rewrite over another writer's text is refused until the agent recalls the turn itself", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    seedPromotedNote(t1, "a short title", "A short conclusion.");
    // Another writer owns the field — without a foreign stamp the gate admits
    // on rule 3 and never consults a grant at all.
    stampField(db, "turn", t1, "content", sessionWriterId(sessionDbId), NOW - 900);
    const job = claimWindow(sessionDbId, 1, 1);
    const { facade } = settleContextFor(sessionDbId, job);
    const write = {
      turn: `S${sessionDbId}/T1`,
      content: "In hindsight: what this turn actually settled.",
      mode: { content: "write" as const },
    };

    const refused = evaluateSettlementTurnWrite(db, facade, write, NOW + 1, { apply: true });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain("has not been read this session");

    // THE AGENT'S OWN READ — the same call its `recall` tool makes, under the
    // same claim identity the facade checks against.
    recallMemory(db, {
      id: `S${sessionDbId}/T1`,
      turn: 4_000,
      readerId: claimWriterId(job.id, job.claimGeneration, job.stage),
      now: () => NOW + 2,
    });

    const admitted = evaluateSettlementTurnWrite(db, facade, write, NOW + 3, { apply: true });
    expect(admitted.ok).toBe(true);
    expect(getShadowNote(db, t1)!.content).toBe(
      "In hindsight: what this turn actually settled.",
    );
  });

  test("a recall that TRUNCATED the field still refuses the whole-field rewrite, in the gate's own words", () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    seedPromotedNote(
      t1,
      "a title",
      Array.from({ length: 400 }, (_unused, i) => `sentence${i}`).join(" "),
    );
    stampField(db, "turn", t1, "content", sessionWriterId(sessionDbId), NOW - 900);
    const job = claimWindow(sessionDbId, 1, 1);
    const { facade } = settleContextFor(sessionDbId, job);
    const writer = claimWriterId(job.id, job.claimGeneration, job.stage);
    const write = {
      turn: `S${sessionDbId}/T1`,
      content: "a whole new content, over text I never saw whole",
      mode: { content: "write" as const },
    };

    // A read at the DEFAULT per-item budget: it grants the turn, but cuts the
    // body — so the grant exists and the completeness fact says `false`.
    recallMemory(db, { id: `S${sessionDbId}/T1`, readerId: writer, now: () => NOW + 1 });
    const refused = evaluateSettlementTurnWrite(db, facade, write, NOW + 2, { apply: true });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain("was not delivered in full");

    // Step 0's own remedy: re-read with a bigger `turn` budget, then write.
    recallMemory(db, { id: `S${sessionDbId}/T1`, turn: 50_000, readerId: writer, now: () => NOW + 3 });
    expect(evaluateSettlementTurnWrite(db, facade, write, NOW + 4, { apply: true }).ok).toBe(true);
  });

  test("the session narrative still writes — its grant is the one the build keeps", () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1);
    // Another writer owns the session's content, so the gate must consult a
    // grant rather than admitting on the never-written rule.
    stampField(db, "session", sessionDbId, "content", sessionWriterId(sessionDbId), NOW - 900);
    const job = claimWindow(sessionDbId, 1, 1);
    const { facade } = settleContextFor(sessionDbId, job);

    const result = evaluateSettlementTurnWrite(
      db,
      facade,
      {
        session: `S${sessionDbId}`,
        content: "This window: the pull turn landed.",
        mode: { content: "write" },
      },
      NOW + 1,
      { apply: true },
    );

    expect(result.ok).toBe(true);
  });
});

describe("settlement dispatch — staged writes and commit (ticket 05: review, proposals, relations — no reconstruction, no assign)", () => {
  test("a full run (review, a proposal, a relation) lands atomically once the agent calls commit", async () => {
    // Settlement-commit-report ticket 01 (acceptance criterion 3): this
    // exact string must reach the dispatch's OWN metrics sink, verbatim.
    const FULL_RUN_COMMIT_REPORT =
      "This window forced a guess on S1/T3's relation direction (grounds vs extends).";
    const fixture = seedFourTurnWindow();
    // A judged relation is legal only on a pair present BEFORE this window's
    // run (spec C7) — seed the T3->T1 pair here (a prior bare citation, in
    // production) so the `grounds` relation below is attaching to an
    // existing pair, not minting one. `grounds` (not `consume`) because it
    // carries no phase restriction at all — legal regardless of T1's staged
    // decision-phase (`design`) and T3's delivery+decision
    // (`implement`+`correction`) type (flow-relations spec's six-row law,
    // `shared/turn-phase.ts`).
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: fixture.turnIds[2]! },
          cited: { kind: "turn", id: fixture.turnIds[0]! },
          relation: null,
          provenance: "text-ref",
        },
      ],
      NOW - 4_000,
    );
    // The CITED side of a phase check reads the LIVE database (both at stage
    // time's dry run and inside commit's own replay) — a sibling stage call
    // that also corrects T1's type is not yet applied when T3's phase check
    // runs against it, so T1 needs its decision-phase type seeded directly
    // rather than relying on this same run's own T1 correction landing
    // first (ticket 08's phase-legality gate).
    updateTurnById(db, fixture.turnIds[0]!, { type: ["design"] });

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        // T1's type was seeded above, so replacing it is a declared `write`
        // (ticket 07, spec D12).
        engine.writeNote({
          turn: "S1/T1",
          type: ["design"],
          tags: ["lease"],
          mode: { type: "write" },
        });
        // Peer round P1-8: the run's own relations read — the same `recall`,
        // under the same claim identity, that a real agent makes before it
        // states how a turn's edges stand. Without it the edge half of the
        // call below is refused.
        recallMemory(db, {
          id: "S1/T3",
          filter: { fields: ["relations"] },
          readerId: claimWriterId(fixture.job.id, fixture.job.claimGeneration, fixture.job.stage),
        });
        engine.writeNote({
          turn: "S1/T3",
          type: ["implement", "correction"],
          tags: ["lease"],
          grounds: ["S1/T1"],
        });
        engine.writeNote({ turn: "S1/T2", type: ["research"], tags: ["lease"] });
        engine.writeMembership({
          action: "create",
          id: `E${containerId("lease")}`,
          tag: "a-lane-settlement-noticed",
        });
        // Settlement-commit-report ticket 01: a distinctive report, so the
        // metrics assertion below can tell "this run's own report" apart
        // from any other string a mutation might substitute (e.g. a stray
        // counts restatement, or another test's placeholder).
        engine.commit(FULL_RUN_COMMIT_REPORT);
      }),
      (value) => metricsSeen.push(value),
    )({ job: fixture.job });
    expect(outcome).toEqual({ ok: true });

    // The judged relation (spec C7's pre-state gate).
    const judged = getOutgoingEdges(db, { kind: "turn", id: fixture.turnIds[2]! });
    expect(judged.some((edge) => edge.relation === "grounds" && edge.provenance === "judged")).toBe(true);

    // The lane — declared on an existing segment, never a new one. Ticket 15:
    // settlement mints no segments at all, so the only open segments are the
    // ticket-14 tag containers this file's own fixture minted.
    expect(getLane(db, containerId("lease"), "a-lane-settlement-noticed")).not.toBeNull();
    expect(listOpenSegments(db)).toHaveLength(FIXTURE_TAG_CONTAINERS.length);

    // The agent's own notes on every turn keep their origin — settlement
    // never touched prose.
    for (const turnId of fixture.turnIds) {
      expect(getShadowNote(db, turnId)!.writerOrigin).toBe("agent");
    }

    // Job/cursor resolution: `commit` is what did this, not the dispatch.
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(4);
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.committed).toBe(true);

    // The job log's counts are sourced from `commit`'s own replay: three
    // reviews, one relation, one lane declared — no prose, no session narrative.
    expect(metricsSeen[0]!.commit).toEqual({
      turnsReviewed: 3,
      reviewsYieldedToLateNote: 0,
      proseWritten: 0,
      relationsWritten: 1,
      relationsRestated: 0,
      relationsRetracted: 0,
      sessionNarrativeWritten: 0,
      lanesDeclared: 1,
      lanesDeleted: 0,
      lanesMerged: 0,
      lanesJustified: 0,
      report: FULL_RUN_COMMIT_REPORT,
      // era-grant-by-settlement ticket 02: no era cutoff is recorded in this
      // fixture, so there is nothing to grant relief from.
      eraGranted: 0,
    });
    // Isolated from the count fields above: the metrics line's `report` is
    // this run's OWN commit call, verbatim, not a re-derivation from the
    // counts (which is exactly what the ticket forbids the field from
    // restating).
    expect(metricsSeen[0]!.commit!.report).toBe(FULL_RUN_COMMIT_REPORT);
    // Attempt bookkeeping (spec A2a): a first-attempt success is convergence,
    // never abandonment.
    expect(metricsSeen[0]!.attempt).toBe(fixture.job.attempts);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(false);
  });

  test("an EMPTY-HANDED run (nothing staged, nothing to correct) lands cleanly through commit alone — the checklist's own scenario (ticket 05)", async () => {
    const fixture = seedFourTurnWindow();

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        // No stageNoteWrite, no stageMembershipWrite — the model looked, found
        // nothing to correct or propose, and simply commits.
        engine.commit("no friction this window");
      }),
      (value) => metricsSeen.push(value),
    )({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(4);
    expect(metricsSeen[0]!.commit).toEqual({
      turnsReviewed: 0,
      reviewsYieldedToLateNote: 0,
      proseWritten: 0,
      relationsWritten: 0,
      relationsRestated: 0,
      relationsRetracted: 0,
      sessionNarrativeWritten: 0,
      lanesDeclared: 0,
      lanesDeleted: 0,
      lanesMerged: 0,
      lanesJustified: 0,
      report: "no friction this window",
      // era-grant-by-settlement ticket 02: no era cutoff is recorded in this
      // fixture, so there is nothing to grant relief from.
      eraGranted: 0,
    });
  });

  test("commit is the only path that COMPLETES a job — a run that writes but never commits leaves the job unfinished (requirement 9)", async () => {
    const fixture = seedFourTurnWindow();

    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.writeNote({ turn: "S1/T2", type: ["research"], tags: ["lease"] });
        // Deliberately no engine.commit() call.
      }),
    )({ job: fixture.job });

    expect(outcome.ok).toBe(false);
    // Requirement 9 is about JOB COMPLETION, and that half stands: no commit,
    // no `done`, no cursor advance, so the window is re-settled later.
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("claimed");
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(0);
    // What does NOT stand any more is "nothing landed": the read-write-contract
    // batch made each tool call its own check-write-stamp transaction, so a
    // write is durable the moment it returns. This assertion is the inverse of
    // the one the staging era pinned here, and it is the shipped behaviour the
    // stub was hiding while it still drove the (now deleted) staging engine.
    expect(getTurnById(db, fixture.turnIds[1]!)!.tags).toEqual(["lease"]);
  });

  /**
   * The job log documents the three-strike cursor advance as ABANDONING a
   * remainder, not converging toward eventually settling it (spec A2a).
   * This dispatch never decides terminality itself (that is
   * db/note-settlement.ts's `failNoteSettlementJob`/`advanceNoteSettlementCursor`,
   * driven by the scheduler after this call returns) — it only reports
   * `job.attempts` against the same cap.
   */
  test("a failed run on the job's last attempt reports attemptsExhausted — abandonment, not convergence (spec A2a)", async () => {
    const fixture = seedFourTurnWindow();
    const lastAttemptJob = { ...fixture.job, attempts: NOTE_SETTLEMENT_MAX_ATTEMPTS };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.writeNote({ turn: "S1/T2", type: ["research"], tags: [] });
        // Deliberately no commit — this attempt fails, and it is the job's
        // last one.
      }),
      (value) => metricsSeen.push(value),
    )({ job: lastAttemptJob });

    expect(outcome.ok).toBe(false);
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.attempt).toBe(NOTE_SETTLEMENT_MAX_ATTEMPTS);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(true);
    expect(metricsSeen[0]!.commit).toBeNull();
  });

  test("a failed run BEFORE the last attempt does not report attemptsExhausted — there is still a retry coming", async () => {
    const fixture = seedFourTurnWindow();
    const firstAttemptJob = { ...fixture.job, attempts: 1 };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    await dispatchWith(
      queryThatStages(() => {
        // No staged writes, no commit — this attempt simply fails.
      }),
      (value) => metricsSeen.push(value),
    )({ job: firstAttemptJob });

    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.attempt).toBe(1);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(false);
  });

  test("a SUCCESSFUL commit on the job's last attempt is convergence, not abandonment — attemptsExhausted stays false", async () => {
    const fixture = seedFourTurnWindow();
    const lastAttemptJob = { ...fixture.job, attempts: NOTE_SETTLEMENT_MAX_ATTEMPTS };

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        for (const turnId of fixture.turnIds) {
          updateTurnById(db, turnId, { type: ["research"] });
        }
        engine.commit("no friction this window");
      }),
      (value) => metricsSeen.push(value),
    )({ job: lastAttemptJob });

    expect(outcome).toEqual({ ok: true });
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.attempt).toBe(NOTE_SETTLEMENT_MAX_ATTEMPTS);
    expect(metricsSeen[0]!.attemptsExhausted).toBe(false);
  });

  test("discards the whole run when the job generation expired before commit's own fence", async () => {
    const fixture = seedFourTurnWindow();

    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.writeMembership({
          action: "create",
          id: `E${containerId("lease")}`,
          tag: "should-not-complete",
        });
        // Another worker reclaimed the window while this dispatch was "thinking" —
        // simulated here, inside the query, exactly where the race would land.
        db.query<unknown, [number]>(
          "UPDATE note_settlement_jobs SET claim_generation = claim_generation + 1 WHERE id = ?",
        ).run(fixture.job.id);
        engine.commit("no friction this window");
      }),
    )({ job: fixture.job });

    expect(outcome.ok).toBe(false);
    // The job does not complete and its cursor does not move, so the window is
    // re-settled later. The lane itself LANDED — it was declared while this
    // dispatch still held a valid lease, and a direct write is durable on
    // return; ticket 08's fence stops the writes that come AFTER the reclaim,
    // and commit's own fence stops the completion. No segment is ever minted.
    expect(listOpenSegments(db)).toHaveLength(FIXTURE_TAG_CONTAINERS.length);
    expect(getLane(db, containerId("lease"), "should-not-complete")).not.toBeNull();
    expect(getNoteSettlementCursor(db, fixture.sessionDbId)).toBe(0);
  });

  /**
   * A replay conflict refuses the WHOLE commit and keeps every staged write;
   * a fresh dispatch attempt (a new `runQuery` call, a new staging engine —
   * exactly what the job's own attempt/retry mechanism already provides)
   * against a world that no longer conflicts then succeeds. Ticket 05: this
   * used to demonstrate the shape through `assign` against a vanished
   * segment, then through a `propose` whose own turn vanished. Ticket 15
   * retired both verbs, so the vanishing now happens to a TURN the run has
   * already written — the same general "the world moved" mechanism, on the
   * surface settlement still has.
   */
  test("a vanished write target refuses the whole commit; a fresh dispatch attempt against a valid one succeeds", async () => {
    const fixture = seedFourTurnWindow();

    // Attempt 1: writes across the window, then one of those turns vanishes
    // before commit — refuses whole.
    const firstOutcome = await dispatchWith(
      queryThatStages((engine) => {
        for (const turnId of fixture.turnIds) {
          updateTurnById(db, turnId, { type: ["research"] });
        }
        db.query<unknown, [number]>("DELETE FROM turns WHERE id = ?").run(fixture.turnIds[1]!);
        const refused = engine.commit("no friction this window");
        expect(refused.content[0]!.text).toContain("Commit refused");
      }),
    )({ job: fixture.job });
    expect(firstOutcome.ok).toBe(false);
    expect(getTurnById(db, fixture.turnIds[1]!)).toBeNull();

    // Attempt 2: a genuinely fresh dispatch call — new `runQuery`
    // invocation, new staging engine — against turns that are all still
    // present. The job is still `claimed` under the same generation
    // (nothing moved it), so this models the job's own next attempt rather
    // than a same-run patch.
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        for (const turnId of [fixture.turnIds[0]!, fixture.turnIds[2]!, fixture.turnIds[3]!]) {
          updateTurnById(db, turnId, { type: ["research"] });
        }
        engine.commit("no friction this window");
      }),
    )({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
  });

  /**
   * Spec D4/D6: the subagent may revise a turn from an earlier window that is
   * still in its context — not a loophole, ordinary review-window mechanics.
   * T1's tags from window one are corrected in window two, once T1 is a
   * PRECEDING turn rather than a window turn.
   */
  test("a note call revises a turn settled by an earlier window once it is only in the preceding-turns context", async () => {
    const fixture = seedFourTurnWindow();
    const firstOutcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.writeNote({ turn: "S1/T1", type: ["design"], tags: ["settlement"] });
        engine.writeNote({ turn: "S1/T3", type: ["implement"], tags: ["settlement"] });
        engine.commit("no friction this window");
      }),
    )({ job: fixture.job });
    expect(firstOutcome).toEqual({ ok: true });
    expect(getTurnById(db, fixture.turnIds[0]!)!.tags).toEqual(["settlement"]);

    // A second window, T5-T8: T1-T4 are now PRECEDING turns in its context,
    // not window turns — buildNoteSettlementContext still exposes them (ticket
    // 04: lookback defaults to the window's own size, here 4, which is
    // exactly enough to reach back to T1), which is what makes citing S1/T1
    // legal here.
    for (let promptNumber = 5; promptNumber <= 8; promptNumber += 1) {
      const turnId = seedTurn(fixture.sessionDbId, promptNumber, {
        note: { title: `implement+seam: turn ${promptNumber}`, content: "Noted." },
      });
      seedDebt(turnId, fixture.sessionDbId, promptNumber, "noted", null);
    }
    classifyThrough(fixture.sessionDbId, 8);
    const secondJob = claimWindow(fixture.sessionDbId, 5, 8);

    const secondOutcome = await dispatchWith(
      queryThatStages((engine, request) => {
        // T1's tag turned out wrong — corrected now that its real scale is
        // visible. Tag-mandate ticket 06: the FIRST window's claim wrote
        // those fields, so this run is a different writer and must earn its
        // own grant — the prompt's Step-0 coverage pass, here as the one
        // `recall` the correction depends on. Without it the write is
        // refused with "has not been read this session", which is the pull
        // architecture working, not a regression.
        recallMemory(db, {
          id: "S1/T1",
          filter: { fields: ["metadata", "content", "relations"] },
          turn: 4_000,
          readerId: claimWriterId(request.jobId, request.claimGeneration, request.stage),
          now: () => NOW,
        });
        engine.writeNote({
          turn: "S1/T1",
          type: ["design"],
          tags: ["revised"],
          mode: { type: "write", tags: "write" },
        });
        for (let promptNumber = 5; promptNumber <= 8; promptNumber += 1) {
          engine.writeNote({
            turn: `S1/T${promptNumber}`,
            type: ["implement"],
            tags: ["seam"],
          });
        }
        engine.commit("no friction this window");
      }),
    )({ job: secondJob });

    expect(secondOutcome).toEqual({ ok: true });
    expect(getTurnById(db, fixture.turnIds[0]!)!.tags).toEqual(["revised"]);
    expect(getNoteSettlementJob(db, secondJob.id)!.status).toBe("done");
  });
});

describe("settlement payload at the scheduler seam", () => {
  test("a trigger drains the window through the real payload", async () => {
    const sessionDbId = seedSession();
    if (sessionDbId !== 1) {
      throw new Error("fixture expected session id 1");
    }
    for (let promptNumber = 1; promptNumber <= 4; promptNumber += 1) {
      const turnId = seedTurn(sessionDbId, promptNumber, {
        note: { title: `implement+seam: turn ${promptNumber}`, content: "Noted." },
      });
      seedDebt(turnId, sessionDbId, promptNumber, "noted", null);
    }
    // A 5th, still-open turn: turn 4 alone is not yet decided (spec D10) —
    // this is what makes it so, and it stays outside window 1-4.
    seedTurn(sessionDbId, 5, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 4);

    const scheduler = createNoteSettlementScheduler({
      db,
      // The stub stage 1, NAMED (final review, re-ruling 10) — this file's
      // subject is the window/backfill path, not the topic pass.
      stage1Dispatch: createTransitionOnlyStageOneDispatch(db, () => NOW),
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      nowMs: () => NOW * 1000,
      thresholdTurns: 4,
      dispatch: dispatchWith(
        queryThatStages((engine) => {
          for (let promptNumber = 1; promptNumber <= 4; promptNumber += 1) {
            engine.writeNote({
              turn: `S1/T${promptNumber}`,
              type: ["implement"],
              tags: ["scheduler seam"],
            });
          }
          engine.commit("no friction this window");
        }),
      ),
      logger: { warn: () => {}, error: () => {} },
    });

    const pass = await scheduler.onTurnStop(sessionDbId);
    expect(pass.created).toHaveLength(1);
    expect(pass.dispatched).toHaveLength(1);

    // commit already completed the job and moved the cursor inside its own
    // transaction; the scheduler's completion re-asserts the same facts.
    expect(getNoteSettlementJob(db, pass.created[0]!.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(4);
  });

  test("an empty-handed window (main agent already typed/noted everything, nothing to correct) completes end to end through the scheduler (ticket 05, checklist item 1)", async () => {
    const sessionDbId = seedSession();
    if (sessionDbId !== 1) {
      throw new Error("fixture expected session id 1");
    }
    const t1 = seedTurn(sessionDbId, 1, {
      note: { title: "design+seam: window shape", content: "Chose windows." },
    });
    seedDebt(t1, sessionDbId, 1, "noted", null);
    const t2 = seedTurn(sessionDbId, 2, {
      note: { title: "research+seam: already noted by the main agent", content: "Explored it." },
    });
    seedDebt(t2, sessionDbId, 2, "noted", null);
    updateTurnById(db, t1, { type: ["design"] });
    updateTurnById(db, t2, { type: ["research"] });
    // Turn 3, still open: turn 2 alone is not yet decided (spec D10).
    seedTurn(sessionDbId, 3, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 2);

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const dispatch = createNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      // The model looks, finds nothing to correct or propose, and commits
      // empty-handed — legal by construction after ticket 05's demolition.
      runQuery: queryThatStages((engine) => {
        engine.commit("no friction this window");
      }),
      metrics: (value) => metricsSeen.push(value),
      logger: { warn: () => {}, error: () => {} },
    });
    const scheduler = createNoteSettlementScheduler({
      db,
      // The stub stage 1, NAMED (final review, re-ruling 10) — this file's
      // subject is the window/backfill path, not the topic pass.
      stage1Dispatch: createTransitionOnlyStageOneDispatch(db, () => NOW),
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      nowMs: () => NOW * 1000,
      thresholdTurns: 2,
      dispatch,
      logger: { warn: () => {}, error: () => {} },
    });

    const pass = await scheduler.onTurnStop(sessionDbId);
    expect(pass.dispatched).toHaveLength(1);

    expect(getNoteSettlementJob(db, pass.created[0]!.id)!.status).toBe("done");
    expect(getNoteSettlementCursor(db, sessionDbId)).toBe(2);
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.committed).toBe(true);
    expect(metricsSeen[0]!.commit).toEqual({
      turnsReviewed: 0,
      reviewsYieldedToLateNote: 0,
      proseWritten: 0,
      relationsWritten: 0,
      relationsRestated: 0,
      relationsRetracted: 0,
      sessionNarrativeWritten: 0,
      lanesDeclared: 0,
      lanesDeleted: 0,
      lanesMerged: 0,
      lanesJustified: 0,
      report: "no friction this window",
      // era-grant-by-settlement ticket 02: no era cutoff is recorded in this
      // fixture, so there is nothing to grant relief from.
      eraGranted: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Ticket 06 (read-write-contract spec "重试"): failure classification, both
// the pure classifier and its wiring into the dispatch's own outcome.
// ---------------------------------------------------------------------------

describe("classifySettlementFailure (ticket 06)", () => {
  test("SQLITE_BUSY is transient", () => {
    expect(classifySettlementFailure({ code: "SQLITE_BUSY", message: "database is locked" })).toBe(
      "transient",
    );
  });

  test("a connection-shaped error (ECONNRESET) is transient", () => {
    expect(classifySettlementFailure({ code: "ECONNRESET", message: "socket hang up" })).toBe(
      "transient",
    );
  });

  test("an authentication/invalid-request-shaped error is deterministic", () => {
    expect(classifySettlementFailure({ type: "invalid_request_error", status: 400 })).toBe(
      "deterministic",
    );
  });

  test("an unrecognised error defaults to deterministic (unknown failures do not retry forever)", () => {
    expect(classifySettlementFailure(new Error("something this classifier has never seen"))).toBe(
      "deterministic",
    );
  });
});

describe("the dispatch's own outcome carries a failureClass (ticket 06)", () => {
  test("runQuery throwing a connection-shaped error reports failureClass: transient", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1, { note: { title: "design+seam: x", content: "y" } });
    seedTurn(sessionDbId, 2, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const dispatch = dispatchWith(async () => {
      throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    });
    const outcome = await dispatch({ job });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failureClass).toBe("transient");
  });

  test("runQuery returning normally but the job never committing reports failureClass: deterministic", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1, { note: { title: "design+seam: x", content: "y" } });
    seedTurn(sessionDbId, 2, { userPrompt: "still open" });
    classifyThrough(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    // The model's run ends normally (no thrown error) but never calls commit
    // — exactly what a Stop-hook-blocked-then-exhausted run looks like from
    // the dispatch's own vantage point.
    const dispatch = dispatchWith(
      queryThatStages(() => {
        /* never commits */
      }),
    );
    const outcome = await dispatch({ job });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failureClass).toBe("deterministic");
  });
});

/**
 * rubric-v10 ticket 06: a run that never calls `lane_check` gets a
 * LOG-LEVEL reminder only — never a block, and never a factor in this
 * dispatch's own ok/failure verdict. `queryThatStages` never touches the
 * `lane_check` tool at all (it drives the direct-write engine directly),
 * so its `NoteSettlementQueryResult` carries no `laneCheckCalled` field —
 * exactly the "a stub that says nothing" case `laneCheckCalled?: boolean`'s
 * own `?? false` default exists for.
 */
describe("lane_check reminder (rubric-v10 ticket 06) — advisory, never a block", () => {
  test("a committed window that never called lane_check logs a reminder, and still reports ok:true", async () => {
    const fixture = seedFourTurnWindow();
    const warnings: string[] = [];
    const dispatch = createNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      runQuery: queryThatStages((engine) => {
        engine.commit("no friction this window");
      }),
      logger: {
        warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
        error: () => {},
      },
    });

    const outcome = await dispatch({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    expect(getNoteSettlementJob(db, fixture.job.id)!.status).toBe("done");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("reminder");
    expect(warnings[0]).toContain("lane_check");
    expect(warnings[0]).toContain(`job ${fixture.job.id}`);
  });

  test("a run whose runQuery reports laneCheckCalled: true logs no reminder", async () => {
    const fixture = seedFourTurnWindow();
    const warnings: string[] = [];
    const dispatch = createNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      runQuery: async (request) => {
        const staged = queryThatStages((engine) => {
          engine.commit("no friction this window");
        });
        const result = await staged(request);
        return { ...result, laneCheckCalled: true };
      },
      logger: {
        warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
        error: () => {},
      },
    });

    const outcome = await dispatch({ job: fixture.job });

    expect(outcome).toEqual({ ok: true });
    expect(warnings).toHaveLength(0);
  });

  test("a run that ends without committing STILL logs the reminder, and the reminder never changes the failure verdict", async () => {
    const sessionDbId = seedSession();
    seedTurn(sessionDbId, 1, { note: { title: "design+seam: x", content: "y" } });
    classifyThrough(sessionDbId, 1);
    const job = claimWindow(sessionDbId, 1, 1);

    const warnings: string[] = [];
    const dispatch = createNoteSettlementDispatch({
      db,
      config: SETTLEMENT_ENABLED_CONFIG,
      now: () => NOW,
      runQuery: queryThatStages(() => {
        /* never commits, never calls lane_check either */
      }),
      logger: {
        warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
        error: () => {},
      },
    });

    const outcome = await dispatch({ job });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failureClass).toBe("deterministic");
    expect(warnings.some((line) => line.includes("lane_check"))).toBe(true);
  });
});

/**
 * THE IMMUTABLE WRITABLE SET (tag-mandate ticket 05, spec "the writable set
 * is IMMUTABLE and declared"). Proved at the DISPATCH, which is the only
 * place it is computed: the range check inside the facade and the commit
 * gate inside the query layer both read this one value, so a dispatch that
 * declared the wrong set would fork them silently.
 */
describe("the dispatch declares one immutable writable set (tag-mandate ticket 05)", () => {
  test("the request carries window ∪ rendered lookback ∪ the deadlock-guard closure", async () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1, { note: { title: "one", content: "first" } });
    const t2 = seedTurn(sessionDbId, 2, { note: { title: "two", content: "second" } });
    const t3 = seedTurn(sessionDbId, 3, { note: { title: "three", content: "third" } });
    const t4 = seedTurn(sessionDbId, 4, { note: { title: "four", content: "fourth" } });

    // T4 continues T1 with an UNTAGGED extends — the mandate's own stock
    // case. T1 is far enough back that the render never shows it, so without
    // the closure the repair (tag the edge; the subset invariant needs the
    // tag on both endpoints) would be unreachable and the window would be
    // pinned on a commit it could never satisfy.
    writeMemoryEdges(
      db,
      [
        {
          citing: { kind: "turn", id: t4 },
          cited: { kind: "turn", id: t1 },
          relation: "extends",
          provenance: "asserted",
          ...deriveSideTags([]),
        },
      ],
      NOW,
    );

    // A one-turn window: the lookback defaults to the window's own size, so
    // the RENDER reaches back exactly to T3 and T1/T2 stay off-screen.
    const job = claimWindow(sessionDbId, 4, 4);

    let seen: NoteSettlementQueryRequest | null = null;
    await dispatchWith(async (request) => {
      seen = request;
      return { text: "no commit", commitMetrics: null };
    })({ job });

    const request = seen as NoteSettlementQueryRequest | null;
    expect(request).not.toBeNull();
    expect([...request!.writableTurnIds].sort((a, b) => a - b)).toEqual([t1, t3, t4]);
    // T2 is neither rendered nor an endpoint of any in-scope edge: the
    // closure widens for repairability, never for convenience.
    expect(request!.writableTurnIds.has(t2)).toBe(false);

    // Settlement-ergonomics ticket 07 (spec D0/D5): the SAME set, threaded
    // to the request a second way — carved by error origin. This fixture is
    // exactly the "one of each" case the ticket names: T4 is this job's own
    // window, T3 is the declared lookback (the window's own size, 1, reaches
    // back exactly one turn), and T1 arrives ONLY through the deadlock-guard
    // closure over T4's untagged edge.
    expect(request!.scopeProvenance).toEqual({
      window: new Set([t4]),
      baseLookback: new Set([t3]),
      closureOnly: new Set([t1]),
    });
  });
});

// ---------------------------------------------------------------------------
// era-grant-by-settlement ticket 02: the grant count reaches the operator on
// the SAME `[claude-mnemo] note-settlement` metrics line the commit counts
// already ride, as `commit.eraGranted` — proved here at the DISPATCH seam
// (`createNoteSettlementDispatch`, note-settlement-dispatch.ts), the layer
// that actually assembles and emits that line.
// ---------------------------------------------------------------------------

describe("era-grant-by-settlement ticket 02: the grant count reaches the metrics line", () => {
  const CUTOFF = NOW + 1;

  function grantEpoch(turnId: number): number | null {
    return (
      db
        .query<{ epoch: number | null }, [number]>(
          `SELECT ${ERA_GRANT_COLUMN} AS epoch FROM turns WHERE id = ?`,
        )
        .get(turnId)?.epoch ?? null
    );
  }

  /** The only way a forward job may cover a pre-era window (insertJob's era floor). */
  function claimBackfillWindow(
    sessionDbId: number,
    windowStart: number,
    windowEnd: number,
  ): NoteSettlementJob {
    const inserted = enqueueBackfillNoteSettlementJob(
      db,
      sessionDbId,
      windowStart,
      windowEnd,
      NOW,
      CUTOFF,
      { allowPreEra: true },
    );
    if (!inserted.ok) {
      throw new Error(`fixture failed to enqueue backfill window: ${inserted.reason}`);
    }
    const job = claimNextNoteSettlementJob(db, sessionDbId, NOW, NOW * 1000);
    if (!job) {
      throw new Error("fixture failed to claim the backfill job");
    }
    return job;
  }

  test("a settlement commit over a pre-era window reports its grant count on the note-settlement metrics line", async () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    const t2 = seedTurn(sessionDbId, 2);
    ensureRecordedEraCutoff(db, CUTOFF);
    const job = claimBackfillWindow(sessionDbId, 1, 2);

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages((engine) => {
        engine.commit("regrading a pre-era window under the current model");
      }),
      (value) => metricsSeen.push(value),
    )({ job });

    expect(outcome).toEqual({ ok: true });
    expect(metricsSeen).toHaveLength(1);
    // The metrics payload `createNoteSettlementDispatch` emits: the grant
    // rides `commit`, the SAME field the other commit counts already ride
    // (decision 4/6) — not a second, top-level field.
    expect(metricsSeen[0]!.commit).not.toBeNull();
    expect(metricsSeen[0]!.commit!.eraGranted).toBe(2);
    expect(grantEpoch(t1)).toBe(NOW);
    expect(grantEpoch(t2)).toBe(NOW);
  });

  test("a post-era window's metrics line states zero explicitly, matching how the neighbouring counts report an empty-handed run", async () => {
    const fixture = seedFourTurnWindow();
    // A REAL recorded cutoff, well before every fixture turn's own
    // created_at_epoch (NOW - 999..NOW - 996) — genuinely post-era, not
    // merely "no boundary recorded at all" (a different branch, covered by
    // its own test in note-settlement-direct-write.test.ts).
    ensureRecordedEraCutoff(db, NOW - 2_000);

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    await dispatchWith(
      queryThatStages((engine) => {
        engine.commit("no friction this window");
      }),
      (value) => metricsSeen.push(value),
    )({ job: fixture.job });

    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.commit).not.toBeNull();
    // Not zero-suppressed — `turnsReviewed`/`proseWritten`/etc. all render
    // their 0 explicitly on this same object, and `eraGranted` matches that
    // convention rather than inventing its own.
    expect(metricsSeen[0]!.commit).toHaveProperty("eraGranted", 0);
  });

  test("a run that never commits (gate refusal) grants nothing and the metrics line's commit is null, not zero", async () => {
    const sessionDbId = seedSession();
    const t1 = seedTurn(sessionDbId, 1);
    ensureRecordedEraCutoff(db, CUTOFF);
    const job = claimBackfillWindow(sessionDbId, 1, 1);

    const metricsSeen: NoteSettlementWindowMetrics[] = [];
    const outcome = await dispatchWith(
      queryThatStages(() => {
        // The agent looked and stopped without ever calling commit.
      }),
      (value) => metricsSeen.push(value),
    )({ job });

    expect(outcome.ok).toBe(false);
    expect(metricsSeen).toHaveLength(1);
    expect(metricsSeen[0]!.committed).toBe(false);
    expect(metricsSeen[0]!.commit).toBeNull();
    expect(grantEpoch(t1)).toBeNull();
  });
});
