import type { Database } from "bun:sqlite";

import { parseQualifiedReferences } from "./references";
import { getSegment, type SegmentRecord } from "./segments";
import { isSegmentEra } from "../segment-era";
import { typeListsEqual } from "../shared/type-vocabulary";

/**
 * Derived ordering for the segment read surfaces (spec D8).
 *
 * There is no stored score anywhere in here. A position is an ORDER BY over
 * columns that are FACTS about the row — did this turn overturn something, how
 * many distinct pieces of work cite it, did it ship, how many files did it
 * change, when was it written — so any position can be explained by reading the
 * row, and re-reading a turn (which writes a `retrieval` edge) re-ranks it
 * automatically. The milestone experiment is the reason: weighted sums never did
 * any work there, the key ORDER did.
 *
 * The keys, in the spec's order:
 *
 *   ① is a corrector      DESC — hindsight outranks the thing it corrected
 *   ② type is rolled-back ASC  — an overturned conclusion sinks
 *   ③ de-duplicated in-degree DESC — how many DISTINCT nodes consumed this
 *   ④ is a delivered segment's member DESC — work that shipped
 *   ⑤ files_modified count DESC — mechanical weight
 *   ⑥ created_at DESC, id DESC — recency, then a total-order backstop
 *
 * ③ counts a (citing, cited) PAIR once however many provenances or relations
 * carry it (spec D8's de-duplication): provenance is an audit layer, not a
 * multiplier. ⑥'s `id` tiebreak is not in the spec's list — it is what makes the
 * comparator a total order, so two turns written in the same second cannot swap
 * places between two renders of the same data.
 */

/** Raw row shape straight off `RANK_FACT_COLUMNS`: `type` is unparsed JSON-array text (ticket 02, spec B5). */
interface MemberRankFactsRow {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  title: string | null;
  type: string;
  status: string;
  createdAtEpoch: number;
  isCorrector: number;
  isRolledBack: number;
  citedBy: number;
  isDeliveryMember: number;
  filesModifiedCount: number;
}

/** The fact columns the ORDER BY reads, carried out so a caller can print them. */
export interface MemberRankFacts {
  turnId: number;
  sessionId: number;
  promptNumber: number;
  title: string | null;
  /** Multi-valued (ticket 02, spec B5); `[]` when the turn stated no type. */
  type: string[];
  status: string;
  createdAtEpoch: number;
  /** 1 when this turn carries an outgoing `supersedes` edge. */
  isCorrector: number;
  /** 1 when this turn's type is the settlement-only `rolled-back` value. */
  isRolledBack: number;
  /** DISTINCT citing nodes over `memory_edges` — one pair counts once. */
  citedBy: number;
  /** 1 when this turn belongs to at least one `delivered` segment. */
  isDeliveryMember: number;
  filesModifiedCount: number;
}

export interface RankedSegmentMember extends MemberRankFacts {
  /**
   * 1-based position in the segment body's citation order, or null when the
   * body never cites this member. Anchors take their slots before the derived
   * order is consulted at all (spec D8 / D9 user story 17).
   */
  anchorPosition: number | null;
}

const RANK_FACT_COLUMNS = `
  t.id AS turnId,
  t.session_id AS sessionId,
  t.prompt_number AS promptNumber,
  t.title AS title,
  t.type AS type,
  t.status AS status,
  t.created_at_epoch AS createdAtEpoch,
  (EXISTS (
     SELECT 1 FROM memory_edges e
     WHERE e.citing_kind = 'turn' AND e.citing_id = t.id
       AND e.relation = 'supersedes'
   )) AS isCorrector,
  -- 'rolled-back' left the type vocabulary (ticket 02, spec B4): a reversal is
  -- knowable only after the fact and is carried by a supersedes edge, never a
  -- type a turn states about itself. This scalar comparison against t.type
  -- -- now a JSON-array column (spec B5) -- is therefore permanently false
  -- for every row: no legacy turn ever carried a bare 'rolled-back' scalar
  -- either (it was a settlement-only, segment-only value), so this key was
  -- already inert before the migration and stays inert after it. Moving it to
  -- an inbound-supersedes-edge test is spec B4's explicit direction but is
  -- edge work this ticket does not own (ticket 06/13).
  (COALESCE(t.type, '') = 'rolled-back') AS isRolledBack,
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT e.citing_kind, e.citing_id
     FROM memory_edges e
     WHERE e.cited_kind = 'turn' AND e.cited_id = t.id
   )) AS citedBy,
  (EXISTS (
     SELECT 1 FROM segment_members dm
     JOIN segments ds ON ds.id = dm.segment_id
     WHERE dm.turn_id = t.id AND ds.status = 'delivered'
   )) AS isDeliveryMember,
  (CASE WHEN json_valid(t.files_modified)
        THEN json_array_length(t.files_modified) ELSE 0 END) AS filesModifiedCount
`;

