import type { Database } from "bun:sqlite";

import { getMaxPromptNumber } from "../db/turns";
import {
  rewindSessionScanCursor,
  updateSessionScanCursor,
} from "../db/sessions";
import {
  extractUserPrompt,
  isChainParticipant,
  isInterruptedUserMarker,
  isRealUserPrompt,
  type TranscriptEntryWithLineNumber,
} from "../shared/transcript-parser";
import {
  DEFAULT_SCAN_MAX_LINES,
  rewindCursorToLine,
  scanTranscriptIncrementally,
  type IncrementalScanResult,
  type ScanCursor,
} from "./transcript-scan";

export type CaptureRepairLog = (message: string) => void;

const defaultLog: CaptureRepairLog = (message) => {
  process.stderr.write(`[claude-mnemo] ${message}\n`);
};

export interface CompactBoundaryClaim {
  uuid: string;
  boundaryLineNumber: number;
  promptId: string;
  wrapperLineNumber: number;
  summary: string;
  trigger: "manual" | "auto";
  preCompactTokenCount: number | null;
}

export interface CompactClaimOutcome {
  inserted: number;
  converted: number;
  adopted: number;
  skipped: number;
}

export interface LinkReconcileOutcome {
  linked: number;
  skipped: number;
}

export interface CaptureRepairOutcome {
  compact: CompactClaimOutcome;
  links: LinkReconcileOutcome;
  scannedEntries: number;
  truncated: boolean;
  cursor: ScanCursor;
  /** True when the wall-clock deadline stopped the run before the line cap. */
  stoppedForDeadline: boolean;
}

function rawContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block): block is { type?: unknown; text?: unknown } => {
      return Boolean(block) && typeof block === "object";
    })
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Every compact boundary in the window paired with its summary wrapper.
 *
 * `pendingBoundaryLine` is set when the window ENDS on a boundary whose wrapper
 * has not been written yet. The caller must hold the cursor before that line:
 * committing past an unpaired boundary would strand it permanently unclaimable,
 * which is the exact failure mode (9 boundaries, 2 markers) this ticket fixes.
 */
export function collectCompactBoundaryClaims(
  entries: TranscriptEntryWithLineNumber[],
): { claims: CompactBoundaryClaim[]; pendingBoundaryLine: number | null } {
  const claims: CompactBoundaryClaim[] = [];
  let pendingBoundaryLine: number | null = null;

  entries.forEach((entry, index) => {
    if (
      entry.type !== "system" ||
      entry.subtype !== "compact_boundary" ||
      !entry.uuid
    ) {
      return;
    }

    const wrapper = entries[index + 1];

    if (!wrapper) {
      pendingBoundaryLine = entry.lineNumber;
      return;
    }

    if (
      wrapper.role !== "user" ||
      wrapper.parentUuid !== entry.uuid ||
      !wrapper.promptId
    ) {
      return;
    }

    const summary = rawContentText(wrapper.content);
    if (!summary) {
      return;
    }

    const metadata = entry.compactMetadata;
    claims.push({
      uuid: entry.uuid,
      boundaryLineNumber: entry.lineNumber,
      promptId: wrapper.promptId,
      wrapperLineNumber: wrapper.lineNumber,
      summary,
      trigger: metadata?.trigger === "auto" ? "auto" : "manual",
      preCompactTokenCount:
        typeof metadata?.preCompactTokenCount === "number"
          ? metadata.preCompactTokenCount
          : typeof metadata?.pre_tokens === "number"
            ? metadata.pre_tokens
            : null,
    });
  });

  return { claims, pendingBoundaryLine };
}

interface OwnerRow {
  id: number;
  type: string | null;
  compactBoundaryUuid: string | null;
}

/** Rendering metadata every marker carries, inserted or converted alike. */
function compactMetadataTags(claim: CompactBoundaryClaim): string[] {
  return [
    `compact:pre_tokens=${claim.preCompactTokenCount ?? 0}`,
    `compact:trigger=${claim.trigger}`,
  ];
}

