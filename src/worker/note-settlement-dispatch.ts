import type { Database } from "bun:sqlite";

import { isSqliteBusy } from "../db/database";
import {
  completeNoteSettlementJob,
  computeSettlementWritableTurnIds,
  getNoteSettlementJob,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  type NoteSettlementFailureClass,
  type NoteSettlementJob,
  type NoteSettlementStage,
} from "../db/note-settlement";
import type { MnemoConfig } from "../shared/config";
import { DEFAULT_CONFIG, DEFAULT_NOTE_SETTLEMENT_MODEL } from "../shared/config";
import { classifyWorkerError } from "./error-classifier";
import {
  buildNoteSettlementContext,
  resolveSettlementScopeProvenance,
  resolveSettlementWritableSet,
  type NoteSettlementContext,
  type SettlementScopeProvenance,
} from "./note-settlement-context";
import type { NoteSettlementCommitRecord } from "./note-settlement-direct-write";
import {
  NOTE_SETTLEMENT_SYSTEM_PROMPT,
  renderNoteSettlementPrompt,
} from "./note-settlement-prompt";
import { buildSettlementWorklistRendering } from "./note-settlement-shape-numbers";
// claim-monitor-repair ticket 02 (peer round 2, gate 6): the frozen-scope
// installer comes from its OWN module now, not from the SDK query's. This is
// the last value edge the worker core had into `note-settlement-sdk-query.ts`
// — one such edge is enough to bundle the whole model client into worker.cjs
// — and the types beside it are erased, so nothing of the settlement model
// reaches this process any more.
import { installSettlementEdgesScope } from "./note-settlement-edges-scope";
import type {
  NoteSettlementUnifiedQuery,
  NoteSettlementUnifiedQueryResult,
} from "./note-settlement-sdk-query";
import {
  NOTE_SETTLEMENT_UNIFIED_SYSTEM_PROMPT,
  renderNoteSettlementUnifiedPrompt,
} from "./note-settlement-unified-prompt";
import type {
  NoteSettlementDispatch,
  NoteSettlementDispatchOutcome,
} from "./note-settlement";

/**
 * Ticket 06 (read-write-contract spec "重试"): map a `runQuery` failure onto
 * settlement's own two-class retry vocabulary — reusing the extraction
 * pipeline's already-audited signal classifier (`error-classifier.ts`,
 * 0.6.6's retry philosophy) rather than a second, independently maintained
 * set of network-error heuristics. `isSqliteBusy` is checked first because a
 * local SQLITE_BUSY (the database's own writer lock, not an Anthropic API
 * response) carries none of `classifyWorkerError`'s HTTP-shaped signals and
 * would otherwise fall through to its conservative "unknown -> deterministic"
 * default — exactly the one SQLITE_BUSY is named as transient for in the
 * spec's own "网络/连接/SQLITE_BUSY" list. Every OTHER classification
 * (`"deterministic" | "blocked" | "extraction-stall"`) collapses to
 * settlement's `"deterministic"`: settlement's retry state machine has only
 * two classes, and an unrecognised or account-level failure is exactly the
 * kind that must not retry forever on its own.
 */
export function classifySettlementFailure(error: unknown): NoteSettlementFailureClass {
  if (isSqliteBusy(error)) {
    return "transient";
  }
  return classifyWorkerError(error) === "connection" ? "transient" : "deterministic";
}

/**
 * The existing per-row error budget (`db/note-settlement.ts`'s own
 * `reason.slice(0, 500)` on every `last_error` write) — named here so this
 * module's own composition targets the SAME number rather than a second
 * literal.
 */
export const SETTLEMENT_DIAGNOSIS_BUDGET_CHARS = 500;

/**
 * DIAGNOSIS COMPOSITION (settlement-execution-repair spec Rev 5, peer P1-7;
 * ticket 04 pinned decision). The DISPATCH — never the scheduler — builds
 * `last_error`: a stage marker, a mechanical conclusion, and the run's own
 * final assistant text, truncated ONCE to the existing 500-character budget.
 * `failNoteSettlementJob`'s own `.slice(0, 500)` becomes a redundant safety
 * net once every caller already produces a string under budget — it is not
 * removed, because a caller this module does not control (a thrown error's
 * raw message, say) still needs it.
 *
 * The assistant text's TAIL is kept when something must go: the diagnosis a
 * run leaves for the operator conventionally ends its own reply (a closing
 * sentence after the last tool call), so trimming from the FRONT of that text
 * — never from the fixed, short stage-marker/conclusion prefix — is what
 * keeps it. No path may replace this composition with a generic reason once a
 * final text exists (the retired chain branch's discard behaviour dies with
 * it).
 */
export function composeSettlementDiagnosis(
  stage: NoteSettlementStage,
  mechanicalConclusion: string,
  finalText: string,
): string {
  const head = `stage ${stage}: ${mechanicalConclusion}`;
  const tail = finalText.trim();
  if (tail === "") {
    return head.slice(0, SETTLEMENT_DIAGNOSIS_BUDGET_CHARS);
  }
  const separator = " — ";
  const full = `${head}${separator}${tail}`;
  if (full.length <= SETTLEMENT_DIAGNOSIS_BUDGET_CHARS) {
    return full;
  }
  const prefix = `${head}${separator}`;
  if (prefix.length >= SETTLEMENT_DIAGNOSIS_BUDGET_CHARS) {
    // The fixed prefix alone already exceeds the budget — keep ITS own tail
    // rather than drop the diagnosis outright; there is no room left for any
    // of the assistant text.
    return prefix.slice(prefix.length - SETTLEMENT_DIAGNOSIS_BUDGET_CHARS);
  }
  const remaining = SETTLEMENT_DIAGNOSIS_BUDGET_CHARS - prefix.length;
  return prefix + tail.slice(tail.length - remaining);
}

