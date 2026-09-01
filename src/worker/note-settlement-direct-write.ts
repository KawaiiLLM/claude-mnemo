import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "../db/database";
import { resolveEraCutoff } from "../db/era";
import {
  laneTouchSegmentTagKey,
  laneTouchTurnTagKey,
  loadRunLaneTouches,
  recordLaneTouch,
  type RunLaneTouches,
} from "../db/lane-disposition";
import {
  assertNoteSettlementJobClaimed,
  completeNoteSettlementJobIfSegmentedCore,
  NoteSettlementJobFenceError,
} from "../db/note-settlement-completion";
import { ERA_GRANT_COLUMN } from "../segment-era";
import {
  evaluateSettlementMembershipWrite,
  renderSettlementMembershipWriteReceipt,
  type SettlementMembershipWriteInput,
  type SettlementMembershipWriteOutcome,
} from "./note-settlement-membership-facade";
import {
  renderSettlementSystemFailure,
  type SettlementSystemFailure,
} from "./note-settlement-system-failure";
import {
  evaluateSettlementTurnWrite,
  renderSettlementTurnWriteReceipt,
  type SettlementTurnFacadeContext,
  type SettlementTurnWriteInput,
  type SettlementTurnWriteOutcome,
} from "./note-settlement-turn-facade";

/**
 * The settlement direct-write engine (ticket 05, read-write-contract spec
 * "结算(直写改造)") — what REPLACED the staged-commit engine, deleted outright
 * by ticket 11 (edge-mechanism-revision) once it had been call-site-free for a
 * whole batch. `note-settlement-sdk-query.ts` registers this module's three
 * functions under the `note`/`remember`/`commit` tool names.
 *
 * Every `note`/`remember` call VALIDATES and LANDS in the SAME transaction,
 * immediately: `evaluateSettlementTurnWrite`/
 * `evaluateSettlementMembershipWrite` have exactly one form now (ticket 11
 * removed their `apply` split along with the staging engine that was its only
 * consumer), and this engine returns their receipt as a FACT ("Landed", never
 * "Staged... pending commit"). There is no in-memory staged list, no replay,
 * and therefore no "refused commit, staging kept, re-stage and retry" story:
 * a rejected call is rejected right there, and a landed one is already
 * durable before the tool result returns.
 *
 * `commit` is repurposed by ticket 06 (spec "commit 重定位") to three things
 * only: claim validity (the SAME fence `evaluateSettlementTurnWrite`'s
 * writer identity already leans on for staleness, checked here as the
 * job-level CAS `completeNoteSettlementJobIfSegmentedCore` already was),
 * this run's own write counts (accumulated as each call lands, never
 * replayed), and the terminal mark. It does NOT judge duty coverage — an
 * empty-handed window (nothing staged... nothing WRITTEN, now) completes
 * exactly as cleanly as one that corrected everything the rubric found
 * wrong, because `completeNoteSettlementJobIfSegmentedCore` has been an
 * empty shell (fence + CAS only) since ticket 05 of the ownership-and-
 * note-cadence spec — see that function's own doc comment
 * (db/note-settlement-completion.ts).
 *
 * TICKET 08 (edge-mechanism-revision, peer 终审必改 5): every direct write is
 * lease-fenced PER CALL, not only at `commit`. The earlier reading — that a
 * lapsed claimant is fenced out field-by-field by the write gate, so a
 * job-level check at `commit` sufficed — does not hold for the writes that
 * create state rather than overwrite it: `remember(declare)` mints a lane row
 * and `remember(merge)` rewrites member tags and edge sides before deleting
 * one. None of those collide with a field stamp, so a reclaimed claimant could
 * plant a stray lane on a segment — or fold two live ones together — and only
 * learn at `commit` that it never held the lease, by which time the next
 * window renders the result. `assertNoteSettlementJobClaimed` therefore
 * runs as the FIRST statement inside each write's own transaction (the same
 * predicate `commit` leans on, not a second one), so the fence and the write
 * commit or vanish together: a lease that moved before this transaction
 * opened aborts the call before any mutation runs.
 *
 * `commit`'s own end-of-run check is UNCHANGED and still required — per-write
 * fencing is an ADDITIONAL gate, not a replacement. It is also not a
 * substitute for the field-level write gate, which continues to arbitrate two
 * writers that both hold a valid claim on different generations of the same
 * field.
 *
 * STAGED SETTLEMENT (spec Rev 5, ticket 05 mounting ticket 03's argument):
 * every one of those calls now names `context.stage`, so the fence is the FULL
 * ownership tuple `(job, claimGeneration, stage)`. This is the member the
 * generation cannot supply: the generation deliberately does NOT bump at the
 * stage transition (spec §State machine and ownership), so a stale stage-1
 * context keeps a valid generation indefinitely and would otherwise go on
 * writing into a job stage 2 already owns. Its writes now assert
 * `stage='topics'` and abort against `'edges'`.
 *
 * `completeNoteSettlementJob`/`touchNoteSettlementJobLease` stay stage-agnostic
 * on purpose (ticket 03's recorded reading): stage 1's inability to reach
 * `commit` is bounded by its TOOLSET, not by those two CASes.
 */

