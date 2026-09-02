import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { foldLaneImpressionIntoSurvivor } from "./impressions";
import { normalizeIncidentAttribution } from "./normalize-incident-attribution";
import {
  isEdgeProvenance,
  rankEdgeProvenance,
  UNSETTLED_SIDE_TAG,
  type CitingNode,
  type CitingNodeKind,
  type EdgeNode,
  type EdgeNodeKind,
} from "./memory-edges";
import {
  getOwningSegmentId,
  writeMembershipTags,
  type MembershipTagWrite,
} from "./segments";
import {
  findTagNamespaceHolder,
  TagNamespaceCollisionError,
} from "./tag-namespace";
import { liveTurnSql } from "./turn-liveness";
import {
  LANE_CLEAR_WRITER,
  LANE_MERGE_WRITER,
  stampTurnRelationsRevision,
} from "./write-gate";

/**
 * Lane registry (lane-declaration spec Rev 2, D1). A lane is a DECLARED
 * object identified by `(segment, ONE tag)` — no title, the tag is the name
 * (the card pays per character, D1's own note). `declare`/`undeclare`
 * (mcp/remember.ts, and the settlement facade) are its only writers.
 *
 * MEMBERSHIP IS NOT MIRRORED HERE, and since lane-model-v12 ticket 10 it is
 * not an edge fact either: a turn belongs to the lanes its OWN `turns.tags`
 * name (intersected with what this registry has declared in that turn's
 * segment — `db/turn-tag-gate.ts` gates the write side, `db/lane-checker-
 * load.ts` resolves the read side). This table answers only "does this lane
 * exist", which is exactly what makes an undeclared word count for nothing in
 * attribution, and what `undeclare`'s guard below has to protect.
 */
export interface LaneRecord {
  id: number;
  segmentId: number;
  tag: string;
  createdAtEpoch: number;
}

interface LaneRow {
  id: number;
  segmentId: number;
  tag: string;
  createdAtEpoch: number;
}

const LANE_COLUMNS = `
  id,
  segment_id AS segmentId,
  tag,
  created_at_epoch AS createdAtEpoch
`;

function mapLaneRow(row: LaneRow | null): LaneRecord | null {
  return row ? { ...row } : null;
}

// ---------------------------------------------------------------------------
// Canonical tag predicate (D1, peer P2-10; charset tightened by container-
// unification ticket 01 / spec D2). Stored form: NFC-normalized, trimmed,
// lowercase, non-empty, no interior whitespace, and drawn ENTIRELY from
// `[a-z0-9-]` — never starting or ending with `-`. `declare` (and, this
// module's own symmetric choice, `undeclare`) REFUSE a value that is not
// ALREADY in this exact form — never silently canonicalize — so
// "write-gate" / "Write-Gate" / " write-gate " can never become three
// lanes. Checked in a fixed order so a value failing several rules at once
// still gets ONE clear, reproducible reason.
//
// THE CHARSET IS WHAT MAKES A LANE ADDRESSABLE. `recall`'s `id` parameter
// splits on `,` to support address lists, and the next ticket's `E<n>/#<tag>`
// address form reserves `/` and `#` as its own separators — `*` and `.` are
// selector syntax elsewhere in that same grammar. A tag containing any of
// them has no usable address: `E1/#a,b` silently splits into two selectors
// naming a lane that was never called either. Excluding the whole class by
// SHAPE (an allow-list, not a growing deny-list of separators) is what keeps
// a future selector character from reopening this hole.
// ---------------------------------------------------------------------------

export type LaneTagCanonicalViolation =
  | "empty"
  | "not-trimmed"
  | "interior-whitespace"
  | "mixed-case"
  | "not-nfc"
  | "prefixed"
  | "invalid-character"
  | "edge-hyphen";

/** The full canonical charset (D2): lowercase ASCII letters, digits, `-`. */
const CANONICAL_TAG_CHARSET_PATTERN = /^[a-z0-9-]+$/;

/**
 * The machine's namespace separator (lane-model-v12 spec D3b, ticket 14). A
 * tag a HOOK writes carries a prefix — `compact:`, `invalidated:`,
 * `delivery:` (534 / 77 / 45 occurrences measured, plus two malformed `1:`
 * values this same rule catches). A tag an AGENT may declare is a bare word.
 * Keeping the two namespaces disjoint by SHAPE rather than by a list is what
 * lets the tags gate treat "contains the separator" as "not yours to write"
 * without enumerating the hooks' vocabulary at every call site.
 */
export const TAG_NAMESPACE_SEPARATOR = ":";

export type LaneTagCanonicalCheck =
  | { ok: true }
  | { ok: false; violation: LaneTagCanonicalViolation; message: string };

export function checkCanonicalLaneTag(raw: string): LaneTagCanonicalCheck {
  if (raw.trim() === "") {
    return { ok: false, violation: "empty", message: "tag must not be empty." };
  }
  if (raw !== raw.trim()) {
    return {
      ok: false,
      violation: "not-trimmed",
      message: `tag ${JSON.stringify(raw)} has leading or trailing whitespace — canonical form is ${JSON.stringify(raw.trim())}.`,
    };
  }
  if (/\s/.test(raw)) {
    return {
      ok: false,
      violation: "interior-whitespace",
      message: `tag ${JSON.stringify(raw)} has interior whitespace — a canonical tag has none.`,
    };
  }
  if (raw !== raw.toLowerCase()) {
    return {
      ok: false,
      violation: "mixed-case",
      message: `tag ${JSON.stringify(raw)} is not lowercase — canonical form is ${JSON.stringify(raw.toLowerCase())}.`,
    };
  }
  const nfc = raw.normalize("NFC");
  if (raw !== nfc) {
    return { ok: false, violation: "not-nfc", message: `tag ${JSON.stringify(raw)} is not NFC-normalized.` };
  }
  // Ticket 14 (spec D3b): last, so a value failing an earlier rule still gets
  // that rule's reason. A prefixed value is not malformed — it is a MACHINE
  // tag, written by a hook straight to the column, and neither a lane nor a
  // segment may take a name out of that namespace.
  if (raw.includes(TAG_NAMESPACE_SEPARATOR)) {
    return {
      ok: false,
      violation: "prefixed",
      message:
        `tag ${JSON.stringify(raw)} carries a "${TAG_NAMESPACE_SEPARATOR}" namespace prefix — a lane ` +
        "or segment tag is a bare word. The prefixed namespaces are the hooks' (compact:, " +
        "invalidated:, delivery:) and the subject word a turn's note carries (topic:); none of " +
        "them names a container, so none of them can name a lane, a segment, or an edge side.",
    };
  }
  // D2's own tightening: every selector separator (`,` `/` `#` `*` `.`, and
  // anything else outside the allow-list) is excluded by shape, named by the
  // FIRST offending character so the reason is reproducible rather than a
  // generic "non-canonical". Codepoint-wise (`[...raw]`), not UTF-16 code
  // units, so a surrogate pair is reported as one character, not two.
  if (!CANONICAL_TAG_CHARSET_PATTERN.test(raw)) {
    const offending = [...raw].find((ch) => !/^[a-z0-9-]$/.test(ch)) ?? raw[0];
    return {
      ok: false,
      violation: "invalid-character",
      message:
        `tag ${JSON.stringify(raw)} contains ${JSON.stringify(offending)} — a canonical tag uses only ` +
        'lowercase letters, digits, and "-".',
    };
  }
  if (raw.startsWith("-") || raw.endsWith("-")) {
    return {
      ok: false,
      violation: "edge-hyphen",
      message:
        `tag ${JSON.stringify(raw)} starts or ends with "-" — canonical form may not start or end with "-".`,
    };
  }
  return { ok: true };
}

/**
 * How many lanes a segment currently has DECLARED (staged-settlement ticket
 * 09, spec §Lane threshold) — `COUNT(*)` on `lanes` filtered by
 * `segment_id`, served by `idx_lanes_segment`. `undeclare`/`clearLane`
 * physically delete the row (this file's own `deleteLane`), so this is
 * already "currently declared", not "ever declared" — no liveness filter
 * needed on top, unlike the member-turn counts above which read `turns`.
 */
export function countDeclaredLanesForSegment(db: Database, segmentId: number): number {
  return (
    db
      .query<{ n: number }, [number]>(
        `SELECT COUNT(*) AS n FROM lanes WHERE segment_id = ?`,
      )
      .get(segmentId)?.n ?? 0
  );
}

/**
 * How many EXISTING turns already carry a word (lane-model-v12 spec D3b,
 * ticket 14). `declare` prints this before minting, because declaring a
 * legacy free-form word as a lane RETROACTIVELY CONSCRIPTS every turn that
 * ever used it — measured on the live database: `spec` 153, `citation-edges`
 * 124, `timeline` 123. That number is also the best evidence a name is too
 * generic to be a lane at all.
 *
 * `inSegment` is the number that will actually become members: under D3e a
 * lane tag only counts on a turn that also carries its segment's tag, so the
 * two numbers together say both "how many turns use this word" and "how many
 * of them are yours".
 */
export function countTurnsCarryingTag(
  db: Database,
  tag: string,
  segmentId: number,
): { total: number; inSegment: number } {
  const total =
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM turns t
          WHERE EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)`,
      )
      .get(tag)?.n ?? 0;
  const inSegment =
    db
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n FROM turns t
           JOIN segment_members sm ON sm.turn_id = t.id
          WHERE EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
            AND sm.segment_id = ?`,
      )
      .get(tag, segmentId)?.n ?? 0;
  return { total, inSegment };
}

export function isCanonicalLaneTag(raw: string): boolean {
  return checkCanonicalLaneTag(raw).ok;
}

/**
 * Best-effort normalization, used ONLY by the M0/M2 migration below to seed
 * a lane from an EXISTING edge tag that predates this predicate. Never used
 * on a live `declare`/`undeclare` call — those refuse rather than
 * transform (see the predicate's own doc comment above).
 */
function bestEffortCanonicalizeLegacyTag(raw: string): string {
  return raw.trim().toLowerCase().normalize("NFC");
}

// ---------------------------------------------------------------------------
// DB primitives
// ---------------------------------------------------------------------------

export function getLane(db: Database, segmentId: number, tag: string): LaneRecord | null {
  return mapLaneRow(
    db
      .query<LaneRow, [number, string]>(
        `SELECT ${LANE_COLUMNS} FROM lanes WHERE segment_id = ? AND tag = ?`,
      )
      .get(segmentId, tag),
  );
}

/** Every lane a segment has declared, ascending by tag — mostly a test/inspection convenience in this ticket; the card's own render is a later ticket. */
export function listLanesForSegment(db: Database, segmentId: number): LaneRecord[] {
  return db
    .query<LaneRow, [number]>(
      `SELECT ${LANE_COLUMNS} FROM lanes WHERE segment_id = ? ORDER BY tag ASC`,
    )
    .all(segmentId)
    .map((row) => mapLaneRow(row)!)
    .filter((lane): lane is LaneRecord => lane !== null);
}

/**
 * Idempotent insert — `null` when `(segmentId, tag)` already exists (a caller
 * lost a race, or never pre-checked).
 *
 * THE NAMESPACE INVARIANT IS ENFORCED HERE, not in the facades and not in
 * `merge` (lane-model-v12 spec D3e, peer A2). `merge` never creates a name; it
 * folds one lane into a lane that already exists. This function and
 * `setSegmentTag` (db/segments.ts) are the only two that mint one, so a global
 * check in each — through the ONE shared helper, inside the caller's existing
 * IMMEDIATE write transaction — closes both directions at the only two places a
 * collision can be born. It THROWS (see `TagNamespaceCollisionError`) because
 * this function's `null` already means "that exact lane exists", and because
 * a migration or a repair script reaches this primitive without passing any
 * facade's friendlier pre-check.
 */
export function insertLane(
  db: Database,
  segmentId: number,
  tag: string,
  nowEpoch: number,
): LaneRecord | null {
  const holder = findTagNamespaceHolder(db, "lane", tag);
  if (holder) {
    throw new TagNamespaceCollisionError("lane", holder);
  }
  return mapLaneRow(
    db
      .query<LaneRow, [number, string, number]>(
        `INSERT INTO lanes (segment_id, tag, created_at_epoch) VALUES (?, ?, ?)
         ON CONFLICT (segment_id, tag) DO NOTHING
         RETURNING ${LANE_COLUMNS}`,
      )
      .get(segmentId, tag, nowEpoch),
  );
}

/** `true` iff a row was actually removed. */
export function deleteLane(db: Database, segmentId: number, tag: string): boolean {
  return (
    db
      .query<{ id: number }, [number, string]>(
        `DELETE FROM lanes WHERE segment_id = ? AND tag = ? RETURNING id`,
      )
      .get(segmentId, tag) !== null
  );
}

/**
 * `undeclare`'s own guard (lane-model-v12 D3, ticket 10): how many LIVE turns
 * OWNED by `segmentId` still carry `tag` in their OWN `tags` — i.e. how many
 * MEMBERS the lane still has. Non-zero means `undeclare` REFUSES; clearing
 * those tags is settlement's own explicit act, never a side effect of taking
 * the lane away.
 *
 * TICKET 10 CHANGED THE CONDITION, not just the query. The guard used to
 * count EDGES carrying the tag, which was the right question only while
 * membership itself came from edges. Under v12 a node belongs to the lanes
 * its own tags name, so a PROVISIONAL lane — declared, tagged onto one or two
 * turns, no edge written yet (v12 D3 makes that a legal state, with no fixed
 * timepoint by which an edge must appear) — reads as zero edges. The old
 * guard would have let it be undeclared out from under its own members,
 * leaving turns whose tags point at a lane that does not exist. Counting
 * members is the reading that matches what `undeclare` actually destroys.
 *
 * OWNERSHIP, NOT MERE MEMBERSHIP: `MIN(segment_id)`, `getOwningSegmentId`'s
 * own tie-break, so a turn in two segments is counted for exactly the segment
 * whose lane it can belong to — the same rule `db/lane-checker-load.ts`
 * resolves `laneTags` by, so the guard and the checker can never disagree
 * about who a member is.
 *
 * LAW 8 (rubric v11, `skip/rewind`: "被 skip 或 rewind 的 turn 不是节点";
 * `db/turn-liveness.ts`), carried over from the edge-counting guard because
 * it closes the same deadlock: a lane whose whole membership was later
 * SKIPPED must still be undeclarable. Without the predicate such a lane is
 * held open forever by turns that exist in no graph any reader can see, and
 * that are dormant, so nothing can retag them either.
 *
 * THE `CASE` IS LOAD-BEARING (same shape M0's filter below uses). SQLite's
 * `json_each` RAISES on a malformed value instead of returning zero rows, and
 * a raise inside WHERE fails the whole statement — `turns.tags` has no
 * `json_valid` CHECK, so one unreadable column would make `undeclare`
 * un-runnable for the entire segment. `json_valid`/`json_type` first, inside
 * a `CASE` (lazy arms, unlike a bare `AND` chain): an unreadable column
 * claims no lane, which is also the honest reading of a claim nobody can
 * parse.
 */
