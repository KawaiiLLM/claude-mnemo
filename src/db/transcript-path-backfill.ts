import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { runWriteTransaction } from "./database";
import { transcriptRootPath } from "../shared/paths";

/**
 * One-time repair for `sessions.transcript_path` (see src/shared/paths.ts).
 *
 * Rows created before the column existed have no authoritative transcript path,
 * and the derivation they fall back to is exactly the one that breaks for a
 * session that `cd`ed. This pass looks each row's transcript up by content
 * session id under the transcript root and fills what it can find.
 *
 * WHERE THIS RUNS. Only in the worker, off every critical path
 * (src/worker/server.ts wires it into the watchdog tick). It is deliberately
 * NOT called from `initializeDatabase`: that runs in every hook process too,
 * which would put an unbounded filesystem scan on the hook critical path and
 * let several processes drive the same repair at once. Readers already fall
 * back to the legacy derivation while `transcript_path` is NULL, so a delayed
 * repair costs nothing and nothing here is urgent.
 *
 * The repair is driven by a VERSIONED, RESUMABLE ledger rather than by the
 * ALTER that added the column: the ALTER commits in milliseconds, the scan
 * touches the filesystem, and binding them would mean a crash mid-scan leaves
 * the column present and the repair silently unfinished forever. The ledger's
 * high-water cursor is over session ids ascending, and EVERY examined row
 * crosses it — including the ones left NULL — so a row is never permanently
 * re-selected and never double-counted. The completion marker is written last.
 *
 * Worker-only hosting is not trusted as the serialization mechanism. The ledger
 * row is also a lease-and-fence claim, the same idiom `settlement_jobs` uses:
 * claiming bumps `claim_generation`, every later write CASes on the generation
 * it claimed, and a fenced-out write rolls its whole batch back rather than
 * counting rows it did not write.
 */

export const TRANSCRIPT_PATH_BACKFILL_NAME = "transcript-path-backfill-v1";

/** Rows per transaction. */
export const DEFAULT_BACKFILL_BATCH_SIZE = 200;
/** Upper bound on rows examined in a single run; the rest resumes next tick. */
export const DEFAULT_BACKFILL_MAX_ROWS = 2000;
/** Wall-clock budget for the row phase, checked between committed batches. */
export const DEFAULT_BACKFILL_ROW_BUDGET_MS = 250;
/** Wall-clock budget for building the filesystem index (`maxRows` cannot bound it). */
export const DEFAULT_BACKFILL_SCAN_BUDGET_MS = 2_000;
/** Directory entries the index may enumerate before it gives up for this run. */
export const DEFAULT_BACKFILL_MAX_DIR_ENTRIES = 50_000;
/**
 * How long a claim stays valid without being released. A run is bounded by the
 * budgets above (well under a second), so this only matters after a crash: the
 * dead runner's claim ages out and the repair becomes claimable again.
 */
export const BACKFILL_LEASE_MS = 5 * 60_000;
/** First deferral waits this long; each further one doubles. */
export const BACKFILL_DEFERRAL_BASE_MS = 60_000;
/** …up to this ceiling (reached at the 11th consecutive deferral). */
export const BACKFILL_DEFERRAL_MAX_MS = 24 * 60 * 60_000;

export interface TranscriptPathBackfillOptions {
  /** Override the transcript root (tests; defaults to the shared resolver). */
  transcriptRoot?: string;
  batchSize?: number;
  maxRows?: number;
  rowBudgetMs?: number;
  scanBudgetMs?: number;
  maxDirEntries?: number;
  leaseMs?: number;
  /** Epoch seconds (ledger timestamps). */
  now?: () => number;
  /** Monotonic-ish milliseconds (budgets and the claim lease). */
  nowMs?: () => number;
  log?: (message: string) => void;
}

export type TranscriptPathBackfillStatus =
  /** Ledger already complete — no filesystem access, no writes. */
  | "skipped"
  /** Another runner holds a live claim; this one exits without touching anything. */
  | "busy"
  /**
   * Transcript root unreadable or too large to index inside the scan budget.
   * Nothing is consumed and the ledger never reaches `done`, so the one-shot
   * repair survives; a backoff stops the attempt from repeating every tick.
   */
  | "deferred"
  /** Row cap or time budget hit; the cursor advanced and the rest resumes. */
  | "progressed"
  | "completed";