/**
 * Turn a real turn that stole the summary wrapper's promptId into the compact
 * marker (spec §F conversion). Column disposition is exhaustive and explicit:
 *
 * - preserve: prompt_number, user_prompt, created_at_epoch, content_prompt_id
 * - set:      type, status, title, compact_boundary_uuid, updated_at_epoch,
 *             tags (the boundary's compact: metadata), cites_recorded = 1
 * - clear:    every extraction-derived column, the stall-retry family, and the
 *             row's OUTGOING citation edges
 *
 * Clearing is what stops a later extraction from overwriting the marker: the row
 * leaves as terminal `extracted` with no assistant_response and no queue work,
 * so neither the orphan nor the stranded selector can pick it up again.
 *
 * Citations get an asymmetric treatment on purpose. The outgoing edges were
 * produced by the phantom extraction that is being erased, so leaving them would
 * feed in-degree confirmation with citations no surviving text makes; they are
 * deleted. Incoming edges are a different thing entirely — provenance written by
 * OTHER turns about this one — and survive. `cites_recorded = 1` makes the now-
 * empty outgoing set authoritative instead of "unknown, go parse inline [T<n>]
 * out of content" (content is NULL after this, so the fallback would find none
 * anyway, but the predicate must state the fact rather than imply it).
 */
function convertOccupiedTurnToMarker(
  db: Database,
  turnId: number,
  claim: CompactBoundaryClaim,
  nowEpoch: number,
): void {
  db.query<unknown, [string, number, string, number]>(
    `UPDATE turns
     SET type = 'compact',
         status = 'extracted',
         title = '/compact',
         compact_boundary_uuid = ?,
         updated_at_epoch = ?,
         tags = ?,
         cites_recorded = 1,
         content = NULL,
         insight = NULL,
         significance_grade = NULL,
         assistant_response = NULL,
         assistant_transcript = NULL,
         files_read = NULL,
         files_modified = NULL,
         tool_call_count = NULL,
         was_interrupted = 0,
         was_rolled_back = 0,
         extraction_stall_attempts = 0,
         extraction_stall_retry_at_ms = NULL,
         extraction_stall_retry_after_seq = NULL,
         extraction_stall_retry_mode = NULL
     WHERE id = ?`,
  ).run(
    claim.uuid,
    nowEpoch,
    JSON.stringify(compactMetadataTags(claim)),
    turnId,
  );

  // Outgoing only. `cited_turn_id = ?` rows are other turns' provenance.
  db.query<unknown, [number]>(
    "DELETE FROM turn_citations WHERE citing_turn_id = ?",
  ).run(turnId);

  // The cleared row must not keep answering recall with its old extraction.
  db.query<unknown, [number]>(
    "DELETE FROM memory_fts WHERE layer = 'turn' AND source_id = ?",
  ).run(turnId);

  // Same terminal semantics as SessionEnd orphan finalization
  // (db/orphan-turns.ts): retire pending observations, drop their queue work.
  db.query<unknown, [number]>(
    `UPDATE observations SET status = 'skipped'
     WHERE turn_id = ? AND status = 'pending'`,
  ).run(turnId);
  db.query<unknown, [number]>(
    `DELETE FROM pending_queue
     WHERE kind = 'obs' AND target_id IN (
       SELECT id FROM observations WHERE turn_id = ?
     )`,
  ).run(turnId);
  db.query<unknown, [number]>(
    "DELETE FROM pending_queue WHERE kind = 'turn-stop' AND target_id = ?",
  ).run(turnId);
}

/**
 * Claim every unclaimed compact boundary in the window, in transcript order.
 * Idempotent on the boundary UUID: a re-scan of the same region is a no-op.
 */
