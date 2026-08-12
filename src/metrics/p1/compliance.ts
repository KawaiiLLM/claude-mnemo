import type { Database } from "bun:sqlite";

import { resolveEraCutoff } from "../../db/era";
import { NOTE_DEBT_AGING_TURNS, realPromptPredicate } from "../../db/note-debt";
import { agentAuthoredNotePredicate } from "../../db/shadow-notes";
import { isMnemoOwnToolName } from "../../shared/note-tool";

/**
 * Metric (a): how often the main agent actually writes the notes it owes.
 *
 * Two counting rules carry the whole metric and both are easy to get wrong:
 *
 * 1. The denominator is the note-debt ledger, and a turn's weight is counted
 *    with the ledger's own predicate — observations minus mnemo's own tool
 *    calls (`countSubstantiveToolCalls`). `turns.tool_call_count` is derived
 *    from the transcript by a later backfill and includes mnemo's calls, so
 *    bucketing by it would put turns in weight buckets the ledger never used
 *    and the totals would not reconcile with the ledger.
 *
 * 2. A debt that aged out without ever being shown to the agent is NOT a
 *    violation. The reminder displays only the five oldest debts, so during a
 *    backlog the newest debts are never rendered; charging those to the agent
 *    would measure the display cap, not compliance. Exposure comes from the
 *    `note_id_exposures` ledger, whose rows mean "rendered into the model's
 *    context" — the only fact that makes a miss the agent's to answer for.
 */

/** How a debt ended, from the trial's point of view. */
export type DebtOutcome =
  /** Written. */
  | "noted"
  /** Shown to the agent, never written, past the aging bound. The violation. */
  | "defaulted"
  /** Aged out without ever being displayed — the system never asked. */
  | "unreached"
  /** Still inside the aging window. */
  | "open"
  /** Rolled back: no note was ever owed. Excluded from the rate. */
  | "waived";

export interface DebtFact {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  status: string;
  reason: string | null;
  outcome: DebtOutcome;
  exposures: number;
  exposed: boolean;
  /** Past the aging bound but not yet reconciled to `skipped(aged)`. */
  lazyAged: boolean;
  substantiveToolCalls: number;
  sessionTurnCount: number;
  writerModel: string;
  /** True when writerModel was inferred from the session, not read off a note. */
  writerModelInferred: boolean;
  /** Turns between the turn and the turn the note was written in. */
  latencyTurns: number | null;
}

export interface OutcomeCounts {
  total: number;
  noted: number;
  defaulted: number;
  unreached: number;
  open: number;
  openExposed: number;
  waived: number;
  exposed: number;
}

export interface BucketRow {
  label: string;
  counts: OutcomeCounts;
  /** noted / (noted + defaulted) — null when nothing has settled yet. */
  complianceRate: number | null;
  /**
   * exposed / non-waived — how often a listing channel (per-debt reminder or
   * backlog relief) actually reached the debt.
   */
  reachRate: number | null;
}

export interface LatencySummary {
  measured: number;
  median: number | null;
  p90: number | null;
  withinThreeTurns: number | null;
}

export interface ComplianceReport {
  overall: BucketRow;
  bySessionLength: BucketRow[];
  byTurnWeight: BucketRow[];
  byWriterModel: BucketRow[];
  latency: LatencySummary;
  sessionsCovered: number;
  /**
   * Notes written for turns the ledger never opened a debt for, EXCLUDING the
   * current-turn protocol's (裁决 25) — a genuine anomaly count again.
   */
  notesWithoutDebt: number;
  /**
   * Debtless notes whose ride turn is their own turn — 裁决 25 working as
   * designed. The ledger tables above never see these; the trial's cross-era
   * read splits here.
   */
  currentTurnNotes: number;
  inferredWriterModels: number;
  agingTurns: number;
}

export interface CollectDebtFactsOptions {
  sessionId?: number;
  agingTurns?: number;
  /**
   * The note-prompt-clock era boundary (P2 fix): turns created at or after this
   * epoch get the DERIVED denominator below instead of the `note_debt`-based
   * one, because the new protocol only ever writes a `note_debt` row for a
   * decline or a residual close-out — an on-time note leaves none. Defaults to
   * `resolveEraCutoff(db)`; `null` (no era recorded) leaves every turn on the
   * old, `note_debt`-based reading, unchanged.
   */
  eraCutoffEpoch?: number | null;
}