export function countLaneMemberTurnsInSegment(
  db: Database,
  segmentId: number,
  tag: string,
): number {
  return (
    db
      .query<{ n: number }, [number, string]>(
        `SELECT COUNT(*) AS n FROM turns t
          WHERE (SELECT MIN(sm.segment_id) FROM segment_members sm WHERE sm.turn_id = t.id) = ?
            AND ${liveTurnSql("t")}
            AND CASE
                  WHEN json_valid(t.tags) AND json_type(t.tags) = 'array'
                    THEN EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
                  ELSE 0
                END`,
      )
      .get(segmentId, tag)?.n ?? 0
  );
}

// ---------------------------------------------------------------------------
// `merge` — one declared lane folded into another (lane-model-v12 D3d, ticket 15)
// ---------------------------------------------------------------------------

/**
 * Raised when the merge reaches its own last step — taking lane `from` out of
 * the registry — while a live member turn still carries that tag.
 *
 * This is an INVARIANT, not a caller mistake: every population the guard counts
 * was rewritten a few statements earlier in this same transaction, so the only
 * way to see this error is an implementation that undeclares before it
 * rewrites. It throws (rather than returning a refusal) for exactly that
 * reason — there is no input a caller could send that would fix it, and the
 * throw rolls the whole transaction back, so a merge that cannot finish leaves
 * nothing behind.
 */
export class LaneMergeInvariantError extends Error {}

/** One identity-key collision the side rewrite created, recorded from BOTH sides. */
export interface LaneMergeCollision {
  citingAddress: string;
  citedAddress: string;
  /** `null` only for a bare pair row, which carries no side tag and therefore never collides here. */
  relation: string | null;
  /** The surviving row's post-merge sides — the last two components of the key the rows collided on. */
  tailTag: string;
  headTag: string;
  keptEdgeId: number;
  keptProvenance: string;
  keptCreatedAtEpoch: number;
  droppedEdgeId: number;
  droppedProvenance: string;
  droppedCreatedAtEpoch: number;
  rule: LaneModelV12MergeRule;
}

export interface LaneMergeReceipt {
  segmentId: number;
  /** The lane that ceased to exist. */
  from: string;
  /** The lane it became. */
  into: string;
  /** Member turns whose own `tags` lost `from`. */
  turnsRetagged: number;
  /** Of those, the ones that already carried `into` — the word was DROPPED there, not renamed, so the set keeps one copy. */
  turnsDeduplicated: number;
  /** Edge SIDES rewritten. An edge tagged `from` on both sides counts twice — that is the unit the identity key is made of. */
  edgeSidesRewritten: number;
  /** Rows deleted because the rewrite landed two of them on one identity key. */
  collisions: readonly LaneMergeCollision[];
  /**
   * Turns that still carry `from` after the merge (lane-merge-skip-receipt
   * ticket 01): the SAME tag predicate the member SELECT above uses, its
   * `MIN(segment_id) = segmentId` restriction simply dropped, read AFTER the
   * member retag loop — every turn that loop actually captured lost `from`
   * a few statements earlier, so a match here is not a prediction, it is the
   * merge's own outcome. `S<session>/T<prompt>` addresses (`resolveTurnAddress`,
   * this file), ascending by turn id. Ordinarily empty: a non-empty list
   * means some turn's own `tags` disagree with `segment_members` about who a
   * member is — the incident this ticket answers, eleven such turns still
   * live in production under E60's now-undeclared "lane-declaration".
   */
  stillCarrying: readonly string[];
}

/**
 * THE ONLY PATH BY WHICH `merge` TAKES A LANE OUT OF THE REGISTRY, and the
 * check and the delete are one statement on purpose.
 *
 * The ordering `merge` must never get wrong is "rewrite the members, THEN
 * undeclare". Inside one transaction the wrong order produces the SAME final
 * state, so no test that reads the database afterwards can tell the two apart —
 * the intermediate half-merge is real but unobservable. Pairing the guard with
 * the delete is what makes the ordering checkable at all: move this call above
 * the member rewrite and the guard is evaluated while the members still carry
 * the tag, so it throws instead of leaving a lane nobody can undeclare.
 *
 * It is `undeclare`'s own guard, deliberately — the same question, asked at the
 * same moment, so `merge` cannot destroy a lane that a plain `undeclare` would
 * have refused to touch.
 */
function undeclareEmptiedLane(db: Database, segmentId: number, tag: string): void {
  const remaining = countLaneMemberTurnsInSegment(db, segmentId, tag);
  if (remaining > 0) {
    throw new LaneMergeInvariantError(
      `merge would undeclare E${segmentId}'s lane "${tag}" while ${remaining} member turn(s) ` +
        "still carry it — the members are rewritten BEFORE the lane is taken away, never after.",
    );
  }
  deleteLane(db, segmentId, tag);
}

/**
 * Resolves whether one edge SIDE belongs to `segmentId` — the shared
 * judgment `mergeLaneTag` and `clearLane` (container-unification ticket 07,
 * spec D5, peer #4) both need: a lane's identity is `(segment, tag)`, but an
 * edge side stores only the bare tag STRING, so two segments declaring the
 * identical word produce a side that reads alike on both unless it is
 * resolved through its OWN endpoint's owning segment rather than compared as
 * a string — an `E1/alpha -> E2/alpha` edge has "alpha" on both sides while
 * being a crossing between two different lanes.
 *
 * Factored out here rather than left as a closure `mergeLaneTag` alone
 * owns, so `clearLane` REUSES this judgment instead of writing a second,
 * easily-drifting predicate beside it — Rev 1 of this batch's own spec made
 * exactly that mistake once already (see this file's module doc comment).
 *
 * Memoized per call: an endpoint's owning segment cannot change mid-
 * transaction, and a caller here asks about the same turn on both the tail
 * and the head of several candidate rows.
 */
function makeSideOwnershipResolver(
  db: Database,
  segmentId: number,
): (kind: string, id: number) => boolean {
  const owners = new Map<number, number | null>();
  return (kind: string, id: number): boolean => {
    if (kind !== "turn") {
      // A side whose endpoint is not a turn has no owning segment to compare
      // against, so no lane of this segment can be claiming it.
      return false;
    }
    if (!owners.has(id)) {
      owners.set(id, getOwningSegmentId(db, id));
    }
    return owners.get(id) === segmentId;
  };
}

interface LaneMergeTurnRow {
  id: number;
  tags: string;
}

interface LaneMergeEdgeRow {
  id: number;
  citingKind: string;
  citingId: number;
  citedKind: string;
  citedId: number;
  relation: string | null;
  provenance: string;
  tailTag: string;
  headTag: string;
  createdAtEpoch: number;
}

/**
 * `merge` (lane-model-v12 spec D3d, ticket 15): fold lane `from` into lane
 * `into`, both declared in `segmentId`, so that `from` ceases to exist.
 *
 * FOUR MUTATIONS, ONE TRANSACTION — the caller's (`db/database.ts`'s
 * `runWriteTransaction`, opened by the settlement direct-write engine, the
 * same arrangement `declare`/`undeclare` already have). A half-merged state is
 * not representable: members retagged but the lane still declared, or the lane
 * gone with members still pointing at it, are both states this function has to
 * pass THROUGH but can never leave behind.
 *
 *   1. every member turn's own `tags`: `from` becomes `into`, and where the
 *      turn already carried `into` the word is simply dropped — `tags` is a
 *      SET, so a rename that duplicates is a rename that removes;
 *   2. every edge side attributed to `from`: `tail_tag`/`head_tag` become
 *      `into`, plus the `memory_edge_side_tags` lookup rows that mirror them;
 *   2b. `from`'s IMPRESSION is CONCATENATED onto `into`'s (lane-impressions
 *      ticket 07, the user's ruling at T2269) — the fourth population, added
 *      because the three above moved everything about a lane EXCEPT the model
 *      the settlement runs had built of it, and a fold that keeps the members
 *      while destroying the understanding is the loss the ruling names;
 *   3. `from` leaves the registry.
 *
 * LIVENESS IS NOT CONSULTED, deliberately, and this differs from
 * `countLaneMemberTurnsInSegment`'s own Law-8 filter above. That guard asks
 * "may this lane be taken away", where a skipped turn is no member of anything
 * and must not hold a lane open forever. This asks something stronger: after a
 * merge the word `from` does not name a lane in this segment at all, so any
 * turn still carrying it — dormant or not — would be carrying an attribution
 * to something that no longer exists. Undeclare refuses and leaves; merge is
 * the explicit act that clears.
 *
 * OWNERSHIP DECIDES WHOSE TAG IT IS. A lane is `(segment, tag)`, so the same
 * word in another segment is a DIFFERENT lane and is left alone — for turns via
 * `MIN(segment_id)` (`getOwningSegmentId`'s own tie-break, the rule
 * `db/lane-checker-load.ts` resolves membership by), and for an edge SIDE via
 * the segment owning THAT side's own endpoint. An edge crossing from this
 * segment into another has exactly one side rewritten.
 *
 * COLLISIONS GO THROUGH THE ESTABLISHED RULE. An edge identity is
 * `(citing, cited, relation, tail_tag, head_tag)`, so folding two tags into one
 * can land two rows on one key — an `extends` from T1 to T2 tagged `a→a` and
 * another tagged `b→b` are two rows today and one key after. They fold through
 * `sortLaneModelV12MergeGroup` (asserted metadata survives; equal rank keeps
 * the earlier row), the SAME comparator the v12 migrations use, and the count
 * lands in the receipt. Casualties are DELETED BEFORE any survivor is
 * rewritten, M-B's own ordering: a survivor's new key belongs to its own group
 * and every other member of that group is already gone, so no `UPDATE` can
 * transiently collide and the UNIQUE constraint never has to be suspended.
 *
 * THE TAG WRITE RE-DERIVES MEMBERSHIP, and that is not defensive padding.
 * `deriveTurnSegmentMembership` (db/segments.ts) is what keeps `tags` and
 * `segment_members` from disagreeing — "the one state derivation may never
 * produce", in its own words — and a raw `UPDATE turns SET tags` goes around
 * it. For the ordinary merge nothing moves (a lane tag is not a segment tag,
 * so the word that identifies the container is untouched), and the derivation
 * early-returns. It is called anyway because "no lane tag is ever some
 * segment's tag" is a fact about the DECLARE gate, not about this function's
 * inputs, and the cost of being wrong about it is a turn whose stored
 * membership no longer matches its stored tags.
 *
 * NO MULTI-STATEMENT `db.exec` ANYWHERE BELOW. `bun:sqlite` swallows a
 * constraint failure in the middle of a multi-statement `exec` and runs the
 * rest, which for a function that MOVES data is silent loss (spec's own
 * platform-mine note). Every mutation here is a prepared `.run()`.
 */