/**
 * TICKET 11 (edge-mechanism-revision, peer 终审必改 6): one bucket per VERB,
 * because a receipt that folds two verbs into one number cannot be read back
 * as "what did that settlement pass do". Two specific dishonesties this shape
 * retires:
 *
 *   - `create` used to land in `proposalsCreated`. The membership accumulator
 *     branched on `reassign` and treated everything else as a proposal, so a
 *     minted segment — the one membership act that creates durable state
 *     nobody asked for — was reported as a text-only suggestion. `create` has
 *     its own count now, and the accumulator branches on all three verbs by
 *     name rather than on one of them plus an `else`.
 *   - prose, restatements and retractions were counted NOWHERE (ADR-0009's own
 *     recorded open item: "commit metrics count neither prose nor
 *     retractions"). All three are the capabilities the re-arming added, so
 *     the run's report under-stated exactly the new work.
 */
export interface NoteSettlementCommitCounts {
  /** Turns a `note` call actually carried a review (type/tags) for, landed or with at least one field yielded. */
  turnsReviewed: number;
  /** Of `turnsReviewed`, how many had at least one field (type/tags) rejected by the write gate as stale/never-read. */
  reviewsYieldedToLateNote: number;
  /** `note` calls that landed turn prose (title/content/insight) — one per call, not per field. */
  proseWritten: number;
  /** Relation rows this run ADDED. */
  relationsWritten: number;
  /** Accepted relation targets whose row was already stored — a restatement, not new work. */
  relationsRestated: number;
  /** Relation rows a `retract…` mirror deleted. */
  relationsRetracted: number;
  /** A `session`-addressed `note` call that landed (title and/or content). */
  sessionNarrativeWritten: number;
  /** Lanes this run minted. */
  lanesDeclared: number;
  /** Lanes this run removed outright (container-unification ticket 06: the retired `undeclare`'s own bucket, renamed with it). */
  lanesDeleted: number;
  /** Lanes this run folded into another (ticket 15) — the fold's own moved-row counts are in each call's receipt, not here. */
  lanesMerged: number;
  // `lanesJustified` RETIRED with `justify` itself (settlement-gate-taxonomy
  // ticket 06). It is dropped from the metrics line rather than pinned at 0:
  // a permanently-zero count teaches every future reader of that line that the
  // verb still exists and this window simply did not use it.
}

/**
 * Settlement-commit-report ticket 01 (spec "commit carries a friction report
 * into the settlement metrics line"): `NoteSettlementCommitCounts` PLUS the
 * one field that is not a count — `report`, this run's own account of what
 * the settlement CONTRACT made hard, never a restatement of the counts
 * above. Required at `commit` time (an optional field here would be empty
 * forever — the spec's own ruling), capped at
 * `SETTLEMENT_COMMIT_REPORT_MAX_CHARS` and refused rather than truncated
 * above it (`validateCommitReport`). Set once, at the run's first
 * successful `commit`; a second, idempotent `commit` call in the same run
 * returns before this record is ever rebuilt, so it never overwrites the
 * report a successful call already carried.
 *
 * Rides the exact path the counts already ride (the spec's own decision: no
 * column, no table) — `getLastCommitMetrics()` below, `NoteSettlementQueryResult
 * .commitMetrics` (note-settlement-dispatch.ts), and the `metrics({…})`
 * log line that reads it.
 */
export interface NoteSettlementCommitRecord extends NoteSettlementCommitCounts {
  report: string;
  /**
   * era-grant-by-settlement ticket 02: turns THIS commit granted era
   * eligibility to. Population is window COVERAGE (every turn in
   * `[windowStart, windowEnd]`), not turns reviewed (ruled [S15069/T1818]) —
   * a turn the agent chose not to note is counted the same as one it wrote
   * on, because that choice is its own legitimate judgment and must not
   * leave the turn permanently invisible. See
   * `grantEraVisibilityForCommittedWindow`'s own doc comment for the three
   * ways this lands as 0: the window sits entirely at or after the era
   * cutoff, every turn in it was already granted by an earlier commit
   * (idempotent re-run), or no era cutoff is recorded at all.
   */
  eraGranted: number;
}

function emptyCommitCounts(): NoteSettlementCommitCounts {
  return {
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
  };
}

function accumulateTurnWriteCounts(
  counts: NoteSettlementCommitCounts,
  outcome: SettlementTurnWriteOutcome,
): void {
  if (outcome.review) {
    counts.turnsReviewed += 1;
    const anyYielded =
      (outcome.review.type !== undefined && !outcome.review.type.landed) ||
      (outcome.review.tags !== undefined && !outcome.review.tags.landed);
    if (anyYielded) {
      counts.reviewsYieldedToLateNote += 1;
    }
  }
  if (outcome.prose) {
    counts.proseWritten += 1;
  }
  if (outcome.relations) {
    counts.relationsWritten += outcome.relations.written;
    counts.relationsRestated += outcome.relations.restated;
    counts.relationsRetracted += outcome.relations.retracted;
  }
  if (outcome.session) {
    counts.sessionNarrativeWritten += 1;
  }
}