export interface TranscriptPathBackfillSummary {
  status: TranscriptPathBackfillStatus;
  /** Rows examined by THIS run. */
  examined: number;
  /** Of those, how many were given a path (includes the ambiguous picks). */
  filled: number;
  /** Of those, how many found no transcript and stay NULL (reader falls back). */
  unresolved: number;
  /** Of the filled, how many had more than one candidate. */
  ambiguous: number;
  /** Ledger totals across all runs, after this one. */
  totals: { filled: number; unresolved: number; ambiguous: number };
  cursorId: number;
  /** When set, no run is attempted before this epoch second. */
  deferredUntilEpoch: number | null;
  /** Consecutive deferrals; drives the backoff and resets on a good scan. */
  deferralAttempts: number;
}

interface LedgerRow {
  status: string;
  cursorId: number;
  filledCount: number;
  unresolvedCount: number;
  ambiguousCount: number;
  claimGeneration: number;
  claimedAtEpoch: number | null;
  deferredUntilEpoch: number | null;
  deferralAttempts: number;
}

interface PendingSessionRow {
  id: number;
  contentSessionId: string;
}

interface CandidatePick {
  id: number;
  path: string;
  ambiguous: boolean;
}

type IndexOutcome =
  | { ok: true; index: Map<string, string[]> }
  | { ok: false; reason: "unreadable" | "over-budget" };

/** Thrown inside a batch transaction when the claim was taken over; rolls it back. */
class FencedOutError extends Error {}

function defaultLog(message: string): void {
  process.stderr.write(`[claude-mnemo] ${message}\n`);
}

const LEDGER_COLUMNS = `status,
        cursor_id AS cursorId,
        filled_count AS filledCount,
        unresolved_count AS unresolvedCount,
        ambiguous_count AS ambiguousCount,
        claim_generation AS claimGeneration,
        claimed_at_epoch AS claimedAtEpoch,
        deferred_until_epoch AS deferredUntilEpoch,
        deferral_attempts AS deferralAttempts`;

function readLedger(db: Database, name: string): LedgerRow | null {
  return (
    db
      .query<LedgerRow, [string]>(
        `SELECT ${LEDGER_COLUMNS} FROM repair_ledger WHERE name = ?`,
      )
      .get(name) ?? null
  );
}

/**
 * Take the repair's claim, creating the ledger row on first sight.
 *
 * Returns null when a live claim already exists — the loser exits before any
 * filesystem or counter work, so losing costs one indexed read. The returned
 * generation is the fence every later write in this run CASes on.
 */
function claimLedger(
  db: Database,
  name: string,
  nowEpoch: number,
  leaseCutoffEpoch: number,
): number | null {
  return runWriteTransaction(db, () => {
    db.query<unknown, [string, number]>(
      `INSERT OR IGNORE INTO repair_ledger (name, status, started_at_epoch)
       VALUES (?, 'running', ?)`,
    ).run(name, nowEpoch);

    const claimed = db
      .query<{ claimGeneration: number }, [number, string, number]>(
        `UPDATE repair_ledger
         SET claim_generation = claim_generation + 1,
             claimed_at_epoch = ?
         WHERE name = ?
           AND status = 'running'
           AND (claimed_at_epoch IS NULL OR claimed_at_epoch <= ?)
         RETURNING claim_generation AS claimGeneration`,
      )
      .get(nowEpoch, name, leaseCutoffEpoch);

    return claimed?.claimGeneration ?? null;
  });
}

/**
 * uuid -> every `<uuid>.jsonl` under the transcript root, one entry per project
 * directory it appears in. Built once per run: one readdir per project dir beats
 * one stat per (row × dir), and it yields the full candidate list a multi-hit
 * tie-break needs.
 *
 * `maxRows` bounds database rows, not this. A partial index would mark real
 * sessions unresolved and push them past the high-water cursor permanently, so
 * an enumeration that blows its budget yields no index at all and the run
 * defers instead — the same handling an unreadable root gets.
 */