export function claimCompactBoundaries(
  db: Database,
  sessionId: number,
  claims: CompactBoundaryClaim[],
  nowEpoch: number,
  log: CaptureRepairLog,
): CompactClaimOutcome {
  const outcome: CompactClaimOutcome = {
    inserted: 0,
    converted: 0,
    adopted: 0,
    skipped: 0,
  };

  for (const claim of claims) {
    const alreadyClaimed = db
      .query<{ id: number }, [number, string]>(
        `SELECT id FROM turns
         WHERE session_id = ? AND compact_boundary_uuid = ? LIMIT 1`,
      )
      .get(sessionId, claim.uuid);

    if (alreadyClaimed) {
      outcome.skipped += 1;
      continue;
    }

    const owner = db
      .query<OwnerRow, [number, string]>(
        `SELECT id, type, compact_boundary_uuid AS compactBoundaryUuid
         FROM turns
         WHERE session_id = ? AND content_prompt_id = ? LIMIT 1`,
      )
      .get(sessionId, claim.promptId);

    if (owner) {
      if (owner.compactBoundaryUuid !== null) {
        outcome.skipped += 1;
        log(
          `compact boundary ${claim.uuid}: promptId ${claim.promptId} already ` +
            `marks boundary ${owner.compactBoundaryUuid}; skipped`,
        );
        continue;
      }

      // A marker created by the retired PostCompact path (no UUID column yet).
      // Adopt it — stamping the identity key is enough; rewriting it would
      // destroy the token/trigger tags it already carries.
      if (owner.type === "compact") {
        db.query<unknown, [string, number]>(
          `UPDATE turns SET compact_boundary_uuid = ?
           WHERE id = ? AND compact_boundary_uuid IS NULL`,
        ).run(claim.uuid, owner.id);
        outcome.adopted += 1;
        continue;
      }

      convertOccupiedTurnToMarker(db, owner.id, claim, nowEpoch);
      outcome.converted += 1;
      log(
        `compact boundary ${claim.uuid}: converted turn ${owner.id} that had ` +
          `claimed promptId ${claim.promptId}`,
      );
      continue;
    }

    const maxPromptNumber = getMaxPromptNumber(db, sessionId) ?? 0;
    const tags = compactMetadataTags(claim);

    db.query<
      unknown,
      [number, number, string, string, number, string, string, number]
    >(
      `INSERT OR IGNORE INTO turns (
         session_id,
         prompt_number,
         content_prompt_id,
         status,
         title,
         content,
         type,
         transcript_line_start,
         tags,
         files_read,
         files_modified,
         tool_call_count,
         compact_boundary_uuid,
         created_at_epoch
       ) VALUES (?, ?, ?, 'extracted', '/compact', ?, 'compact', ?, ?, '[]', '[]', 0, ?, ?)`,
    ).run(
      sessionId,
      maxPromptNumber + 1,
      claim.promptId,
      claim.summary,
      claim.wrapperLineNumber,
      JSON.stringify(tags),
      claim.uuid,
      nowEpoch,
    );
    outcome.inserted += 1;
  }

  return outcome;
}

interface LinkCandidate {
  promptId: string;
  lineNumber: number;
  text: string;
}

interface NullLinkTurn {
  id: number;
  promptNumber: number;
  userPrompt: string | null;
  contentPromptId: string | null;
  transcriptLineStart: number | null;
}

function collectLinkCandidates(
  entries: TranscriptEntryWithLineNumber[],
): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (
      entry.role !== "user" ||
      entry.isSidechain === true ||
      !isChainParticipant(entry) ||
      !entry.promptId ||
      seen.has(entry.promptId) ||
      isInterruptedUserMarker(entry) ||
      !isRealUserPrompt(entry)
    ) {
      continue;
    }

    const text = extractUserPrompt(entry);
    if (text === "") {
      continue;
    }

    seen.add(entry.promptId);
    candidates.push({
      promptId: entry.promptId,
      lineNumber: entry.lineNumber,
      text,
    });
  }

  return candidates;
}

/**
 * Fill `content_prompt_id` / `transcript_line_start` where they are NULL — and
 * nothing else. Deliberately NOT `backfillFromTranscript`: that path overwrites
 * assistant_response/tool counts, which here would resurrect stale drafts.
 *
 * Pairing is anchored on an exact, window-unique full-text match rather than on
 * position, because an incremental window starts mid-session and positional
 * pairing would misalign. Every rejected pairing is logged with its reason:
 * duplicate text, a promptId another turn already owns, or an order inversion.
 */
