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
// visible. FIVE sources, constructive and destructive alike (ticket 04 added
// the two destructive ones — a run that BREAKS a lane has touched it as
// surely as one that builds it): an ATTACHED edge's either lane side, a
// RETRACTED edge's either lane side, a tags write whose landed set includes
// the tag, a tags write that REMOVED the tag, and a `justify` addressed to
// the lane.
//
// Two independent key shapes, because those sources resolve a lane
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
//     the call carried. A REMOVED tag takes the same shape for a different
//     reason: the turn it left is no longer in that lane's membership, so a
//     (turn, tag) key would match nothing in the post-state the gate judges.
// ---------------------------------------------------------------------------

/** Touch key for a (turn, tag) pair this run's own write landed — an edge side or a tags write. Matched against a lane's own island membership at gate time, never resolved to a segment here. */
export function laneTouchTurnTagKey(turnId: number, tag: string): string {
  return `${turnId}:${tag}`;
}

/** Touch key for a (segment, tag) lane this run named DIRECTLY rather than through one of its members. */
export function laneTouchSegmentTagKey(segmentId: number, tag: string): string {
  return `${segmentId}:${tag}`;
}

/** This run's own touch facts, accumulated as `note`/`remember` calls land — see `laneTouchTurnTagKey`/`laneTouchSegmentTagKey` for the two key shapes. */
export interface RunLaneTouches {
  turnTagPairs: ReadonlySet<string>;
  /**
   * The LANE-ADDRESSED touches — `(segment, tag)`, not `(turn, tag)`.
   *
   * TWO SOURCES: a `justify` addressed to the lane, and (ticket 04) a landed
   * `tags` write that REMOVED a lane tag from a member. That second case
   * cannot use the `(turn, tag)` shape, and the reason is structural rather
   * than a matter of taste — the gate resolves a `(turn, tag)` touch by
   * looking the turn up in the lane's CURRENT island membership, and a turn
   * whose tag was just removed is no longer a member of that lane at all, so
   * its `(turn, tag)` key would match nothing in the post-state the gate
   * judges. The lane it LEFT is named directly instead.
   */
  laneKeys: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// The DURABLE touch ledger (`lane_run_touches`)
//
// Ticket 04's second hole: the sets above used to live only as `Set`s on a
// live engine instance, while every direct write commits immediately in its
// own transaction. Attempt A landed a severing write and died; attempt B
// rebuilt empty sets and saw an untouched fracture — and settlement caps
// attempts at 3, so a retry is an ordinary path. Rows here are written INSIDE
// the transaction of the write that produced them (see
// `note-settlement-direct-write.ts`), so a rolled-back write leaves no touch
// behind and a landed one cannot lose its touch.
// ---------------------------------------------------------------------------

/**
 * `turn-tag` — an edge side, or a tag a landed `tags` write named (added,
 * restated or REMOVED); `entityId` is the turn.
 * `lane` — a lane this run addressed directly; `entityId` is the segment.
 */
export type LaneTouchKind = "turn-tag" | "lane";

export interface LaneTouchRecord {
  jobId: number;
  kind: LaneTouchKind;
  entityId: number;
  laneTag: string;
  createdAtEpoch: number;
}

/** `INSERT OR IGNORE` against the row's own UNIQUE key: a restated edge side or a re-asserted tag records the same touch once, not once per repetition. */
export function recordLaneTouch(db: Database, record: LaneTouchRecord): void {
  db.query(
    `INSERT OR IGNORE INTO lane_run_touches
       (job_id, touch_kind, entity_id, lane_tag, created_at_epoch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(record.jobId, record.kind, record.entityId, record.laneTag, record.createdAtEpoch);
}

interface LaneTouchDbRow {
  touchKind: LaneTouchKind;
  entityId: number;
  laneTag: string;
}

/**
 * Every touch this JOB has on record, in both key shapes — the durable half
 * of `getRunLaneTouches()`. Job-scoped on purpose (decision 2): a reclaimed
 * claimant, running under a bumped claim generation, inherits the obligation
 * its predecessor created, so this query takes no generation at all rather
 * than taking one and ignoring it.
 */
export function loadRunLaneTouches(db: Database, jobId: number): RunLaneTouches {
  const turnTagPairs = new Set<string>();
  const laneKeys = new Set<string>();
  for (const row of db
    .query<LaneTouchDbRow, [number]>(
      `SELECT touch_kind AS touchKind, entity_id AS entityId, lane_tag AS laneTag
         FROM lane_run_touches WHERE job_id = ?`,
    )
    .all(jobId)) {
    if (row.touchKind === "turn-tag") {
      turnTagPairs.add(laneTouchTurnTagKey(row.entityId, row.laneTag));
    } else {
      laneKeys.add(laneTouchSegmentTagKey(row.entityId, row.laneTag));
    }
  }
  return { turnTagPairs, laneKeys };
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
  /**
   * Ticket 05: the member ids THIS CALL actually rendered — its own page's
   * slice, not the page NUMBER it asked for. A page number is only a coverage
   * fact in combination with the page size that produced it, and the page
   * size was never recorded; that omission is the whole defect this field
   * replaces (see `unreadLaneMembers`).
   */
  renderedTurnIds: readonly number[];
  sequence: number;
  createdAtEpoch: number;
}

export function recordLaneReadReceipt(db: Database, receipt: LaneReadReceipt): void {
  db.query(
    `INSERT INTO lane_read_receipts
       (reader_id, segment_id, lane_tag, membership_snapshot, rendered_member_ids, sequence, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.readerId,
    receipt.segmentId,
    receipt.laneTag,
    JSON.stringify(receipt.membershipTurnIds),
    JSON.stringify(receipt.renderedTurnIds),
    receipt.sequence,
    receipt.createdAtEpoch,
  );
}

interface ReceiptDbRow {
  renderedMemberIds: string;
}

/**
 * The union of every member id this `readerId` has ever had RENDERED on this
 * lane, across every receipt. Accumulation across calls is the natural
 * behaviour of a union rather than a special case bolted onto a page count —
 * a reader may page the lane in any order, at any page size, over any number
 * of calls, and what it has seen is simply what it has seen.
 */
function renderedLaneMembers(
  db: Database,
  readerId: string,
  segmentId: number,
  laneTag: string,
): Set<number> {
  const seen = new Set<number>();
  for (const row of db
    .query<ReceiptDbRow, [string, number, string]>(
      `SELECT rendered_member_ids AS renderedMemberIds FROM lane_read_receipts
       WHERE reader_id = ? AND segment_id = ? AND lane_tag = ?`,
    )
    .all(readerId, segmentId, laneTag)) {
    for (const turnId of JSON.parse(row.renderedMemberIds) as number[]) {
      seen.add(turnId);
    }
  }
  return seen;
}

/**
 * The ids in `requiredMemberIds` this `readerId` has NOT had rendered — `[]`
 * when the obligation is met, and otherwise exactly what a refusal should
 * name.
 *
 * TICKET 05 (phase-connectivity, "a read receipt that counts members, not
 * pages"). The predecessor asked whether the reader had covered
 * `ceil(memberCount / 10)` PAGES, with the 10 hardcoded while `recall` honours
 * a caller-supplied `pageSize`. Reading pages 1-3 at `pageSize: 1` therefore
 * "covered" a 25-member lane after seeing three of its members, and the
 * justify was accepted. Counting the ids actually rendered is strictly
 * simpler than the arithmetic it replaces and closes three defects at once:
 * the page-size mismatch, the union of page NUMBERS across snapshots taken at
 * different sizes, and the "mythical one-shot read" that motivated paging in
 * the first place.
 *
 * An empty `requiredMemberIds` is vacuously covered — nothing to read.
 */
export function unreadLaneMembers(
  db: Database,
  readerId: string,
  segmentId: number,
  laneTag: string,
  requiredMemberIds: readonly number[],
): number[] {
  if (requiredMemberIds.length === 0) {
    return [];
  }
  const seen = renderedLaneMembers(db, readerId, segmentId, laneTag);
  return requiredMemberIds.filter((turnId) => !seen.has(turnId));
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