interface DebtRow {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  status: string;
  reason: string | null;
  wasRolledBack: number;
  sessionTurnCount: number;
  sessionMaxPromptNumber: number;
  writerModel: string | null;
  ridePromptNumber: number | null;
  reminderExposures: number;
  /**
   * A real agent-authored note exists for this turn RIGHT NOW, independent of
   * `status`. `closeNoteDebtAsNoted` (note-debt.ts) only flips `pending` or
   * `skipped(declined)` rows to `noted` — a debt the SYSTEM closed as
   * `aged`/`rolled-back`/`closed` stays terminal forever even when the agent
   * (or settlement backfill, per spec D7) later writes a real note for that
   * same turn (ticket 06's known 01-carryover). `status` alone is therefore
   * not the ledger's current truth for those three reasons; `shadow_notes`
   * existence is.
   */
  hasNote: number;
}

const UNKNOWN_MODEL = "unknown";

function bucketSessionLength(turnCount: number): string {
  if (turnCount < 25) return "1-24 turns";
  if (turnCount < 100) return "25-99 turns";
  if (turnCount < 300) return "100-299 turns";
  return "300+ turns";
}

function bucketTurnWeight(toolCalls: number): string {
  if (toolCalls <= 0) return "0 tools";
  if (toolCalls === 1) return "1 tool";
  if (toolCalls <= 3) return "2-3 tools";
  if (toolCalls <= 7) return "4-7 tools";
  return "8+ tools";
}

const SESSION_LENGTH_ORDER = [
  "1-24 turns",
  "25-99 turns",
  "100-299 turns",
  "300+ turns",
];

const TURN_WEIGHT_ORDER = [
  "0 tools",
  "1 tool",
  "2-3 tools",
  "4-7 tools",
  "8+ tools",
];

/**
 * A turn's substantive tool calls. Reads the captured observations rather than
 * `turns.tool_call_count`: the count column is derived from the transcript by a
 * later backfill and includes mnemo's own calls, while observations are what the
 * hook actually saw and carry the exclusion marker.
 *
 * Relocated from db/note-debt.ts by note-prompt-clock (ticket 03): the live
 * note path no longer counts tool calls for anything — a turn's eligibility to
 * be noted or skipped is address resolution alone (spec D5), not a weight —
 * but the P1 trial's turn-weight bucketing (below) still needs this exact
 * predicate to reconcile against the ledger it is measuring, so it moved here
 * with its one remaining caller instead of being deleted.
 */
export function countSubstantiveToolCalls(db: Database, turnId: number): number {
  const rows = db
    .query<{ toolName: string | null }, [number]>(
      `SELECT tool_name AS toolName FROM observations
       WHERE turn_id = ? AND excluded_from_extraction = 0`,
    )
    .all(turnId);

  return rows.filter(
    (row) => row.toolName !== null && !isMnemoOwnToolName(row.toolName),
  ).length;
}

/**
 * Substantive tool calls for every turn in the ledger, in one query.
 *
 * Same predicate as `countSubstantiveToolCalls`, batched: calling that function
 * per debt would be one indexed lookup per turn, which is fine for a fixture and
 * needless work on a production-sized ledger. A test pins the two against each
 * other so the batched form cannot drift from the ledger's own rule.
 */
export function countSubstantiveToolCallsForDebts(
  db: Database,
  sessionId?: number,
): Map<number, number> {
  const rows =
    sessionId === undefined
      ? db
          .query<{ turnId: number; toolName: string }, []>(
            `SELECT o.turn_id AS turnId, o.tool_name AS toolName
             FROM observations o
             JOIN note_debt d ON d.turn_id = o.turn_id
             WHERE o.excluded_from_extraction = 0 AND o.tool_name IS NOT NULL`,
          )
          .all()
      : db
          .query<{ turnId: number; toolName: string }, [number]>(
            `SELECT o.turn_id AS turnId, o.tool_name AS toolName
             FROM observations o
             JOIN note_debt d ON d.turn_id = o.turn_id
             WHERE o.excluded_from_extraction = 0
               AND o.tool_name IS NOT NULL
               AND d.session_id = ?`,
          )
          .all(sessionId);

  const counts = new Map<number, number>();
  for (const row of rows) {
    if (isMnemoOwnToolName(row.toolName)) {
      continue;
    }
    counts.set(row.turnId, (counts.get(row.turnId) ?? 0) + 1);
  }

  return counts;
}