export function reconcileTurnLinks(
  db: Database,
  sessionId: number,
  entries: TranscriptEntryWithLineNumber[],
  log: CaptureRepairLog,
): LinkReconcileOutcome {
  const outcome: LinkReconcileOutcome = { linked: 0, skipped: 0 };
  const candidates = collectLinkCandidates(entries);

  if (candidates.length === 0) {
    return outcome;
  }

  const nullLinkTurns = db
    .query<NullLinkTurn, [number]>(
      `SELECT
         id,
         prompt_number AS promptNumber,
         user_prompt AS userPrompt,
         content_prompt_id AS contentPromptId,
         transcript_line_start AS transcriptLineStart
       FROM turns
       WHERE session_id = ?
         AND (content_prompt_id IS NULL OR transcript_line_start IS NULL)
       ORDER BY prompt_number ASC`,
    )
    .all(sessionId);

  if (nullLinkTurns.length === 0) {
    return outcome;
  }

  const ownedPromptIds = new Set(
    db
      .query<{ contentPromptId: string }, [number]>(
        `SELECT content_prompt_id AS contentPromptId FROM turns
         WHERE session_id = ? AND content_prompt_id IS NOT NULL`,
      )
      .all(sessionId)
      .map((row) => row.contentPromptId),
  );

  const writeLink = db.query<
    unknown,
    [string | null, number | null, number]
  >(
    `UPDATE turns
     SET content_prompt_id = COALESCE(content_prompt_id, ?),
         transcript_line_start = COALESCE(transcript_line_start, ?)
     WHERE id = ?`,
  );

  // Pass 1 — turns that already know their promptId but not their line. No text
  // matching needed, so no ambiguity is possible.
  const candidateByPromptId = new Map(
    candidates.map((candidate) => [candidate.promptId, candidate]),
  );
  const resolvedTurnIds = new Set<number>();

  for (const turn of nullLinkTurns) {
    if (turn.contentPromptId === null || turn.transcriptLineStart !== null) {
      continue;
    }
    const candidate = candidateByPromptId.get(turn.contentPromptId);
    if (!candidate) {
      continue;
    }
    writeLink.run(null, candidate.lineNumber, turn.id);
    resolvedTurnIds.add(turn.id);
    outcome.linked += 1;
  }

  // Pass 2 — unlinked turns matched by exact prompt text.
  const unlinkedTurns = nullLinkTurns.filter(
    (turn) => turn.contentPromptId === null && !resolvedTurnIds.has(turn.id),
  );

  if (unlinkedTurns.length === 0) {
    return outcome;
  }

  const turnTextCounts = new Map<string, number>();
  for (const turn of unlinkedTurns) {
    if (turn.userPrompt === null) {
      continue;
    }
    turnTextCounts.set(
      turn.userPrompt,
      (turnTextCounts.get(turn.userPrompt) ?? 0) + 1,
    );
  }

  const candidateTextCounts = new Map<string, number>();
  for (const candidate of candidates) {
    candidateTextCounts.set(
      candidate.text,
      (candidateTextCounts.get(candidate.text) ?? 0) + 1,
    );
  }

  const consumedTurnIds = new Set<number>();
  let lastLinkedPromptNumber = -1;

  for (const candidate of candidates) {
    // Checked BEFORE any text matching so the diagnostics account for every
    // occupied candidate, not only those that happened to also find a NULL-link
    // turn with identical text (spec §F: occupied promptIds are skipped AND
    // logged). Compact summary wrappers land here by design once their boundary
    // is claimed — the marker owns that promptId.
    if (ownedPromptIds.has(candidate.promptId)) {
      outcome.skipped += 1;
      log(
        `link reconcile: promptId ${candidate.promptId} (line ` +
          `${candidate.lineNumber}) already owned by another turn; skipped`,
      );
      continue;
    }

    const matches = unlinkedTurns.filter(
      (turn) =>
        turn.userPrompt === candidate.text && !consumedTurnIds.has(turn.id),
    );

    if (matches.length === 0) {
      continue;
    }

    if (
      matches.length > 1 ||
      (turnTextCounts.get(candidate.text) ?? 0) > 1 ||
      (candidateTextCounts.get(candidate.text) ?? 0) > 1
    ) {
      outcome.skipped += 1;
      log(
        `link reconcile: ambiguous prompt text for promptId ` +
          `${candidate.promptId} (line ${candidate.lineNumber}); skipped`,
      );
      continue;
    }

    const turn = matches[0]!;

    if (turn.promptNumber <= lastLinkedPromptNumber) {
      outcome.skipped += 1;
      log(
        `link reconcile: transcript order and prompt order disagree for turn ` +
          `${turn.id} (T${turn.promptNumber}); skipped`,
      );
      continue;
    }

    writeLink.run(
      candidate.promptId,
      turn.transcriptLineStart === null ? candidate.lineNumber : null,
      turn.id,
    );
    ownedPromptIds.add(candidate.promptId);
    consumedTurnIds.add(turn.id);
    lastLinkedPromptNumber = turn.promptNumber;
    outcome.linked += 1;
  }

  return outcome;
}