/**
 * The real settlement payload: assemble the window's context, run ONE
 * stateless Sonnet call in a subprocess against the staged write tools
 * (`remember`/`note`/`commit`, note-settlement-sdk-query.ts), and read back
 * whatever the run actually landed.
 *
 * It plugs into the dispatch seam unchanged — `(job) => verdict` — so every
 * scheduling property (lease, generation fence, backoff, cursor) stays
 * exactly where it was proved. What this module adds is the payload, and its
 * only contract with the machine is the verdict it returns: `ok:false` means the
 * window is unsettled and may be retried, `ok:true` means the window's effects
 * are already durable.
 *
 * This module reads no envelope of any kind — the settlement agent's WORK
 * lands as it happens, one staged tool call at a time, and durability is
 * decided entirely by whether the agent's own `commit` call succeeded
 * (note-settlement-staging.ts), inside the subprocess. This function's whole
 * job after `runQuery` returns is to look: `commit`'s completion gate is the
 * ONLY path that can move a job to `done`, so re-reading the job row is a
 * complete answer to "did this run settle its window" — no parsing, no
 * reconciliation, no replay.
 *
 * `metrics()` below reads `commit`'s own replay counts, returned by
 * `runQuery` itself (`NoteSettlementQueryResult.commitMetrics`, sourced from
 * `note-settlement-staging.ts`'s `getLastCommitMetrics`), which is a fact
 * about what THIS run's `commit` actually landed, never a guess.
 *
 * TICKET 05'S DEMOLITION (ownership-and-note-cadence spec): the
 * summary-contradiction check (`db/note-settlement-summary-flags.ts`) is
 * DELETED along with the segment-field reading it depended on — settlement
 * no longer reads a segment's content/insight at all. `reconstructableTurnIds`/
 * `rideTurnId`/`writerModel` (duty 2's own plumbing) and `attachedSegmentIds`
 * (ticket 08's membership domain, deleted by ticket 04 along with the
 * restriction it encoded) are gone from the query request for the same
 * reason: nothing on the other side of the subprocess boundary reads them any
 * more.
 */

/**
 * Spec D9: settlement runs on Sonnet, by user decision (裁决 10).
 *
 * Re-exported from shared/config.ts's `DEFAULT_NOTE_SETTLEMENT_MODEL` (ticket
 * 02, [S15069/T1017]): the model is config-tunable (`noteSettlementModel`) now
 * — this stays the fallback `createNoteSettlementDispatch` uses when the
 * assembly site (worker/server.ts) does not supply an override, and a valid
 * import path for anything that still names this constant directly.
 */
export const NOTE_SETTLEMENT_MODEL = DEFAULT_NOTE_SETTLEMENT_MODEL;

export interface NoteSettlementQueryRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  /**
   * Ticket 01 (S15069/T1433-T1435): the settlement agent's own thinking-token
   * budget, resolved from `noteSettlementMaxThinkingTokens`. `null` or
   * omitted means the SDK query's `maxThinkingTokens` option is left out
   * entirely — same as `model`, the resolved config value travels on the
   * request rather than being read again inside the query layer.
   */
  maxThinkingTokens?: number | null;
  signal?: AbortSignal;
  /**
   * Job identity and the write facades' per-dispatch scope (ticket 10a/10b,
   * spec G6). Carried on the REQUEST rather than closed over at
   * `createNoteSettlementDispatch` construction time, because a job (and its
   * reconstructable/reviewable/exposed scope) exists only per call — one
   * dispatch instance serves every window a session ever produces. The SDK
   * query layer (note-settlement-sdk-query.ts) is what actually keeps these
   * out of the model's reach, by injecting them into a staging-engine
   * closure the model's own tool input schemas have no field for.
   */
  jobId: number;
  claimGeneration: number;
  /**
   * The THIRD member of the ownership tuple `(job, claimGeneration, stage)`
   * (staged-settlement spec Rev 5, §Identity and authorization) — `job.stage`,
   * verbatim off the row this dispatch claimed.
   *
   * Everything the query layer authorizes keys on it: the writer identity
   * `claimWriterId` builds (and with it read grants, per-field completeness,
   * the relations gate and lane-read receipts), and the `expectedStage` fence
   * every direct write asserts. Stage 2 therefore inherits no authority stage 1
   * earned, and a stale stage-1 context — whose claim GENERATION is still
   * valid, because the generation deliberately does not bump at the transition
   * — writes nothing into a job stage 2 owns.
   *
   * Required, deliberately: a default would file a stage-2 dispatch under stage
   * 1's identity, which is the inheritance the tuple exists to forbid.
   */
  stage: NoteSettlementStage;
  sessionId: number;
  /**
   * The IMMUTABLE WRITABLE SET (tag-mandate ticket 05, spec "the writable set
   * is IMMUTABLE and declared") — `db/note-settlement.ts`'s
   * `computeSettlementWritableTurnIds` over the context's rendered turns:
   * window ∪ rendered lookback ∪ the deadlock-guard closure (the cited
   * endpoints of in-scope-anchored edges). Computed ONCE, here, before the
   * model runs, and it is the SINGLE definition three things read:
   *
   *   1. the turn facade's own writable-range check (its
   *      `SettlementTurnFacadeContext.reviewableTurnIds`, fed verbatim from
   *      this field by `note-settlement-sdk-query.ts` — that field keeps its
   *      older name only because the membership facade shares it; it carries
   *      THIS set, not a separately computed one);
   *   2. the commit gate, which refuses while any checker error anchors
   *      inside it (`note-settlement-sdk-query.ts`);
   *   3. the prompt, which declares it to the agent (ticket 06).
   *
   * It was `reviewableTurnIds` (window ∪ RENDERED lookback) before this
   * ticket. The rename is the honest one: the closure adds ids this prompt
   * never rendered, so "reviewable" stopped describing it, and a gate that
   * judged one set while the facade enforced another would be the fork this
   * spec's whole "immutable and declared" clause exists to forbid.
   */
  writableTurnIds: ReadonlySet<number>;
  /**
   * The SAME set as `writableTurnIds` above, carved by ERROR ORIGIN rather
   * than by render shape (settlement-ergonomics ticket 07, spec D0/D5):
   * `note-settlement-context.ts`'s `resolveSettlementScopeProvenance`, three
   * frozen, mutually exclusive buckets — this job's own `window`, the
   * DECLARED `baseLookback`, and `closureOnly` (the deadlock-guard closure's
   * own additions). Computed from the identical `writableTurnIds` value
   * above, so the two can never disagree about which ids exist — only about
   * which of the three each one is filed under.
   *
   * NOT a writability split. `resolveSettlementWritableSet`'s collapse of
   * rendered lookback and closure into one list stands untouched, and all
   * three buckets here remain equally writable — see that function's own
   * comment. What this adds is a DIFFERENT AXIS, consumed by exactly one
   * reader: `note-settlement-sdk-query.ts`'s `evaluateSettlementCommitGate`,
   * to partition a commit refusal's finding list by where each finding
   * anchors, so the agent can tell its own window's mistakes from a lookback
   * turn's or an edge-dragged endpoint's (measured on a real run: 63 refusal
   * errors in one undifferentiated list, spread across all three origins).
   *
   * Optional — a `NoteSettlementQuery` stub predating this ticket, or one
   * that never models the distinction, keeps compiling and keeps getting the
   * OLD flat, undifferentiated refusal list; `createNoteSettlementDispatch`
   * (the one production caller) always supplies it.
   */
  scopeProvenance?: SettlementScopeProvenance;
  contextBuiltAtEpoch: number;
  /**
   * The settled window's own prompt-number bounds (rubric-v10 ticket 06):
   * the `lane_check` tool's scope, exactly `job.windowStart`/`windowEnd` —
   * not `writableTurnIds`, which also carries the rendered LOOKBACK turns
   * and the deadlock-guard closure. A lane check runs over the window being
   * settled, same as the spec's own "may run it over its window's lanes".
   *
   * Tag-mandate ticket 05: the commit GATE runs that same projection over
   * this same window scope, then filters the resulting errors by
   * `writableTurnIds`. Scope and verdict are two different questions — one
   * projection decides what is TRUE, the set decides what is THIS RUN'S to
   * fix.
   */
  windowStart: number;
  windowEnd: number;
  // Ticket 04 (edge-mechanism-revision D6): `eligibleRelationPairKeys` — spec
  // C7's frozen pre-run pair snapshot — is gone from this request, and
  // `getExistingEdgePairKeys` (the query that built it) is gone from
  // `db/memory-edges.ts` with it. A relation is a standalone claim now, so
  // there is no pre-state for it to be eligible against.
}