function accumulateMembershipWriteCounts(
  counts: NoteSettlementCommitCounts,
  outcome: SettlementMembershipWriteOutcome,
): void {
  // One bucket per VERB, and the branch reads the OUTCOME rather than the
  // input: a receipt that folded two verbs into one number cannot be read back
  // as "what did that settlement pass do" (ticket 11's finding, kept when
  // ticket 15 replaced the three membership verbs with the three lane ones).
  if (outcome.lane.action === "create") {
    counts.lanesDeclared += 1;
    return;
  }
  if (outcome.lane.action === "delete") {
    counts.lanesDeleted += 1;
    return;
  }
  // EXHAUSTIVE from here, never a fall-through default: `justify` arrived as a
  // fourth legal action after this function was written, and the old catch-all
  // silently reported every justification as a lane MERGE — a mutation that
  // never happened, in metrics that outlive the run. `justify` has since
  // retired (ticket 06) and the exhaustiveness stays: a NEW action must fail to
  // compile rather than land in whichever bucket happens to be last.
  if (outcome.lane.action === "merge") {
    counts.lanesMerged += 1;
    return;
  }
  const unreachable: never = outcome.lane.action;
  throw new Error(`unhandled lane action: ${String(unreachable)}`);
}

function summarizeCounts(counts: NoteSettlementCommitCounts): string {
  const bits = [
    `${counts.turnsReviewed} turn review(s)`,
    `${counts.proseWritten} note(s) written`,
    `${counts.relationsWritten} relation(s) attached`,
    `${counts.relationsRestated} already present`,
    `${counts.relationsRetracted} retracted`,
    `${counts.lanesDeclared} lane(s) declared`,
    `${counts.lanesDeleted} deleted`,
    `${counts.lanesMerged} merged`,
  ];
  if (counts.sessionNarrativeWritten > 0) {
    bits.push("session narrative written");
  }
  return `(${bits.join(", ")}.)`;
}

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
};

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function parameterError(message: string): ToolTextResult {
  return textResult(`Parameter error: ${message}`);
}

/**
 * Settlement-commit-report ticket 01: the cap `report` refuses above rather
 * than truncates at. Matches the convention 0.21.1 settled for the public
 * read knobs (`MAX_PAGE_BUDGET` etc., `src/mcp/definitions.ts`) — a bound the
 * caller must respect, not a silent clamp.
 */
export const SETTLEMENT_COMMIT_REPORT_MAX_CHARS = 1000;

type CommitReportValidation =
  | { ok: true; report: string }
  | { ok: false; refusal: string };

/**
 * Validated fully in-process, never left to the MCP schema layer alone: the
 * tool's own input shape (`note-settlement-sdk-query.ts`) declares `report`
 * required, but a schema-level "required" check cannot express "non-empty",
 * "non-whitespace" or "state the actual length in the refusal", and the
 * test harness that drives the registered handler directly
 * (`captureToolImpl`, tests/worker/note-settlement-sdk-query.test.ts) bypasses
 * schema validation entirely. Absent, empty and whitespace-only all fail the
 * same guard, deliberately — a caller that sends `undefined` and one that
 * sends `"   "` made the identical mistake (nothing to record), and get the
 * identical refusal.
 */
function validateCommitReport(rawReport: unknown): CommitReportValidation {
  if (typeof rawReport !== "string" || rawReport.trim().length === 0) {
    return {
      ok: false,
      refusal:
        '"report" is required and must be a non-empty, non-whitespace string ' +
        "— state this window's FRICTION (a forced guess, a relation the seven " +
        "words could not express, a commit-gate refusal you routed around, a " +
        "turn you could not read), never a restatement of the counts.",
    };
  }
  if (rawReport.length > SETTLEMENT_COMMIT_REPORT_MAX_CHARS) {
    return {
      ok: false,
      refusal:
        `"report" exceeds the ${SETTLEMENT_COMMIT_REPORT_MAX_CHARS}-character cap ` +
        `(got ${rawReport.length} characters). Refused, not truncated — shorten it ` +
        "below ~800 characters and call commit again.",
    };
  }
  return { ok: true, report: rawReport };
}

