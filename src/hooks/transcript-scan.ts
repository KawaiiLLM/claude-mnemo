import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

import {
  dedupeTranscriptEntries,
  parseTranscriptLineWindow,
  type TranscriptEntryWithLineNumber,
} from "../shared/transcript-parser";

/** Byte offset of the first unscanned byte + number of lines already committed. */
export interface ScanCursor {
  byteOffset: number;
  lineNumber: number;
}

export interface IncrementalScanResult {
  entries: TranscriptEntryWithLineNumber[];
  /** Where the next scan resumes if every entry in this window is consumed. */
  nextCursor: ScanCursor;
  /** True when the line cap stopped the window short of EOF (remainder defers). */
  truncated: boolean;
  /** True when the file shrank below the cursor and the scan restarted at 0. */
  restarted: boolean;
  /** Byte offset at which each committed line in this window begins. */
  lineStartOffsets: number[];
  /**
   * True when the byte window held no newline at all yet more bytes exist on
   * disk — i.e. one record is longer than the byte cap. Nothing is committable,
   * so the cursor is held before that record and the window is deferred.
   */
  oversizedRecord: boolean;
}

export type TranscriptScanLog = (message: string) => void;

export interface IncrementalScanOptions {
  /** Max fully committed lines processed in one pass (spec §F: 5000). */
  maxLines?: number;
  /** Max bytes pulled from disk in one pass; the cursor bounds the rest. */
  maxBytes?: number;
  /** Diagnostics sink; called at most once per scan for the oversized case. */
  log?: TranscriptScanLog;
}

export const DEFAULT_SCAN_MAX_LINES = 5000;
export const DEFAULT_SCAN_MAX_BYTES = 5 * 1024 * 1024;

const NEWLINE_BYTE = 0x0a;