export function mergeLaneTag(
  db: Database,
  segmentId: number,
  from: string,
  into: string,
  nowEpoch: number,
): LaneMergeReceipt {
  // --- 1. member turns -----------------------------------------------------
  const memberTurns = db
    .query<LaneMergeTurnRow, [number, string]>(
      `SELECT t.id AS id, t.tags AS tags FROM turns t
        WHERE (SELECT MIN(sm.segment_id) FROM segment_members sm WHERE sm.turn_id = t.id) = ?
          AND CASE
                WHEN json_valid(t.tags) AND json_type(t.tags) = 'array'
                  THEN EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
                ELSE 0
              END
        ORDER BY t.id ASC`,
    )
    .all(segmentId, from);

  let turnsDeduplicated = 0;
  const memberWrites: MembershipTagWrite[] = [];
  for (const turn of memberTurns) {
    const stored = (JSON.parse(turn.tags) as unknown[]).filter(
      (tag): tag is string => typeof tag === "string",
    );
    if (stored.includes(into)) {
      turnsDeduplicated += 1;
    }
    const next: string[] = [];
    for (const tag of stored) {
      const rewritten = tag === from ? into : tag;
      if (!next.includes(rewritten)) {
        next.push(rewritten);
      }
    }
    memberWrites.push({ turnId: turn.id, tags: next });
  }
  // THE MEMBERSHIP PRIMITIVE (settlement-read-once spec D4), `normal`: it
  // writes the tags, STAMPS the `tags` field, and derives — where this loop
  // used to raw-`UPDATE turns SET tags` and stamp nothing, so a lane merge
  // moved a turn's tags underneath a writer holding a read grant on them and
  // that writer's next whole-set write was admitted as fresh.
  //
  // `callerNormalizesAttribution`: this verb is a COMPOUND attribution change
  // — tags now, edge sides in step 2 — and normalising between the two halves
  // would clear every `from` declaration as invalid (and delete the edge where
  // its endpoint is in several lanes) a moment before the rewrite that carries
  // the attribution across. The seam runs once at the end instead, over the
  // finished state.
  writeMembershipTags(db, {
    operation: "normal",
    writes: memberWrites,
    nowEpoch,
    callerNormalizesAttribution: true,
  });

  // --- 1b. turns still carrying `from` after the retag (lane-merge-skip-
  //         receipt ticket 01) ---------------------------------------------
  // The SAME tag CASE the member SELECT above uses, its `MIN(segment_id) = ?`
  // restriction simply dropped — read ONLY NOW, after every turn that
  // restriction captured just lost `from` in the loop above. A match here is
  // therefore, by construction, a turn the member query never saw: it fell
  // outside `segment_members` membership for this segment (the incident's own
  // orphans — a tag with no membership row at all), and the merge left it
  // exactly as it found it.
  const stillCarrying = db
    .query<{ id: number }, [string]>(
      `SELECT t.id AS id FROM turns t
        WHERE CASE
                WHEN json_valid(t.tags) AND json_type(t.tags) = 'array'
                  THEN EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
                ELSE 0
              END
        ORDER BY t.id ASC`,
    )
    .all(from)
    .map((row) => resolveTurnAddress(db, row.id));

  // --- 2. edge sides -------------------------------------------------------
  // Both words are read, not just the one being folded away: a row that
  // ALREADY says `into` is the collision partner of a row this pass rewrites,
  // and a query restricted to `from` would see one row where the post-merge
  // key holds two. Every possible partner is in this set by construction — a
  // colliding row must match the survivor's key, whose rewritten side is
  // `into`.
  const candidates = db
    .query<LaneMergeEdgeRow, [string, string, string, string]>(
      `SELECT id,
              citing_kind AS citingKind, citing_id AS citingId,
              cited_kind AS citedKind, cited_id AS citedId,
              relation, provenance,
              tail_tag AS tailTag, head_tag AS headTag,
              created_at_epoch AS createdAtEpoch
         FROM memory_edges
        WHERE tail_tag IN (?, ?) OR head_tag IN (?, ?)
        ORDER BY id ASC`,
    )
    .all(from, into, from, into);

  const ownsSide = makeSideOwnershipResolver(db, segmentId);

  interface LaneMergeRewrite {
    row: LaneMergeEdgeRow;
    tailTag: string;
    headTag: string;
    sidesRewritten: number;
  }

  const rewrites: LaneMergeRewrite[] = [];
  for (const row of candidates) {
    let sidesRewritten = 0;
    let tailTag = row.tailTag;
    let headTag = row.headTag;
    if (tailTag === from && ownsSide(row.citingKind, row.citingId)) {
      tailTag = into;
      sidesRewritten += 1;
    }
    if (headTag === from && ownsSide(row.citedKind, row.citedId)) {
      headTag = into;
      sidesRewritten += 1;
    }
    rewrites.push({ row, tailTag, headTag, sidesRewritten });
  }

  const groups = new Map<string, LaneMergeRewrite[]>();
  for (const rewrite of rewrites) {
    // JSON.stringify of the field tuple rather than a joined string: a join
    // needs a separator that cannot occur in a tag, which is what pushed an
    // earlier version here to raw control bytes — valid at runtime, invisible
    // in review, and the second such byte this batch shipped. `null` for a
    // bare row survives the encoding distinctly from the string "bare", so the
    // encoding is injective where the join was merely unlikely to collide.
    const key = JSON.stringify([
      rewrite.row.citingKind,
      rewrite.row.citingId,
      rewrite.row.citedKind,
      rewrite.row.citedId,
      rewrite.row.relation ?? null,
      rewrite.tailTag,
      rewrite.headTag,
    ]);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(rewrite);
    } else {
      groups.set(key, [rewrite]);
    }
  }

  const dropSideTagRows = db.query<unknown, [number]>(
    "DELETE FROM memory_edge_side_tags WHERE edge_row_id = ?",
  );
  const insertSideTagRow = db.query<unknown, [number, string, string]>(
    "INSERT OR IGNORE INTO memory_edge_side_tags (edge_row_id, side, tag) VALUES (?, ?, ?)",
  );
  const deleteEdge = db.query<unknown, [number]>("DELETE FROM memory_edges WHERE id = ?");
  const updateEdgeSides = db.query<unknown, [string, string, number]>(
    "UPDATE memory_edges SET tail_tag = ?, head_tag = ? WHERE id = ?",
  );

  // Settlement-read-once ticket 00 (spec D0): every citing TURN whose outgoing
  // rows this fold rewrites or deletes, collected as the mutations are decided
  // and stamped once, at the end, inside this same transaction. Both halves of
  // the fold change the set a reader was shown — a casualty removes a row
  // outright, a survivor's side rewrite changes the row's identity key — so
  // both go in. `citingKind !== "turn"` cannot carry a relation under v12's
  // turn-scoped CHECK, and a bare row has no side tags to rewrite, so the
  // filter is the schema's own shape rather than a judgment.
  const relationsMoved = new Set<number>();
  const noteCitingTurn = (row: LaneMergeEdgeRow): void => {
    if (row.citingKind === "turn") {
      relationsMoved.add(row.citingId);
    }
  };

  const collisions: LaneMergeCollision[] = [];
  const survivors: LaneMergeRewrite[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      survivors.push(bucket[0]!);
      continue;
    }
    const ordered = sortLaneModelV12MergeGroup(
      bucket.map((entry) => ({
        id: entry.row.id,
        provenance: entry.row.provenance,
        createdAtEpoch: entry.row.createdAtEpoch,
        entry,
      })),
    );
    const kept = ordered[0]!;
    survivors.push(kept.entry);
    for (const dropped of ordered.slice(1)) {
      collisions.push({
        citingAddress: resolveEdgeNodeAddress(db, kept.entry.row.citingKind, kept.entry.row.citingId),
        citedAddress: resolveEdgeNodeAddress(db, kept.entry.row.citedKind, kept.entry.row.citedId),
        relation: kept.entry.row.relation,
        tailTag: kept.entry.tailTag,
        headTag: kept.entry.headTag,
        keptEdgeId: kept.id,
        keptProvenance: kept.provenance,
        keptCreatedAtEpoch: kept.createdAtEpoch,
        droppedEdgeId: dropped.id,
        droppedProvenance: dropped.provenance,
        droppedCreatedAtEpoch: dropped.createdAtEpoch,
        rule: laneModelV12MergeRule(kept, dropped),
      });
      // Explicit rather than trusting `ON DELETE CASCADE`: the index row is a
      // derived lookup, and a merge that left one behind would point a reader
      // at a lane through an edge that no longer exists.
      dropSideTagRows.run(dropped.id);
      deleteEdge.run(dropped.id);
      noteCitingTurn(dropped.entry.row);
    }
  }

  let edgeSidesRewritten = 0;
  for (const survivor of survivors) {
    if (survivor.sidesRewritten === 0) {
      continue;
    }
    edgeSidesRewritten += survivor.sidesRewritten;
    noteCitingTurn(survivor.row);
    updateEdgeSides.run(survivor.tailTag, survivor.headTag, survivor.row.id);
    dropSideTagRows.run(survivor.row.id);
    if (survivor.tailTag !== "") {
      insertSideTagRow.run(survivor.row.id, "tail", survivor.tailTag);
    }
    if (survivor.headTag !== "") {
      insertSideTagRow.run(survivor.row.id, "head", survivor.headTag);
    }
  }

  // --- 2a. the relations revision (settlement-read-once ticket 00, D0) -----
  // `checkRelationsGate` promises that an edge write is refused when the
  // citing turn's outgoing rows moved under the writer BY ANY PATH. Before
  // this ticket only `note` and the settlement turn facade kept that promise;
  // this raw-SQL fold rewrote and deleted rows and stamped nothing, so a run
  // holding a grant read before the fold could still write on a set the fold
  // had changed. Stamped under a reserved id rather than the caller's own so
  // the caller does not out-rank its own structural verb (see
  // `LANE_MERGE_WRITER`).
  for (const turnId of relationsMoved) {
    stampTurnRelationsRevision(db, turnId, LANE_MERGE_WRITER, nowEpoch);
  }

  // --- 2c. POST-NORMALISATION (main-agent-edges P2), once, over the finished
  //         state: a declaration the fold made redundant (the endpoint is down
  //         to one lane) is cleared, one it made untrue is cleared, and a side
  //         nobody can attribute any more either invalidates a live settlement
  //         run over its citer or takes the seam's own subtraction.
  normalizeIncidentAttribution(
    db,
    memberWrites.map((write) => write.turnId),
    { writer: LANE_MERGE_WRITER, nowEpoch },
  );

  // --- 2b. the impression (lane-impressions ticket 07, ruling T2269) --------
  // BEFORE step 3, and that adjacency is the whole point: once
  // `undeclareEmptiedLane` has taken `from`'s row away there is no text left to
  // carry, which is precisely how a RENAME used to destroy an impression —
  // `renameLane` below is mint-then-fold, so the "folded" side is the ONLY
  // holder of the text and the survivor is a row minted seconds earlier.
  //
  // Called for EVERY fold, including settlement's own membership facade: the
  // debts and the STALE flag are scoped to MANUAL operations (ticket 03's own
  // reasoning — a settlement-initiated fold is already inside that run's touch
  // ledger), but keeping the material is not a judgment anyone can be exempt
  // from. `foldLaneImpressionIntoSurvivor` moves the CAS fence and touches no
  // flag; the survivor's STALE mark, where one is owed, is the caller's.
  foldLaneImpressionIntoSurvivor(db, { segmentId, tag: from }, { segmentId, tag: into });

  // --- 3. the lane leaves the registry -------------------------------------
  undeclareEmptiedLane(db, segmentId, from);

  return {
    segmentId,
    from,
    into,
    turnsRetagged: memberTurns.length,
    turnsDeduplicated,
    edgeSidesRewritten,
    collisions,
    stillCarrying,
  };
}

// ---------------------------------------------------------------------------
// `retag` — a lane's own name change (container-unification ticket 04, spec D3)
// ---------------------------------------------------------------------------

export type RenameLaneOutcome =
  | { kind: "no-from" }
  | { kind: "duplicate" }
  | { kind: "renamed"; receipt: LaneMergeReceipt };

/**
 * `retag`'s lane-tier primitive: renaming `from` to `to` is the SAME four
 * populations `mergeLaneTag` already moves for a fold — member tags, edge
 * sides, the impression, the registry row — with a destination that does not
 * exist yet instead of one that does. Reusing it, rather than writing a second
 * traversal, is what stops the two from drifting apart: a rename is not a
 * distinct mechanism, it is a fold whose target is freshly minted.
 *
 * THE IMPRESSION SURVIVES THE RELABEL (lane-impressions ticket 07, ruling
 * T2269), and it does so through that same reuse rather than through anything
 * written here: the minted row is empty, so the fold's degenerate arm carries
 * `from`'s text, its origin and — via the fold's own revision bump — a fence
 * coordinate that has MOVED, so an in-flight run's `replace` decided against
 * the pre-rename text cannot land. Before ticket 07 the text, the revision and
 * the origin all died with the old row: a relabel silently destroyed the model
 * the settlement runs had built.
 *
 * MINT THEN FOLD. `insertLane`'s own idempotent insert (`ON CONFLICT ... DO
 * NOTHING RETURNING`) is the guard for "`to` is not already taken", and it is
 * PAIRED with the write by construction — there is no window between the
 * check and the row landing for a concurrent caller to land in, because they
 * are the same statement. This function never writes a name that already
 * exists; the insert that would create it simply returns `null` first. The
 * registry's OTHER guard — "`from` must currently exist" — has no such
 * atomic primitive to lean on (an absent row is not a conflict `insertLane`
 * can detect), so it is checked explicitly, first, before anything mints.
 *
 * A fresh `to` starts with zero members, so nothing is deduplicated and the
 * fold's own collision handling only fires on a genuine pre-existing
 * conflict (e.g. a stray unlabelled edge already carrying the destination
 * word) — the ordinary case is a clean rename with an empty collision list.
 *
 * Callers own segment existence and open/closed status — this function only
 * ever sees a `segmentId` its caller already resolved, matching every other
 * primitive in this file.
 */
export function renameLane(
  db: Database,
  segmentId: number,
  from: string,
  to: string,
  nowEpoch: number,
): RenameLaneOutcome {
  if (!getLane(db, segmentId, from)) {
    return { kind: "no-from" };
  }
  const minted = insertLane(db, segmentId, to, nowEpoch);
  if (!minted) {
    return { kind: "duplicate" };
  }
  const receipt = mergeLaneTag(db, segmentId, from, to, nowEpoch);
  return { kind: "renamed", receipt };
}

// ---------------------------------------------------------------------------
// `clear` — un-home a lane's members and delete its edges (container-
// unification ticket 07, spec D5/D5b)
// ---------------------------------------------------------------------------

/**
 * One edge `clearLane` would touch that it refuses to delete without
 * `force` — printed whether or not `force` was given (spec D8: `force`
 * means only "proceed despite the warning", never "I have read this list",
 * so the list is its own product, not a precondition of the flag).
 */
export interface LaneClearBlocker {
  edgeId: number;
  citingAddress: string;
  citedAddress: string;
  relation: string | null;
  /**
   * `cross-lane` — the OTHER side resolves to a DIFFERENT declared lane
   * (same segment or another one); deleting the row destroys that lane's
   * own record. `half-settled` — the other side is the unsettled sentinel
   * (`''`, spec D5 peer #6): `''` is not "another lane", so it needs its
   * own class rather than silently passing a cross-lane-only check.
   */
  kind: "cross-lane" | "half-settled";
  /** `E<n>/#<tag>` for a cross-lane blocker; always `null` for half-settled — there is no lane to name. */
  otherLane: string | null;
}

export interface LaneClearReceipt {
  segmentId: number;
  tag: string;
  /** Member turns whose own `tags` lost this lane's word. */
  turnsCleared: number;
  /** Stored declarations of this lane that the clear made untrue and the post-normalisation removed. */
  declarationsCleared: number;
  /** Edge ROWS deleted — only those the clear left UNATTRIBUTABLE (a side whose endpoint is still in several lanes with no declaration surviving). Nothing else is deleted: an edge is a fact about two nodes, and un-homing a turn does not unmake it. */
  edgesDeleted: number;
}

export type LaneClearOutcome =
  | { kind: "not-declared" }
  | { kind: "cleared"; receipt: LaneClearReceipt };

/**
 * `clear`'s lane-tier primitive: un-home every member turn from this lane,
 * then RE-RESOLVE every attribution the change touched.
 *
 * ## What it stopped doing, and why
 *
 * It used to DELETE every edge row that resolved to the lane, restore a bare
 * prose row for any pair the deletion emptied, and refuse without `force` the
 * moment a candidate row would strand a CROSS-LANE or HALF-SETTLED side. All
 * three followed from the stored-side model: a side carried a lane word, so a
 * lane going away left that word naming nothing and the row had nowhere to
 * sit.
 *
 * Under resolution (main-agent-edges spec D2) a lane side is an ATTRIBUTION,
 * not a property of the row. Clearing a lane changes which lane an edge is
 * attributed to — usually to none — and changes nothing about whether one turn
 * corrected another. So the verb mutates attribution only
 * (`normalizeIncidentAttribution`), and the blockers go with the deletion they
 * were guarding: there is no longer a destructive outcome for `force` to gate.
 * The ONE case that still subtracts is an edge the change leaves genuinely
 * unattributable — a side whose endpoint is in two or more lanes with no
 * declaration left — and that is the seam's own rule (T2421), receipted in
 * `edge_attribution_receipts`.
 *
 * The member tags move through `writeMembershipTags` exactly as `mergeLaneTag`
 * moves them, so the tag write is stamped and derived in one place — and it is
 * that primitive that runs the normalisation, in this function's own
 * transaction.
 */