function indexTranscriptFiles(
  root: string,
  limits: {
    maxEntries: number;
    deadlineMs: number;
    nowMs: () => number;
  },
): IndexOutcome {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const index = new Map<string, string[]>();
  let entriesSeen = projectDirs.length;

  for (const dir of projectDirs) {
    if (entriesSeen > limits.maxEntries || limits.nowMs() >= limits.deadlineMs) {
      return { ok: false, reason: "over-budget" };
    }

    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      // A single unreadable project directory is not a reason to abandon the
      // whole repair; its sessions simply resolve to zero candidates.
      continue;
    }
    entriesSeen += files.length;

    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const uuid = file.slice(0, -".jsonl".length);
      const paths = index.get(uuid);
      if (paths) {
        paths.push(join(dir, file));
      } else {
        index.set(uuid, [join(dir, file)]);
      }
    }
  }

  if (entriesSeen > limits.maxEntries) {
    return { ok: false, reason: "over-budget" };
  }

  return { ok: true, index };
}

function modifiedAtMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Stable multi-hit order: most recently written first, ties broken by the
 * normalized absolute path ascending. The second key is what makes the pick
 * reproducible — two transcripts written in the same millisecond would
 * otherwise resolve by readdir order, which is filesystem-dependent.
 *
 * A unique hit — the common case — short-circuits before any `stat`: there is
 * nothing to order, so the filesystem round trip buys nothing.
 */
export function orderTranscriptCandidates(
  candidates: string[],
  mtimeOf: (path: string) => number = modifiedAtMs,
): string[] {
  if (candidates.length <= 1) {
    return candidates.map((path) => resolve(path));
  }

  return candidates
    .map((path) => ({ path: resolve(path), mtimeMs: mtimeOf(path) }))
    .sort((a, b) =>
      b.mtimeMs !== a.mtimeMs
        ? b.mtimeMs - a.mtimeMs
        : a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0,
    )
    .map((candidate) => candidate.path);
}

/** Exponential, capped. Returns milliseconds for the Nth consecutive deferral. */
function deferralDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  if (exponent >= 32) {
    return BACKFILL_DEFERRAL_MAX_MS;
  }
  return Math.min(
    BACKFILL_DEFERRAL_MAX_MS,
    BACKFILL_DEFERRAL_BASE_MS * 2 ** exponent,
  );
}