/** `RANK_FACT_COLUMNS`' raw `type` text, parsed once for every reader (ticket 02, spec B5). */
function parseTypeList(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function mapMemberRankFactsRow(row: MemberRankFactsRow): MemberRankFacts {
  return { ...row, type: parseTypeList(row.type) };
}

/** The spec's key order, written once so both readers cannot disagree. */
const DERIVED_RANK_ORDER = `
  ORDER BY isCorrector DESC,
           isRolledBack ASC,
           citedBy DESC,
           isDeliveryMember DESC,
           filesModifiedCount DESC,
           t.created_at_epoch DESC,
           t.id DESC
`;

/**
 * Turn ids a segment's body designates as load-bearing, in body order.
 *
 * The settlement pass writes the body with fixed-format citations (spec D9 user
 * story 11) and those citations ARE the anchor list — nothing else marks a turn
 * as an anchor, so the list cannot drift from the prose that justifies it. Only
 * qualified turn references count: a `[E<n>]` in the body points at another
 * segment, not at a member.
 */
export function resolveSegmentAnchorTurnIds(
  db: Database,
  segment: Pick<SegmentRecord, "id" | "content">,
): number[] {
  const references = parseQualifiedReferences(segment.content);
  if (references.length === 0) {
    return [];
  }

  const lookup = db.query<{ id: number }, [number, number, number]>(
    `SELECT t.id AS id
     FROM turns t
     JOIN segment_members sm ON sm.turn_id = t.id
     WHERE t.session_id = ? AND t.prompt_number = ? AND sm.segment_id = ?`,
  );

  const anchors: number[] = [];
  for (const reference of references) {
    if (reference.kind !== "turn") {
      continue;
    }
    const row = lookup.get(reference.sessionId, reference.promptNumber, segment.id);
    // A citation that resolves to a non-member is prose about a neighbour, not
    // an anchor: the anchor list only ever promotes turns the segment owns.
    if (row && !anchors.includes(row.id)) {
      anchors.push(row.id);
    }
  }
  return anchors;
}

/**
 * A segment's members, anchors first and the rest in derived rank order,
 * truncated to `limit` (the render budget).
 *
 * Anchors occupy their slots BEFORE the derived order is consulted, so a turn
 * the settlement pass named as load-bearing cannot be pushed out by a turn that
 * merely scores well mechanically.
 *
 * Nothing stops membership from reaching back across the era boundary — a
 * session open through the switch has turns on both sides and the settlement
 * pass can claim either. Under a cutoff the member list is therefore the ERA
 * half alone, so a pre-cutoff turn is read where it was written, in the legacy
 * arc, and is never counted on both sides of the divider. With no cutoff there
 * is no boundary to respect and the whole membership renders, which is what
 * keeps `E<n>` readable before ticket 09 sets one.
 */
export function rankSegmentMembers(
  db: Database,
  segmentId: number,
  limit?: number,
  eraCutoffEpoch: number | null = null,
): RankedSegmentMember[] {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return [];
  }

  const rows = db
    .query<MemberRankFactsRow, number[]>(
      `SELECT ${RANK_FACT_COLUMNS}
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE sm.segment_id = ?
         ${eraCutoffEpoch === null ? "" : "AND t.created_at_epoch >= ?"}
       ${DERIVED_RANK_ORDER}`,
    )
    .all(...(eraCutoffEpoch === null ? [segmentId] : [segmentId, eraCutoffEpoch]))
    .map(mapMemberRankFactsRow);

  const anchorIds = resolveSegmentAnchorTurnIds(db, segment);
  const anchorPosition = new Map(
    anchorIds.map((turnId, index) => [turnId, index + 1] as const),
  );
  const byTurnId = new Map(rows.map((row) => [row.turnId, row] as const));

  const ordered: RankedSegmentMember[] = [];
  for (const turnId of anchorIds) {
    const row = byTurnId.get(turnId);
    if (row) {
      ordered.push({ ...row, anchorPosition: anchorPosition.get(turnId) ?? null });
    }
  }
  for (const row of rows) {
    if (anchorPosition.has(row.turnId)) {
      continue;
    }
    ordered.push({ ...row, anchorPosition: null });
  }

  return limit === undefined ? ordered : ordered.slice(0, Math.max(0, limit));
}