export function clearLane(
  db: Database,
  segmentId: number,
  tag: string,
  nowEpoch: number,
): LaneClearOutcome {
  if (!getLane(db, segmentId, tag)) {
    return { kind: "not-declared" };
  }

  const memberTurns = db
    .query<{ id: number; tags: string }, [number, string]>(
      `SELECT t.id AS id, t.tags AS tags FROM turns t
        WHERE (SELECT MIN(sm.segment_id) FROM segment_members sm WHERE sm.turn_id = t.id) = ?
          AND CASE
                WHEN json_valid(t.tags) AND json_type(t.tags) = 'array'
                  THEN EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
                ELSE 0
              END
        ORDER BY t.id ASC`,
    )
    .all(segmentId, tag);

  const written = writeMembershipTags(db, {
    operation: "normal",
    writes: memberTurns.map((turn) => ({
      turnId: turn.id,
      tags: (JSON.parse(turn.tags) as unknown[])
        .filter((value): value is string => typeof value === "string")
        .filter((value) => value !== tag),
    })),
    nowEpoch,
    normalizationWriter: LANE_CLEAR_WRITER,
  });

  const attribution = written.ok ? written.attribution : undefined;
  return {
    kind: "cleared",
    receipt: {
      segmentId,
      tag,
      turnsCleared: memberTurns.length,
      declarationsCleared: attribution?.clearedDeclarations.length ?? 0,
      edgesDeleted: attribution?.deletedEdges.length ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Migration receipts (D6, shared shell)
// ---------------------------------------------------------------------------

interface MigrationReceiptPayloadRow {
  payload: string;
}

/**
 * Exported for the v12 edge-shape phases that live in db/schema.ts rather
 * than here (M-A and M-D are table REBUILDS, so they need this file's DDL
 * builders and cannot move into this module without a cycle). The receipt
 * discipline is the same one every phase in this file obeys — one shell, so
 * "did this phase run" is asked the same way everywhere.
 */
export function hasMigrationReceipt(db: Database, name: string): boolean {
  return (
    db
      .query<{ x: number }, [string]>(
        "SELECT 1 AS x FROM migration_receipts WHERE name = ?",
      )
      .get(name) !== null
  );
}

function readMigrationReceiptPayload<T>(db: Database, name: string): T | null {
  const row = db
    .query<MigrationReceiptPayloadRow, [string]>(
      "SELECT payload FROM migration_receipts WHERE name = ?",
    )
    .get(name);
  if (!row) {
    return null;
  }
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

/** `true` iff THIS call won the insert (never true twice for the same `name`). */
export function writeMigrationReceipt(
  db: Database,
  name: string,
  nowEpoch: number,
  payload: unknown,
): boolean {
  return (
    db
      .query<{ id: number }, [string, number, string]>(
        `INSERT INTO migration_receipts (name, applied_at_epoch, payload)
         VALUES (?, ?, ?)
         ON CONFLICT (name) DO NOTHING
         RETURNING id`,
      )
      .get(name, nowEpoch, JSON.stringify(payload)) !== null
  );
}

// ---------------------------------------------------------------------------
// M0 — classify (read-only)
// ---------------------------------------------------------------------------

export const LANE_REGISTRY_M0_CLASSIFY_RECEIPT = "lane-declaration-m0-classify";
export const LANE_REGISTRY_M2_SEED_RECEIPT = "lane-declaration-m2-seed";

export interface LaneMigrationClassifiedEdge {
  edgeId: number;
  citingTurnId: number;
  citedTurnId: number;
  relation: string;
  /** Canonicalized (D1 form); a raw tag that cannot be made canonical at all — empty after trim — is dropped. */
  tags: string[];
  citingSegmentId: number | null;
  citedSegmentId: number | null;
}

/**
 * WHICH SHAPE of unreadability M0 found, and the whole point of the enum
 * (ticket 13): `rejected` holds two structurally different things, and only
 * SOME of them may be disposed of.
 *
 *   - `malformed-tags-column` — `tags` is not a readable JSON array at all
 *     (invalid JSON, or valid JSON that is not an array). No reader can act on
 *     it; the edge reaches no other bucket. DISPOSABLE.
 *   - `no-canonical-tag` — a FULL rejection: the column read fine, but not one
 *     tag survived `bestEffortCanonicalizeLegacyTag` + D1. The edge `continue`s
 *     and reaches no other bucket, so nothing else would ever touch it.
 *     DISPOSABLE.
 *   - `partial-canonical-loss` — some tags survived. The edge ALSO appears in
 *     `placeable` or `notPlaceable`, classified on those survivors, and this
 *     entry is only the record of what was lost beside it. NEVER DISPOSABLE:
 *     stripping its column would destroy legitimate, still-legal tags.
 *
 * Rev 1 of this receipt gave the last two the SAME `no-canonical-tag` reason,
 * which made them distinguishable only by set arithmetic against the other two
 * buckets — at the call site, and nowhere at all for a human reading the
 * receipt afterwards. Splitting the name is the discriminator: a reader sees
 * the shape without cross-referencing anything.
 */
export type LaneMigrationRejectionReason =
  | "malformed-tags-column"
  | "no-canonical-tag"
  | "partial-canonical-loss";

/**
 * An edge whose tags could not be READ as lane tags at all — malformed JSON, a
 * non-array `tags` column, or tag strings no normalization can make canonical.
 * A third bucket exists because the alternative is a silent drop: such an edge
 * belongs to neither `placeable` nor `notPlaceable`, so without this it would
 * vanish from the receipt entirely and ticket 04's disposition pass — which
 * reads the receipt, not the table — would never see it.
 */
export interface LaneMigrationRejectedEdge {
  edgeId: number;
  citingTurnId: number;
  citedTurnId: number;
  relation: string;
  /** The `tags` column verbatim, so the disposition is auditable from the receipt alone. */
  rawTags: string;
  /** Tags this pass could not canonicalize; empty when the column was unreadable as an array, or held no string at all. */
  droppedTags: string[];
  reason: LaneMigrationRejectionReason;
}

export interface LaneMigrationClassification {
  /** Both endpoints belong to a segment — M2 seeds from this set only. */
  placeable: LaneMigrationClassifiedEdge[];
  /** At least one endpoint is homeless — ticket 04's M3/M4 consume this. */
  notPlaceable: LaneMigrationClassifiedEdge[];
  /** Unreadable as lane tags — reported, never silently skipped. */
  rejected: LaneMigrationRejectedEdge[];
}

interface TaggedEdgeRow {
  id: number;
  citingId: number;
  citedId: number;
  relation: string;
  tags: string;
}

/**
 * M0 (spec D6): read-only. Every LIVE turn↔turn relation-carrying edge whose
 * `tags` is non-empty, classified as `placeable` (both endpoints own a
 * segment) or not. Tags are canonicalized here on a best-effort basis
 * (`bestEffortCanonicalizeLegacyTag`) because this ticket's stricter D1
 * predicate postdates every tag already stored on `memory_edges` — a tag
 * that STILL fails the predicate after trim/lowercase/NFC (e.g. genuine
 * interior whitespace) is never seeded as a malformed lane — it lands in
 * `rejected` instead, named, so the loss appears in the receipt rather than
 * happening in silence.
 *
 * LAW 8 (rubric v11, `skip/rewind`; `db/turn-liveness.ts`). Both endpoints
 * are joined against `turns` and gated by `liveTurnSql` — the SAME predicate
 * the checker's own loader (`db/lane-checker-load.ts`) applies to both
 * endpoints of every edge it reads. A row with a skipped or rolled-back
 * endpoint is NOT an edge, so it enters NO bucket here: it seeds no lane in
 * M2 (which would mint a registry row whose members no reader can see, and
 * which the `undeclare` guard above would then have refused to clear) and it
 * is disposed of by NO phase either. That second half is deliberate on both
 * counts. `skipped` is DORMANT, not deleted — `db/turns.ts`'s
 * `promoteTurnFromNote` restores such a turn WHOLE, its stored edges
 * included — so downgrading its tag in M4 would destroy, permanently, a fact
 * held back by a reversible condition. And a row that resurfaces alive later
 * is judged then by the live surfaces (the write gate on any rewrite, the
 * checker on every read), which is where an illegality that is real belongs,
 * rather than being pre-emptively repaired while invisible.
 *
 * Measured read-only on production before this repair landed: 0 of 441
 * tagged turn-edges have a dead endpoint, so this changes no live receipt —
 * it closes a permanent runtime asymmetry, not an observed corruption.
 *
 * THE `tags` FILTER IS MALFORMED-TOLERANT BY CONSTRUCTION (ticket 13). SQLite's
 * `json_array_length` RAISES "malformed JSON" rather than returning NULL, and a
 * raise inside a WHERE clause fails the WHOLE statement — so the plain
 * `json_array_length(me.tags) > 0` this filter used to be did not merely skip an
 * unreadable row, it aborted M0, and with it `initializeSchema`, for every
 * process opening that database. The `CASE` asks `json_valid`/`json_type`
 * FIRST (a `CASE` evaluates its arms lazily; a bare `AND` chain is not
 * guaranteed to) and admits anything that is not a readable array, so an
 * unreadable row lands in `rejected` — named, and disposable by M4 — instead of
 * taking the migration down with it. `tags` is `NOT NULL DEFAULT '[]'`
 * (schema.ts), so there is no NULL arm to write; `'[]'` stays excluded, as an
 * untagged edge is not this pass's business.
 */
function classifyTaggedEdges(db: Database): LaneMigrationClassification {
  const rows = db
    .query<TaggedEdgeRow, []>(
      `SELECT me.id AS id, me.citing_id AS citingId, me.cited_id AS citedId,
              me.relation AS relation, me.tags AS tags
       FROM memory_edges me
       JOIN turns tc ON tc.id = me.citing_id
       JOIN turns td ON td.id = me.cited_id
       WHERE me.citing_kind = 'turn' AND me.cited_kind = 'turn'
         AND me.relation IS NOT NULL
         AND CASE
               WHEN json_valid(me.tags) AND json_type(me.tags) = 'array'
                 THEN json_array_length(me.tags) > 0
               ELSE 1
             END
         AND ${liveTurnSql("tc")} AND ${liveTurnSql("td")}
       ORDER BY me.id ASC`,
    )
    .all();

  const placeable: LaneMigrationClassifiedEdge[] = [];
  const notPlaceable: LaneMigrationClassifiedEdge[] = [];
  const rejected: LaneMigrationRejectedEdge[] = [];

  for (const row of rows) {
    let parsed: unknown;
    let readable = true;
    try {
      parsed = JSON.parse(row.tags);
    } catch {
      parsed = [];
      readable = false;
    }
    if (!Array.isArray(parsed)) {
      readable = false;
      parsed = [];
    }
    const rawTags = (parsed as unknown[]).filter(
      (tag): tag is string => typeof tag === "string",
    );
    const canonical = new Set<string>();
    const droppedTags: string[] = [];
    for (const raw of rawTags) {
      const candidate = bestEffortCanonicalizeLegacyTag(raw);
      if (checkCanonicalLaneTag(candidate).ok) {
        canonical.add(candidate);
      } else {
        droppedTags.push(raw);
      }
    }
    const tags = [...canonical].sort();
    // Reported, never skipped in silence: an edge that carries tags in the
    // column but yields no canonical tag here would otherwise appear in no
    // bucket at all, and ticket 04 reads the RECEIPT rather than re-deriving.
    if (!readable || tags.length === 0) {
      rejected.push({
        edgeId: row.id,
        citingTurnId: row.citingId,
        citedTurnId: row.citedId,
        relation: row.relation,
        rawTags: row.tags,
        droppedTags,
        reason: readable ? "no-canonical-tag" : "malformed-tags-column",
      });
      continue;
    }
    // A PARTIAL loss is a fact too: the edge still classifies on the tags that
    // survived, and the ones that did not are named beside it. Its OWN reason
    // (ticket 13) is what keeps M4 off it — this same edge is about to be
    // pushed into `placeable`/`notPlaceable` below, and disposing of it here
    // would strip the survivors that just earned it a place there.
    if (droppedTags.length > 0) {
      rejected.push({
        edgeId: row.id,
        citingTurnId: row.citingId,
        citedTurnId: row.citedId,
        relation: row.relation,
        rawTags: row.tags,
        droppedTags,
        reason: "partial-canonical-loss",
      });
    }

    const citingSegmentId = getOwningSegmentId(db, row.citingId);
    const citedSegmentId = getOwningSegmentId(db, row.citedId);
    const entry: LaneMigrationClassifiedEdge = {
      edgeId: row.id,
      citingTurnId: row.citingId,
      citedTurnId: row.citedId,
      relation: row.relation,
      tags,
      citingSegmentId,
      citedSegmentId,
    };
    if (citingSegmentId !== null && citedSegmentId !== null) {
      placeable.push(entry);
    } else {
      notPlaceable.push(entry);
    }
  }

  return { placeable, notPlaceable, rejected };
}

// ---------------------------------------------------------------------------
// M2 — seed
// ---------------------------------------------------------------------------

export interface LaneMigrationSeedReceipt {
  perSegment: Array<{ segmentId: number; count: number }>;
  totalSeeded: number;
  /**
   * A legacy edge tag M2 REFUSED to mint a lane from, because the word is
   * already some segment's own tag (lane-model-v12 D3e's one namespace — see
   * `db/tag-namespace.ts`). Named rather than silently dropped, the same
   * discipline M0's `rejected` bucket states its own reason for: this is the
   * only record that a tag which used to ride an edge has no lane to be legal
   * under, and M4 disposes of nothing on this account.
   */
  skippedNamespaceCollisions: Array<{
    segmentId: number;
    tag: string;
    /** The segment whose own tag the word already is. */
    holderSegmentId: number;
  }>;
}

/**
 * M2 (spec D6): one lane per (owning segment, tag), from the PLACEABLE set
 * only — a tag M4 (ticket 04) is about to strip off a homeless-endpoint edge
 * never gets a lane minted for it here. A cross-segment edge seeds BOTH its
 * segments (D2's "consulted once per endpoint" rule), which collapses to one
 * seed when both endpoints share a segment. `count` is how many lanes THIS
 * call newly inserted (the only way to run given the M0/M2 receipt gate),
 * not a re-derived total.
 */
function seedLanesFromClassification(
  db: Database,
  placeable: readonly LaneMigrationClassifiedEdge[],
  nowEpoch: number,
): LaneMigrationSeedReceipt {
  const wantedTagsBySegment = new Map<number, Set<string>>();
  for (const entry of placeable) {
    const segmentIds = new Set(
      [entry.citingSegmentId, entry.citedSegmentId].filter(
        (id): id is number => id !== null,
      ),
    );
    for (const segmentId of segmentIds) {
      let tags = wantedTagsBySegment.get(segmentId);
      if (!tags) {
        tags = new Set();
        wantedTagsBySegment.set(segmentId, tags);
      }
      for (const tag of entry.tags) {
        tags.add(tag);
      }
    }
  }

  const perSegment: Array<{ segmentId: number; count: number }> = [];
  const skippedNamespaceCollisions: LaneMigrationSeedReceipt["skippedNamespaceCollisions"] = [];
  let totalSeeded = 0;
  const segmentIds = [...wantedTagsBySegment.keys()].sort((a, b) => a - b);
  for (const segmentId of segmentIds) {
    const tags = [...wantedTagsBySegment.get(segmentId)!].sort();
    let count = 0;
    for (const tag of tags) {
      // ASKED HERE TOO, not left to `insertLane`'s throw. The primitive is the
      // authority and refuses by throwing, which is right for a live caller —
      // but this loop runs inside `initializeSchema`, so one legacy edge tag
      // that happens to spell some segment's own tag would abort schema
      // initialisation for every process opening the database. A migration may
      // not mint the state D3e outlaws, and it may not brick the database
      // either; skipping it and NAMING it in the receipt is the reading that
      // does neither.
      const holder = findTagNamespaceHolder(db, "lane", tag);
      if (holder) {
        skippedNamespaceCollisions.push({ segmentId, tag, holderSegmentId: holder.segmentId });
        continue;
      }
      if (insertLane(db, segmentId, tag, nowEpoch)) {
        count += 1;
        totalSeeded += 1;
      }
    }
    perSegment.push({ segmentId, count });
  }

  return { perSegment, totalSeeded, skippedNamespaceCollisions };
}

// ---------------------------------------------------------------------------
// M3 — legal membership, by explicit allowlist
// ---------------------------------------------------------------------------

export const LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT = "lane-declaration-m3-membership";

/**
 * D6/M3 (peer P1-4, "a count is not provenance"). Rev 1 stamped a segment's
 * curated tags onto its tagless members whenever the segment held "≤2"
 * curated tags — a legacy segment carrying two DERIVED tags (the pre-ticket-07
 * frequency mush, not hand-curated identity) would have been stamped just as
 * readily as a genuinely curated one, and a hand-curated THREE-tag segment
 * would have been skipped. This hard-coded, reviewed list is the ONLY
 * eligibility test: `(segment id, EXACT curated tag set)`, order-independent —
 * a segment whose curated tags do not match one of these entries exactly is
 * always reported, never stamped, whatever its member count.
 *
 * Measured live (2026-08-24): E60's curated tags are `["claude-mnemo"]` and it
 * is the only segment on this list — E53/E58/E59 carry 29/21/18 entries, the
 * old derived-tag mechanism's leftovers (predating ticket 07's "tags are
 * hand-curated identity, not derived"), and are reported, never touched.
 * Extending this list is a reviewed, deliberate act — never automatic.
 */
const LANE_MIGRATION_MEMBERSHIP_ALLOWLIST: ReadonlyArray<{
  segmentId: number;
  curatedTags: readonly string[];
}> = [{ segmentId: 60, curatedTags: ["claude-mnemo"] }];

/** Order-independent set equality, used only for the allowlist's exact-match test above. */
function tagSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((tag, index) => tag === sortedB[index]);
}

export interface LaneMigrationStampedSegment {
  segmentId: number;
  curatedTags: string[];
  /** Turn ids this call actually rewrote, ascending — the audit trail for the stamp. */
  stampedTurnIds: number[];
}

export interface LaneMigrationReportedSegment {
  segmentId: number;
  curatedTags: string[];
  /** How many members are missing at least one curated tag — reported, never touched. */
  taglessMemberCount: number;
}

export interface LaneMigrationMalformedMember {
  turnId: number;
  segmentId: number;
  /** The `tags` column verbatim. Never present for a NULL column — see the reason field. */
  rawTags: string;
  /** `malformed-tags-column` = not even valid JSON; `non-array-tags-column` = valid JSON, but not an array (a bare string, an object, ...). A NULL column is neither — it reads as `[]`, same as `db/segments.ts`'s own `parseMemberFacetArray` convention. */
  reason: "malformed-tags-column" | "non-array-tags-column";
}

export interface LaneMigrationMembershipReceipt {
  stamped: LaneMigrationStampedSegment[];
  reported: LaneMigrationReportedSegment[];
  malformed: LaneMigrationMalformedMember[];
}

interface SegmentCuratedTagsRow {
  id: number;
  tags: string;
}

interface SegmentMemberTagsRow {
  turnId: number;
  tags: string | null;
}

type MemberTagColumnRead =
  | { ok: true; tags: string[] }
  | { ok: false; reason: LaneMigrationMalformedMember["reason"] };

/**
 * `turns.tags` carries no `json_valid` CHECK (db/segments.ts's own
 * `parseMemberFacetArray` notes the same fact), so a malformed value is
 * storable. NULL is a legitimate "no tags stated" — treated as `[]`, never
 * reported — matching the codebase's standing "empty is never a claim"
 * convention; only a NON-NULL value that fails to parse, or parses to
 * something other than an array, is malformed.
 */
function readMemberTagsColumn(raw: string | null): MemberTagColumnRead {
  if (raw === null) {
    return { ok: true, tags: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed-tags-column" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "non-array-tags-column" };
  }
  return {
    ok: true,
    tags: parsed.filter((tag): tag is string => typeof tag === "string"),
  };
}

/**
 * M3 (spec D6, ticket 04): repairs the legal-membership gap ticket 07's
 * `checkSegmentMembershipTagGate` (db/segments.ts) created retroactively — a
 * segment's curated tags gate every NEW membership write, but every member
 * that joined BEFORE that gate existed may still lack them, which is exactly
 * what breaks D2's subset invariant for a tagged edge among that segment's
 * turns. Scans every segment with non-empty curated tags (an EMPTY set gates
 * nothing — the same vacuous-pass rule `checkSegmentMembershipTagGate` itself
 * applies, so a segment with no curated tags is not even a candidate here),
 * finds members missing at least one, and STAMPS — a UNION onto the member's
 * existing tags, never a replacement, so nothing already stored is lost —
 * only when `(segmentId, curatedTags)` exactly matches the allowlist above.
 * Every other segment with tagless members is named in `reported` and left
 * byte-for-byte untouched.
 *
 * `turns.updated_at_epoch` is deliberately left as-is: this is a mechanical
 * repair, not a content edit, and no read surface in this codebase orders
 * turns by it (checked: no `ORDER BY ... updated_at_epoch` reads it off
 * `turns` anywhere in `src/`).
 */
function classifyAndRepairMembership(db: Database): LaneMigrationMembershipReceipt {
  const segments = db
    .query<SegmentCuratedTagsRow, []>(
      `SELECT id, tags FROM segments WHERE json_array_length(tags) > 0 ORDER BY id ASC`,
    )
    .all();

  const stamped: LaneMigrationStampedSegment[] = [];
  const reported: LaneMigrationReportedSegment[] = [];
  const malformed: LaneMigrationMalformedMember[] = [];

  const listMembers = db.query<SegmentMemberTagsRow, [number]>(
    `SELECT t.id AS turnId, t.tags AS tags
     FROM segment_members sm JOIN turns t ON t.id = sm.turn_id
     WHERE sm.segment_id = ?
     ORDER BY t.id ASC`,
  );
  const updateTurnTags = db.query<unknown, [string, number]>(
    `UPDATE turns SET tags = ? WHERE id = ?`,
  );

  for (const segment of segments) {
    const curatedTags = (JSON.parse(segment.tags) as unknown[]).filter(
      (tag): tag is string => typeof tag === "string",
    );
    const allowlisted = LANE_MIGRATION_MEMBERSHIP_ALLOWLIST.find(
      (entry) =>
        entry.segmentId === segment.id && tagSetsEqual(entry.curatedTags, curatedTags),
    );

    const stampedTurnIds: number[] = [];
    let taglessMemberCount = 0;

    for (const member of listMembers.all(segment.id)) {
      const read = readMemberTagsColumn(member.tags);
      if (!read.ok) {
        malformed.push({
          turnId: member.turnId,
          segmentId: segment.id,
          rawTags: member.tags ?? "",
          reason: read.reason,
        });
        continue;
      }
      const memberTags = new Set(read.tags);
      const missing = curatedTags.filter((tag) => !memberTags.has(tag));
      if (missing.length === 0) {
        continue;
      }
      taglessMemberCount += 1;
      if (allowlisted) {
        const nextTags = [...read.tags, ...missing];
        updateTurnTags.run(JSON.stringify(nextTags), member.turnId);
        stampedTurnIds.push(member.turnId);
      }
    }

    if (taglessMemberCount === 0) {
      continue;
    }
    if (allowlisted) {
      stamped.push({ segmentId: segment.id, curatedTags, stampedTurnIds });
    } else {
      reported.push({ segmentId: segment.id, curatedTags, taglessMemberCount });
    }
  }

  return { stamped, reported, malformed };
}

// ---------------------------------------------------------------------------
// M4 — illegal edges, downgraded to untagged
// ---------------------------------------------------------------------------

export const LANE_REGISTRY_M4_DISPOSAL_RECEIPT = "lane-declaration-m4-disposal";

/**
 * WHICH illegality this disposal repaired — the receipt's own answer to "why
 * was this edge's tag taken away", so an auditor never has to re-derive it
 * from M0's buckets:
 *
 *   - `homeless-endpoint` — M0's `notPlaceable`: an endpoint owns no segment,
 *     so no declaration can ever legalize the tag (ticket 04).
 *   - `no-canonical-tag` — M0's FULL rejection: every tag on the column failed
 *     D1 even after best-effort canonicalization (ticket 13).
 *   - `malformed-tags-column` — M0 could not read the column as a JSON array
 *     at all (ticket 13).
 *
 * The last two are the disposable half of `LaneMigrationRejectionReason`;
 * `partial-canonical-loss` deliberately has no cause here, because it is never
 * disposed of.
 */
export type LaneMigrationDisposalCause =
  | "homeless-endpoint"
  | "no-canonical-tag"
  | "malformed-tags-column";

export interface LaneMigrationDowngradedEdge {
  edgeId: number;
  citingTurnId: number;
  citingAddress: string;
  citedTurnId: number;
  citedAddress: string;
  relation: string;
  /** The tags this row carried, as this pass could READ them — `[]` when the column was unreadable. A render for the human scanning the receipt, not the record of what was destroyed; that is `rawTags`. */
  tags: string[];
  /**
   * The `tags` column VERBATIM, before the downgrade cleared it (ticket 13).
   * A downgrade destroys the only surviving copy of the original tag string —
   * `memory_edges.tags` is stripped and `memory_edge_tags` goes with it — so
   * without this the receipt could name a loss it could not describe. It is
   * the ONLY faithful record when `cause` is `malformed-tags-column`, where
   * `tags` above is necessarily `[]`.
   */
  rawTags: string;
  cause: LaneMigrationDisposalCause;
  /**
   * "downgraded" = this row's OWN tags were cleared to untagged in place.
   * "merged" = an untagged row for the same (pair, relation) already
   * existed, so this row was deleted rather than colliding with the
   * `(pair, relation, tags)` UNIQUE key — its fact is absorbed into that
   * pre-existing row, named by `mergedIntoEdgeId`.
   */
  disposition: "downgraded" | "merged";
  mergedIntoEdgeId?: number;
}

export interface LaneMigrationDisposalReceipt {
  downgraded: LaneMigrationDowngradedEdge[];
}

/** What M4 acts on: an edge id plus the shape that condemned it. The row itself is re-read fresh at disposal time, so nothing of M0's snapshot but these two facts is carried across the phase boundary. */
interface LaneMigrationDisposalTarget {
  edgeId: number;
  cause: LaneMigrationDisposalCause;
}

/**
 * M4's input set (ticket 13). `notPlaceable` in full, plus the DISPOSABLE half
 * of `rejected` — everything whose tag no declaration could ever legalize and
 * which therefore reaches no other bucket.
 *
 * The `partial-canonical-loss` skip is the load-bearing line of this ticket. An
 * entry with that reason names an edge that is ALSO in `placeable` or
 * `notPlaceable`, carrying the tags that survived; disposing of it here would
 * strip legitimate tags off an edge that is otherwise fine, and would do it
 * twice over for the `notPlaceable` case. Skipping it is not a loss of
 * coverage: if that same edge is illegal for the OTHER reason, it is already in
 * `notPlaceable` and arrives with `homeless-endpoint` as its cause, which is
 * the truthful one.
 *
 * That skip is also what makes the result DISJOINT by edge id, which M4 relies
 * on: a repeated id would have the second pass find the first pass's own
 * now-untagged row as the "pre-existing untagged row" to merge into, and delete
 * the very row it just repaired.
 */
function collectDisposalTargets(
  classification: LaneMigrationClassification | null,
): LaneMigrationDisposalTarget[] {
  const targets: LaneMigrationDisposalTarget[] = [];
  for (const entry of classification?.notPlaceable ?? []) {
    targets.push({ edgeId: entry.edgeId, cause: "homeless-endpoint" });
  }
  for (const entry of classification?.rejected ?? []) {
    if (entry.reason === "partial-canonical-loss") {
      continue;
    }
    targets.push({ edgeId: entry.edgeId, cause: entry.reason });
  }
  // Ascending by edge id across BOTH sources, so the receipt reads in one order
  // rather than bucket-by-bucket, and so collapsing several rows of the same
  // (pair, relation) is deterministic.
  return targets.sort((a, b) => a.edgeId - b.edgeId);
}

interface DisposalEdgeRow {
  id: number;
  citingId: number;
  citedId: number;
  relation: string;
  tags: string;
}

/** `S<session>/T<prompt>`, matching every other write surface's address form (e.g. `db/segments.ts`'s `SegmentMembershipGateViolation.turnAddress`). Falls back to a bare id if the turn row is somehow gone. */
export function resolveTurnAddress(db: Database, turnId: number): string {
  const row = db
    .query<{ sessionId: number; promptNumber: number }, [number]>(
      `SELECT session_id AS sessionId, prompt_number AS promptNumber FROM turns WHERE id = ?`,
    )
    .get(turnId);
  return row ? `S${row.sessionId}/T${row.promptNumber}` : `turn ${turnId}`;
}

/** The disposal-time read of a `tags` column. Never throws: a column M0 already judged unreadable is still unreadable here, and the verbatim string is what the receipt carries anyway. */
function readEdgeTagsColumn(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === "string")
    : [];
}

/**
 * M4 (spec D6, ticket 04; repaired by [S15069/T1566], peer P1-1; widened by
 * ticket 13). Disposes of every edge whose tag NO declaration could ever
 * legalize, in the one way available — stripping the tag column:
 *
 *   - `notPlaceable`: a homeless endpoint can never gain a segment declaration
 *     through this migration (that is a live `assign` operator act, not a
 *     repair), so every entry is PERMANENTLY illegal under D2 rule 2, not
 *     merely illegal today. Ticket 01's own doc comment on the orchestrator
 *     named this exactly: "a later ticket consumes `notPlaceable` off the M0
 *     receipt."
 *   - the disposable half of `rejected` (ticket 13): a tag that is not
 *     canonical, or a column that is not a readable array, is illegal under D1
 *     FOREVER — `declare` refuses a non-canonical tag by construction, so the
 *     lane such an edge derives in the checker can never be declared, never be
 *     used, and never be `undeclare`d either (it was never declared). It used
 *     to be the one M0 bucket nothing consumed, leaving exactly the debt D6
 *     promises the receipt never hides.
 *
 * `partial-canonical-loss` is NOT here; see `collectDisposalTargets`.
 *
 * Writes `tags` and does NOT dual-write lane-model-v12's `tail_tag`/
 * `head_tag` (ticket 05), deliberately and safely: this phase is only ever
 * reached from `runLaneRegistryMigration`, which refuses to run a pending
 * phase against a table that has already taken the two-sided shape
 * (`assertPreLaneModelV12EdgeShape`). Those columns therefore do not exist
 * when this code runs, and adding them here would break the very ordering
 * that guarantees it.
 *
 * EVERY relation downgrades to untagged — there is no relation class that
 * deletes anymore. The original M4 deleted `extends`/`narrows` because an
 * UNTAGGED continuation edge was itself illegal under the tag mandate; the
 * user has since withdrawn that mandate, so all eight relation words have a
 * legal untagged form and stripping the tag is a repair for every one of
 * them, not seven of eight.
 *
 * Acts on the CURRENT row (looked up fresh by `edgeId`), not the M0 snapshot's
 * own relation/tags — defensive against a row that no longer matches between
 * phases; a row that is simply gone is silently skipped, since there is
 * nothing left to repair.
 *
 * `memory_edge_tags` maintenance is TARGETED, not a full rebuild (there is no
 * `rebuildMemoryEdgeTagsIndex` call here on purpose: that helper opens its OWN
 * `runWriteTransaction`, and nesting one inside another does not compose under
 * bun:sqlite's `.immediate()` — see `note-settlement-completion.ts`'s
 * `completeNoteSettlementJobIfSegmentedCore` for the same constraint). A
 * DELETE now happens only for a merge collision (an untagged row for the same
 * (pair, relation) already existed), and that already cascades via
 * `memory_edge_tags.edge_row_id REFERENCES memory_edges(id) ON DELETE CASCADE`
 * (schema.ts); only the in-place downgrade needs its own tag-index row
 * cleared explicitly, since that edge survives with a different tag set.
 */
function disposeIllegalEdges(
  db: Database,
  targets: readonly LaneMigrationDisposalTarget[],
): LaneMigrationDisposalReceipt {
  const downgraded: LaneMigrationDowngradedEdge[] = [];

  const readEdge = db.query<DisposalEdgeRow, [number]>(
    `SELECT id, citing_id AS citingId, cited_id AS citedId, relation, tags
     FROM memory_edges WHERE id = ?`,
  );
  const deleteEdge = db.query<unknown, [number]>(`DELETE FROM memory_edges WHERE id = ?`);
  const findUntaggedRow = db.query<{ id: number }, [number, number, string]>(
    `SELECT id FROM memory_edges
     WHERE citing_kind = 'turn' AND citing_id = ?
       AND cited_kind = 'turn' AND cited_id = ?
       AND relation = ? AND tags = '[]'`,
  );
  const downgradeEdgeTags = db.query<unknown, [number]>(
    `UPDATE memory_edges SET tags = '[]' WHERE id = ?`,
  );
  const clearTagIndexForEdge = db.query<unknown, [number]>(
    `DELETE FROM memory_edge_tags WHERE edge_row_id = ?`,
  );

  for (const target of targets) {
    const row = readEdge.get(target.edgeId);
    if (!row) {
      continue;
    }
    const citingAddress = resolveTurnAddress(db, row.citingId);
    const citedAddress = resolveTurnAddress(db, row.citedId);
    // Read, never assumed parseable: a `malformed-tags-column` target is
    // precisely a row `JSON.parse` throws on, and throwing here would abort the
    // phase's transaction instead of repairing the row it was called for.
    const tags = readEdgeTagsColumn(row.tags);

    const existingUntagged = findUntaggedRow.get(row.citingId, row.citedId, row.relation);
    if (existingUntagged) {
      deleteEdge.run(row.id);
      downgraded.push({
        edgeId: row.id,
        citingTurnId: row.citingId,
        citingAddress,
        citedTurnId: row.citedId,
        citedAddress,
        relation: row.relation,
        tags,
        rawTags: row.tags,
        cause: target.cause,
        disposition: "merged",
        mergedIntoEdgeId: existingUntagged.id,
      });
    } else {
      downgradeEdgeTags.run(row.id);
      clearTagIndexForEdge.run(row.id);
      downgraded.push({
        edgeId: row.id,
        citingTurnId: row.citingId,
        citingAddress,
        citedTurnId: row.citedId,
        citedAddress,
        relation: row.relation,
        tags,
        rawTags: row.tags,
        cause: target.cause,
        disposition: "downgraded",
      });
    }
  }

  return { downgraded };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * The four phase receipts in run order. "Settled" means all four are present:
 * no phase of this migration can ever need to run against this database
 * again, which is the precondition every LATER migration era has to be able
 * to test for (see `assertLaneRegistrySettled`).
 */
export const LANE_REGISTRY_PHASE_RECEIPTS = [
  LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
  LANE_REGISTRY_M2_SEED_RECEIPT,
  LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT,
  LANE_REGISTRY_M4_DISPOSAL_RECEIPT,
] as const;

/**
 * A DELIBERATE skip, written when the migration had nothing to read at all —
 * a database born after lane-declaration shipped, the overwhelmingly common
 * case being a fresh install.
 *
 * Why a row and not simply the absence of one: the phase receipts alone
 * cannot tell a later reader "this database never carried pre-lane-declaration
 * data" apart from "somebody deleted the receipts" or "this code has not run
 * yet". Absence is not a statement of absence — the same rule the segmentation
 * exclusions table exists for (schema.ts). Auditing a support case, or a
 * later migration era deciding whether an anomaly predates it, both need the
 * positive fact.
 *
 * NOT in the `lane-declaration-*` family on purpose: that prefix names PHASE
 * receipts and is counted as such (`... WHERE name LIKE 'lane-declaration-%'`).
 * This row is a disposition of the whole migration, not a fifth phase.
 */
export const LANE_REGISTRY_NOT_APPLICABLE_RECEIPT = "lane-registry-not-applicable";

export interface LaneRegistryNotApplicableReceipt {
  reason: "nothing-to-migrate";
}

const EMPTY_CLASSIFICATION: LaneMigrationClassification = {
  placeable: [],
  notPlaceable: [],
  rejected: [],
};
const EMPTY_SEED_RECEIPT: LaneMigrationSeedReceipt = {
  perSegment: [],
  totalSeeded: 0,
  skippedNamespaceCollisions: [],
};
const EMPTY_MEMBERSHIP_RECEIPT: LaneMigrationMembershipReceipt = {
  stamped: [],
  reported: [],
  malformed: [],
};
const EMPTY_DISPOSAL_RECEIPT: LaneMigrationDisposalReceipt = { downgraded: [] };

/**
 * What each phase leaves behind when it runs and finds nothing. The
 * not-applicable path writes THESE rather than executing the phases, so the
 * skip is byte-identical to the run it replaces; the phases stay gated by
 * their own receipts exactly as before, and no reader anywhere has to learn a
 * second shape. Typed, so a change to any receipt interface breaks the build
 * here; `schema.lane-migration-ordering.test.ts` additionally pins each value
 * against what the real phase bodies produce.
 */
const LANE_REGISTRY_EMPTY_PHASE_PAYLOADS: ReadonlyArray<readonly [string, unknown]> = [
  [LANE_REGISTRY_M0_CLASSIFY_RECEIPT, EMPTY_CLASSIFICATION],
  [LANE_REGISTRY_M2_SEED_RECEIPT, EMPTY_SEED_RECEIPT],
  [LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT, EMPTY_MEMBERSHIP_RECEIPT],
  [LANE_REGISTRY_M4_DISPOSAL_RECEIPT, EMPTY_DISPOSAL_RECEIPT],
];

/** Raised only by a migration ORDER violation — never by data. See `assertPreLaneModelV12EdgeShape`. */
export class LaneMigrationOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneMigrationOrderError";
  }
}

function hasTable(db: Database, table: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== null
  );
}

function hasAnyRow(db: Database, table: string): boolean {
  if (!hasTable(db, table)) {
    return false;
  }
  return db.query<{ x: number }, []>(`SELECT 1 AS x FROM ${table} LIMIT 1`).get() !== null;
}

/**
 * Everything the four phases can read, and nothing else: M0 reads
 * `memory_edges`; M2 reads M0's receipt; M3 reads `segments` JOINed through
 * `segment_members` to `turns`; M4 reads M0's receipt plus `memory_edges`. A
 * segment with no members contributes nothing to M3 (`taglessMemberCount ===
 * 0` short-circuits), and a member row whose turn does not exist drops out of
 * M3's JOIN — so `turns` empty means M3 is empty, and `segments` needs no
 * probe of its own.
 */
function laneRegistryHasInputs(db: Database): boolean {
  return hasAnyRow(db, "memory_edges") || hasAnyRow(db, "turns");
}

/** All four phase receipts present — no phase can ever need to run here again. */
export function isLaneRegistrySettled(db: Database): boolean {
  return LANE_REGISTRY_PHASE_RECEIPTS.every((name) => hasMigrationReceipt(db, name));
}

/**
 * THE ORDERING BARRIER (lane-model-v12 ticket 01, spec D4).
 *
 * M0 and M4 read and write `memory_edges.tags`. v12 replaces that column with
 * `tail_tag`/`head_tag` (v12 tickets 05 expand / 09 contract). Land either
 * half before this migration has settled and the whole unreleased
 * lane-declaration batch is voided at the first open of a released build: M0
 * would see no column to classify (or, worse, classify the old column while
 * M4 writes `tags = '[]'` into a column no reader consults anymore, silently
 * diverging from the new ones).
 *
 * So this is checked where the DAMAGE is, not where the code happens to sit:
 * any implementation of the column change, wherever a future ticket puts it,
 * has to leave one of these two marks on `memory_edges`, and a run with work
 * still to do refuses loudly instead of proceeding into a silent void. A
 * comment saying "keep this order" cannot be tested; this can.
 *
 * Only reached when at least one phase is still pending — a database that
 * settled BEFORE v12 ran is the normal post-v12 shape and returns at the
 * `isLaneRegistrySettled` gate above, long before here.
 */
function assertPreLaneModelV12EdgeShape(db: Database): void {
  if (!hasTable(db, "memory_edges")) {
    return;
  }
  const columns = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
      .all()
      .map((row) => row.name),
  );
  const v12Columns = ["tail_tag", "head_tag"].filter((column) => columns.has(column));
  if (columns.has("tags") && v12Columns.length === 0) {
    return;
  }
  throw new LaneMigrationOrderError(
    "lane registry migration (lane-declaration D6/M0-M4) still has pending phases, but " +
      `memory_edges has already taken a lane-model-v12 shape (${
        columns.has("tags") ? "" : "no `tags` column; "
      }${
        v12Columns.length > 0 ? `carries ${v12Columns.join("/")}` : "nothing v12-era found"
      }). The v12 edge-column work must run AFTER runLaneRegistryMigration, in ` +
      "initializeSchema's runLaneModelV12EdgeMigration slot — see lane-model-v12 spec D4.",
  );
}