export interface ApplyCaptureRepairOptions {
  nowEpoch: number;
  log?: CaptureRepairLog;
}

/**
 * Apply one scanned window: claim boundaries first (so the summary wrappers'
 * promptIds are owned before link reconcile looks at them), then reconcile
 * links, then commit the cursor. Caller owns the surrounding transaction.
 *
 * `observedCursor` is the cursor value this scan actually started from — the
 * compare-and-set key for the cursor write, and the origin the window's line
 * numbers are measured against.
 */
export function applyCaptureRepair(
  db: Database,
  sessionId: number,
  scan: IncrementalScanResult,
  observedCursor: ScanCursor,
  options: ApplyCaptureRepairOptions,
): CaptureRepairOutcome {
  const log = options.log ?? defaultLog;
  const windowFirstLineNumber =
    (scan.restarted ? 0 : observedCursor.lineNumber) + 1;
  const { claims, pendingBoundaryLine } = collectCompactBoundaryClaims(
    scan.entries,
  );

  const compact = claimCompactBoundaries(
    db,
    sessionId,
    claims,
    options.nowEpoch,
    log,
  );
  const links = reconcileTurnLinks(db, sessionId, scan.entries, log);

  const cursor =
    pendingBoundaryLine === null
      ? scan.nextCursor
      : rewindCursorToLine(scan, windowFirstLineNumber, pendingBoundaryLine);

  // A pending-boundary hold and a file-shrank restart both legitimately move the
  // cursor backwards, so they take the explicit rewind path; the ordinary
  // advance takes the monotonic one. Both compare-and-set on the offset this
  // scan observed, so a concurrent hook that already committed a newer scan wins
  // and this stale result is dropped instead of regressing the high-water mark.
  const isRewind = pendingBoundaryLine !== null || scan.restarted;
  const writeCursor = isRewind
    ? rewindSessionScanCursor
    : updateSessionScanCursor;
  const committed = writeCursor(
    db,
    sessionId,
    cursor.byteOffset,
    cursor.lineNumber,
    observedCursor.byteOffset,
  );

  if (!committed) {
    log(
      `capture repair: scan cursor for session ${sessionId} moved under us ` +
        `(observed ${observedCursor.byteOffset}); dropped this window's cursor write`,
    );
  }

  return {
    compact,
    links,
    scannedEntries: scan.entries.length,
    truncated: scan.truncated,
    cursor,
    stoppedForDeadline: false,
  };
}