export interface SegmentSpineRow {
  segment: SegmentRecord;
  /** See `deriveDominantType`. */
  dominantType: string | null;
  /** Era-side members across every session, not only the one being rendered. */
  memberCount: number;
  /** Era-side members that belong to the session being rendered. */
  sessionMemberCount: number;
  firstPromptNumber: number | null;
  lastPromptNumber: number | null;
  firstEpoch: number;
  lastEpoch: number;
  /**
   * Member type LISTS in chronological order with consecutive equal lists
   * collapsed (ticket 02, spec B5): the phase trace (spec D6 — a function
   * switch is not a segment boundary, so the trace is what shows the shape of
   * the work inside one). Equality is the same ordered-list rule
   * `typeListsEqual` applies to the timeline's own phase grouping — two
   * members share a run iff their type lists are identical.
   */
  phaseTrace: string[][];
}

interface SpineMemberRow {
  segmentId: number;
  turnId: number;
  sessionId: number;
  promptNumber: number;
  /** Multi-valued (ticket 02, spec B5); `[]` when the turn stated no type. */
  type: string[];
  createdAtEpoch: number;
}

/**
 * The segment spine for one session: every segment holding at least one
 * era-side member turn of this session, chronologically by its first such
 * member.
 *
 * A segment is deliberately not session-bound (spec D6), so its member set can
 * reach outside the session being rendered; `memberCount` reports the whole
 * segment while the prompt span reports only what this session contributed.
 *
 * Every count here is over ERA-side members only. A segment that also claims
 * pre-cutoff turns describes them in the legacy arc below the divider, and one
 * turn counted on both sides is exactly the mixed reading the boundary exists
 * to prevent.
 *
 * `windowTurnIds` restricts which segments appear — not what their rows say.
 * A range view asks "what happened in T100..T130", so a chapter none of those
 * turns belongs to has no business on the screen; but the chapter itself is not
 * window-bound, so its count and span still report the whole session's share of
 * it, which is how the reader sees the work continues past the window.
 */