/**
 * The gate a LATER migration era calls before touching the edge columns:
 * throws unless every phase of the lane registry migration has settled. This
 * is the other half of `assertPreLaneModelV12EdgeShape` — that one catches
 * the column change arriving too early by its effect on the table, this one
 * catches the v12 phase slot itself being invoked too early, before the
 * column change is even written.
 */
export function assertLaneRegistrySettled(db: Database, phase: string): void {
  if (isLaneRegistrySettled(db)) {
    return;
  }
  const missing = LANE_REGISTRY_PHASE_RECEIPTS.filter(
    (name) => !hasMigrationReceipt(db, name),
  );
  throw new LaneMigrationOrderError(
    `${phase} ran before the lane registry migration settled (missing receipts: ` +
      `${missing.join(", ")}). Those phases read memory_edges.tags; run ` +
      "runLaneRegistryMigration first — see lane-model-v12 spec D4.",
  );
}

/**
 * ONE transaction for all five rows: a crash midway leaves none of them, and
 * the next open finds the same still-empty database and takes this path
 * again. Deliberately NOT gated on a "the file was brand new" flag computed
 * once at open time — that fact does not survive the crash it would have to
 * survive, whereas "the tables this migration reads are empty" is re-derivable
 * forever and is the truthful statement of not-applicable anyway.
 */
