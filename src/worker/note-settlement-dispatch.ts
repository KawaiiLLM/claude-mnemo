import type { Database } from "bun:sqlite";

import { isSqliteBusy } from "../db/database";
import {
  computeSettlementWritableTurnIds,
  getNoteSettlementJob,
  NOTE_SETTLEMENT_MAX_ATTEMPTS,
  type NoteSettlementFailureClass,
  type NoteSettlementJob,
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
      // Nothing to settle — a window whose turns were deleted. Resolving it as
      // done is what lets the cursor walk past it instead of retrying forever.
      return { ok: true };
    }

    // Tag-mandate ticket 05: the immutable writable set, resolved HERE —
    // before the prompt is rendered and before the model exists — so the
    // range check, the commit gate and (ticket 06) the prompt's own
    // declaration all read one value that cannot move mid-run. Deliberately
    // computed ahead of `renderNoteSettlementPrompt` so ticket 06's prompt
    // rewrite has it in hand at the render call with no reordering.
    const writableTurnIds = computeSettlementWritableTurnIds(
      db,
      context.reviewableTurnIds,
    );
    // Tag-mandate ticket 06: the SAME set, in the address vocabulary the
    // prompt declares and every write call takes. Resolved from
    // `writableTurnIds` itself rather than re-derived from the context, so
    // the printed declaration and the enforced set can never disagree — the
    // fork the spec's "immutable and declared" clause exists to forbid.
    const writableSet = resolveSettlementWritableSet(db, context, writableTurnIds);
    // Settlement-ergonomics ticket 07 (spec D0/D5): the SAME writableTurnIds,
    // carved by error origin rather than by render shape — computed here,
    // alongside writableSet, so both derive from the one frozen
    // writableTurnIds value and can never disagree about what exists.
    const scopeProvenance = resolveSettlementScopeProvenance(context, writableTurnIds);

    let queryResult: NoteSettlementQueryResult;
    try {
      queryResult = await options.runQuery({
        prompt: renderNoteSettlementPrompt(context, writableSet),
        systemPrompt: NOTE_SETTLEMENT_SYSTEM_PROMPT,
        model,
        maxThinkingTokens: config.noteSettlementMaxThinkingTokens,
        jobId: job.id,
        claimGeneration: job.claimGeneration,
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
      return {
        ok: false,
        reason: `note settlement run ended without a successful commit (job status: ${settled?.status ?? "missing"})`,
        failureClass: "deterministic",
      };
    }
    return { ok: true };
  };
}