function dominantWriterModelPerSession(db: Database): Map<number, string> {
  const rows = db
    .query<{ sessionId: number; writerModel: string; hits: number }, []>(
      `SELECT t.session_id AS sessionId, n.writer_model AS writerModel,
              COUNT(*) AS hits
       FROM shadow_notes n
       JOIN turns t ON t.id = n.turn_id
       WHERE n.writer_model IS NOT NULL AND n.writer_model <> ''
         AND ${agentAuthoredNotePredicate()}
       GROUP BY t.session_id, n.writer_model`,
    )
    .all();

  const best = new Map<number, { model: string; hits: number }>();
  for (const row of rows) {
    const current = best.get(row.sessionId);
    if (!current || row.hits > current.hits) {
      best.set(row.sessionId, { model: row.writerModel, hits: row.hits });
    }
  }

  return new Map(
    [...best.entries()].map(([sessionId, value]) => [sessionId, value.model]),
  );
}

interface DerivedFactRow {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  wasRolledBack: number;
  sessionTurnCount: number;
  sessionMaxPromptNumber: number;
  writerModel: string | null;
  ridePromptNumber: number | null;
  reminderExposures: number;
  hasNote: number;
}

/**
 * The post-era denominator (P2 fix): every turn `note_debt` was never asked to
 * open a row for, because the new protocol closed one only for a decline or a
 * residual write-off (spec D1/D8) — an on-time note leaves no row at all. Read
 * directly off `turns`/`shadow_notes`, with the SAME base filter
 * `listOwedNoteTurns` uses (note-debt.ts's `realPromptPredicate`) so a
 * sidechain row, a rolled-back prompt, or a compact marker cannot inflate the
 * denominator either. The session's own current (not yet ended) turn is
 * excluded the same way `listOwedNoteTurns` excludes it: nothing can be a
 * violation before a later prompt has even arrived.
 *
 * Deliberately disjoint from the `note_debt`-based rows above: `NOT EXISTS`
 * against `note_debt` means a turn already counted through a decline/close row
 * is never double-counted here.
 */
function collectDerivedDebtFacts(
  db: Database,
  eraCutoffEpoch: number,
  sessionId: number | undefined,
): DerivedFactRow[] {
  const sql = `
    WITH session_size AS (
      SELECT session_id AS sessionId,
             COUNT(*) AS turnCount,
             MAX(prompt_number) AS maxPromptNumber
      FROM turns
      GROUP BY session_id
    )
    SELECT
      t.id AS turnId,
      t.session_id AS sessionId,
      t.prompt_number AS promptNumber,
      t.was_rolled_back AS wasRolledBack,
      z.turnCount AS sessionTurnCount,
      z.maxPromptNumber AS sessionMaxPromptNumber,
      n.writer_model AS writerModel,
      r.prompt_number AS ridePromptNumber,
      (SELECT COUNT(*) FROM note_id_exposures e
        WHERE e.session_id = t.session_id
          AND e.exposed_turn_id = t.id
          AND e.source IN ('reminder', 'injection')) AS reminderExposures,
      (CASE WHEN n.turn_id IS NOT NULL THEN 1 ELSE 0 END) AS hasNote
    FROM turns t
    JOIN session_size z ON z.sessionId = t.session_id
    LEFT JOIN shadow_notes n ON n.turn_id = t.id
      AND ${agentAuthoredNotePredicate()}
    LEFT JOIN turns r ON r.id = n.ride_turn_id
    WHERE t.created_at_epoch >= ?
      AND ${realPromptPredicate("t")}
      AND NOT EXISTS (SELECT 1 FROM note_debt d WHERE d.turn_id = t.id)
      AND t.prompt_number < (
        SELECT MAX(latest.prompt_number) FROM turns latest
        WHERE latest.session_id = t.session_id AND latest.status != 'undone'
      )
      ${sessionId === undefined ? "" : "AND t.session_id = ?"}
    ORDER BY t.session_id ASC, t.prompt_number ASC
  `;

  return sessionId === undefined
    ? db.query<DerivedFactRow, [number]>(sql).all(eraCutoffEpoch)
    : db.query<DerivedFactRow, [number, number]>(sql).all(eraCutoffEpoch, sessionId);
}