export interface CreateSettlementDirectWriteEngineOptions {
  db: Database;
  context: SettlementTurnFacadeContext;
  /** Epoch seconds, injectable for tests; each call is stamped with its own reading. */
  now?: () => number;
  /**
   * Test seam only (same `options.runWriteTransaction ?? runWriteTransaction`
   * port `mcp/note.ts` and `mcp/remember.ts` already expose): lets a test
   * interleave a competing write INSIDE this engine's own transaction, which
   * is the only way to prove the lease check and the mutation share one. Every
   * one of the three tools routes through it — a seam that some writes escaped
   * would report atomicity the engine does not actually have.
   */
  runWriteTransaction?: typeof runWriteTransaction;
  /**
   * era-grant-by-settlement ticket 02: this dispatch's own frozen window
   * bounds (`job.windowStart`/`job.windowEnd`), read only by `commit`'s own
   * forward era grant — see `grantEraVisibilityForCommittedWindow`. Optional
   * so a construction site that predates this ticket, or never models a
   * window (a bare unit test of `note`/`remember`), keeps compiling; the one
   * production caller (`note-settlement-sdk-query.ts`) always supplies both,
   * straight from the request the dispatch built.
   */
  windowStart?: number;
  windowEnd?: number;
  /**
   * READ THE TERMINAL STATE INSIDE THE TERMINAL TRANSACTION (final review,
   * finding 9). Called by `commit`, inside the same write transaction as the
   * completion CAS and the era grant, once both have landed and before the
   * transaction closes.
   *
   * It exists because the commit REPORT's shape numbers audit the partition
   * this run settled, and they were being computed after the transaction
   * committed — a plain read of the live edge table, in which any writer that
   * landed in between is already visible. The numbers would then describe a
   * graph that is not the one this commit made durable, and there is no way
   * to tell from the receipt. Computed under the write lock they describe
   * exactly the state the terminal commit left.
   *
   * A HOOK rather than a return value: the shape numbers are the
   * SDK-query layer's own vocabulary (its worklist snapshot, its renderers),
   * and pulling that module in here would make the write engine depend on the
   * reporting layer it is called by. It runs for effect; whatever it captures
   * is the caller's own closure to keep.
   *
   * A throw from it aborts the commit — deliberately: it runs after the CAS,
   * so a failure means the terminal state could not be read, and committing a
   * receipt that cannot describe itself is worse than a retry.
   */
  captureAtCommit?: (db: Database) => void;
  /**
   * TICKET 19, finding 1: THE TERMINAL GATES, READ INSIDE THE TERMINAL
   * TRANSACTION. Called by `commit` as the first thing inside the write
   * transaction and BEFORE the completion CAS, so the grammar and disposition
   * verdicts describe the state this commit is about to make terminal rather
   * than a state that was true some statements earlier.
   *
   * Ordering inside the transaction is `gates → report validation → lease
   * fence → CAS`, which is the refusal PRECEDENCE the outer layer used to
   * produce by running the gates before it ever called this function
   * (gate beats malformed report beats reclaimed lease). Nothing before the
   * CAS mutates anything, so the fence's usual "first statement" discipline
   * — which exists to bind a lease check to the MUTATION it guards — is
   * satisfied by the CAS itself, and the write lock taken at `BEGIN
   * IMMEDIATE` covers every read above it regardless of statement order.
   *
   * A callback rather than a returned verdict, for `captureAtCommit`'s
   * reason: the refusal texts are the SDK-query layer's own vocabulary (lane
   * checker projections, anchor addresses, phase reports), and importing that
   * module here would make the write engine depend on the reporting layer
   * that calls it.
   *
   * Omitted (a bare unit test of the engine) means "no gates": the commit
   * proceeds exactly as it did before this option existed.
   */
  evaluateTerminalGates?: (db: Database) => SettlementTerminalGateVerdict;
  /**
   * THE IMPRESSION OBLIGATION, INSIDE THE TERMINAL TRANSACTION (lane-impressions
   * spec Rev 8, "Settlement maintenance"; ticket 02). Called by `commit` with
   * the `impressions` payload exactly as the tool received it, AFTER the lease
   * fence and BEFORE the completion CAS.
   *
   * "The terminal commit payload carries the impression replacements, validated
   * inside the terminal transaction — `done` never swallows an unpersisted
   * maintenance obligation." That is the whole reason it is a callback here
   * rather than a follow-up write outside: a refusal throws, SQLite rolls the
   * transaction back whole, and the job row is untouched — so a run that cannot
   * honour its impression obligations cannot mark the window settled either.
   *
   * BEFORE THE CAS, and that ordering is load-bearing rather than a preference:
   * the impression cap is taken over the settled universe unioned with this
   * window's own projection, and `loadSettlementCoveredTurnIds` reads
   * `status = 'done'` job rows — so once the CAS has run, this job's window is
   * already inside the settled half and the membership digest would differ from
   * the advisory's on every single commit. See `settleImpressions`' own doc
   * comment (worker/note-settlement-impressions.ts).
   *
   * A CALLBACK rather than a parameter for `evaluateTerminalGates`' reason: the
   * touched-set derivation, the advisory ledger and the refusal vocabulary are
   * the impression module's own, and importing it here would make the write
   * engine depend on a maintenance layer it exists underneath.
   *
   * Omitted (a bare unit test of the engine, or any caller predating this
   * ticket) means "no impression obligation": the commit proceeds exactly as it
   * did before this option existed.
   */
  settleImpressions?: (
    db: Database,
    rawImpressions: unknown,
  ) => SettlementImpressionVerdict;
}

/**
 * The verdict of `settleImpressions`. A refusal is NOT a parameter error and
 * NOT a lost lease: the call was well-formed and the run can repair it, exactly
 * like a terminal-gate refusal — so it takes the same unwrapped-text register.
 */
export type SettlementImpressionVerdict =
  | { ok: false; refusal: string }
  | { ok: true };

export interface SettlementDirectWriteEngine {
  writeNote(rawInput: SettlementTurnWriteInput): ToolTextResult;
  writeMembership(rawInput: SettlementMembershipWriteInput): ToolTextResult;
  /**
   * `rawReport` is `unknown`, not `string` — the tool's own input shape
   * requires it as a string, but this engine validates it again itself
   * (`validateCommitReport`) rather than trusting that layer, so a caller
   * driving this function directly (a test, or a schema-validation bypass)
   * gets the identical refusal a real malformed tool call would.
   */
  /**
   * `rawImpressions` is the `impressions` argument as the tool received it,
   * handed straight to `options.settleImpressions` inside the transaction —
   * this engine never inspects it. Absent means the caller models no impression
   * obligation at all (see the option's own doc comment).
   */
  commit(rawReport: unknown, rawImpressions?: unknown): ToolTextResult;
  /** This run's own write counts plus its friction report, sourced from what actually landed (ticket 10c's discipline, carried over) — null until a `commit` has landed. */
  getLastCommitMetrics(): NoteSettlementCommitRecord | null;
  /**
   * Severed-lane over-blocking fix: the lane-touch facts THIS RUN's own
   * landed writes produced so far. Read by
   * `note-settlement-sdk-query.ts`'s `evaluateLaneDispositionGate` at both
   * its callers (`lane_check`'s preview and `commit`'s own gate), so the two
   * can never disagree about what this run has actually written.
   *
   * TICKET 04 (phase-connectivity, "a touch ledger as durable as the writes
   * it guards"): the UNION of the durable `lane_run_touches` rows for this
   * JOB and whatever this instance has accumulated in memory. The in-memory
   * half was the whole story before, and it died with the engine instance:
   * an attempt that landed a severing write and then failed left the next
   * attempt rebuilding empty sets over a fracture nobody was on the hook
   * for. Job-scoped, never claim-scoped — a reclaimed claimant inherits its
   * predecessor's obligation.
   */
  getRunLaneTouches(): RunLaneTouches;
}

