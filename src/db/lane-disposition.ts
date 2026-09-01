import type { Database } from "bun:sqlite";

import type { LaneComponentReport, LaneIsland } from "../shared/lane-checker";

/**
 * FRACTURE IDENTITY and the durable run-touch ledger.
 *
 * SETTLEMENT-GATE-TAXONOMY TICKET 06 (user ruling S15069/T2278) RETIRED the
 * `justify` / disposition ledger from this file: `recordLaneDispositionJustification`,
 * `checkLaneDispositionJustification`, `laneRepresentativeContentSequence`,
 * `computeDuplicateReasonRate` and the two lane-read-receipt READERS
 * (`hasAnyLaneReadReceipt`, `unreadLaneMembers`) are gone, because ticket 04
 * made a fracture a WARNING and a warning has nothing to discharge. What is
 * left here is what the warning itself is computed from — fracture identity —
 * plus the touch ledger that decides which lanes a run is told about at all.
 * The `lane_disposition_justifications` TABLE and its rows are untouched and
 * INERT: no code writes them and no code reads them (see `db/schema.ts`).
 *
 * FRACTURE IDENTITY. A lane with N (>1) islands has N-1 fractures — one
 * per CONSECUTIVE pair in the islands' own ascending-by-representative
 * order (`buildComponentReport`, `shared/lane-checker.ts`, already sorts
 * them that way). This is a spanning-tree framing, not an every-pair one:
 * stitching N-1 consecutive gaps reduces N islands to one component, so it
 * is the minimum stitch set a re-run checker can ever name and therefore
 * also the maximum a caller is ever shown in one pass. A FINGERPRINT is
 * `(segment, lane tag, the two representative ids, ascending)` —
 * deterministic, and recomputed from the post-state on every call, so it
 * names the fracture as it stands rather than as any earlier pass left it.
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
// visible. FOUR sources, constructive and destructive alike (ticket 04 added
// the two destructive ones — a run that BREAKS a lane has touched it as
// surely as one that builds it): an ATTACHED edge's either lane side, a
// RETRACTED edge's either lane side, a tags write whose landed set includes
// the tag, and a tags write that REMOVED the tag.
//
// THE FIFTH SOURCE WAS `justify`, AND IT WAS SELF-ARMING (ticket 06). Job
// 166's lane was armed by exactly ONE touch row — `lane|60|execution-repair`
// — and `justify` itself had written it: calling justify made the lane
// touched, which made the gate demand a disposition for that lane, which the
// run answered with another justify. The verb retired under user ruling
// S15069/T2278 and its touch source retired with it. Every source left is a
// write to the GRAPH, so a run can no longer arm a lane merely by talking
// about it.
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
//   - A REMOVED tag names its lane directly — `(segmentId, tag)` — because
//     the turn it left is no longer in that lane's membership, so a
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
  /**
   * THE TURNS THIS RUN WROTE AT (settlement-gate-taxonomy ticket 04), derived
   * from the same `turn-tag` rows as `turnTagPairs` — every entity id among
   * them, including the ones recorded with the `''` lane sentinel for a DRAFT
   * edge side.
   *
   * Its one consumer is the judgment seam: a finding this run CREATED is judged
   * on wherever it sits, and this is the durable record of where the run wrote.
   * It is deliberately a set of TURNS and not of findings — see
   * `note-settlement-sdk-query.ts`'s `evaluateWindowLanes` for what that does
   * and does not cover.
   */
  turnIds: ReadonlySet<number>;
  turnTagPairs: ReadonlySet<string>;
  /**
   * The LANE-ADDRESSED touches — `(segment, tag)`, not `(turn, tag)`.
   *
   * ONE SOURCE since ticket 06: a landed `tags` write that REMOVED a lane tag
   * from a member (ticket 04). It cannot use the `(turn, tag)` shape, and the
   * reason is structural rather than a matter of taste — the gate resolves a
   * `(turn, tag)` touch by looking the turn up in the lane's CURRENT island
   * membership, and a turn whose tag was just removed is no longer a member of
   * that lane at all, so its `(turn, tag)` key would match nothing in the
   * post-state the gate judges. The lane it LEFT is named directly instead.
   *
   * The other source was `justify` (ticket 06 retired it, user ruling
   * S15069/T2278) — the self-arming one: it named a lane no member of which
   * the run had written, which is how job 166 armed a gate against itself.
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
//
// WHAT HAPPENS TO THE `justify` ROWS ALREADY IN THIS TABLE (ticket 06). They
// STAY. The ledger is durable and job-scoped, it carries no column recording
// which verb wrote a row, and a `lane` row written by a retired justify is
// byte-identical to one written by a tag removal — so there is nothing to
// filter on and nothing is deleted (this batch makes no destructive change to
// production data). Their remaining effect is bounded to one line: the job
// that wrote them, if it is ever re-dispatched, still counts that lane as
// touched and so still gets its fractures listed in the LANE DISPOSITION
// WARNING block. Since ticket 04 that block refuses nothing, asks for
// nothing, and cannot be discharged or silenced — so a stale row now costs a
// warning line on one job, where it used to cost an unsatisfiable gate.
// ---------------------------------------------------------------------------

/**
 * `turn-tag` — an edge side, or a tag a landed `tags` write named (added,
 * restated or REMOVED); `entityId` is the turn.
 * `lane` — a lane this run addressed directly; `entityId` is the segment.
 * Ticket 06: the only remaining WRITER of a `lane` row is a landed tag
 * removal. Rows of this kind written by the retired `justify` survive and are
 * indistinguishable from it — see the section comment above.
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
  const turnIds = new Set<number>();
  const turnTagPairs = new Set<string>();
  const laneKeys = new Set<string>();
  for (const row of db
    .query<LaneTouchDbRow, [number]>(
      `SELECT touch_kind AS touchKind, entity_id AS entityId, lane_tag AS laneTag
         FROM lane_run_touches WHERE job_id = ?`,
    )
    .all(jobId)) {
    if (row.touchKind === "turn-tag") {
      turnIds.add(row.entityId);
      // TICKET 04: a DRAFT edge side is recorded with the `''` lane sentinel —
      // the run wrote at the turn, and named no lane there. It contributes to
      // `turnIds` (that is the whole point of recording it) and is kept OUT of
      // the (turn, tag) pair set, which means "this run placed this turn in
      // this lane" and would be answering a different question with a key no
      // lane lookup can ever match.
      if (row.laneTag !== "") {
        turnTagPairs.add(laneTouchTurnTagKey(row.entityId, row.laneTag));
      }
    } else {
      laneKeys.add(laneTouchSegmentTagKey(row.entityId, row.laneTag));
    }
  }
  return { turnIds, turnTagPairs, laneKeys };
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
   * replaced. Its reader retired with `justify` (ticket 06) — see the note at
   * the foot of this file.
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

// ---------------------------------------------------------------------------
// TICKET 06 RESIDUE, stated rather than left to be discovered: this table now
// has a WRITER (`mcp/recall.ts`, the lane route) and NO READER. Its two
// readers — `hasAnyLaneReadReceipt` and `unreadLaneMembers` — existed for
// `justify`'s recall-before-justify obligation alone, and retired with it.
// The writer is deliberately left standing: removing it is a change to the
// recall read path rather than to the settlement path this ticket retires,
// and the receipts are the one durable record of what a run was actually
// shown of a lane. Retiring the write side belongs to whoever designs the
// operator-owned annotation the ruling foresees.
// ---------------------------------------------------------------------------
