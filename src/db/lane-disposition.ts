import type { Database } from "bun:sqlite";

import type { LaneComponentReport, LaneIsland } from "../shared/lane-checker";

/**
 * The mandatory-disposition machinery (severed-lane ticket 02, spec "The
 * refined form" / "Anti-grinding" / "Recall-before-justify"): fracture
 * identity, the justify ledger, and the lane-read receipts a justify's
 * page-coverage obligation is checked against.
 *
 * FRACTURE IDENTITY. A lane with N (>1) islands owes N-1 dispositions — one
 * per CONSECUTIVE pair in the islands' own ascending-by-representative
 * order (`buildComponentReport`, `shared/lane-checker.ts`, already sorts
 * them that way). This is a spanning-tree framing, not an every-pair one:
 * stitching (or justifying) N-1 consecutive gaps reduces N islands to one
 * component, and it is the minimum disposition set a re-run checker can
 * ever demand, so it is also the maximum a caller is ever asked to justify
 * in one pass. A FINGERPRINT is `(segment, lane tag, the two representative
 * ids, ascending)` — deterministic, and INVALIDATED BY CONSTRUCTION the
 * moment a stitch or a further split changes either island's
 * representative: the checker recomputes islands fresh on every commit
 * (post-state, ticket 02's own rule), so an old fingerprint simply stops
 * matching any CURRENT fracture rather than needing a second invalidation
 * pass.
 */
export interface LaneFracture {
  segmentId: number;
  laneTag: string;
  representativeA: number;
  representativeB: number;
  fingerprint: string;
}

export function computeComponentFingerprint(
  segmentId: number,
  laneTag: string,
  representativeA: number,
  representativeB: number,
): string {
  const [lo, hi] =
    representativeA <= representativeB
      ? [representativeA, representativeB]
      : [representativeB, representativeA];
  return `${segmentId}:${laneTag}:${lo}:${hi}`;
}

/** The consecutive-pair fracture list for one SEVERED lane (componentCount > 1); `[]` for a whole lane. */
export function computeLaneFractures(
  segmentId: number,
  component: LaneComponentReport,
): LaneFracture[] {
  const islands: readonly LaneIsland[] = component.islands;
  const fractures: LaneFracture[] = [];
  for (let index = 0; index < islands.length - 1; index += 1) {
    const a = islands[index]!.representative;
    const b = islands[index + 1]!.representative;
    fractures.push({
      segmentId,
      laneTag: component.key.tag,
      representativeA: a,
      representativeB: b,
      fingerprint: computeComponentFingerprint(segmentId, component.key.tag, a, b),
    });
  }
  return fractures;
}

// ---------------------------------------------------------------------------
// Run-touch tracking (severed-lane over-blocking fix)
//
// `evaluateLaneDispositionGate` used to derive "touched" from membership in
// `scope.writableTurnIds` (window ∪ lookback ∪ closure) — so a severed lane
// this run never wrote into still owed a disposition whenever any member
// merely fell inside the rendered lookback. TOUCHED now means the run's own
// LANDED writes named the lane, not that one of its members was merely
// visible: an edge whose either lane side names it, a turn tags write whose
// landed set includes the tag, or a `justify` addressed to it.
//
// Two independent key shapes, because the three touch sources resolve a lane
// differently:
//
//   - An edge side or a tags write names a (turn, tag) pair — never a
//     segment id directly (the write facades do not resolve one). Matched at
//     gate time against the CHECKER's own island membership
//     (`evaluateLaneDispositionGate`: `component.islands[].memberIds`), so
//     the segment a (turn, tag) pair belongs to is always the loader's own
//     answer, never a second, independently-resolved one that could drift
//     from it.
//   - A `justify` names its lane directly — `(segmentId, tag)` — since the
//     membership facade already resolved the segment via the `E<n>` address
//     the call carried.
// ---------------------------------------------------------------------------

/** Touch key for a (turn, tag) pair this run's own write landed — an edge side or a tags write. Matched against a lane's own island membership at gate time, never resolved to a segment here. */
export function laneTouchTurnTagKey(turnId: number, tag: string): string {
  return `${turnId}:${tag}`;
}

/** Touch key for a (segment, tag) lane this run's own `justify` named directly. */
export function laneTouchSegmentTagKey(segmentId: number, tag: string): string {
  return `${segmentId}:${tag}`;
}