/**
 * What one query call produces, once the model's run has fully ended (ticket
 * 10c). `text` is whatever final message the model produced after its tool
 * calls — no longer a structured envelope this module parses (ticket 10b);
 * it is not inspected for correctness, `commit`'s own effect on the job row
 * is. `commitMetrics` is `commit`'s own replay result (null if the run never
 * committed), read by the query implementation ONLY after the model's run
 * has ended and never exposed to the model as a tool result — see
 * `note-settlement-staging.ts`'s `getLastCommitMetrics` doc comment for why
 * that ordering is what makes the counts inside it safe under spec G9.
 */
export interface NoteSettlementQueryResult {
  text: string;
  /** Settlement-commit-report ticket 01: rides this same field with no shape change of its own — `commitMetrics.report` is the run's required friction report, set once at the first successful `commit`. */
  commitMetrics: NoteSettlementCommitRecord | null;
  /**
   * Ticket 06: whether THIS run's `lane_check` tool was ever called.
   * Optional (defaults to `false` when a caller omits it) so every existing
   * `NoteSettlementQuery` stub predating this ticket keeps compiling
   * unchanged — the reminder below degrades to "never called" for a stub
   * that says nothing, which is the honest reading for a fixture that never
   * modeled this tool at all.
   */
  laneCheckCalled?: boolean;
}

/**
 * The subprocess boundary. The worker hosts no model in-process (D10), so this
 * is always a spawned child; it is injectable so tests stub it and never reach
 * a network.
 */
export type NoteSettlementQuery = (
  request: NoteSettlementQueryRequest,
) => Promise<NoteSettlementQueryResult>;

export interface NoteSettlementWindowMetrics {
  jobId: number;
  sessionId: number;
  windowStart: number;
  windowEnd: number;
  triggerType: NoteSettlementJob["triggerType"];
  windowTurns: number;
  /** Did the run's own `commit` call land the window (job status read back `done`)? */
  committed: boolean;
  /** This dispatch's own attempt number against the job row (1 = first claim). */
  attempt: number;
  /**
   * True when this was the job's LAST allowed attempt and it did not commit.
   * The scheduler's own cursor logic then walks past this window for good
   * (db/note-settlement.ts's `advanceNoteSettlementCursor`, A2a) — spec's
   * three-strike policy ABANDONS the remainder here, it does not converge
   * toward eventually settling it. `attemptsExhausted: true` is that
   * abandonment being logged, not evidence of a bug this dispatch caused.
   */
  attemptsExhausted: boolean;
  /**
   * What `commit` itself landed, sourced from its own replay
   * (`note-settlement-staging.ts`'s `getLastCommitMetrics`) rather than from
   * a payload nobody sends any more (ticket 10c). Null when `committed` is
   * false — nothing landed, so there is nothing to count. The counts inside
   * are for THIS log line only (spec G9): never returned to the agent at
   * any point before this line runs. era-grant-by-settlement ticket 02: the
   * era-grant count rides this SAME field, as `commit.eraGranted` — the
   * path the other commit counts already ride, not a second one.
   */
  commit: NoteSettlementCommitRecord | null;
  /** Ticket 06: whether this run's `lane_check` tool was ever called — a reminder-only signal, never a factor in `committed`/failure accounting. */
  laneCheckCalled: boolean;
}

export type NoteSettlementMetricsSink = (
  metrics: NoteSettlementWindowMetrics,
) => void;