export interface RunCaptureRepairOptions extends ApplyCaptureRepairOptions {
  maxLines?: number;
  maxBytes?: number;
  /**
   * Lines per deadline check. Defaults to `maxLines` (one batch, deadline
   * checked only before starting).
   */
  batchLines?: number;
  /** Wall-clock ms stamp past which no further batch is started. */
  deadlineMs?: number;
  /** Monotonic-ish ms clock for the deadline; injectable for tests. */
  nowMs?: () => number;
  /** Wraps the DB writes; hooks pass their own budgeted hook transaction. */
  writeTransaction?: <T>(db: Database, work: () => T) => T;
}

function mergeOutcomes(
  first: CaptureRepairOutcome | null,
  next: CaptureRepairOutcome,
): CaptureRepairOutcome {
  if (!first) {
    return next;
  }

  return {
    compact: {
      inserted: first.compact.inserted + next.compact.inserted,
      converted: first.compact.converted + next.compact.converted,
      adopted: first.compact.adopted + next.compact.adopted,
      skipped: first.compact.skipped + next.compact.skipped,
    },
    links: {
      linked: first.links.linked + next.links.linked,
      skipped: first.links.skipped + next.links.skipped,
    },
    scannedEntries: first.scannedEntries + next.scannedEntries,
    truncated: next.truncated,
    cursor: next.cursor,
    stoppedForDeadline: next.stoppedForDeadline,
  };
}

/**
 * Scan (file I/O, outside any transaction) then apply (inside one), in batches
 * of `batchLines` up to `maxLines`, stopping at `deadlineMs`. Returns null when
 * there was nothing to do — missing transcript or an already-current cursor.
 *
 * Batching exists for the deadline: the wall clock is checked between batches,
 * and a run cut short leaves its cursor exactly where the last committed batch
 * ended, so the remainder defers to the next event just like the line cap does.
 */
export function runCaptureRepair(
  db: Database,
  session: { id: number; scanCursorByteOffset: number; scanCursorLine: number },
  transcriptPath: string | undefined,
  options: RunCaptureRepairOptions,
): CaptureRepairOutcome | null {
  if (!transcriptPath) {
    return null;
  }

  const log = options.log ?? defaultLog;
  const nowMs = options.nowMs ?? Date.now;
  const maxLines = options.maxLines ?? DEFAULT_SCAN_MAX_LINES;
  const batchLines = Math.max(1, options.batchLines ?? maxLines);

  let cursor: ScanCursor = {
    byteOffset: session.scanCursorByteOffset ?? 0,
    lineNumber: session.scanCursorLine ?? 0,
  };
  let remainingLines = maxLines;
  let aggregate: CaptureRepairOutcome | null = null;

  while (remainingLines > 0) {
    if (options.deadlineMs !== undefined && nowMs() >= options.deadlineMs) {
      if (aggregate) {
        aggregate.stoppedForDeadline = true;
      }
      return aggregate;
    }

    const scan = scanTranscriptIncrementally(transcriptPath, cursor, {
      maxLines: Math.min(batchLines, remainingLines),
      maxBytes: options.maxBytes,
      log,
    });

    // An empty window with an unmoved cursor is genuinely nothing to do. An
    // empty window that DID move (a run of blank or api-error lines) still has
    // to commit its cursor, or that region is re-read on every future event.
    if (
      !scan ||
      (scan.entries.length === 0 &&
        scan.nextCursor.byteOffset === cursor.byteOffset &&
        !scan.restarted)
    ) {
      return aggregate;
    }

    const observedCursor = cursor;
    const apply = () =>
      applyCaptureRepair(db, session.id, scan, observedCursor, options);
    const outcome = options.writeTransaction
      ? options.writeTransaction(db, apply)
      : apply();

    aggregate = mergeOutcomes(aggregate, outcome);
    remainingLines -= Math.max(
      0,
      outcome.cursor.lineNumber - (scan.restarted ? 0 : cursor.lineNumber),
    );

    // No forward progress (a held partial line, or a rewind onto a pending
    // boundary): another batch would read the identical bytes forever.
    if (outcome.cursor.byteOffset <= cursor.byteOffset && !scan.restarted) {
      return aggregate;
    }

    cursor = outcome.cursor;

    if (!scan.truncated) {
      return aggregate;
    }
  }

  return aggregate;
}