/** This run's own touch facts, accumulated as `note`/`remember` calls land — see `laneTouchTurnTagKey`/`laneTouchSegmentTagKey` for the two key shapes. */
export interface RunLaneTouches {
  turnTagPairs: ReadonlySet<string>;
  justifiedLaneKeys: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Justify ledger
// ---------------------------------------------------------------------------

export interface LaneDispositionJustification {
  jobId: number;
  segmentId: number;
  laneTag: string;
  componentFingerprint: string;
  representativeA: number;
  representativeB: number;
  reason: string;
  createdAtEpoch: number;
}

export function recordLaneDispositionJustification(
  db: Database,
  justification: LaneDispositionJustification,
): void {
  db.query(
    `INSERT INTO lane_disposition_justifications
       (job_id, segment_id, lane_tag, component_fingerprint, representative_a, representative_b, reason, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    justification.jobId,
    justification.segmentId,
    justification.laneTag,
    justification.componentFingerprint,
    justification.representativeA,
    justification.representativeB,
    justification.reason,
    justification.createdAtEpoch,
  );
}

/** Does a justify record exist, BOUND to this exact fingerprint — presence and binding, never truth (ticket 02's own honesty boundary). */
export function hasLaneDispositionJustification(
  db: Database,
  segmentId: number,
  laneTag: string,
  fingerprint: string,
): boolean {
  return (
    db
      .query<{ n: number }, [number, string, string]>(
        `SELECT COUNT(*) AS n FROM lane_disposition_justifications
         WHERE segment_id = ? AND lane_tag = ? AND component_fingerprint = ?`,
      )
      .get(segmentId, laneTag, fingerprint)?.n ?? 0
  ) > 0;
}

interface JustificationDbRow {
  reason: string;
}

/**
 * Ticket 02 switch 2 (defaulted): the duplicate-reason RATE across every
 * justify this segment has ever recorded — `duplicateCount / total`, where a
 * "duplicate" is a reason string shared by 2+ records (every record sharing
 * that text counts, not just the extras). `null` when fewer than
 * `MIN_SAMPLE` records exist — a rate over 1-3 records is noise, not a
 * signal, and would trip on the very first justify of a fresh segment.
 */
const DUPLICATE_REASON_MIN_SAMPLE = 4;
/** Above this rate the duplicate-reason signal is anomalous enough to surface — the ticket names no number, so this is my own default, documented and easy to retune from one place. */
export const DUPLICATE_REASON_ANOMALY_RATE = 0.5;

export function computeDuplicateReasonRate(
  db: Database,
  segmentId: number,
): { total: number; duplicateCount: number; rate: number } | null {
  const rows = db
    .query<JustificationDbRow, [number]>(
      `SELECT reason FROM lane_disposition_justifications WHERE segment_id = ?`,
    )
    .all(segmentId);
  if (rows.length < DUPLICATE_REASON_MIN_SAMPLE) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  }
  let duplicateCount = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      duplicateCount += count;
    }
  }
  return { total: rows.length, duplicateCount, rate: duplicateCount / rows.length };
}

// ---------------------------------------------------------------------------
// Lane read receipts
// ---------------------------------------------------------------------------

export interface LaneReadReceipt {
  readerId: string;
  segmentId: number;
  laneTag: string;
  membershipTurnIds: readonly number[];
  pagesCovered: readonly number[];
  sequence: number;
  createdAtEpoch: number;
}

export function recordLaneReadReceipt(db: Database, receipt: LaneReadReceipt): void {
  db.query(
    `INSERT INTO lane_read_receipts
       (reader_id, segment_id, lane_tag, membership_snapshot, page_coverage, sequence, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.readerId,
    receipt.segmentId,
    receipt.laneTag,
    JSON.stringify(receipt.membershipTurnIds),
    JSON.stringify(receipt.pagesCovered),
    receipt.sequence,
    receipt.createdAtEpoch,
  );
}

interface ReceiptDbRow {
  pageCoverage: string;
}

/**
 * The union of every page this `readerId` has ever covered on this lane,
 * across every receipt — a lane-scoped recall pages through, and coverage
 * accumulates call over call rather than requiring one all-in-one read (the
 * ticket's own words: "not a mythical one-shot full read").
 */
function coveredPages(db: Database, readerId: string, segmentId: number, laneTag: string): Set<number> {
  const pages = new Set<number>();
  for (const row of db
    .query<ReceiptDbRow, [string, number, string]>(
      `SELECT page_coverage AS pageCoverage FROM lane_read_receipts
       WHERE reader_id = ? AND segment_id = ? AND lane_tag = ?`,
    )
    .all(readerId, segmentId, laneTag)) {
    for (const page of JSON.parse(row.pageCoverage) as number[]) {
      pages.add(page);
    }
  }
  return pages;
}

/** The default recall page size (`mcp/recall.ts`'s own `input.pageSize ?? 10`) — the divisor `requiredPageCount` below uses. */
export const LANE_READ_PAGE_SIZE = 10;

/**
 * Has `readerId` covered every page of this lane's CURRENT membership size —
 * `ceil(memberCount / LANE_READ_PAGE_SIZE)` pages, all present in this
 * reader's accumulated `coveredPages`. `memberCount <= 0` is vacuously
 * covered (nothing to page through).
 */
export function hasFullLaneReadCoverage(
  db: Database,
  readerId: string,
  segmentId: number,
  laneTag: string,
  memberCount: number,
): boolean {
  if (memberCount <= 0) {
    return true;
  }
  const requiredPageCount = Math.ceil(memberCount / LANE_READ_PAGE_SIZE);
  const covered = coveredPages(db, readerId, segmentId, laneTag);
  for (let page = 1; page <= requiredPageCount; page += 1) {
    if (!covered.has(page)) {
      return false;
    }
  }
  return true;
}

/** Has `readerId` recalled this lane at all — the cheaper "some receipt exists" half of the recall-before-justify obligation, surfaced separately from full coverage so a refusal can say WHICH is missing. */
export function hasAnyLaneReadReceipt(
  db: Database,
  readerId: string,
  segmentId: number,
  laneTag: string,
): boolean {
  return (
    db
      .query<{ n: number }, [string, number, string]>(
        `SELECT COUNT(*) AS n FROM lane_read_receipts WHERE reader_id = ? AND segment_id = ? AND lane_tag = ?`,
      )
      .get(readerId, segmentId, laneTag)?.n ?? 0
  ) > 0;
}