export interface CreateNoteSettlementDispatchOptions {
  db: Database;
  runQuery: NoteSettlementQuery;
  config?: MnemoConfig;
  /** Epoch seconds. */
  now?: () => number;
  model?: string;
  metrics?: NoteSettlementMetricsSink;
  logger?: NoteSettlementDispatchLogger;
  /**
   * The same three-strike cap the scheduler's own claim/fail path enforces
   * (db/note-settlement.ts). Duplicated here as a metrics-only reading, not a
   * second source of truth for retry behaviour: this module never writes
   * `attempts` or decides terminality, it only reports what `job.attempts`
   * already says against this ceiling, for the job-log line (ticket 10c).
   */
  maxAttempts?: number;
}

/**
 * The worker's logger exposes `info` where `console` exposes `log`; the metrics
 * line goes to whichever is present, so the same dispatch works under both.
 */
export type NoteSettlementDispatchLogger = Pick<Console, "warn" | "error"> &
  Partial<Pick<Console, "log" | "info">>;

export const NOTE_SETTLEMENT_METRICS_PREFIX = "[claude-mnemo] note-settlement";

export function defaultNoteSettlementMetricsSink(
  logger: Partial<Pick<Console, "log" | "info">> = console,
): NoteSettlementMetricsSink {
  return (metrics) => {
    const line = `${NOTE_SETTLEMENT_METRICS_PREFIX} ${JSON.stringify(metrics)}`;
    if (logger.info) {
      logger.info(line);
      return;
    }
    logger.log?.(line);
  };
}

/**
 * THE EMPTY-WINDOW TERMINAL EXCEPTION (ticket 12 Part B; peer P1). The one
 * dispatch-side path allowed to call `completeNoteSettlementJob` directly:
 * a window whose turns were deleted out from under it has nothing for the
 * model to settle, so there is no run to trust and no `ok: true` this
 * dispatch could return without the row already showing `done` would
 * survive the scheduler's own phantom-completion rule
 * (`worker/note-settlement.ts`: any row still `claimed` with `ok: true` is a
 * deterministic failure, whatever stage it is claimed at). Both dispatch
 * shapes below (the resume dispatch and the unified dispatch) call this SAME
 * helper, so the terminal write and the reasoning behind it never drift
 * apart between the two copies.
 *
 * A CAS loss here (the row moved under a concurrent reclaim) is not an
 * error: the scheduler's own re-read sees the same row and classifies it
 * correctly either way — this call's own `ok: true` describes what THIS
 * dispatch did, not a promise about what the row will show.
 */
function completeEmptyWindowSettlement(
  db: Database,
  job: NoteSettlementJob,
  nowEpoch: number,
): NoteSettlementDispatchOutcome {
  completeNoteSettlementJob(db, job.id, nowEpoch, job.claimGeneration);
  return { ok: true };
}