export function listSegmentSpineForSession(
  db: Database,
  sessionId: number,
  eraCutoffEpoch: number | null,
  windowTurnIds?: ReadonlySet<number>,
): SegmentSpineRow[] {
  if (eraCutoffEpoch === null) {
    return [];
  }

  const memberRows = db
    .query<Omit<SpineMemberRow, "type"> & { type: string }, [number, number, number]>(
      `SELECT
         sm.segment_id AS segmentId,
         t.id AS turnId,
         t.session_id AS sessionId,
         t.prompt_number AS promptNumber,
         t.type AS type,
         t.created_at_epoch AS createdAtEpoch
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE t.created_at_epoch >= ?
         AND sm.segment_id IN (
           SELECT sm2.segment_id
           FROM segment_members sm2
           JOIN turns t2 ON t2.id = sm2.turn_id
           WHERE t2.session_id = ? AND t2.created_at_epoch >= ?
         )
       ORDER BY t.created_at_epoch ASC, t.id ASC`,
    )
    .all(eraCutoffEpoch, sessionId, eraCutoffEpoch)
    .map((row) => ({ ...row, type: parseTypeList(row.type) }));

  const bySegment = new Map<number, SpineMemberRow[]>();
  for (const row of memberRows) {
    const bucket = bySegment.get(row.segmentId) ?? [];
    bucket.push(row);
    bySegment.set(row.segmentId, bucket);
  }

  const rows: SegmentSpineRow[] = [];
  for (const [segmentId, members] of bySegment) {
    const segment = getSegment(db, segmentId);
    if (!segment) {
      continue;
    }
    const sessionMembers = members.filter((member) => member.sessionId === sessionId);
    if (
      windowTurnIds !== undefined &&
      !sessionMembers.some((member) => windowTurnIds.has(member.turnId))
    ) {
      continue;
    }
    const prompts = sessionMembers.map((member) => member.promptNumber);

    rows.push({
      segment,
      // Flattened: a multi-valued member contributes every one of its own
      // words to the mode count (spec B5), not just a "first" pick —
      // `deriveDominantType`'s own logic is untouched (pin: it stays).
      dominantType: deriveDominantType(
        members.flatMap((member) => member.type),
        segment.type,
      ),
      memberCount: members.length,
      sessionMemberCount: sessionMembers.length,
      firstPromptNumber: prompts.length > 0 ? Math.min(...prompts) : null,
      lastPromptNumber: prompts.length > 0 ? Math.max(...prompts) : null,
      firstEpoch: members[0]!.createdAtEpoch,
      lastEpoch: members[members.length - 1]!.createdAtEpoch,
      phaseTrace: collapseTypeListRuns(
        members.map((member) => member.type).filter((type) => type.length > 0),
      ),
    });
  }

  // Chronological by the segment's first member of THIS session, so the spine
  // reads in the order the session lived it.
  return rows.sort((left, right) => {
    const leftPrompt = left.firstPromptNumber ?? Number.MAX_SAFE_INTEGER;
    const rightPrompt = right.firstPromptNumber ?? Number.MAX_SAFE_INTEGER;
    if (leftPrompt !== rightPrompt) {
      return leftPrompt - rightPrompt;
    }
    return left.segment.id - right.segment.id;
  });
}

/**
 * The one type a segment row wears as its glyph.
 *
 * The member-type MODE decides it (spec D9 lists "成员 type 众数" among the
 * mechanical priors) — but only when the mode is unambiguous. On a tie there is
 * no mode, and rather than break it by arrival order the row defers to the
 * segment's OWN first type value: that list is the settlement pass's judgement,
 * and a judgement beats an arbitrary tiebreak. With neither available the row
 * shows no type at all rather than guessing (spec B7: empty is never a claim).
 *
 * `memberTypes` must be in chronological order.
 */