function markLaneRegistryNotApplicable(db: Database, nowEpoch: number): void {
  runWriteTransaction(db, () => {
    for (const [name, payload] of LANE_REGISTRY_EMPTY_PHASE_PAYLOADS) {
      writeMigrationReceipt(db, name, nowEpoch, payload);
    }
    const receipt: LaneRegistryNotApplicableReceipt = { reason: "nothing-to-migrate" };
    writeMigrationReceipt(db, LANE_REGISTRY_NOT_APPLICABLE_RECEIPT, nowEpoch, receipt);
  });
}

/**
 * D6/M0-M4: ordered, durable, per-phase receipts — a phase is skipped only
 * when ITS OWN receipt row exists, never inferred from `lanes` having rows
 * (the first process to open an upgraded database is often a hook, and a
 * crash between phases must not silently skip the rest forever). `lanes`
 * and `migration_receipts` themselves are unconditional
 * `CREATE TABLE IF NOT EXISTS` DDL in SCHEMA_SQL (schema.ts) — already
 * idempotent, so table creation needs no receipt of its own.
 *
 * Every phase runs in its OWN transaction (not one big one): a crash between
 * phases leaves the earlier ones' receipts durable and the rest still pending
 * on the NEXT process to open this database — never re-running a finished
 * phase, never silently skipping a pending one. M2 and M4 both read M0's
 * receipt back rather than re-classifying, which is exactly why M0 must be
 * fully committed first.
 *
 * M3 (ticket 04) reads no earlier receipt — it re-derives directly from
 * `segments`/`segment_members`/`turns`, independent of M0's edge-only
 * classification. M4 consumes M0's `notPlaceable` bucket (ticket 04, per
 * ticket 01's own note above this function's earlier revision) TOGETHER WITH
 * the disposable half of its `rejected` bucket (ticket 13) — see
 * `collectDisposalTargets` for which half and why. Ordered M3
 * before M4 to match D6's own enumeration; the two touch disjoint columns
 * (`turns.tags` vs `memory_edges`) so their relative order carries no
 * functional weight of its own.
 *
 * Three gates precede the phases (lane-model-v12 ticket 01), in this order and
 * for these reasons:
 *
 *   1. SETTLED — all four receipts present, nothing can run: return before
 *      gate 3, because a post-v12 database legitimately no longer has the
 *      column gate 3 insists on.
 *   2. NOTHING TO READ — the tables the phases read are empty, so the phases
 *      would be no-ops: record that as an explicit disposition
 *      (`LANE_REGISTRY_NOT_APPLICABLE_RECEIPT`) instead of running them, and
 *      write the receipts they would have written.
 *   3. ORDER — work IS pending, so `memory_edges` must still be pre-v12
 *      shaped. See `assertPreLaneModelV12EdgeShape`.
 */