export function createNoteSettlementDispatch(
  options: CreateNoteSettlementDispatchOptions,
): NoteSettlementDispatch {
  const db = options.db;
  const config = options.config ?? DEFAULT_CONFIG;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const model = options.model ?? NOTE_SETTLEMENT_MODEL;
  const logger = options.logger ?? console;
  const metrics = options.metrics ?? defaultNoteSettlementMetricsSink(logger);
  const maxAttempts = options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS;

  return async ({ job }): Promise<NoteSettlementDispatchOutcome> => {
    if (!config.settlementEnabled) {
      // Configuration, not a runtime failure of any kind — deterministic by
      // construction: retrying without a config change would fail identically.
      return { ok: false, reason: "note settlement is disabled", failureClass: "deterministic" };
    }

    const nowEpoch = now();
    const context: NoteSettlementContext | null = buildNoteSettlementContext(db, job, {
      nowEpoch,
    });
    if (!context) {
      // A structural data problem (the window's own session row is gone),
      // not a network/connection signal — deterministic.
      return {
        ok: false,
        reason: `note settlement window has no session ${job.sessionId}`,
        failureClass: "deterministic",
      };
    }
    if (context.windowTurns.length === 0) {
      // Nothing to settle — the empty-window terminal exception (ticket 12
      // Part B; see `completeEmptyWindowSettlement`'s own doc comment).
      return completeEmptyWindowSettlement(db, job, nowEpoch);
    }

    // ONE DURABLE TRUTH, AND THE PROMPT READS IT TOO (final review, finding
    // 7). The transition's own snapshot is this pass's authority — the SDK
    // query reads it and lets it WIN over anything the request carried — so a
    // set recomputed live here would be a second answer to the same question,
    // and the two come apart the moment anything writes an edge between the
    // transition and this dispatch: `computeSettlementWritableTurnIds` follows
    // live edges into their cited endpoints, so a concurrent write widens the
    // live set and the PROMPT would then declare turns the gate refuses. Worse
    // per RETRY: each attempt recomputed a different scope while the authority
    // never moved.
    //
    // `null` is the honest "this job never transitioned" (a pre-staging row);
    // only then does the live computation stand, which is exactly the
    // pre-staging behaviour. Routed through the SAME `installSettlementEdgesScope`
    // the SDK query itself calls (ticket 02's own install seam; ticket 04
    // amendment b) rather than a second hand-rolled `frozen?.field ?? live`
    // fallback — one function owns "frozen wins when it exists", so this
    // dispatch and the query it calls can never drift on the decision, even
    // though each still reads the persisted snapshot once on its own side of
    // the call.
    const liveWritableTurnIds = computeSettlementWritableTurnIds(
      db,
      context.reviewableTurnIds,
    );
    const liveScopeProvenance = resolveSettlementScopeProvenance(
      context,
      liveWritableTurnIds,
    );
    const scopeHolder = installSettlementEdgesScope(db, job.id, {
      writableTurnIds: liveWritableTurnIds,
      scopeProvenance: liveScopeProvenance,
    });
    // Tag-mandate ticket 05: the immutable writable set, resolved HERE —
    // before the prompt is rendered and before the model exists — so the
    // range check, the commit gate and (ticket 06) the prompt's own
    // declaration all read one value that cannot move mid-run.
    const writableTurnIds = scopeHolder.current.writableTurnIds;
    // Tag-mandate ticket 06: the SAME set, in the address vocabulary the
    // prompt declares and every write call takes. Resolved from
    // `writableTurnIds` itself rather than re-derived from the context, so
    // the printed declaration and the enforced set can never disagree — the
    // fork the spec's "immutable and declared" clause exists to forbid.
    const writableSet = resolveSettlementWritableSet(db, context, writableTurnIds);
    // Settlement-ergonomics ticket 07 (spec D0/D5): the SAME writableTurnIds,
    // carved by error origin rather than by render shape — the snapshot's own
    // three-bucket carve when there is one, so the refusal renderer and the
    // phase-connectivity window read the same classes the gate does.
    const scopeProvenance = scopeHolder.current.scopeProvenance ?? liveScopeProvenance;

    let queryResult: NoteSettlementQueryResult;
    try {
      queryResult = await options.runQuery({
        // Staged settlement (ticket 07's snapshots, ticket 08's retirement of
        // the single-pass flow): the stage-1 transition's three snapshots,
        // resolved to addresses. Unconditional now — this pass is always the
        // second of two, so the prompt always says so and always declares a
        // worklist, empty or not. There is no longer a rendering that would
        // address a run doing both jobs at once.
        prompt: renderNoteSettlementPrompt(
          context,
          writableSet,
          buildSettlementWorklistRendering(db, job.id),
        ),
        systemPrompt: NOTE_SETTLEMENT_SYSTEM_PROMPT,
        model,
        maxThinkingTokens: config.noteSettlementMaxThinkingTokens,
        jobId: job.id,
        claimGeneration: job.claimGeneration,
        // The ownership tuple's third member, straight off the claimed row.
        stage: job.stage,
        sessionId: job.sessionId,
        writableTurnIds,
        scopeProvenance,
        contextBuiltAtEpoch: context.builtAtEpoch,
        windowStart: job.windowStart,
        windowEnd: job.windowEnd,
      });
    } catch (error) {
      return {
        ok: false,
        reason: `note settlement call failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        failureClass: classifySettlementFailure(error),
      };
    }

    // Requirement 9: `commit` (inside the subprocess, note-settlement-
    // staging.ts) is the ONLY path that can move this job to `done` — there
    // is no envelope here to parse and no write-back transaction to apply.
    // Re-reading the row is a COMPLETE answer to "did this run settle its
    // window": `commit`'s completion gate runs under the same ownership
    // fence a stale attempt would fail, so a `done` read here can only be
    // this run's own doing or a strictly newer one's — either way the
    // scheduler's own post-hoc reconciliation (worker/note-settlement.ts)
    // is what tells those two apart, exactly as it already does for the
    // "payload settles its own window" case that predates this ticket.
    const settled = getNoteSettlementJob(db, job.id);
    const committed = settled?.status === "done";

    metrics({
      jobId: job.id,
      sessionId: job.sessionId,
      windowStart: job.windowStart,
      windowEnd: job.windowEnd,
      triggerType: job.triggerType,
      windowTurns: context.windowTurns.length,
      committed,
      attempt: job.attempts,
      // Abandonment, not convergence (spec A2a): this attempt consumed the
      // job's LAST life and still did not commit. The scheduler's own
      // cursor advance is what actually walks past the window
      // (db/note-settlement.ts) — this flag only reports that fact for the
      // operator, from the same `job.attempts` the claim already
      // incremented before this dispatch ran.
      attemptsExhausted: !committed && job.attempts >= maxAttempts,
      commit: committed ? queryResult.commitMetrics : null,
      laneCheckCalled: queryResult.laneCheckCalled ?? false,
    });

    // Ticket 06 (spec "settlement agent (v2 duty)"): a REMINDER, never a
    // block and never a factor in this dispatch's own ok/failure verdict —
    // the lane checker is advisory (spec: "findings enter the agent's
    // EXISTING supply/correct/propose judgment... never an automatic write
    // obligation"), so a run that settled its window cleanly without ever
    // consulting it is not a bug, only something worth a log line for an
    // operator watching the metrics stream.
    if (!(queryResult.laneCheckCalled ?? false)) {
      logger.warn(
        `${NOTE_SETTLEMENT_METRICS_PREFIX} reminder: job ${job.id} (S${job.sessionId} T${job.windowStart}-${job.windowEnd}) completed without ever calling lane_check`,
      );
    }

    if (!committed) {
      // Ticket 06 (pinned decision): the run ENDED (no thrown/transient
      // error — `runQuery` returned normally) but its window never landed —
      // an agent that stopped without calling `commit`, or a `commit` that
      // refused for a structural reason. There is no network/connection
      // signal to classify here at all, so this is deterministic by
      // construction, not merely by the classifier's own unknown-error
      // default.
      //
      // Ticket 04: the reason is now the COMPOSED diagnosis — the run's own
      // final text carries whatever it worked out before stopping (a correct
      // read of an unsatisfiable gate, say), and the scheduler must not
      // discard it for a generic line.
      return {
        ok: false,
        reason: composeSettlementDiagnosis(
          job.stage,
          `stopped without commit (job status: ${settled?.status ?? "missing"})`,
          queryResult.text,
        ),
        failureClass: "deterministic",
      };
    }
    return { ok: true };
  };
}

// ---------------------------------------------------------------------------
// The unified dispatch — topics-stage claims, one query for both stages
// ---------------------------------------------------------------------------

/**
 * TICKET 07 (settlement-execution-repair spec Rev 5, "The reclaimed run dies
 * instead of haunting"): the claim monitor's poll interval — a MODEST
 * interval, not one derived from the lease constant, so this module never
 * needs to import `NOTE_SETTLEMENT_LEASE_MS`'s ten-minute window just to
 * divide it. Thirty seconds catches a reclaim (which itself only happens
 * when another trigger event re-claims this session, per `db/note-
 * settlement.ts`'s own "run in passing by a content event, never a wake-up"
 * design) well inside any lease window worth having, without polling the
 * row so often that a long edge-writing run pays for it. Exported so a test
 * can assert the production default without a second magic number.
 */
export const NOTE_SETTLEMENT_CLAIM_MONITOR_INTERVAL_MS = 30_000;

/**
 * Same injectable-timer shape as `worker/server.ts`'s own
 * `setTimeoutImpl`/`clearTimeoutImpl` deps (the bounded hard-exit timer,
 * ticket 08's idleness clock) — reused here rather than invented fresh, so a
 * fake-clock test drives this monitor's ticks the same way it drives every
 * other timer in this codebase.
 */
export interface SettlementClaimMonitorDeps {
  setTimeoutImpl?: (callback: () => void | Promise<void>, delayMs: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  /** Overrides the derived poll interval — the test seam this ticket's fake-clock suite uses. */
  intervalMs?: number;
}

interface SettlementClaimMonitorHandle {
  /** Idempotent; stops polling. Safe to call whether or not `onLoss` ever fired. */
  clear(): void;
}

/**
 * THE CLAIM MONITOR (ticket 07). An independent, cancellable timer that
 * re-reads the durable `(job, claimGeneration, status)` row on its own
 * schedule — never keyed to a tool call — because a wedged model call that
 * never issues another one is exactly the failure this exists to observe:
 * "the in-call fences are correctness checks, not the stall detector" (spec).
 *
 * THREE ROW STATES, NOT TWO (claim-monitor-repair ticket 01 Part A). The row
 * this monitor re-reads answers one of three different questions, and the
 * predicate that collapsed the last two into "lost" was wrong on every
 * successful run whose post-commit tail outlived a tick (observed three for
 * three on 2026-08-30, jobs 160/161/163):
 *
 *   - `claimed` + SAME generation → still ours, keep ticking;
 *   - `done` + SAME generation → OUR OWN TERMINAL COMMIT. `commit`
 *     (note-settlement-staging.ts) moves the row to `done` from INSIDE this
 *     run, under this run's own generation, while the SDK session is still
 *     narrating its tail — so this is the run finishing, not ownership
 *     moving. The monitor clears itself SILENTLY: no `onLoss`, no abort. The
 *     dispatch keeps awaiting the query to its natural end and the normal
 *     completion path logs its metrics line. Nothing else can produce this
 *     state: every reclaim path in `db/note-settlement.ts` bumps the
 *     generation unconditionally, so a `done` row still carrying OUR
 *     generation was written by our own commit (or by our own empty-window
 *     terminal exception) and by nothing else;
 *   - anything else — row gone, generation moved (the
 *     lease-expired-with-attempts-left path, the lease-expired-at-cap path,
 *     and the backoff-elapsed re-pending path all bump it), or the status
 *     regressed to `pending`/`abandoned` — → GENUINE LOSS: `onLoss` fires
 *     once and the monitor stops polling, exactly as before.
 *
 * `clear()` must be called by the caller once the watched query settles
 * (resolved or rejected) — that is the "cleared when the query settles"
 * half of the contract; this function only ever arms itself once and never
 * re-arms after `onLoss` or `clear()`.
 */
function armSettlementClaimMonitor(
  db: Database,
  jobId: number,
  claimGeneration: number,
  onLoss: () => void,
  deps: SettlementClaimMonitorDeps = {},
): SettlementClaimMonitorHandle {
  const setTimeoutImpl =
    deps.setTimeoutImpl ??
    ((callback: () => void | Promise<void>, delayMs: number): unknown =>
      setTimeout(() => void callback(), delayMs));
  const clearTimeoutImpl =
    deps.clearTimeoutImpl ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const intervalMs = deps.intervalMs ?? NOTE_SETTLEMENT_CLAIM_MONITOR_INTERVAL_MS;

  let cleared = false;
  let handle: unknown = null;

  const tick = (): void => {
    if (cleared) {
      return;
    }
    // THE ROW RE-READ — the mutation target: neuter this line (or either
    // predicate below) and the never-resolving-queryImpl test must die,
    // because it is the only thing that can ever call `onLoss` here.
    const row = getNoteSettlementJob(db, jobId);
    const ours = row !== null && row.claimGeneration === claimGeneration;
    if (ours && row.status === "claimed") {
      handle = setTimeoutImpl(tick, intervalMs);
      return;
    }
    if (ours && row.status === "done") {
      // OUR OWN TERMINAL COMMIT — stop polling, say nothing. See this
      // function's doc comment: no `onLoss`, no abort, no re-arm.
      cleared = true;
      return;
    }
    cleared = true;
    onLoss();
  };

  handle = setTimeoutImpl(tick, intervalMs);

  return {
    clear(): void {
      if (cleared) {
        return;
      }
      cleared = true;
      if (handle !== null) {
        clearTimeoutImpl(handle);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// THE SHIELD IS GONE (claim-monitor-repair ticket 02)
// ---------------------------------------------------------------------------

/**
 * Ticket 01 shipped a refcounted process-level `unhandledRejection` listener
 * here, to swallow the debris an aborted model client leaks (its vendored
 * transport dispatches an inbound control request unawaited, so a write that
 * throws under abort rejects with no observer and Bun ends the process). It
 * is DELETED, not moved: peer review found three independent structural
 * faults, and all three reduce to the same one — at the `unhandledRejection`
 * layer NO QUERY IDENTITY EXISTS, so the listener could not tell this run's
 * debris from a stranger's, could not be released when the query it guarded
 * never settled, and could not choose a time window that both covered a late
 * control-request handler and excluded an unrelated bug.
 *
 * The replacement is architectural and lives in `note-settlement-child.ts`:
 * one settlement run is one CHILD PROCESS, so that debris can only ever kill
 * the run that produced it. Consequently the worker keeps ZERO global
 * rejection handlers, and an unrelated unhandled rejection in the worker
 * still ends the worker exactly as it did before ticket 01 — which is the
 * crash-on-genuine-bug semantics both tickets meant to preserve.
 */

export interface CreateUnifiedNoteSettlementDispatchOptions {
  db: Database;
  runQuery: NoteSettlementUnifiedQuery;
  config?: MnemoConfig;
  /** Epoch seconds. */
  now?: () => number;
  model?: string;
  metrics?: NoteSettlementMetricsSink;
  logger?: NoteSettlementDispatchLogger;
  maxAttempts?: number;
  /**
   * TICKET 08's busy-token lifecycle contract (`worker/server.ts`'s
   * `acquireBusyToken`/`BusyToken`): called ONCE per dispatch invocation,
   * before the query starts, to acquire the token that tells the worker's
   * one idleness clock "this run's work is genuinely live". The claim
   * monitor's abort verdict releases it immediately — independent of
   * whether the wedged query promise it wraps ever settles — so `idleSince`
   * starts counting from the abort, not from a promise that may never
   * resolve (spec: "an aborted query stops counting as work").
   *
   * A CLEARLY-NAMED SEAM, not yet wired: `worker/server.ts`'s own assembly
   * of `createUnifiedNoteSettlementDispatch` does not thread a real acquirer
   * through this option today (that wiring is ticket 10's, not this
   * ticket's — rewiring `server.ts`'s assembly site is explicitly out of
   * this ticket's territory). Omitted, every release call below is a
   * no-op, which is exactly today's behaviour (the whole drain this
   * dispatch runs inside is already covered by `server.ts`'s own
   * `trackGlobalWork` at the trigger level).
   */
  acquireBusyToken?: () => { release(): void };
  /** Ticket 07's claim-monitor timers — same injectable-clock idiom as `now` above. */
  claimMonitorSetTimeoutImpl?: SettlementClaimMonitorDeps["setTimeoutImpl"];
  claimMonitorClearTimeoutImpl?: SettlementClaimMonitorDeps["clearTimeoutImpl"];
  claimMonitorIntervalMs?: number;
}

/**
 * THE UNIFIED DISPATCH (settlement-execution-repair spec Rev 5,
 * "One dispatch per claim"; ticket 04). The scheduler's `stage1Dispatch` slot,
 * once a job's claim STARTS on stage `topics` — one `runQuery` call carries
 * BOTH stages (ticket 03's `createUnifiedNoteSettlementSdkQuery`: the topic
 * pass and, once the run's own `finalize` succeeds, the edge pass), so there
 * is no second dispatch left for the scheduler to chain into. Same seam as
 * `createNoteSettlementDispatch` above: `(job) => verdict`, and the row —
 * never this verdict — is what answers "did this settle" (post-hoc truth,
 * re-anchored at the terminal end, worker/note-settlement.ts).
 *
 * A job claimed already on stage `edges` (a reclaim after a crash between the
 * transition and the terminal commit) never reaches this function: the
 * scheduler routes it to `createNoteSettlementDispatch` instead — the cold,
 * stage-2-shaped resume, unmodified, the one shape that still crosses two
 * separate SDK sessions and only because the first one already died.
 */
export function createUnifiedNoteSettlementDispatch(
  options: CreateUnifiedNoteSettlementDispatchOptions,
): NoteSettlementDispatch {
  const db = options.db;
  const config = options.config ?? DEFAULT_CONFIG;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const model = options.model ?? NOTE_SETTLEMENT_MODEL;
  const logger = options.logger ?? console;
  const metrics = options.metrics ?? defaultNoteSettlementMetricsSink(logger);
  const maxAttempts = options.maxAttempts ?? NOTE_SETTLEMENT_MAX_ATTEMPTS;

  return async ({ job }): Promise<NoteSettlementDispatchOutcome> => {
    if (!config.settlementEnabled) {
      return { ok: false, reason: "note settlement is disabled", failureClass: "deterministic" };
    }

    const nowEpoch = now();
    const context: NoteSettlementContext | null = buildNoteSettlementContext(db, job, {
      nowEpoch,
    });
    if (!context) {
      return {
        ok: false,
        reason: `note settlement window has no session ${job.sessionId}`,
        failureClass: "deterministic",
      };
    }
    if (context.windowTurns.length === 0) {
      // The same empty-window terminal exception as the resume dispatch
      // above — one helper, one write.
      return completeEmptyWindowSettlement(db, job, nowEpoch);
    }

    // The topic pass has no frozen scope to read yet (the transition, if it
    // happens, is this same run's own doing, mid-query) — the live-computed
    // set stands, exactly like the pre-staging single-pass flow and stage 1's
    // own retired standalone dispatch.
    const writableTurnIds = computeSettlementWritableTurnIds(
      db,
      context.reviewableTurnIds,
    );
    const writableSet = resolveSettlementWritableSet(db, context, writableTurnIds);
    const scopeProvenance = resolveSettlementScopeProvenance(context, writableTurnIds);

    // TICKET 07: the query's own abort signal, and the busy token this run's
    // work holds against the worker's idleness clock (ticket 08's seam,
    // wired at `worker/server.ts`'s assembly site — see the option's own doc
    // comment).
    //
    // Ticket 02: the signal's MEANING changed without its shape changing.
    // `runQuery` is a child process now, and `note-settlement-child.ts`
    // answers this signal with `SIGTERM` and then `SIGKILL` — so aborting is
    // no longer a request the query may decline. The token spans that child's
    // life and is released EXACTLY ONCE, whichever exit path gets there
    // first; a double release would decrement the worker's shared
    // `busyCount` for work only one token was ever taken against.
    const abortController = new AbortController();
    const busyToken = options.acquireBusyToken?.() ?? null;
    let busyTokenReleased = false;
    const releaseBusyToken = (): void => {
      if (busyTokenReleased) {
        return;
      }
      busyTokenReleased = true;
      busyToken?.release();
    };

    // TICKET 12 PART A (peer P0 pinned repair): a claim-loss promise that
    // RACES the query, rather than a bare abort signal the query is merely
    // asked to honor. `abortController.abort()` alone is a request — a
    // `runQuery` that ignores it (the real subprocess boundary, or a stub
    // built before this ticket) would still wedge this `await` forever, and
    // with it the drain `worker/server.ts`'s `trackGlobalWork` never settles
    // (spec: "the wedged query must not hold the drain"). `lossReject` is
    // armed exactly once, by the claim monitor's own `onLoss` below, and is
    // the ONLY way `lossPromise` ever settles. `lossMessage` (rather than
    // comparing the caught error's identity against a captured `Error`)
    // doubles as BOTH the composed reason text and the "did loss win the
    // race" discriminator below — a plain `string | null` narrows cleanly
    // even though it is reassigned inside a closure, where a captured
    // `Error | null` binding does not.
    let lossMessage: string | null = null;
    let lossReject: ((error: Error) => void) | null = null;
    const lossPromise = new Promise<never>((_resolve, reject) => {
      lossReject = reject;
    });

    // THE CLAIM MONITOR (spec "The reclaimed run dies instead of haunting"):
    // armed here, independent of every tool call the query below ever makes,
    // and cleared in every exit path below — success, thrown error, or its
    // own `onLoss` firing. A wedged model call that never issues another
    // tool call still gets observed, because this timer never waits on one.
    const claimMonitor = armSettlementClaimMonitor(
      db,
      job.id,
      job.claimGeneration,
      () => {
        lossMessage = `note settlement claim monitor: job ${job.id} lost ownership of claim generation ${job.claimGeneration} — the in-flight query is detached, not awaited`;
        // Ticket 02: for the production `runQuery` this abort IS the kill —
        // `note-settlement-child.ts` sends `SIGTERM`, then `SIGKILL` after a
        // bounded wait — so "detached" now means "will be reaped shortly",
        // not "may haunt us forever".
        abortController.abort(
          new Error(
            `note settlement claim monitor: job ${job.id} lost ownership of claim generation ${job.claimGeneration} — killing the in-flight run`,
          ),
        );
        releaseBusyToken();
        lossReject?.(new Error(lossMessage));
      },
      {
        setTimeoutImpl: options.claimMonitorSetTimeoutImpl,
        clearTimeoutImpl: options.claimMonitorClearTimeoutImpl,
        intervalMs: options.claimMonitorIntervalMs,
      },
    );

    // Peer round-2 P2 note: the production runQuery is an async function, so
    // its failures arrive as rejections — but an injected seam that THROWS
    // SYNCHRONOUSLY would otherwise escape the try below and strand the claim
    // monitor and busy token. The thunk wrap routes a sync throw into the
    // same rejected-promise path as every other failure.
    const queryPromise = Promise.resolve().then(() => options.runQuery({
      prompt: renderNoteSettlementUnifiedPrompt(context, writableSet),
      systemPrompt: NOTE_SETTLEMENT_UNIFIED_SYSTEM_PROMPT,
      model,
      maxThinkingTokens: config.noteSettlementMaxThinkingTokens,
      jobId: job.id,
      claimGeneration: job.claimGeneration,
      stage: job.stage,
      sessionId: job.sessionId,
      writableTurnIds,
      scopeProvenance,
      contextBuiltAtEpoch: context.builtAtEpoch,
      windowStart: job.windowStart,
      windowEnd: job.windowEnd,
      signal: abortController.signal,
    }));

    let queryResult: NoteSettlementUnifiedQueryResult;
    try {
      // THE RACE. `Promise.race` itself subscribes to both promises
      // synchronously, so neither can ever surface as an unhandled
      // rejection purely by virtue of losing — the explicit swallow below,
      // in the loss branch, is this ticket's own belt-and-braces on top of
      // that, naming the contract rather than resting it on an engine detail.
      queryResult = await Promise.race([queryPromise, lossPromise]);
    } catch (error) {
      claimMonitor.clear();
      if (lossMessage !== null) {
        // THE DETACH (peer P0), now bounded. The killed run's promise is
        // never awaited again — the dispatch has already said what it knows
        // and the scheduler's own row re-read (worker/note-settlement.ts) is
        // what turns this into "preempted". The lone `catch` that stays is
        // the swallow for its late settle: with a child process that settle
        // arrives within the kill grace, but an INJECTED `runQuery` that
        // never settles must still not surface an unhandled rejection here,
        // and must never hold this return — which is the drain-safety
        // property this race exists for.
        queryPromise.catch(() => {});
        releaseBusyToken();
        return {
          ok: false,
          reason: lossMessage,
          failureClass: "deterministic",
        };
      }
      releaseBusyToken();
      return {
        ok: false,
        reason: `note settlement call failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        failureClass: classifySettlementFailure(error),
      };
    }
    claimMonitor.clear();
    releaseBusyToken();

    // Same reasoning as the resume dispatch above: `commit` is the only path
    // to `done`, so re-reading the row is a complete answer.
    const settled = getNoteSettlementJob(db, job.id);
    const committed = settled?.status === "done";

    metrics({
      jobId: job.id,
      sessionId: job.sessionId,
      windowStart: job.windowStart,
      windowEnd: job.windowEnd,
      triggerType: job.triggerType,
      windowTurns: context.windowTurns.length,
      committed,
      attempt: job.attempts,
      attemptsExhausted: !committed && job.attempts >= maxAttempts,
      commit: committed ? queryResult.commitMetrics : null,
      laneCheckCalled: queryResult.laneCheckCalled,
    });

    if (!queryResult.laneCheckCalled) {
      logger.warn(
        `${NOTE_SETTLEMENT_METRICS_PREFIX} reminder: job ${job.id} (S${job.sessionId} T${job.windowStart}-${job.windowEnd}) completed without ever calling lane_check`,
      );
    }

    if (!committed) {
      // The stage marker reflects what the RUN actually reached, not what it
      // was claimed under: a run that transitioned mid-session and then
      // stopped diagnoses as `edges` (its window did not land); a run that
      // never reached `finalize` diagnoses as `topics`.
      const stage = settled?.stage ?? job.stage;
      return {
        ok: false,
        reason: composeSettlementDiagnosis(
          stage,
          stage === "edges"
            ? `stopped without commit (job status: ${settled?.status ?? "missing"})`
            : `ended without reaching finalize (job status: ${settled?.status ?? "missing"})`,
          queryResult.text,
        ),
        failureClass: "deterministic",
      };
    }
    return { ok: true };
  };
}