/** Rejection sentinel: thrown inside the per-call transaction so the whole
 * check-write-stamp sequence rolls back, caught at the boundary and reported
 * as an ordinary parameter error (never escapes this module). */
class DirectWriteRefused extends Error {}

/**
 * TICKET 19, finding 1: the terminal gates' own sentinel — the SAME
 * roll-back-by-throwing mechanism as `DirectWriteRefused`, kept a separate
 * class for one reason: a gate refusal is NOT a parameter error and must not
 * pick up that prefix. It carries the caller-composed refusal text verbatim
 * and this module returns it unwrapped.
 */
class TerminalGateRefused extends Error {}

/**
 * The impression obligation's own sentinel — same roll-back-by-throwing
 * mechanism, kept a separate class only so the two refusals cannot be confused
 * at the boundary. Like a gate refusal it is returned unwrapped, and like a gate
 * refusal it costs no attempt: the transaction rolled back, so the job row is
 * still `claimed` and the run may repair its payload and call `commit` again.
 */
class ImpressionObligationRefused extends Error {}

/**
 * THE THIRD CHANNEL's own sentinel (settlement-gate-taxonomy ticket 05). Same
 * roll-back-by-throwing mechanism as the two above and a separate class for the
 * opposite reason: a refusal costs no attempt BECAUSE the run may repair and
 * retry, and a system failure costs no attempt because there is nothing to
 * retry. Conflating them at the throw would make the engine's own catch block
 * read as if the two were interchangeable.
 */
class SettlementSystemFailureRaised extends Error {}

/**
 * TICKET 19, finding 1 — the verdict of `evaluateTerminalGates`, evaluated
 * INSIDE `commit`'s own write transaction.
 *
 * The gates it carries (the lane-grammar commit gate and the mandatory
 * lane-disposition gate) used to be evaluated by the SDK-query layer BEFORE
 * it called `commit()`, i.e. before this engine ever opened `BEGIN
 * IMMEDIATE`. Nothing re-ran them under the lock, so a public note write that
 * landed in that window — minting an E6 draft edge, an E4, or an
 * undispositioned fracture — was invisible to the verdict and the commit
 * still marked the job `done`. The window is small and entirely real: the
 * gates read the live edge and tag tables, and stage 2 shares this database
 * with every other writer.
 *
 * "Look once, INSIDE": the outer layer no longer evaluates anything of its
 * own. It hands this callback, keeps whatever verdict the callback produced
 * in its own closure (the same shape `captureAtCommit` already uses at this
 * seam), and routes on it afterwards. A refusal throws, so SQLite rolls the
 * transaction back whole and the job row is untouched — the refusal costs no
 * attempt, exactly as it did when it was a plain early return.
 */
export type SettlementTerminalGateVerdict =
  | { ok: false; refusal: string }
  /**
   * THE THIRD CHANNEL, on the commit surface (settlement-gate-taxonomy ticket
   * 05). Not a refusal with a different sentence: a refusal names findings this
   * run can repair and invites it to call `commit` again, and this arm exists
   * precisely for the outcomes where neither is true. Kept a separate arm rather
   * than a flag on the refusal so a reader of this type cannot demote one to the
   * other by forgetting to test a boolean.
   */
  | { ok: false; systemFailure: SettlementSystemFailure }
  | { ok: true; warnings: readonly string[] };

/**
 * A lost lease is NOT a parameter error — the call was well-formed and the
 * model can do nothing to make it succeed. Rendered in `commit`'s own
 * "reclaimed / stop calling" register instead, naming the fence's reason
 * verbatim (`not-claimed` vs `generation-mismatch`, with the job id), so the
 * transcript records which of the two happened rather than a generic refusal.
 */
function leaseRefusal(error: NoteSettlementJobFenceError): ToolTextResult {
  return textResult(
    `Write refused — this dispatch's job lease was reclaimed (${error.message}). ` +
      "Nothing was written. No further write or commit will succeed. " +
      "Stop making tool calls.",
  );
}