export function runLaneRegistryMigration(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  if (isLaneRegistrySettled(db)) {
    return;
  }
  if (!laneRegistryHasInputs(db)) {
    markLaneRegistryNotApplicable(db, nowEpoch);
    return;
  }
  assertPreLaneModelV12EdgeShape(db);

  runWriteTransaction(db, () => {
    if (hasMigrationReceipt(db, LANE_REGISTRY_M0_CLASSIFY_RECEIPT)) {
      return;
    }
    const classification = classifyTaggedEdges(db);
    writeMigrationReceipt(db, LANE_REGISTRY_M0_CLASSIFY_RECEIPT, nowEpoch, classification);
  });

  runWriteTransaction(db, () => {
    if (hasMigrationReceipt(db, LANE_REGISTRY_M2_SEED_RECEIPT)) {
      return;
    }
    const classification = readMigrationReceiptPayload<LaneMigrationClassification>(
      db,
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    const seedReceipt = seedLanesFromClassification(
      db,
      classification?.placeable ?? [],
      nowEpoch,
    );
    writeMigrationReceipt(db, LANE_REGISTRY_M2_SEED_RECEIPT, nowEpoch, seedReceipt);
  });

  runWriteTransaction(db, () => {
    if (hasMigrationReceipt(db, LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT)) {
      return;
    }
    const membershipReceipt = classifyAndRepairMembership(db);
    writeMigrationReceipt(db, LANE_REGISTRY_M3_MEMBERSHIP_RECEIPT, nowEpoch, membershipReceipt);
  });

  runWriteTransaction(db, () => {
    if (hasMigrationReceipt(db, LANE_REGISTRY_M4_DISPOSAL_RECEIPT)) {
      return;
    }
    const classification = readMigrationReceiptPayload<LaneMigrationClassification>(
      db,
      LANE_REGISTRY_M0_CLASSIFY_RECEIPT,
    );
    const disposalReceipt = disposeIllegalEdges(db, collectDisposalTargets(classification));
    writeMigrationReceipt(db, LANE_REGISTRY_M4_DISPOSAL_RECEIPT, nowEpoch, disposalReceipt);
  });
}

// ---------------------------------------------------------------------------
// lane-model-v12 M-C — retract every self edge (ticket 04)
// ---------------------------------------------------------------------------

export const LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT =
  "lane-model-v12-mc-self-edge-retraction";

/** One retracted self edge, addressed the way a reader can act on (`resolveTurnAddress`) rather than by raw row id alone. */
export interface LaneModelV12RetractedSelfEdge {
  edgeId: number;
  nodeKind: string;
  nodeId: number;
  /** `S<session>/T<prompt>` for a turn end; the bare `<kind>#<id>` for anything else. */
  address: string;
  relation: string | null;
  provenance: string;
}

export interface LaneModelV12SelfEdgeRetractionReceipt {
  retracted: readonly LaneModelV12RetractedSelfEdge[];
}

interface SelfEdgeRow {
  id: number;
  citingKind: string;
  citingId: number;
  relation: string | null;
  provenance: string;
}

/**
 * Does the stored table itself refuse every self row? True for exactly two
 * shapes, and correctly for both: the PRE-ticket-05 CHECK
 * (`citing_kind <> cited_kind OR citing_id <> cited_id`, a blanket ban) and
 * lane-model-v12's CONTRACTED one, which is that same text again after D2
 * retracted ticket 05's widening. The three-arm text in between
 * (`... OR relation IS NOT NULL`) admits a relation-carrying self row, and
 * that is the one case M-C still has work to do in.
 *
 * Reads the CHECK rather than the column list on purpose. "No `tags` column"
 * would be a proxy for "M-E has run", and a hand-built table can have the
 * columns of one shape and the constraints of another — this asks the
 * question whose answer actually decides whether a self row can appear.
 */
function memoryEdgesCheckBansEverySelfEdge(db: Database): boolean {
  const storedDdl =
    db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_edges'",
      )
      .get()?.sql ?? null;
  if (storedDdl === null) {
    return false;
  }
  return (
    storedDdl.includes("citing_kind <> cited_kind") &&
    !storedDdl.includes("relation IS NOT NULL")
  );
}

/**
 * M-C (lane-model-v12 spec D4, ticket 04): an edge's two ends must be
 * DIFFERENT nodes, so every stored row whose two ends are the SAME node is
 * retracted once, at upgrade.
 *
 * Live measurement at write time: exactly ONE such row exists in the whole
 * database (`S15069/T1265 grounds T1265`, untagged, `asserted`) — an artifact
 * of the retired cross-phase self-`grounds` permission, whose conditional
 * apparatus this ticket deletes in the same batch. The phase is written to
 * handle N anyway, and to record every row it removes, because a receipt that
 * only proves "one row, as expected" cannot be read on a database that had
 * two.
 *
 * DELETE, not downgrade: unlike M4's illegal-tag disposal there is no legal
 * weaker form of this row to fall back to — the ROW ITSELF is what the rule
 * forbids. Both tag indexes' rows go with it (each cascades on
 * `memory_edges(id)`, but the deletes are issued explicitly so the phase does
 * not depend on `PRAGMA foreign_keys` being on).
 *
 * READS NO LANE COLUMN, deliberately — not `tags`, not `tail_tag`/`head_tag`.
 * This phase shares `runLaneModelV12EdgeMigration` with the expand/contract
 * work of v12 tickets 05/09, so whichever side of that contraction it happens
 * to run on, its query must still resolve. The receipt therefore records the
 * endpoint, the relation and the provenance, and no tag payload.
 *
 * The two index deletes are prepared only when their TABLE exists, for the
 * same reason (ticket 09): a pre-v12 database has no `memory_edge_side_tags`
 * rows to clear, and a CONTRACTED one has no `memory_edge_tags` table at all
 * — M-E drops it with the column. Naming either unconditionally would make
 * "still resolves on either side of the contraction" false in one direction
 * or the other, which is what it used to be.
 *
 * WHAT THE RECEIPT IS AND IS NOT. It is the AUDIT record of the one migration
 * event, never the authority for "no self row can exist" — those are different
 * statements, and the peer review of this batch caught the gap between them.
 * A receipt-only gate leaves a self row RESTORED after the sweep (an operator
 * dropping in an old `memory_edges`, a fixture hand-building a pre-migration
 * table) unswept on every later open, forever.
 *
 * The standing guarantee therefore lives in the SCHEMA, not here: from M-E's
 * contracted shape onward the table's own CHECK bans every self row
 * (`memoryEdgesTableDdl`, db/schema.ts) and `writeMemoryEdges` refuses one in
 * step. This phase's remaining job is to clear the LEGACY rows early enough
 * that the contraction can copy the table at all. So the skip is gated on the
 * TABLE'S OWN CHECK rather than on the receipt: once the stored DDL bans self
 * rows the scan is provably empty and is not issued, which is the steady state
 * of every migrated database; while the table can still admit one, the scan
 * runs whether or not the receipt exists. The receipt is written
 * insert-if-absent, so a later standing repair never overwrites the original
 * findings.
 */
export function runLaneModelV12SelfEdgeRetraction(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  runWriteTransaction(db, () => {
    if (
      hasMigrationReceipt(db, LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT) &&
      memoryEdgesCheckBansEverySelfEdge(db)
    ) {
      return;
    }
    const rows = db
      .query<SelfEdgeRow, []>(
        `SELECT id, citing_kind AS citingKind, citing_id AS citingId,
                relation, provenance
         FROM memory_edges
         WHERE citing_kind = cited_kind AND citing_id = cited_id
         ORDER BY id`,
      )
      .all();

    const clearTagIndex = hasTable(db, "memory_edge_tags")
      ? db.query<unknown, [number]>("DELETE FROM memory_edge_tags WHERE edge_row_id = ?")
      : null;
    const clearSideTagIndex = hasTable(db, "memory_edge_side_tags")
      ? db.query<unknown, [number]>(
          "DELETE FROM memory_edge_side_tags WHERE edge_row_id = ?",
        )
      : null;
    const deleteEdge = db.query<unknown, [number]>("DELETE FROM memory_edges WHERE id = ?");

    const retracted: LaneModelV12RetractedSelfEdge[] = [];
    for (const row of rows) {
      clearTagIndex?.run(row.id);
      clearSideTagIndex?.run(row.id);
      deleteEdge.run(row.id);
      retracted.push({
        edgeId: row.id,
        nodeKind: row.citingKind,
        nodeId: row.citingId,
        address:
          row.citingKind === "turn"
            ? resolveTurnAddress(db, row.citingId)
            : `${row.citingKind}#${row.citingId}`,
        relation: row.relation,
        provenance: row.provenance,
      });
    }

    const receipt: LaneModelV12SelfEdgeRetractionReceipt = { retracted };
    writeMigrationReceipt(
      db,
      LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT,
      nowEpoch,
      receipt,
    );
  });
}

// ---------------------------------------------------------------------------
// lane-model-v12 M-B — the two retired words merge into `override` (ticket 03)
// ---------------------------------------------------------------------------

export const LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT =
  "lane-model-v12-mb-vocabulary-merge";

/** The word this migration targets — v12's seven-word vocabulary keeps it, and both retired words mean a case of it. */
const LANE_MODEL_V12_MERGE_TARGET = "override";

/**
 * The pre-v12 words no live vocabulary holds any more, and what each becomes.
 * Both land on `override`; they differ only in what happens to the row's tag
 * payload.
 *
 *  - `refutes` KEEPS its tags. v11 admitted it as a tag-carrying lane word, so
 *    a tagged row's lane attribution is a fact the merge must not discard —
 *    and the word's meaning ("this turn's main result is repudiated") is
 *    exactly the case `override` now covers, at the same scope.
 *  - `supersedes` LOSES them. The spec says so in as many words ("机械迁移为
 *    无 tag 的 override"): the word predates lanes entirely and never named a
 *    lane-local correction, so carrying a tag across would be inventing an
 *    attribution nobody asserted. Zero measured rows carry a tag, so on the
 *    live snapshot this clause moves nothing; it is written anyway because a
 *    migration contract may not rest on a snapshot — the same reasoning the
 *    spec applies to M-A's "lossless" claim.
 */
const LANE_MODEL_V12_RETIRED_RELATIONS: Readonly<
  Record<string, { readonly clearTags: boolean }>
> = {
  refutes: { clearTags: false },
  supersedes: { clearTags: true },
};

/** The words M-B reads: the two it rewrites, plus the target they collide against. */
export const LANE_MODEL_V12_MERGED_RELATION_WORDS: readonly string[] = [
  ...Object.keys(LANE_MODEL_V12_RETIRED_RELATIONS),
];

/** One row rewritten in place. Rows DELETED as a duplicate are in `merged` instead, never here. */
export interface LaneModelV12RewrittenEdge {
  edgeId: number;
  from: string;
  to: string;
  /** True when the row additionally lost its tag payload — `supersedes` becomes an UNTAGGED `override`. */
  tagsCleared: boolean;
}

/**
 * One identity-key collision, recorded from BOTH sides (the ticket's own
 * requirement: "收据记下双方的行 id 与 provenance"). A reader auditing a
 * missing edge months from now has to be able to answer "which row went, and
 * what did the row that stayed look like" without the deleted row to read.
 */
export interface LaneModelV12MergedEdge {
  citingAddress: string;
  citedAddress: string;
  /**
   * The surviving row's post-migration MERGED tag payload. On a pre-v12 table
   * this is the last field of the identity key the two rows collided on; on an
   * expanded restore the key continues into `tail_tag`/`head_tag`, so there it
   * is an audit field only and not the whole of what they tied on.
   */
  tags: string;
  keptEdgeId: number;
  /** The kept row's PRE-migration word: `override` when the collision victim was the migrated one. */
  keptRelation: string;
  keptProvenance: string;
  keptCreatedAtEpoch: number;
  droppedEdgeId: number;
  droppedRelation: string;
  droppedProvenance: string;
  droppedCreatedAtEpoch: number;
  rule: LaneModelV12MergeRule;
}

/**
 * Which clause of the merge rule chose the survivor:
 * `provenance` — one row outranked the other (`asserted` over `judged`);
 * `earlier` — equal rank, so the earlier row won (`created_at`, then row id).
 */
export type LaneModelV12MergeRule = "provenance" | "earlier";

export interface LaneModelV12VocabularyMergeReceipt {
  rewritten: readonly LaneModelV12RewrittenEdge[];
  merged: readonly LaneModelV12MergedEdge[];
}

interface VocabularyMergeRow {
  id: number;
  citingKind: string;
  citingId: number;
  citedKind: string;
  citedId: number;
  relation: string;
  provenance: string;
  tags: string;
  createdAtEpoch: number;
  /** Present only on an EXPANDED restore — a pre-v12 table has no such column, and the SELECT omits it there. */
  tailTag?: string;
  headTag?: string;
}

/** `S<session>/T<prompt>` for a turn end, the bare `<kind>#<id>` for anything else — same form M-C's receipt uses. */
export function resolveEdgeNodeAddress(db: Database, kind: string, id: number): string {
  return kind === "turn" ? resolveTurnAddress(db, id) : `${kind}#${id}`;
}

/** Unknown provenance sorts BELOW every known one rather than throwing: a hand-built fixture table carries no CHECK. */
export function rankLaneModelV12MergeProvenance(provenance: string): number {
  return isEdgeProvenance(provenance) ? rankEdgeProvenance(provenance) : -1;
}

/** The three fields THE MERGE RULE reads. Anything with an id, a provenance and an age can be merged by it. */
export interface LaneModelV12MergeCandidate {
  id: number;
  provenance: string;
  createdAtEpoch: number;
}