export function deriveDominantType(
  memberTypes: readonly (string | null)[],
  segmentTypes: readonly string[],
): string | null {
  const counts = new Map<string, number>();
  for (const type of memberTypes) {
    if (type === null || type === "") {
      continue;
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }

  if (best !== null && !tied) {
    return best;
  }
  // With no mode and nothing declared on the segment there is no answer to
  // give. Falling back to `best` here would be answering with "whichever tied
  // type was written first", which is arrival order wearing a mode's clothes —
  // and an untyped segment is ordinary, not exotic: an omitted `type` is
  // stored as `[]`, never guessed at (spec B7).
  return segmentTypes[0] ?? null;
}

/**
 * Collapse consecutive chronological entries whose FULL type list is equal
 * (ticket 02, spec B5) into one run each — the phase trace's own version of
 * the timeline's `typeListsEqual` phase-grouping rule (ordered, exact list
 * equality, not a flattened set).
 */
function collapseTypeListRuns(
  values: readonly (readonly string[])[],
): string[][] {
  const out: string[][] = [];
  for (const value of values) {
    const previous = out[out.length - 1];
    if (!previous || !typeListsEqual(previous, value)) {
      out.push([...value]);
    }
  }
  return out;
}

export interface OrphanAnchorRow {
  facts: MemberRankFacts;
  /** Which mechanical signals put this turn on the spine, in rendering order. */
  signals: string[];
}

/**
 * Era turns of this session that belong to NO segment yet still carry a hard
 * mechanical signal (spec D11: the grading axis as a safety net for the arc
 * axis). Without these rows a turn the settlement pass forgot — or has not
 * reached — would be invisible on the default view however load-bearing it is.
 *
 * "Hard" means a signal that some OTHER record vouches for: this turn overturned
 * something, something cites it, or it was itself overturned. File counts and
 * tool volume are deliberately NOT signals here — nearly every implementation
 * turn has them, so admitting them would flood the spine with exactly the
 * per-turn flat list the segment structure exists to replace.
 *
 * An orphan row IS a turn, so `windowTurnIds` bounds it the way the legacy body
 * is bounded: a range view never shows a turn outside its range.
 */
export function listOrphanAnchorTurns(
  db: Database,
  sessionId: number,
  eraCutoffEpoch: number | null,
  windowTurnIds?: ReadonlySet<number>,
): OrphanAnchorRow[] {
  if (eraCutoffEpoch === null) {
    return [];
  }

  const rows = db
    .query<MemberRankFactsRow, [number, number]>(
      `SELECT ${RANK_FACT_COLUMNS}
       FROM turns t
       WHERE t.session_id = ?
         AND t.created_at_epoch >= ?
         AND t.status NOT IN ('skipped', 'undone')
         AND NOT EXISTS (
           SELECT 1 FROM segment_members sm WHERE sm.turn_id = t.id
         )
       ${DERIVED_RANK_ORDER}`,
    )
    .all(sessionId, eraCutoffEpoch)
    .map(mapMemberRankFactsRow);

  return rows
    .filter((facts) => windowTurnIds === undefined || windowTurnIds.has(facts.turnId))
    .map((facts) => ({ facts, signals: orphanSignals(facts) }))
    .filter((row) => row.signals.length > 0);
}

function orphanSignals(facts: MemberRankFacts): string[] {
  const signals: string[] = [];
  if (facts.isCorrector) {
    signals.push("corrector");
  }
  if (facts.isRolledBack) {
    signals.push("rolled-back");
  }
  if (facts.citedBy > 0) {
    signals.push(`cited ${facts.citedBy}`);
  }
  return signals;
}

/** True when this session has any era-side turn at all. */
export function hasEraTurns(
  turns: readonly { createdAtEpoch: number }[],
  eraCutoffEpoch: number | null,
): boolean {
  return turns.some((turn) => isSegmentEra(turn.createdAtEpoch, eraCutoffEpoch));
}

/**
 * Turn id → owning segment id, for exactly the turn ids passed in (spec D8:
 * nesting ticket 03). The schema allows a turn to join more than one segment,
 * but spec D8 measured zero double-membership in practice; `ORDER BY
 * segment_id ASC` makes the (should-never-happen) tie deterministic rather than
 * leaving it to unspecified row order.
 */
export function getSegmentMembershipForTurns(
  db: Database,
  turnIds: readonly number[],
): Map<number, number> {
  const membership = new Map<number, number>();
  if (turnIds.length === 0) {
    return membership;
  }

  const placeholders = turnIds.map(() => "?").join(", ");
  const rows = db
    .query<{ turnId: number; segmentId: number }, number[]>(
      `SELECT turn_id AS turnId, segment_id AS segmentId
       FROM segment_members
       WHERE turn_id IN (${placeholders})
       ORDER BY turn_id ASC, segment_id ASC`,
    )
    .all(...turnIds);

  for (const row of rows) {
    if (!membership.has(row.turnId)) {
      membership.set(row.turnId, row.segmentId);
    }
  }
  return membership;
}