/**
 * era-grant-by-settlement ticket 02 — `commit`'s own FORWARD half of ticket
 * 01's grant (`db/schema.ts`'s `ensureTurnEraGrantColumn`, the one-time
 * retroactive seed). Without this, the grant is frozen at migration time and
 * every future backfill of a pre-era window reproduces the exact silent
 * failure the spec was written about: a completed settlement that changes
 * nothing anyone can read.
 *
 * Population is window COVERAGE, not turns reviewed (ruled [S15069/T1818]):
 * every turn in `[windowStart, windowEnd]`, whether or not this run wrote a
 * note on it. An agent's decision not to note a turn is its own legitimate
 * judgment and must not leave that turn permanently invisible — the same
 * rule the retroactive seed reconstructs from the settlement job ledger,
 * applied live here instead of after the fact, so one rule serves both
 * directions.
 *
 * Scoped to `created_at_epoch < cutoffEpoch`: a turn already at or after the
 * cutoff reads as era-side through `isEraVisibleMember`'s ORIGINAL half
 * (`created_at_epoch >= cutoff`), so granting it would be a write with
 * nothing to show for it — a post-era window's commit costs no extra write
 * because this WHERE clause excludes it, not because of a check bolted on
 * after the fact. `cutoffEpoch === null` (no boundary recorded at all)
 * answers the identical question `isEraVisibleMember` answers false for —
 * nothing to grant relief FROM — so this returns 0 without a query.
 *
 * The `${ERA_GRANT_COLUMN} IS NULL` guard is what makes re-processing an
 * already-granted turn idempotent BY CONSTRUCTION: a turn this UPDATE has
 * already touched matches nothing on a later call, so the first grant's
 * epoch is left standing rather than merely unread, and the returned count
 * reports only the turns THIS call actually moved — never the window's whole
 * size.
 *
 * `windowStart`/`windowEnd` are `undefined` for a caller that predates this
 * ticket or never models a window at all; that is the same as a window
 * covering nothing, so this returns 0 deterministically rather than guessing
 * a range. The one production caller (`note-settlement-sdk-query.ts`) always
 * supplies both, sourced from the job's own frozen bounds.
 *
 * A prepared `.run()`, never `db.exec`: `bun:sqlite`'s multi-statement `exec`
 * swallows a constraint failure and runs the rest, which for a write that
 * MOVES data is a silent half-apply.
 */
function grantEraVisibilityForCommittedWindow(
  db: Database,
  sessionId: number,
  windowStart: number | undefined,
  windowEnd: number | undefined,
  nowEpoch: number,
): number {
  if (windowStart === undefined || windowEnd === undefined) {
    return 0;
  }
  const cutoffEpoch = resolveEraCutoff(db);
  if (cutoffEpoch === null) {
    return 0;
  }
  return db
    .query<unknown, [number, number, number, number, number]>(
      `UPDATE turns
          SET ${ERA_GRANT_COLUMN} = ?
        WHERE session_id = ?
          AND prompt_number BETWEEN ? AND ?
          AND created_at_epoch < ?
          AND ${ERA_GRANT_COLUMN} IS NULL`,
    )
    .run(nowEpoch, sessionId, windowStart, windowEnd, cutoffEpoch).changes;
}

