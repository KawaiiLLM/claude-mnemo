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
  counts.lanesMerged += 1;
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
        "and call commit again.",
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
}

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
  commit(rawReport: unknown): ToolTextResult;
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
        assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);
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
      touchedTurnTagPairs.add(laneTouchTurnTagKey(touch.turnId, touch.tag));
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
        assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);
        const result = evaluateSettlementMembershipWrite(db, context, rawInput, nowEpoch);
        if (!result.ok) {
          throw new DirectWriteRefused(result.message);
        }
        // Ticket 04: the durable touch row, in the SAME transaction as the
        // justify row it accompanies — see `persistTurnWriteTouches` above.
        if (result.outcome.lane.action === "justify") {
          recordLaneTouch(db, {
            jobId: context.jobId,
            kind: "lane",
            entityId: result.outcome.lane.segmentId,
            laneTag: result.outcome.lane.tag,
            createdAtEpoch: nowEpoch,
          });
        }
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
    // Severed-lane over-blocking fix: a `justify` is engagement with the lane
    // it names, even though it changes no lane row — `create`/`delete`/
    // `merge` are NOT touch sources (ticket 02's own touch list, which
    // ticket 04 extended only with the DESTRUCTIVE twins of the sources
    // already on it: a retracted edge's sides and a removed tag).
    if (evaluation.outcome.lane.action === "justify") {
      touchedLaneKeys.add(
        laneTouchSegmentTagKey(evaluation.outcome.lane.segmentId, evaluation.outcome.lane.tag),
      );
    }
    return textResult(renderSettlementMembershipWriteReceipt(evaluation.outcome));
  }

  function commit(rawReport: unknown): ToolTextResult {
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

    // Validated next, before the lease/CAS below: a cheap, purely local
    // check with no DB read of its own, and — the reason it runs BEFORE the
    // lease fence rather than after — a malformed report is something a
    // retry can fix, while a reclaimed lease is not, so the more actionable
    // refusal (when both are true) is the one the caller actually gets.
    const validated = validateCommitReport(rawReport);
    if (!validated.ok) {
      return parameterError(validated.refusal);
    }

    const nowEpoch = now();
    let eraGranted = 0;
    try {
      writeTransaction(db, () => {
        // Ticket 06 (spec "commit 重定位"): claim validity + terminal mark,
        // nothing else — `completeNoteSettlementJobIfSegmentedCore` IS the
        // fence-and-CAS gate, already an empty shell of any duty-coverage
        // judgment (db/note-settlement-completion.ts's own doc comment).
        // `assertNoteSettlementJobClaimed` runs again as this function's own
        // first statement — belt-and-braces with the CAS itself, not a
        // second concept.
        assertNoteSettlementJobClaimed(db, context.jobId, context.claimGeneration);
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
      });
    } catch (error) {
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
    lastCommitMetrics = { ...counts, report: validated.report, eraGranted };
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
        turnTagPairs: new Set([...durable.turnTagPairs, ...touchedTurnTagPairs]),
        laneKeys: new Set([...durable.laneKeys, ...touchedLaneKeys]),
      };
    },
  };
}