/**
 * THE MERGE RULE (spec D4), applied to one identity-key group: survivor
 * first, casualties after, in the order they are to be dropped.
 *
 * Keep the `asserted` row — its row id, its `created_at`, its provenance —
 * and drop the `judged` duplicate. Generalised through the project's own
 * `rankEdgeProvenance` rather than a fresh two-value comparison, so the rule
 * has an answer for the three provenances the measured collision happens not
 * to contain; `asserted` is that ranking's top already, which is what makes
 * the generalisation faithful to the stated rule rather than a substitute for
 * it. Equal rank falls back to the EARLIER row (`created_at`, then row id as
 * the total-order backstop) — the spec's "两行同为 asserted 时保留较早那行".
 *
 * The kept row is not rewritten beyond its own word: an audit trail whose
 * timestamps and provenance were pooled across the group would no longer
 * describe any assertion anybody actually made.
 *
 * ONE function for BOTH collisions the v12 migration can produce — ticket
 * 03's `refutes`→`override` rename (M-B, below) and ticket 05's multi-tag
 * split (M-A, db/schema.ts). The spec says the second "走与票 03 相同的合并
 * 规则"; two copies of a comparator is how that sentence stops being true
 * six months from now.
 */
export function sortLaneModelV12MergeGroup<T extends LaneModelV12MergeCandidate>(
  group: readonly T[],
): T[] {
  return [...group].sort((left, right) => {
    const rankDiff =
      rankLaneModelV12MergeProvenance(right.provenance) -
      rankLaneModelV12MergeProvenance(left.provenance);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    const ageDiff = left.createdAtEpoch - right.createdAtEpoch;
    return ageDiff !== 0 ? ageDiff : left.id - right.id;
  });
}

/** Which clause of the rule above decided one particular casualty — for the receipt, never for the decision itself. */
export function laneModelV12MergeRule(
  kept: LaneModelV12MergeCandidate,
  dropped: LaneModelV12MergeCandidate,
): LaneModelV12MergeRule {
  return rankLaneModelV12MergeProvenance(dropped.provenance) ===
    rankLaneModelV12MergeProvenance(kept.provenance)
    ? "earlier"
    : "provenance";
}

/**
 * M-B runs BEFORE the `tags` -> `tail_tag`/`head_tag` column change (v12
 * tickets 05/09), because the identity key it merges on ENDS in the tag
 * payload and it reads that payload from `tags`. Unlike M-C — which reads no
 * lane column at all and is therefore order-free — this phase has a side, and
 * a comment claiming so cannot be tested. Checked where the damage would be,
 * the same shape `assertPreLaneModelV12EdgeShape` uses one migration era
 * earlier: a PENDING M-B on a table that already took the two-column shape
 * refuses loudly instead of merging against a key it can no longer compute.
 *
 * Only reachable while the phase is PENDING. Once its receipt exists the
 * caller returns before this, which is the normal state on the far side of
 * the column change.
 */
function memoryEdgesColumns(db: Database): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('memory_edges')")
      .all()
      .map((row) => row.name),
  );
}

function memoryEdgesStillCarriesTags(db: Database): boolean {
  return memoryEdgesColumns(db).has("tags");
}

/**
 * Ticket 05's EXPAND half keeps `tags` while ADDING the two side columns, so
 * the probe above cannot see that shape at all — `tags` is right there.
 *
 * It is deliberately NOT a second refusal. The inversion this phase must fear
 * (the column change landing first) is already refused from the OTHER side:
 * M-A rebuilds into the seven-word CHECK and stops with a named error if a
 * retired word is still stored, so "expanded table, pending M-B, retired rows"
 * cannot come out of a reordered phase slot. What it CAN come out of is the
 * restore this phase's predicate gate exists for — an old `memory_edges`
 * dropped into a migrated database — and there the right answer is to repair
 * the row, not to fail the whole open. So M-B stays runnable on either shape
 * and this probe only decides how much of the row it has to rewrite.
 */
function memoryEdgesHasSideTagColumns(db: Database): boolean {
  const columns = memoryEdgesColumns(db);
  return columns.has("tail_tag") && columns.has("head_tag");
}

function vocabularyMergeOrderError(db: Database): LaneMigrationOrderError {
  const columns = memoryEdgesColumns(db);
  return new LaneMigrationOrderError(
    "the lane-model-v12 vocabulary merge (M-B) is still pending, but memory_edges no " +
      `longer carries a \`tags\` column (${
        ["tail_tag", "head_tag"].some((column) => columns.has(column))
          ? "it has already taken the two-sided v12 shape"
          : "nothing tag-shaped found"
      }). M-B merges on an identity key ending in the tag payload, so it must run ` +
      "BEFORE the column change — order the phases inside runLaneModelV12EdgeMigration " +
      "accordingly; see lane-model-v12 spec D4.",
  );
}

/**
 * M-B (lane-model-v12 spec D4, ticket 03): `refutes` and `supersedes` — the
 * two words v12's seven-word vocabulary does not contain — become `override`
 * on every stored row, and the duplicates that rename creates are merged.
 *
 * THE MERGE IS NOT HYPOTHETICAL. Measured on the live database:
 * `S15069/T1072 -> T1068` carries BOTH an `asserted` `refutes` (edge 2643)
 * and a `judged` `override` (edge 3010), both untagged — two independent rows
 * today, one identity key the moment the word is rewritten. An earlier
 * revision of the spec called the whole migration collision-free because it
 * had only checked `supersedes`; the receipt therefore records both sides of
 * every collision, not a count.
 *
 * ORDER INSIDE THE PHASE, and why it cannot be reversed: every dropped row is
 * deleted BEFORE any survivor is rewritten. A survivor's NEW key is by
 * construction its own group's key, and every other member of that group is
 * already gone — so no `UPDATE` can transiently collide with a row this pass
 * has not reached yet, and the table's UNIQUE constraint never has to be
 * suspended.
 *
 * Runs AFTER M-C in the slot: a self edge under a retired word would
 * otherwise be merged, recorded, and then deleted by M-C anyway, leaving a
 * receipt that names a row no longer in the table.
 *
 * GATED ON THE PREDICATE, NOT ON THE RECEIPT, and the difference is load
 * bearing. A receipt-only gate makes "this ran once" mean "no such row can
 * exist", and those are different statements: an operator restoring an old
 * `memory_edges` into a migrated database, or any fixture that hand-builds a
 * pre-migration table under a database whose receipt is already written,
 * produces a retired-word row this phase would then skip — and the M-D CHECK
 * narrow immediately downstream would refuse to rebuild around it, failing
 * the whole open. So the work runs whenever a retired word is present, and
 * the receipt is the AUDIT record of the one migration event rather than its
 * authority. A second run with nothing to do writes nothing and returns.
 *
 * The receipt is written inside the SAME transaction as the data, so a crash
 * between the two is not a state this migration can be in. It records the
 * FIRST run only (`writeMigrationReceipt` is insert-if-absent): a later
 * standing repair is a repair, not a second migration, and overwriting the
 * original findings to say so would destroy the audit trail the receipt
 * exists for.
 */
export function runLaneModelV12VocabularyMerge(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  runWriteTransaction(db, () => {
    const settled = hasMigrationReceipt(db, LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT);
    if (!memoryEdgesStillCarriesTags(db)) {
      // Settled + no `tags` column is the ordinary post-column-change shape
      // (v12 tickets 05/09); PENDING + no `tags` column is the order violation.
      if (settled) {
        return;
      }
      throw vocabularyMergeOrderError(db);
    }

    // The target word is read too, not just the two retired ones: the measured
    // collision is a retired row landing on a row that ALREADY says `override`,
    // so a query restricted to the retired words would see one row where the
    // identity key holds two.
    // The EXPANDED-restore case this phase claims to support (see the gate
    // above): an old `memory_edges` dropped into a database whose table has
    // already taken the two-sided shape. There the two sides are IN the
    // identity key, so the merge cannot be computed without reading them.
    const twoSided = memoryEdgesHasSideTagColumns(db);
    const words = [...LANE_MODEL_V12_MERGED_RELATION_WORDS, LANE_MODEL_V12_MERGE_TARGET];
    const rows = db
      .query<VocabularyMergeRow, string[]>(
        `SELECT id, citing_kind AS citingKind, citing_id AS citingId,
                cited_kind AS citedKind, cited_id AS citedId,
                relation, provenance, tags, created_at_epoch AS createdAtEpoch${
                  twoSided ? ", tail_tag AS tailTag, head_tag AS headTag" : ""
                }
         FROM memory_edges
         WHERE relation IN (${words.map(() => "?").join(", ")})
         ORDER BY id`,
      )
      .all(...words);

    if (settled && !rows.some((row) => LANE_MODEL_V12_RETIRED_RELATIONS[row.relation])) {
      return;
    }

    const groups = new Map<string, VocabularyMergeRow[]>();
    const postMigrationTags = new Map<number, string>();
    for (const row of rows) {
      const retired = LANE_MODEL_V12_RETIRED_RELATIONS[row.relation];
      const tags = retired?.clearTags ? "[]" : row.tags;
      postMigrationTags.set(row.id, tags);
      // THE KEY IS THE TABLE'S OWN IDENTITY KEY, AS THIS PHASE WILL LEAVE IT,
      // and both halves of that sentence are load bearing.
      //
      // AS THIS PHASE WILL LEAVE IT: a `supersedes` row's payload is cleared
      // by the rewrite below, so grouping on what the row says NOW would put
      // it in a bucket it is about to leave. Every component is the PROJECTED
      // value — `('','')` included, which is what `supersedes` lands on.
      //
      // THE TABLE'S OWN: on an EXPANDED restore the UNIQUE ends in
      // `tail_tag, head_tag` too, and there those columns, not `tags`, are
      // where a row's lane identity lives. Keying on the merged set alone —
      // the defect the peer review of this batch caught — makes an
      // `override tail=a/head=b` and a `refutes tail=c/head=d` read as ONE
      // identity, because both say `tags = '[]'`, and deletes a row belonging
      // to a different arc as a "duplicate". Components the stored table does
      // not have are OMITTED rather than defaulted: a pre-v12 table's key
      // really does end at `tags`, and padding it with two constants would
      // only make the key's shape stop describing the table's.
      //
      // The relation is deliberately absent: every row this query returns says
      // `override` AFTER the rewrite, retired or not, so that component is a
      // constant and carrying it would only suggest it varies.
      const key = [
        row.citingKind,
        String(row.citingId),
        row.citedKind,
        String(row.citedId),
        tags,
        ...(twoSided
          ? retired?.clearTags
            ? [UNSETTLED_SIDE_TAG, UNSETTLED_SIDE_TAG]
            : [row.tailTag ?? UNSETTLED_SIDE_TAG, row.headTag ?? UNSETTLED_SIDE_TAG]
          : []),
      ].join("\u0000");
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(row);
      } else {
        groups.set(key, [row]);
      }
    }

    const clearTagIndex = db.query<unknown, [number]>(
      "DELETE FROM memory_edge_tags WHERE edge_row_id = ?",
    );
    const deleteEdge = db.query<unknown, [number]>("DELETE FROM memory_edges WHERE id = ?");
    const rewriteEdge = db.query<unknown, [string, string, number]>(
      "UPDATE memory_edges SET relation = ?, tags = ? WHERE id = ?",
    );
    // A `supersedes` row LOSES its tag payload (see
    // `LANE_MODEL_V12_RETIRED_RELATIONS`). On a table that has already taken
    // ticket 05's two-sided shape — the RESTORE case, never a reordered slot
    // — the side columns hold that same payload, so they lose it in the same
    // transaction or the row ends up saying two different things. Both
    // statements are prepared only when their target exists: this phase must
    // keep running against a pre-v12 table, which has neither.
    const clearSideTags = twoSided
      ? db.query<unknown, [number]>(
          "UPDATE memory_edges SET tail_tag = '', head_tag = '' WHERE id = ?",
        )
      : null;
    const clearSideTagIndex = hasTable(db, "memory_edge_side_tags")
      ? db.query<unknown, [number]>(
          "DELETE FROM memory_edge_side_tags WHERE edge_row_id = ?",
        )
      : null;

    const merged: LaneModelV12MergedEdge[] = [];
    const survivors: VocabularyMergeRow[] = [];

    for (const bucket of groups.values()) {
      if (bucket.length === 1) {
        survivors.push(bucket[0]!);
        continue;
      }
      const ordered = sortLaneModelV12MergeGroup(bucket);
      const kept = ordered[0]!;
      survivors.push(kept);
      for (const dropped of ordered.slice(1)) {
        merged.push({
          citingAddress: resolveEdgeNodeAddress(db, kept.citingKind, kept.citingId),
          citedAddress: resolveEdgeNodeAddress(db, kept.citedKind, kept.citedId),
          tags: postMigrationTags.get(kept.id)!,
          keptEdgeId: kept.id,
          keptRelation: kept.relation,
          keptProvenance: kept.provenance,
          keptCreatedAtEpoch: kept.createdAtEpoch,
          droppedEdgeId: dropped.id,
          droppedRelation: dropped.relation,
          droppedProvenance: dropped.provenance,
          droppedCreatedAtEpoch: dropped.createdAtEpoch,
          rule: laneModelV12MergeRule(kept, dropped),
        });
        clearTagIndex.run(dropped.id);
        // Both index tables, explicitly, for M-C's reason: each cascades on
        // `memory_edges(id)`, but a phase that relied on the cascade would
        // leave orphan lookup rows behind wherever `PRAGMA foreign_keys` is
        // off — which every rebuild in db/schema.ts turns it off for.
        clearSideTagIndex?.run(dropped.id);
        deleteEdge.run(dropped.id);
      }
    }

    const rewritten: LaneModelV12RewrittenEdge[] = [];
    for (const survivor of survivors) {
      const retired = LANE_MODEL_V12_RETIRED_RELATIONS[survivor.relation];
      if (!retired) {
        continue;
      }
      const tags = postMigrationTags.get(survivor.id)!;
      const tagsCleared = tags !== survivor.tags;
      rewriteEdge.run(LANE_MODEL_V12_MERGE_TARGET, tags, survivor.id);
      if (tagsCleared) {
        clearTagIndex.run(survivor.id);
        clearSideTags?.run(survivor.id);
        clearSideTagIndex?.run(survivor.id);
      }
      rewritten.push({
        edgeId: survivor.id,
        from: survivor.relation,
        to: LANE_MODEL_V12_MERGE_TARGET,
        tagsCleared,
      });
    }
    rewritten.sort((left, right) => left.edgeId - right.edgeId);
    merged.sort((left, right) => left.droppedEdgeId - right.droppedEdgeId);

    const receipt: LaneModelV12VocabularyMergeReceipt = { rewritten, merged };
    writeMigrationReceipt(
      db,
      LANE_MODEL_V12_VOCABULARY_MERGE_RECEIPT,
      nowEpoch,
      receipt,
    );
  });
}