export function createSettlementDirectWriteEngine(
  options: CreateSettlementDirectWriteEngineOptions,
): SettlementDirectWriteEngine {
  const { db, context } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const writeTransaction = options.runWriteTransaction ?? runWriteTransaction;

  const counts = emptyCommitCounts();
  let lastCommitMetrics: NoteSettlementCommitRecord | null = null;
  // Severed-lane over-blocking fix: this run's own touch facts, grown by
  // `writeNote`/`writeMembership` as each call's evaluation lands — never
  // reset, never replayed, exactly like `counts` above (module doc: "no
  // in-memory staged list, no replay").
  const touchedTurnTagPairs = new Set<string>();
  const touchedLaneKeys = new Set<string>();
  /** Ticket 04: the turns this run wrote at, the in-memory half of `RunLaneTouches.turnIds`. */
  const touchedTurnIds = new Set<number>();

  /**
   * Ticket 04: the DURABLE half of the same fact, written inside the
   * transaction of the write that produced it. In-transaction is the whole
   * point and not a detail — a touch that outlived a rolled-back write would
   * be a new lie in the other direction, so the row commits with the write or
   * vanishes with it.
   */
  function persistTurnWriteTouches(outcome: SettlementTurnWriteOutcome, nowEpoch: number): void {
    for (const touch of outcome.laneTouches) {
      recordLaneTouch(db, {
        jobId: context.jobId,
        kind: "turn-tag",
        entityId: touch.turnId,
        laneTag: touch.tag,
        createdAtEpoch: nowEpoch,
      });
    }
    for (const touch of outcome.laneKeyTouches) {
      recordLaneTouch(db, {
        jobId: context.jobId,
        kind: "lane",
        entityId: touch.segmentId,
        laneTag: touch.tag,
        createdAtEpoch: nowEpoch,
      });
    }
  }

  function writeNote(rawInput: SettlementTurnWriteInput): ToolTextResult {
    const nowEpoch = now();
    let evaluation: ReturnType<typeof evaluateSettlementTurnWrite>;
    try {
      // One transaction per call (peer finding P1-1): the evaluator's whole
      // check→write→stamp sequence — including a compound call whose LATER
      // half rejects after an EARLIER half already applied — commits or
      // vanishes as a unit. A rejection throws the sentinel so SQLite rolls
      // the transaction back whole (the staging engine's own
      // refusal-inside-transaction pattern), then reports as an ordinary
      // parameter error.
      evaluation = writeTransaction(db, () => {
        // Ticket 08 (and taught in the settlement prompt's own Duties
        // preamble, ticket 11): the lease check is the FIRST statement in the SAME
        // transaction as the write it guards. Its throw rolls the transaction
        // back for free, so no ordering discipline further down can be got
        // wrong — see `assertNoteSettlementJobClaimed`'s own doc comment.
        assertNoteSettlementJobClaimed(
          db,
          context.jobId,
          context.claimGeneration,
          context.stage,
        );
        const result = evaluateSettlementTurnWrite(db, context, rawInput, nowEpoch);
        if (!result.ok) {
          throw new DirectWriteRefused(result.message);
        }
        persistTurnWriteTouches(result.outcome, nowEpoch);
        return result;
      });
    } catch (error) {
      if (error instanceof NoteSettlementJobFenceError) {
        return leaseRefusal(error);
      }
      if (error instanceof DirectWriteRefused) {
        return parameterError(error.message);
      }
      throw error;
    }
    accumulateTurnWriteCounts(counts, evaluation.outcome);
    for (const touch of evaluation.outcome.laneTouches) {
      touchedTurnIds.add(touch.turnId);
      // Ticket 04, mirroring `loadRunLaneTouches`: the `''` sentinel says "this
      // run wrote at this turn and named no lane there" (a DRAFT edge side). It
      // belongs in the turn set and never in the (turn, lane) pair set.
      if (touch.tag !== "") {
        touchedTurnTagPairs.add(laneTouchTurnTagKey(touch.turnId, touch.tag));
      }
    }
    for (const touch of evaluation.outcome.laneKeyTouches) {
      touchedLaneKeys.add(laneTouchSegmentTagKey(touch.segmentId, touch.tag));
    }
    return textResult(renderSettlementTurnWriteReceipt(evaluation.outcome));
  }

  function writeMembership(rawInput: SettlementMembershipWriteInput): ToolTextResult {
    const nowEpoch = now();
    let evaluation: ReturnType<typeof evaluateSettlementMembershipWrite>;
    try {
      // Same one-transaction-per-call discipline; this wrap is also what makes
      // the lane verbs' existence checks share a transaction with the registry
      // mutation they guard — and, for `merge` (ticket 15), what makes the
      // member retag, the edge-side rewrite and the registry removal one
      // unit. A half-merged database is not a state this engine can leave behind.
      evaluation = writeTransaction(db, () => {
        // Ticket 08, and this is the path the ticket was written for: a
        // `declare` mints a lane row and a `merge` rewrites tags across turns
        // and edges — neither meets a field stamp on the way in, so nothing
        // but this fence stops a reclaimed claimant from planting durable
        // state that `commit` can then only complain about after the fact.
        assertNoteSettlementJobClaimed(
          db,
          context.jobId,
          context.claimGeneration,
          context.stage,
        );
        const result = evaluateSettlementMembershipWrite(db, rawInput, nowEpoch);
        if (!result.ok) {
          throw new DirectWriteRefused(result.message);
        }
        // TICKET 06: THIS FACADE RECORDS NO TOUCH AT ALL, and the absence is
        // the point. The one touch a lane write ever recorded came from
        // `justify` — a `lane` row naming a lane no member of which the run had
        // written — and it was self-arming: the call made the lane touched,
        // which made the gate demand a disposition for it, which the run
        // answered with another justify. Job 166's `lane_run_touches` held
        // exactly one row, `lane|60|execution-repair`, and that is where it
        // came from. `create`/`delete`/`merge` were never touch sources, so
        // there is nothing left here to record.
        return result;
      });
    } catch (error) {
      if (error instanceof NoteSettlementJobFenceError) {
        return leaseRefusal(error);
      }
      if (error instanceof DirectWriteRefused) {
        return parameterError(error.message);
      }
      throw error;
    }
    accumulateMembershipWriteCounts(counts, evaluation.outcome);
    return textResult(renderSettlementMembershipWriteReceipt(evaluation.outcome));
  }

  function commit(rawReport: unknown, rawImpressions?: unknown): ToolTextResult {
    // Idempotent within this SAME run: a second `commit` call after one
    // already landed reports the same fact rather than re-running the CAS,
    // which would otherwise throw `not-claimed` (the job is `done`, not
    // `claimed`) and mis-render a legitimate double-call as a lost lease.
    // Checked BEFORE `report` is even looked at (settlement-commit-report
    // ticket 01, decision 5, "first successful commit wins"): whatever this
    // second call passed is simply never read, which is what makes "a
    // second commit does not replace the first report" true by construction
    // rather than by a value comparison this branch would otherwise need.
    if (lastCommitMetrics !== null) {
      return textResult(
        `Already committed. S${context.sessionId} window settled — job complete. ` +
          summarizeCounts(lastCommitMetrics),
      );
    }

    const nowEpoch = now();
    let eraGranted = 0;
    let report = "";
    try {
      writeTransaction(db, () => {
        // TICKET 19, finding 1: THE TERMINAL GATES, INSIDE THE LOCK. First
        // statement in the transaction and, on refusal, the reason nothing
        // below it ever runs — see `evaluateTerminalGates` for why the whole
        // evaluation moved in here and why it, not the lease fence, is what
        // opens this block.
        const verdict = options.evaluateTerminalGates?.(db) ?? {
          ok: true as const,
          warnings: [],
        };
        if (!verdict.ok) {
          throw "systemFailure" in verdict
            ? new SettlementSystemFailureRaised(
                renderSettlementSystemFailure(verdict.systemFailure),
              )
            : new TerminalGateRefused(verdict.refusal);
        }
        // Validated next, before the lease/CAS below: a cheap, purely local
        // check with no DB read of its own, and — the reason it runs BEFORE
        // the lease fence rather than after — a malformed report is something
        // a retry can fix, while a reclaimed lease is not, so the more
        // actionable refusal (when both are true) is the one the caller
        // actually gets. Its rejection rolls this transaction back exactly as
        // the gate's does; no mutation has run yet either way.
        const validated = validateCommitReport(rawReport);
        if (!validated.ok) {
          throw new DirectWriteRefused(validated.refusal);
        }
        report = validated.report;
        // Ticket 06 (spec "commit 重定位"): claim validity + terminal mark,
        // nothing else — `completeNoteSettlementJobIfSegmentedCore` IS the
        // fence-and-CAS gate, already an empty shell of any duty-coverage
        // judgment (db/note-settlement-completion.ts's own doc comment).
        // `assertNoteSettlementJobClaimed` is belt-and-braces with the CAS
        // itself, not a second concept — which is why ticket 19 could seat
        // the two pure-read refusals above it without weakening anything: it
        // still runs before the first statement that MUTATES.
        assertNoteSettlementJobClaimed(
          db,
          context.jobId,
          context.claimGeneration,
          context.stage,
        );
        // THE IMPRESSION OBLIGATION, before the CAS below — see
        // `settleImpressions`' option doc for why this ordering is a
        // correctness rule and not a preference. It is the first statement in
        // this transaction that MUTATES anything, which is exactly why it sits
        // immediately after the lease fence that guards mutations.
        const impressions = options.settleImpressions?.(db, rawImpressions) ?? {
          ok: true as const,
        };
        if (!impressions.ok) {
          throw new ImpressionObligationRefused(impressions.refusal);
        }
        const gate = completeNoteSettlementJobIfSegmentedCore(
          db,
          context.jobId,
          context.claimGeneration,
          nowEpoch,
          {},
        );
        if (!gate.completed) {
          throw new NoteSettlementJobFenceError(
            context.jobId,
            gate.reason ?? "generation-mismatch",
            `settlement job ${context.jobId}: commit CAS did not match (${gate.reason ?? "unknown"})`,
          );
        }
        // era-grant-by-settlement ticket 02: the FORWARD half of ticket 01's
        // grant, written in this SAME transaction as the terminal mark — a
        // grant is part of the commit landing, not a follow-up write a crash
        // could separate from it (decision 2).
        eraGranted = grantEraVisibilityForCommittedWindow(
          db,
          context.sessionId,
          options.windowStart,
          options.windowEnd,
          nowEpoch,
        );
        // The receipt's own view of what this commit left, read INSIDE the
        // lock that left it (finding 9) — see `captureAtCommit`'s own comment.
        options.captureAtCommit?.(db);
      });
    } catch (error) {
      // TICKET 19: the gate's refusal comes back out UNWRAPPED — byte for
      // byte the text the callback composed, which is byte for byte what the
      // SDK-query layer returned when it evaluated the same gates itself.
      // The transaction rolled back, so the job row is untouched: still
      // `claimed`, same attempt count, and `lastCommitMetrics` still null, so
      // the run may repair and call `commit` again.
      if (error instanceof TerminalGateRefused) {
        return textResult(error.message);
      }
      // TICKET 05: the SAME rollback, a different meaning. The text is the
      // channel's own render, composed by `note-settlement-system-failure.ts`
      // and carrying no findings and no retry sentence — see that module.
      if (error instanceof SettlementSystemFailureRaised) {
        return textResult(error.message);
      }
      // Same register, same reason: the impression module composed the whole
      // refusal (it names the containers, their fences and their re-read
      // coordinates), and this engine returns it byte for byte.
      if (error instanceof ImpressionObligationRefused) {
        return textResult(error.message);
      }
      if (error instanceof DirectWriteRefused) {
        return parameterError(error.message);
      }
      if (error instanceof NoteSettlementJobFenceError) {
        return textResult(
          `Commit refused — this dispatch's job lease was reclaimed (${error.message}). ` +
            "No further commit will succeed. Stop making tool calls.",
        );
      }
      throw error;
    }

    // A fresh object, not a reference into the still-mutable `counts`
    // accumulator: the fence above guarantees no further `note`/`remember`
    // call can land after this point (a job that just went `done` fails
    // `assertNoteSettlementJobClaimed` the same way a reclaimed one does),
    // so this copy is never strictly necessary for correctness — it is
    // cheap insurance against that invariant moving later.
    lastCommitMetrics = { ...counts, report, eraGranted };
    return textResult(
      `Committed. S${context.sessionId} window settled — job complete. ` +
        summarizeCounts(counts),
    );
  }

  return {
    writeNote,
    writeMembership,
    commit,
    getLastCommitMetrics: () => lastCommitMetrics,
    // Ticket 04: durable rows FIRST, this instance's own sets folded on top.
    // The in-memory half is strictly redundant while both halves are written
    // together — kept because it costs nothing and because the interface's
    // contract is the union, not "whatever the table happens to hold".
    getRunLaneTouches: () => {
      const durable = loadRunLaneTouches(db, context.jobId);
      return {
        turnIds: new Set([...durable.turnIds, ...touchedTurnIds]),
        turnTagPairs: new Set([...durable.turnTagPairs, ...touchedTurnTagPairs]),
        laneKeys: new Set([...durable.laneKeys, ...touchedLaneKeys]),
      };
    },
  };
}