export function collectDebtFacts(
  db: Database,
  options: CollectDebtFactsOptions = {},
): DebtFact[] {
  const agingTurns = options.agingTurns ?? NOTE_DEBT_AGING_TURNS;
  const sql = `
    WITH session_size AS (
      SELECT session_id AS sessionId,
             COUNT(*) AS turnCount,
             MAX(prompt_number) AS maxPromptNumber
      FROM turns
      GROUP BY session_id
    )
    SELECT
      d.turn_id AS turnId,
      d.session_id AS sessionId,
      d.prompt_number AS promptNumber,
      d.status AS status,
      d.reason AS reason,
      t.was_rolled_back AS wasRolledBack,
      z.turnCount AS sessionTurnCount,
      z.maxPromptNumber AS sessionMaxPromptNumber,
      n.writer_model AS writerModel,
      r.prompt_number AS ridePromptNumber,
      (SELECT COUNT(*) FROM note_id_exposures e
        WHERE e.session_id = d.session_id
          AND e.exposed_turn_id = d.turn_id
          AND e.source IN ('reminder', 'injection')) AS reminderExposures,
      (CASE WHEN n.turn_id IS NOT NULL THEN 1 ELSE 0 END) AS hasNote
    FROM note_debt d
    JOIN turns t ON t.id = d.turn_id
    JOIN session_size z ON z.sessionId = d.session_id
    LEFT JOIN shadow_notes n ON n.turn_id = d.turn_id
      AND ${agentAuthoredNotePredicate()}
    LEFT JOIN turns r ON r.id = n.ride_turn_id
    ${options.sessionId === undefined ? "" : "WHERE d.session_id = ?"}
    ORDER BY d.session_id ASC, d.prompt_number ASC
  `;

  const rows =
    options.sessionId === undefined
      ? db.query<DebtRow, []>(sql).all()
      : db.query<DebtRow, [number]>(sql).all(options.sessionId);

  const toolCalls = countSubstantiveToolCallsForDebts(db, options.sessionId);
  const sessionModels = dominantWriterModelPerSession(db);

  const facts = rows.map((row) => {
    const exposed = row.reminderExposures > 0;
    const pastBound = row.sessionMaxPromptNumber - row.promptNumber > agingTurns;
    const lazyAged = row.status === "pending" && pastBound;

    let outcome: DebtOutcome;
    if (row.status === "noted" || row.hasNote === 1) {
      // `hasNote` wins over a terminal `status` (ticket 06's 01-carryover):
      // `shadow_notes` is the current truth about whether the turn was ever
      // written up, and a debt row the system closed (aged/rolled-back/closed)
      // never un-terminalises even after a real note lands.
      outcome = "noted";
    } else if (row.status === "skipped" && row.reason === "rolled-back") {
      outcome = "waived";
    } else if (row.status === "skipped" || lazyAged) {
      outcome = exposed ? "defaulted" : "unreached";
    } else if (row.wasRolledBack === 1) {
      // Rolled back, still pending only because no reminder has closed it yet.
      outcome = "waived";
    } else {
      outcome = "open";
    }

    const inferredModel = sessionModels.get(row.sessionId);
    const writerModel = row.writerModel ?? inferredModel ?? UNKNOWN_MODEL;

    return {
      turnId: row.turnId,
      sessionId: row.sessionId,
      promptNumber: row.promptNumber,
      status: row.status,
      reason: row.reason,
      outcome,
      exposures: row.reminderExposures,
      exposed,
      lazyAged,
      substantiveToolCalls: toolCalls.get(row.turnId) ?? 0,
      sessionTurnCount: row.sessionTurnCount,
      writerModel,
      writerModelInferred: row.writerModel === null && writerModel !== UNKNOWN_MODEL,
      latencyTurns:
        row.ridePromptNumber === null
          ? null
          : row.ridePromptNumber - row.promptNumber,
    };
  });

  const eraCutoffEpoch =
    options.eraCutoffEpoch !== undefined
      ? options.eraCutoffEpoch
      : resolveEraCutoff(db);
  if (eraCutoffEpoch === null) {
    return facts;
  }

  const derivedFacts = collectDerivedDebtFacts(
    db,
    eraCutoffEpoch,
    options.sessionId,
  ).map((row) => {
    const exposed = row.reminderExposures > 0;
    const pastBound = row.sessionMaxPromptNumber - row.promptNumber > agingTurns;

    let outcome: DebtOutcome;
    if (row.hasNote === 1) {
      outcome = "noted";
    } else if (row.wasRolledBack === 1) {
      outcome = "waived";
    } else if (pastBound) {
      outcome = exposed ? "defaulted" : "unreached";
    } else {
      outcome = "open";
    }

    const inferredModel = sessionModels.get(row.sessionId);
    const writerModel = row.writerModel ?? inferredModel ?? UNKNOWN_MODEL;

    return {
      turnId: row.turnId,
      sessionId: row.sessionId,
      promptNumber: row.promptNumber,
      // No `note_debt` row exists for a derived fact (that is the whole point
      // — see `collectDerivedDebtFacts`), so there is no ledger `status`/
      // `reason` pair to report; `outcome` alone is the derived judgement.
      status: outcome === "noted" ? "noted" : "derived",
      reason: null,
      outcome,
      exposures: row.reminderExposures,
      exposed,
      lazyAged: false,
      // `countSubstantiveToolCallsForDebts`'s batch join is keyed off
      // `note_debt`, which a derived fact by definition has no row in — read
      // per turn instead of falling back to a silent (and wrong) 0.
      substantiveToolCalls: countSubstantiveToolCalls(db, row.turnId),
      sessionTurnCount: row.sessionTurnCount,
      writerModel,
      writerModelInferred: row.writerModel === null && writerModel !== UNKNOWN_MODEL,
      latencyTurns:
        row.ridePromptNumber === null
          ? null
          : row.ridePromptNumber - row.promptNumber,
    };
  });

  return [...facts, ...derivedFacts].sort((left, right) =>
    left.sessionId !== right.sessionId
      ? left.sessionId - right.sessionId
      : left.promptNumber - right.promptNumber,
  );
}