function readRange(
  transcriptPath: string,
  start: number,
  length: number,
): Buffer | null {
  if (length <= 0) {
    return Buffer.alloc(0);
  }

  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

/**
 * Read the transcript forward from a persisted byte cursor.
 *
 * Three invariants, all load-bearing for the capture-repair contract (spec §F):
 *
 * 1. **Never cross a partial final line.** A JSONL transcript is appended to
 *    while the hook runs, so the tail routinely holds half a record. The cursor
 *    stops at the last newline byte; the partial remainder is re-read next pass.
 * 2. **Never rescan.** The seek starts at the cursor, so cost is proportional to
 *    new bytes, not file size.
 * 3. **Bounded work.** At most `maxLines` committed lines per pass; anything
 *    beyond stays unread and the cursor stops there, so the next event picks up
 *    exactly where this one left off.
 *
 * Returns null when the transcript does not exist (caller skips silently).
 */
export function scanTranscriptIncrementally(
  transcriptPath: string,
  cursor: ScanCursor,
  options: IncrementalScanOptions = {},
): IncrementalScanResult | null {
  if (!existsSync(transcriptPath)) {
    return null;
  }

  const maxLines = options.maxLines ?? DEFAULT_SCAN_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_SCAN_MAX_BYTES;

  let fileSize: number;
  try {
    fileSize = statSync(transcriptPath).size;
  } catch {
    return null;
  }

  // Claude Code transcripts are append-only: a session's JSONL is only ever
  // extended, never rewritten in place, so a byte cursor into it stays valid and
  // "resume where we stopped" is exact. The shrink branch below is DEFENSIVE
  // ONLY — it covers a truncated/replaced file (crash, manual deletion, a DB row
  // outliving its transcript), not a supported rewrite mode. Consequently a
  // same-size or larger replacement is deliberately NOT detected: under the
  // append-only assumption that shape cannot occur, and the checks that would
  // detect it (content hash, inode) cost a full re-read on every hook.
  const restarted = cursor.byteOffset > fileSize;
  const startOffset = restarted ? 0 : Math.max(0, cursor.byteOffset);
  const startLineNumber = restarted ? 0 : Math.max(0, cursor.lineNumber);

  if (startOffset >= fileSize) {
    return {
      entries: [],
      nextCursor: { byteOffset: startOffset, lineNumber: startLineNumber },
      truncated: false,
      restarted,
      lineStartOffsets: [],
      oversizedRecord: false,
    };
  }

  const remaining = fileSize - startOffset;
  const buffer = readRange(
    transcriptPath,
    startOffset,
    Math.min(remaining, maxBytes),
  );
  if (buffer === null) {
    return null;
  }

  // A single record longer than the byte cap: the window holds no newline yet
  // more bytes exist on disk. Re-reading `remaining` here would silently replace
  // the cap with the whole tail and hand a malformed transcript an unbounded
  // read inside a 2s/10s hook. So hold the cursor BEFORE the record and defer.
  // Accepted cost: a genuinely >5MB single record wedges this session's cursor
  // permanently rather than blowing the latency bound once.
  const oversizedRecord =
    !buffer.includes(NEWLINE_BYTE) && buffer.length < remaining;
  if (oversizedRecord) {
    options.log?.(
      `transcript scan: record at byte ${startOffset} exceeds the ${maxBytes}-byte ` +
        `window cap; holding the cursor before it and deferring`,
    );
  }

  const newlineOffsets: number[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === NEWLINE_BYTE) {
      newlineOffsets.push(index);
      if (newlineOffsets.length >= maxLines) {
        break;
      }
    }
  }

  if (newlineOffsets.length === 0) {
    // Only a partial line is available; commit nothing and wait for the writer.
    // `truncated` stays false even for the oversized case: it means "more
    // COMPLETE lines are already readable", and here the caller made no
    // progress, so reporting truncation would invite an endless retry loop.
    return {
      entries: [],
      nextCursor: { byteOffset: startOffset, lineNumber: startLineNumber },
      truncated: false,
      restarted,
      lineStartOffsets: [],
      oversizedRecord,
    };
  }

  const lastNewline = newlineOffsets[newlineOffsets.length - 1]!;
  const committedBytes = lastNewline + 1;
  const committed = buffer.subarray(0, committedBytes).toString("utf8");
  // The trailing "" after the final newline is not a line — drop it.
  const lines = committed.split("\n");
  lines.pop();

  const lineStartOffsets: number[] = [];
  let lineStart = 0;
  for (const newlineOffset of newlineOffsets) {
    lineStartOffsets.push(startOffset + lineStart);
    lineStart = newlineOffset + 1;
  }

  // "Truncated" means at least one further COMPLETE line is already on disk but
  // was left for the next event — either past the line cap inside the buffer, or
  // past the byte cap entirely. A merely partial tail line is not truncation.
  const truncated =
    startOffset + buffer.length < fileSize ||
    buffer.subarray(committedBytes).includes(NEWLINE_BYTE);

  // Same UUID-merge semantics the whole-file reader applies: a replay-appended
  // duplicate snapshot of an entry must collapse into the FIRST occurrence
  // (first physical line number, merged payload), or a boundary's compactMetadata
  // reads stale and a link anchors to the replay line instead of the real one.
  //
  // Cross-window duplicates are deliberately left alone: nothing here can see a
  // previous window. They are harmless because both consumers are idempotent —
  // boundary claiming keys on (session_id, boundary uuid) and short-circuits on
  // an already-claimed row, and link reconcile only fills NULL columns and skips
  // any promptId another turn already owns. A cross-window replay is a no-op,
  // not a rewrite.
  return {
    entries: dedupeTranscriptEntries(
      parseTranscriptLineWindow(lines, startLineNumber + 1),
    ),
    nextCursor: {
      byteOffset: startOffset + committedBytes,
      lineNumber: startLineNumber + lines.length,
    },
    truncated,
    restarted,
    lineStartOffsets,
    oversizedRecord,
  };
}

/**
 * Pull the cursor back so the next scan re-reads from `lineNumber` onward.
 * Used when a window ends on a compact boundary whose summary wrapper has not
 * been written yet: committing past it would strand the boundary unclaimable.
 */
export function rewindCursorToLine(
  result: IncrementalScanResult,
  windowFirstLineNumber: number,
  lineNumber: number,
): ScanCursor {
  const index = lineNumber - windowFirstLineNumber;
  const byteOffset = result.lineStartOffsets[index];

  if (byteOffset === undefined) {
    return result.nextCursor;
  }

  return { byteOffset, lineNumber: lineNumber - 1 };
}