export function runTranscriptPathBackfill(
  db: Database,
  options: TranscriptPathBackfillOptions = {},
): TranscriptPathBackfillSummary {
  const name = TRANSCRIPT_PATH_BACKFILL_NAME;
  const log = options.log ?? defaultLog;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = options.nowMs ?? (() => Date.now());
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE);
  const maxRows = Math.max(1, options.maxRows ?? DEFAULT_BACKFILL_MAX_ROWS);
  const rowBudgetMs = Math.max(
    0,
    options.rowBudgetMs ?? DEFAULT_BACKFILL_ROW_BUDGET_MS,
  );
  const scanBudgetMs = Math.max(
    0,
    options.scanBudgetMs ?? DEFAULT_BACKFILL_SCAN_BUDGET_MS,
  );
  const maxDirEntries = Math.max(
    1,
    options.maxDirEntries ?? DEFAULT_BACKFILL_MAX_DIR_ENTRIES,
  );
  const leaseMs = Math.max(0, options.leaseMs ?? BACKFILL_LEASE_MS);

  const existing = readLedger(db, name);
  const idle = (
    status: TranscriptPathBackfillStatus,
    overrides: Partial<TranscriptPathBackfillSummary> = {},
  ): TranscriptPathBackfillSummary => ({
    status,
    examined: 0,
    filled: 0,
    unresolved: 0,
    ambiguous: 0,
    totals: {
      filled: existing?.filledCount ?? 0,
      unresolved: existing?.unresolvedCount ?? 0,
      ambiguous: existing?.ambiguousCount ?? 0,
    },
    cursorId: existing?.cursorId ?? 0,
    deferredUntilEpoch: existing?.deferredUntilEpoch ?? null,
    deferralAttempts: existing?.deferralAttempts ?? 0,
    ...overrides,
  });

  // Idempotent skip: after completion this is the only cost, one indexed read.
  if (existing?.status === "done") {
    return idle("skipped");
  }

  // A deferral in force is checked BEFORE the claim, so a stalled repair costs
  // one indexed read per tick instead of a root read per tick.
  const startEpoch = now();
  if (
    existing?.deferredUntilEpoch != null &&
    startEpoch < existing.deferredUntilEpoch
  ) {
    return idle("deferred");
  }

  const startMs = nowMs();
  const generation = claimLedger(
    db,
    name,
    startEpoch,
    Math.floor((startMs - leaseMs) / 1000),
  );
  if (generation === null) {
    return idle("busy");
  }

  const releaseClaim = (): void => {
    db.query<unknown, [string, number]>(
      `UPDATE repair_ledger
       SET claimed_at_epoch = NULL
       WHERE name = ? AND claim_generation = ?`,
    ).run(name, generation);
  };

  const root = options.transcriptRoot ?? transcriptRootPath();
  const outcome = indexTranscriptFiles(root, {
    maxEntries: maxDirEntries,
    deadlineMs: startMs + scanBudgetMs,
    nowMs,
  });

  if (!outcome.ok) {
    // Nothing consumed and the status stays `running`: an environment whose
    // transcript root is missing must not burn the one-shot repair by marking
    // every session unresolved, and a root that appears later must still be
    // repaired. Only the retry rate is suppressed.
    const attempts = (existing?.deferralAttempts ?? 0) + 1;
    const untilEpoch =
      startEpoch + Math.ceil(deferralDelayMs(attempts) / 1000);
    db.query<unknown, [number, number, string, number]>(
      `UPDATE repair_ledger
       SET claimed_at_epoch = NULL,
           deferral_attempts = ?,
           deferred_until_epoch = ?
       WHERE name = ? AND claim_generation = ?`,
    ).run(attempts, untilEpoch, name, generation);

    // Silent while no repair has started yet (a root that never existed means
    // there is nothing to repair); loud once one has, because then a started
    // repair is stalled.
    if (existing && existing.cursorId > 0) {
      log(
        `transcript-path backfill deferred: transcript root ${root} is ` +
          `${outcome.reason === "unreadable" ? "not readable" : "too large to index within the scan budget"}; ` +
          `retry ${attempts} not before epoch ${untilEpoch}`,
      );
    }

    return idle("deferred", {
      deferredUntilEpoch: untilEpoch,
      deferralAttempts: attempts,
    });
  }

  const index = outcome.index;

  // A good scan clears the backoff, so a transient outage does not leave a
  // day-long wait behind once the root is back.
  if (existing?.deferralAttempts || existing?.deferredUntilEpoch != null) {
    db.query<unknown, [string, number]>(
      `UPDATE repair_ledger
       SET deferral_attempts = 0, deferred_until_epoch = NULL
       WHERE name = ? AND claim_generation = ?`,
    ).run(name, generation);
  }

  let cursorId = existing?.cursorId ?? 0;
  let examined = 0;
  let filled = 0;
  let unresolved = 0;
  let ambiguous = 0;
  let exhausted = false;
  let fenced = false;
  const rowDeadlineMs = startMs + rowBudgetMs;

  while (examined < maxRows) {
    const limit = Math.min(batchSize, maxRows - examined);
    const rows = db
      .query<PendingSessionRow, [number, number]>(
        `SELECT id, content_session_id AS contentSessionId
         FROM sessions
         WHERE id > ? AND transcript_path IS NULL
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(cursorId, limit);

    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    const picks: CandidatePick[] = [];
    let batchUnresolved = 0;

    for (const row of rows) {
      const candidates = index.get(row.contentSessionId) ?? [];
      if (candidates.length === 0) {
        batchUnresolved += 1;
        continue;
      }

      const ordered = orderTranscriptCandidates(candidates);
      const pick = ordered[0]!;
      picks.push({ id: row.id, path: pick, ambiguous: ordered.length > 1 });

      if (ordered.length > 1) {
        log(
          `transcript-path backfill: session ${row.id} ` +
            `(${row.contentSessionId}) matched ${ordered.length} transcripts ` +
            `[${ordered.join(", ")}]; picked ${pick} by (mtime DESC, path ASC)`,
        );
      }
    }

    const batchCursorId = rows[rows.length - 1]!.id;
    let batchFilled = 0;
    let batchAmbiguous = 0;

    // Cursor, counters and row writes land together. A zero-hit row still moves
    // the cursor, so a crash after this commit cannot re-select or re-count it.
    // The counters carry what the guarded UPDATEs ACTUALLY changed, and the
    // ledger write is fenced on the claim generation: a runner whose claim was
    // taken over writes nothing at all, session rows included.
    try {
      runWriteTransaction(db, () => {
        batchFilled = 0;
        batchAmbiguous = 0;

        for (const pick of picks) {
          const written = db
            .query<unknown, [string, number]>(
              `UPDATE sessions
               SET transcript_path = ?
               WHERE id = ? AND transcript_path IS NULL`,
            )
            .run(pick.path, pick.id).changes;
          if (written === 0) {
            continue;
          }
          batchFilled += 1;
          if (pick.ambiguous) {
            batchAmbiguous += 1;
          }
        }

        const ledgerWrite = db
          .query<unknown, [number, number, number, number, string, number]>(
            `UPDATE repair_ledger
             SET cursor_id = MAX(cursor_id, ?),
                 filled_count = filled_count + ?,
                 unresolved_count = unresolved_count + ?,
                 ambiguous_count = ambiguous_count + ?
             WHERE name = ? AND claim_generation = ?`,
          )
          .run(
            batchCursorId,
            batchFilled,
            batchUnresolved,
            batchAmbiguous,
            name,
            generation,
          );

        if (ledgerWrite.changes === 0) {
          throw new FencedOutError();
        }
      });
    } catch (error) {
      if (!(error instanceof FencedOutError)) {
        throw error;
      }
      fenced = true;
      break;
    }

    cursorId = Math.max(cursorId, batchCursorId);
    examined += rows.length;
    filled += batchFilled;
    unresolved += batchUnresolved;
    ambiguous += batchAmbiguous;

    if (rows.length < limit) {
      exhausted = true;
      break;
    }

    // A budget-exhausted run is a normal partial run: the cursor is committed,
    // so the next tick picks up exactly where this one stopped.
    if (nowMs() >= rowDeadlineMs) {
      break;
    }
  }

  if (fenced) {
    // Another runner owns the repair now. Leave its claim alone and report the
    // batches this run legitimately committed before losing.
    const afterFence = readLedger(db, name);
    return {
      status: "busy",
      examined,
      filled,
      unresolved,
      ambiguous,
      totals: {
        filled: afterFence?.filledCount ?? filled,
        unresolved: afterFence?.unresolvedCount ?? unresolved,
        ambiguous: afterFence?.ambiguousCount ?? ambiguous,
      },
      cursorId: afterFence?.cursorId ?? cursorId,
      deferredUntilEpoch: afterFence?.deferredUntilEpoch ?? null,
      deferralAttempts: afterFence?.deferralAttempts ?? 0,
    };
  }

  // Written LAST, in its own statement: only after every batch has committed is
  // the repair allowed to declare itself finished. Fenced like the batches, and
  // it releases the claim in the same write.
  if (exhausted) {
    const completion = db
      .query<unknown, [number, string, number]>(
        `UPDATE repair_ledger
         SET status = 'done', completed_at_epoch = ?, claimed_at_epoch = NULL
         WHERE name = ? AND claim_generation = ?`,
      )
      .run(now(), name, generation);
    if (completion.changes === 0) {
      fenced = true;
    }
  } else {
    releaseClaim();
  }

  const after = readLedger(db, name);
  const summary: TranscriptPathBackfillSummary = {
    status: fenced ? "busy" : exhausted ? "completed" : "progressed",
    examined,
    filled,
    unresolved,
    ambiguous,
    totals: {
      filled: after?.filledCount ?? filled,
      unresolved: after?.unresolvedCount ?? unresolved,
      ambiguous: after?.ambiguousCount ?? ambiguous,
    },
    cursorId,
    deferredUntilEpoch: after?.deferredUntilEpoch ?? null,
    deferralAttempts: after?.deferralAttempts ?? 0,
  };

  if (examined > 0 || exhausted) {
    log(
      `transcript-path backfill ${summary.status}: examined ${examined}, ` +
        `filled ${filled} (${ambiguous} multi-candidate), ` +
        `left NULL ${unresolved}; cursor at session ${cursorId}; ` +
        `totals filled ${summary.totals.filled}, ` +
        `left NULL ${summary.totals.unresolved}, ` +
        `multi-candidate ${summary.totals.ambiguous}`,
    );
  }

  return summary;
}