function emptyCounts(): OutcomeCounts {
  return {
    total: 0,
    noted: 0,
    defaulted: 0,
    unreached: 0,
    open: 0,
    openExposed: 0,
    waived: 0,
    exposed: 0,
  };
}

function accumulate(counts: OutcomeCounts, fact: DebtFact): void {
  counts.total += 1;
  counts[fact.outcome] += 1;
  if (fact.exposed) {
    counts.exposed += 1;
    if (fact.outcome === "open") {
      counts.openExposed += 1;
    }
  }
}

function toBucketRow(label: string, counts: OutcomeCounts): BucketRow {
  const settled = counts.noted + counts.defaulted;
  const nonWaived = counts.total - counts.waived;

  return {
    label,
    counts,
    complianceRate: settled > 0 ? counts.noted / settled : null,
    reachRate: nonWaived > 0 ? counts.exposed / nonWaived : null,
  };
}

function bucketBy(
  facts: DebtFact[],
  key: (fact: DebtFact) => string,
  order?: string[],
): BucketRow[] {
  const buckets = new Map<string, OutcomeCounts>();
  for (const fact of facts) {
    const label = key(fact);
    let counts = buckets.get(label);
    if (!counts) {
      counts = emptyCounts();
      buckets.set(label, counts);
    }
    accumulate(counts, fact);
  }

  const labels = [...buckets.keys()].sort((left, right) => {
    if (order) {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (
          (leftIndex === -1 ? order.length : leftIndex) -
          (rightIndex === -1 ? order.length : rightIndex)
        );
      }
    }
    return left.localeCompare(right);
  });

  return labels.map((label) => toBucketRow(label, buckets.get(label)!));
}

function quantile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.floor(fraction * (sorted.length - 1)),
  );
  return sorted[index]!;
}

function summarizeLatency(facts: DebtFact[]): LatencySummary {
  const latencies = facts
    .filter((fact) => fact.outcome === "noted" && fact.latencyTurns !== null)
    .map((fact) => fact.latencyTurns!)
    .sort((left, right) => left - right);

  return {
    measured: latencies.length,
    median: quantile(latencies, 0.5),
    p90: quantile(latencies, 0.9),
    withinThreeTurns:
      latencies.length === 0
        ? null
        : latencies.filter((value) => value <= 3).length / latencies.length,
  };
}

/**
 * Debtless notes, split by protocol era. Under 裁决 25 a successful
 * current-turn note is written while its turn is live, classification then
 * absorbs the turn without ever opening a debt, and `ride_turn_id = turn_id` is
 * that protocol's signature (the reminder era wrote notes riding a LATER turn,
 * so the two never overlap). Those notes are the new protocol working as
 * designed and must not be reported as an anomaly; a debtless note that rode a
 * different turn still is one. The ledger-based tables above only ever see the
 * reminder era — the trial's cross-era read hangs on this split, since no
 * deploy epoch is recorded anywhere.
 *
 * Note-prompt-clock (P2 fix) adds a SECOND non-anomalous signature, and it is
 * the OPPOSITE shape: its discipline is "the current turn's note is left for
 * the next turn to write" (principle 2), so an on-time note under this
 * protocol rides a LATER turn than the one it is about — `ride_turn_id !=
 * turn_id`, exactly what the reminder-era read alone would have called
 * anomalous. `eraCutoffEpoch` tells the two protocols' debtless notes apart by
 * the NOTED TURN's own creation time; `null` (no era recorded) leaves every
 * note on the reminder-era-only reading, unchanged.
 */
function countNotesWithoutDebt(
  db: Database,
  sessionId: number | undefined,
  eraCutoffEpoch: number | null,
): { anomalous: number; currentTurn: number } {
  // `null` (no era recorded) leaves the reminder-era-only signature exactly as
  // it always read; a recorded era adds the second, opposite-shaped signature
  // as an OR clause rather than sending it as an always-true/false bound
  // parameter.
  const notAnomalousClause =
    eraCutoffEpoch === null
      ? "n.ride_turn_id = n.turn_id"
      : "(n.ride_turn_id = n.turn_id OR t.created_at_epoch >= ?)";
  const sql = `
    SELECT
      COALESCE(SUM(CASE WHEN ${notAnomalousClause} THEN 1 ELSE 0 END), 0)
        AS currentTurn,
      COALESCE(SUM(CASE WHEN ${notAnomalousClause} THEN 0 ELSE 1 END), 0)
        AS anomalous
    FROM shadow_notes n
    JOIN turns t ON t.id = n.turn_id
    LEFT JOIN note_debt d ON d.turn_id = n.turn_id
    WHERE d.turn_id IS NULL AND ${agentAuthoredNotePredicate()}
    ${sessionId === undefined ? "" : "AND t.session_id = ?"}
  `;
  const eraParams = eraCutoffEpoch === null ? [] : [eraCutoffEpoch, eraCutoffEpoch];
  const params =
    sessionId === undefined ? eraParams : [...eraParams, sessionId];

  const row = db
    .query<{ anomalous: number; currentTurn: number }, number[]>(sql)
    .get(...params);
  return { anomalous: row?.anomalous ?? 0, currentTurn: row?.currentTurn ?? 0 };
}

export function computeCompliance(
  db: Database,
  options: CollectDebtFactsOptions = {},
): ComplianceReport {
  const facts = collectDebtFacts(db, options);
  const eraCutoffEpoch =
    options.eraCutoffEpoch !== undefined
      ? options.eraCutoffEpoch
      : resolveEraCutoff(db);
  const debtless = countNotesWithoutDebt(db, options.sessionId, eraCutoffEpoch);
  const overallCounts = emptyCounts();
  for (const fact of facts) {
    accumulate(overallCounts, fact);
  }

  return {
    overall: toBucketRow("all", overallCounts),
    bySessionLength: bucketBy(
      facts,
      (fact) => bucketSessionLength(fact.sessionTurnCount),
      SESSION_LENGTH_ORDER,
    ),
    byTurnWeight: bucketBy(
      facts,
      (fact) => bucketTurnWeight(fact.substantiveToolCalls),
      TURN_WEIGHT_ORDER,
    ),
    byWriterModel: bucketBy(facts, (fact) => fact.writerModel),
    latency: summarizeLatency(facts),
    sessionsCovered: new Set(facts.map((fact) => fact.sessionId)).size,
    notesWithoutDebt: debtless.anomalous,
    currentTurnNotes: debtless.currentTurn,
    inferredWriterModels: facts.filter((fact) => fact.writerModelInferred).length,
    agingTurns: options.agingTurns ?? NOTE_DEBT_AGING_TURNS,
  };
}
