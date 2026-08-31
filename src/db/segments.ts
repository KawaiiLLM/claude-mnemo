import type { Database } from "bun:sqlite";

import type { ImpressionOrigin, StoredImpression } from "./impressions";
import { reconcileCitedPairs } from "./memory-edges";
import { parseQualifiedReferences, validateReferences } from "./references";
import { indexSegmentToFTS } from "./search";
import {
  findTagNamespaceHolder,
  findTagNamespaceHolders,
  formatTagNamespaceRefusal,
  TagNamespaceCollisionError,
  type TagNamespaceHolder,
} from "./tag-namespace";
import { liveTurnSql } from "./turn-liveness";
import { stampField } from "./write-gate";
import { eraVisibleMemberSqlClause } from "../segment-era";
import {
  SEGMENT_EDITABLE_FIELDS,
  type SegmentEditableField,
} from "../shared/segment-fields";
import {
  MEMORY_TYPES,
  normalizeTypeValues,
  type MemoryType,
} from "../shared/type-vocabulary";

/**
 * Segments (spec D6).
 *
 * A segment is one coherent chapter of work on one topic — the unit that would
 * earn a line in the day's diary. It carries a turn's field shape (title,
 * content, multi-value type, tags, status) so the read surfaces do not need a
 * second vocabulary for the higher level, plus a `revision` that makes
 * concurrent rewrites of an OPEN segment safe (see `applySegmentWrites`).
 *
 * Everything here is storage mechanics. Which turns belong to which segment,
 * when a segment closes, and what its body says are settlement decisions; this
 * module only refuses writes that would corrupt the structure.
 */

/**
 * Ticket 05 (ADR-0005: "Old segment statuses (open/delivered) are arc
 * semantics, retired with the arc"; user ruling: "status 初版不需要搞复杂，
 * 和以后用不用状态机无关"). Two values, no state machine: `open` accepts
 * writes and stays on the roster; `closed` is manually toggled through
 * `remember`'s `close` verb, refuses `append`/`replace`, and leaves the
 * roster while remaining `recall`-able. The retired `delivered`/`abandoned`
 * words never appear here — a database written under the old three-value
 * vocabulary keeps whatever it already has on disk (schema.ts's
 * `ensureSegmentStatusVocabulary` widens the physical CHECK so those rows
 * stay legible and updatable; nothing rewrites their stored value).
 */
export const SEGMENT_STATUSES = ["open", "closed"] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

/**
 * Ticket 02 (ADR-0005: "legacy arc-segments freeze as-is — readable via
 * recall, absent from the roster"): the boundary between a legacy
 * arc-segment (this table's pre-redesign occupant — a G4-bounded window,
 * 0-4 graded, no Working State, no topic-container semantics) and a segment
 * created under ADR-0001. `status = 'open'` alone CANNOT tell the two apart:
 * the old write path also defaulted new rows to `open`, so on the live
 * database 13 of 14 `status = 'open'` rows were legacy arc-segments carrying
 * an activity-prefixed title from a different project entirely (measured,
 * ticket 02's own evidence) — the doc comment this replaces asserted the
 * opposite as a load-bearing assumption ("no writer... moves a segment...
 * off `open`, so `status != 'open'` uniquely identifies legacy rows") and it
 * was false against production data from the day it was written.
 *
 * The freeze judgement is therefore a recorded FACT — `created_at_epoch`
 * against a pinned moment — not an inference from a value settlement or
 * `remember` could still be writing today. Same idiom as
 * `ELECTION_ERA_CUTOFF_EPOCH`/`TASK_CAUSALITY_ERA_CUTOFF_EPOCH`
 * (election-era.ts/task-causality-era.ts): a real release moment, not an
 * operator-configured placeholder — but NOT `isSegmentEra`
 * (segment-era.ts), which is a DIFFERENT era boundary (the P2 turn-to-
 * segment-spine cutover) gating TURNS, not this table's own rows.
 *
 * Pinned to commit e709279 ("docs: semantic-container ADRs 0001-0007,
 * glossary, spec and eleven tickets"), 2026-08-17 15:48:57 UTC — the moment
 * ADR-0001's container semantics became the accepted design. Verified against
 * the live database: every legacy row's `created_at_epoch` sits strictly
 * before it (the latest, E47, at 2026-08-16 20:04:14 UTC) and the first
 * genuinely new container (E48, "segment upgraded to per-topic container")
 * sits strictly after it (2026-08-17 18:14:50 UTC) — no row falls in the gap
 * between them, so the exact value within that gap is not load-bearing.
 */
export const SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH = 1_786_981_737;

export function isLiveSegmentEra(
  createdAtEpoch: number,
  cutoffEpoch: number = SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH,
): boolean {
  return createdAtEpoch >= cutoffEpoch;
}

export interface SegmentRecord {
  id: number;
  title: string;
  content: string | null;
  /**
   * Ticket 14 (spec K5): the most reusable conclusion this semantic memory
   * holds, including the routes ruled out and why. The inverse default of a
   * turn's own `insight` — a turn's is empty unless something durable was
   * learned; a segment's is the point of the row.
   */
  insight: string | null;
  /** DERIVED from the members (spec K5a) — see `recomputeSegmentFacets`. */
  type: MemoryType[];
  /** DERIVED from the members, most frequent first (spec K5a). */
  tags: string[];
  status: SegmentStatus;
  revision: number;
  /**
   * Working State (ADR-0001, ticket 02): the resuming worker's six fields,
   * beside the summary trio above. Each is a markdown row list ("- " rows,
   * newline-joined), uncapped, `null` when nothing has been written yet.
   * Maintained ONLY through `remember` (`appendSegmentWorkingStateRows` /
   * `replaceInSegmentWorkingStateField` below) — `applySegmentWrites` (the
   * settlement CAS path) never touches these six, ADR-0002's one-writer-per-
   * layer split.
   */
  goal: string | null;
  constraints: string | null;
  decisions: string | null;
  done: string | null;
  /** Column `next_steps` — camelCased here like every other multi-word column. */
  nextSteps: string | null;
  reference: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface SegmentRow {
  id: number;
  title: string;
  content: string | null;
  insight: string | null;
  type: string;
  tags: string;
  status: SegmentStatus;
  revision: number;
  goal: string | null;
  constraints: string | null;
  decisions: string | null;
  done: string | null;
  nextSteps: string | null;
  reference: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

const SEGMENT_COLUMNS = `
  id,
  title,
  content,
  insight,
  type,
  tags,
  status,
  revision,
  goal,
  constraints,
  decisions,
  done,
  next_steps AS nextSteps,
  reference,
  created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;

/**
 * `field` (the external, snake_case `remember` vocabulary) -> the
 * `SegmentRecord` property it reads/writes. One map, so the MCP seam and the
 * DB writers below cannot disagree about which property a field name means.
 * `next_steps` is the only entry where the two spellings differ.
 *
 * Ticket 05 widened this from the six Working State fields to
 * `SegmentEditableField` (content/insight join the same append/replace
 * mechanism, ADR-0001) — `content`/`insight` map to themselves, same as
 * every other entry except `next_steps`.
 */
const SEGMENT_EDITABLE_PROPERTY: Record<
  SegmentEditableField,
  "goal" | "constraints" | "decisions" | "done" | "nextSteps" | "reference" | "content" | "insight"
> = {
  goal: "goal",
  constraints: "constraints",
  decisions: "decisions",
  done: "done",
  next_steps: "nextSteps",
  reference: "reference",
  content: "content",
  insight: "insight",
};

/**
 * One editable field's current text, addressed by the same external field
 * name every writer types — the read-side counterpart of
 * `writeSegmentWorkingStateField` below. Exported (ticket 06,
 * write-mode-edit-semantics spec D2) so `mcp/remember.ts` can ask "does this
 * field currently hold anything?" — the question that decides whether a
 * `write` needs a complete read — without keeping a second copy of the
 * field -> property mapping above.
 */
export function segmentEditableFieldValue(
  segment: SegmentRecord,
  field: SegmentEditableField,
): string | null {
  return segment[SEGMENT_EDITABLE_PROPERTY[field]];
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The same parse, made total, for a MEMBER TURN's `type`/`tags`.
 *
 * `turns.tags` carries no `json_valid` CHECK, so a malformed value is storable
 * (every bulk rewriter of that column guards `json_valid`/`json_type` for the
 * same reason), and `turns.type` only gained its array CHECK in ticket 02 — a
 * database mid-migration still holds pre-array values. `recomputeSegmentFacets`
 * now runs over the whole corpus during schema initialisation (the ticket 15
 * backfill below), so one unparseable member would otherwise abort schema init
 * for every process. A member whose facet column cannot be read contributes
 * nothing, exactly as an empty one does; it is not a reason to refuse the
 * derivation for its twelve well-formed siblings.
 */
function parseMemberFacetArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    return parseStringArray(value);
  } catch {
    return [];
  }
}

/**
 * TICKET 07 (rubric-v10): trims, drops empties, dedupes preserving
 * first-seen order — applied at both entry points a caller can set a
 * segment's hand-curated tags from (`createSegment`'s `tags` and
 * `setSegmentTags`), so the stored set has the same shape regardless of
 * which one wrote it.
 */
function normalizeSegmentTagValues(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function mapSegmentRow(row: SegmentRow | null): SegmentRecord | null {
  return row
    ? {
        ...row,
        type: parseStringArray(row.type) as MemoryType[],
        tags: parseStringArray(row.tags),
      }
    : null;
}

export interface CreateSegmentInput {
  title: string;
  content?: string | null;
  /** Ticket 14 (spec K5). */
  insight?: string | null;
  /**
   * Storage mechanics only (spec K5a). The settlement tool never states
   * this — `recomputeSegmentFacets` derives it from the members the moment
   * membership exists — so in production this arrives `[]` and is
   * overwritten by the first `addSegmentMembers` call. It stays on the
   * INSERT for a caller that has no members to derive from (a fixture, a
   * repair).
   */
  type?: string[];
  /**
   * TICKET 07 (rubric-v10, "Segment tags and note-time membership"):
   * hand-curated identity, NOT derived — this field used to be treated
   * identically to `type` above (both storage mechanics, both overwritten by
   * the first membership change). It no longer is: this is where a caller
   * sets a segment's tags, once, and they stay exactly as given until a
   * deliberate `setSegmentTags`/`remember(retag)` call changes them.
   * `checkSegmentMembershipTagGate` reads this value to gate every NEW
   * membership write; no membership write ever rewrites it back.
   */
  tags?: string[];
  status?: SegmentStatus;
  nowEpoch: number;
}

export function createSegment(
  db: Database,
  input: CreateSegmentInput,
): SegmentRecord {
  const type = normalizeTypeValues(input.type ?? []);

  // THE THIRD MINTER (peer review [S15069/T1773]). `insertLane`'s own comment
  // states the namespace invariant's premise — "this function and
  // `setSegmentTag` are the only two that mint a name" — and the premise was
  // false: this one writes `tags` straight onto the INSERT, never passing
  // `setSegmentTag`, so a task could take a word an existing LANE already
  // held while the mirror direction threw. Reproduced: E1 declares lane
  // `alpha`, `createSegment({tags:["alpha"]})` succeeds, and `alpha` then
  // names both E1's lane and E2's task, which makes a turn carrying it either
  // double-homed or silently migrated. Throwing matches `insertLane` rather
  // than returning a message, for the same reason it gives: a migration or a
  // repair script reaches this primitive without passing any facade.
  for (const tag of normalizeSegmentTagValues(input.tags ?? [])) {
    const holder = findTagNamespaceHolder(db, "segment", tag);
    if (holder) {
      throw new TagNamespaceCollisionError("segment", holder);
    }
  }

  const inserted = mapSegmentRow(
    db
      .query<
        SegmentRow,
        [
          string,
          string | null,
          string | null,
          string,
          string,
          SegmentStatus,
          number,
          number,
        ]
      >(
        `INSERT INTO segments (
           title, content, insight, type, tags, status,
           created_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(
        input.title,
        input.content ?? null,
        input.insight ?? null,
        JSON.stringify(type),
        JSON.stringify(normalizeSegmentTagValues(input.tags ?? [])),
        input.status ?? "open",
        input.nowEpoch,
        input.nowEpoch,
      ) ?? null,
  );

  if (!inserted) {
    throw new Error("Failed to create segment.");
  }
  indexSegment(db, inserted);
  reconcileSegmentCitedPairs(db, inserted, input.nowEpoch);
  return inserted;
}

/**
 * Spec C6: a segment's title/content/insight is its whole citation-bearing
 * surface (type/tags/status are structured, not prose). Every write that lands
 * a segment row — creation and `applySegmentWrites`' compare-and-set rewrite
 * alike — calls this so a bare `[S<session>/T<n>]`/`[E<n>]` in any of those
 * fields is a real, storable citation and a rewrite that drops one drops the
 * pair.
 *
 * TICKET 14 (spec K7) ADMITTED `insight`. It is scanned in the SAME change
 * that gave the segment the field, deliberately: a prose field that carries
 * citations but is not scanned here produces the worst possible reading — the
 * author sees a citation, the graph has no edge, and nothing reports the
 * difference.
 *
 * The same resolver every other citation-bearing write uses, asking the one
 * question a pair's existence turns on: does the address name a real row.
 * This layer used to be the odd one out — it had no writer-session context to
 * gate against, so it skipped an exposure check the turn and session paths
 * applied, which left one reference kind licensed differently depending on
 * which body carried it. The gate is gone everywhere now, so there is nothing
 * left to be inconsistent about.
 *
 * TICKET 02 (spec "Data model") widened the scan to the six Working State
 * fields alongside the summary trio: a `decisions` row citing its source is
 * exactly as real a citation as one in `content`, and scanning the whole
 * record here — rather than adding a second reconciler for the new columns —
 * is what keeps "every segment write reconciles its own citations" a single
 * invariant instead of two that could drift. Harmless on the settlement path
 * (`applySegmentWrites`), whose `UPDATE` never touches these six: the
 * `RETURNING` row still carries their current stored value, so the scan
 * simply re-confirms citations that did not change.
 */
function reconcileSegmentCitedPairs(
  db: Database,
  segment: SegmentRecord,
  nowEpoch: number,
): void {
  const references = [
    ...parseQualifiedReferences(segment.title),
    ...parseQualifiedReferences(segment.content),
    ...parseQualifiedReferences(segment.insight),
    ...parseQualifiedReferences(segment.goal),
    ...parseQualifiedReferences(segment.constraints),
    ...parseQualifiedReferences(segment.decisions),
    ...parseQualifiedReferences(segment.done),
    ...parseQualifiedReferences(segment.nextSteps),
    ...parseQualifiedReferences(segment.reference),
  ];
  const resolved = validateReferences(db, references).accepted;
  reconcileCitedPairs(
    db,
    { kind: "segment", id: segment.id },
    resolved.map((entry) => entry.node),
    nowEpoch,
    "text-ref",
  );
}

/**
 * Keep the segment's search row in step with the row it was written from.
 *
 * Ticket 03: passes all six Working State fields too, the same set
 * `rebuildSearchIndex`'s full-rebuild query (db/search.ts) selects — this is
 * the ONE place a `SegmentRecord` becomes a `SegmentFtsRecord`, so the two
 * paths cannot drift onto different column sets.
 */
function indexSegment(db: Database, segment: SegmentRecord): void {
  indexSegmentToFTS(db, {
    id: segment.id,
    title: segment.title,
    content: segment.content,
    insight: segment.insight,
    goal: segment.goal,
    constraints: segment.constraints,
    decisions: segment.decisions,
    done: segment.done,
    nextSteps: segment.nextSteps,
    reference: segment.reference,
    type: JSON.stringify(segment.type),
    tags: JSON.stringify(segment.tags),
  });
}

// ---------------------------------------------------------------------------
// The TASK-TIER IMPRESSION (lane-impressions spec Rev 8, "Storage"; ticket 02)
//
// Its TEXT is the `content` column above — the spec stores it "in its content
// field under the same storage rules", and ticket 01 pinned `impression_origin
// IS NULL` as the mechanical "content is still legacy field text, not an
// impression" discriminator. There is no second text home, and a reader must
// never invent one.
//
// These two live HERE rather than in db/impressions.ts (which owns the lane
// tier's identical pair) for one reason: a `content` write has to reindex FTS
// and reconcile the segment's citations, and both of those helpers are private
// to this module. Every other segment content writer above already calls them;
// a settlement-owned write that skipped them would leave the search row and the
// cited-pair graph describing text that no longer exists.
// ---------------------------------------------------------------------------

interface SegmentImpressionRow {
  content: string | null;
  revision: number;
  origin: ImpressionOrigin | null;
  stale: number;
}

/** `null` iff no segment row exists. `text` is `null` while `origin` is null — that is legacy field text, not an impression. */
export function readSegmentTaskImpression(
  db: Database,
  segmentId: number,
): StoredImpression | null {
  const row =
    db
      .query<SegmentImpressionRow, [number]>(
        `SELECT content,
                impression_revision AS revision,
                impression_origin AS origin,
                impression_stale AS stale
           FROM segments WHERE id = ?`,
      )
      .get(segmentId) ?? null;
  if (!row) {
    return null;
  }
  return {
    text: row.origin === null ? null : row.content,
    revision: row.revision,
    origin: row.origin,
    stale: row.stale === 1,
  };
}

export interface ReplaceSegmentTaskImpressionInput {
  segmentId: number;
  /** The impression revision the writer READ. */
  baseRevision: number;
  text: string;
  origin: ImpressionOrigin;
  nowEpoch: number;
}

/**
 * The task tier's whole-impression replacement, CAS-fenced on
 * `impression_revision`. FALSE means another writer moved the row (or the
 * segment is gone) — the caller's whole transaction must reject.
 *
 * `revision` (the SEGMENT's own long-standing content fence) is bumped too,
 * deliberately: through deployment phase 1 the old fields — `content` among
 * them — stay writable by the main agent, and every one of those writers CASes
 * on `revision`. Leaving it standing would let a main-agent write holding a
 * pre-impression revision succeed and silently clobber the impression. The
 * impression fence protects settlement from settlement; this bump protects the
 * impression from the writer settlement does not own.
 */
export function replaceSegmentTaskImpression(
  db: Database,
  input: ReplaceSegmentTaskImpressionInput,
): boolean {
  const updated = mapSegmentRow(
    db
      .query<SegmentRow, [string, string, number, number, number]>(
        `UPDATE segments
            SET content = ?,
                impression_revision = impression_revision + 1,
                impression_origin = ?,
                impression_stale = 0,
                revision = revision + 1,
                updated_at_epoch = ?
          WHERE id = ? AND impression_revision = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(
        input.text,
        input.origin,
        input.nowEpoch,
        input.segmentId,
        input.baseRevision,
      ) ?? null,
  );
  if (!updated) {
    return false;
  }
  indexSegment(db, updated);
  reconcileSegmentCitedPairs(db, updated, input.nowEpoch);
  return true;
}

// ---------------------------------------------------------------------------
// Derived facets (spec K5a, ticket 14)
// ---------------------------------------------------------------------------

/**
 * How a tie in tag frequency is broken: ascending code-point order of the tag
 * itself. Deterministic and independent of member order, which insertion order
 * is not — two settlements that add the same members in a different sequence
 * must produce the same stored row, or the FTS facet and the rendered order
 * would depend on scheduling.
 */
export function compareDerivedTags(
  left: { tag: string; count: number },
  right: { tag: string; count: number },
): number {
  return right.count - left.count || (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0);
}

/**
 * A segment's `type` computed from its members (spec K5a: "a value the
 * system can compute is a value the model can only get wrong"). A6 has
 * asserted the type union since it was written and nothing ever checked it —
 * this is the check.
 *
 * `type` is the UNION of the members' stated activities, ordered by
 * FREQUENCY (most member turns first), with ties broken by the vocabulary's
 * own canonical order (`MEMORY_TYPES`) so the value never depends on which
 * member happened to be added first. The ordering is load-bearing, not
 * cosmetic: `deriveDominantType` (db/segment-rank.ts) falls back to a
 * segment's FIRST type word when the member mode is tied, and its whole
 * contract is that the fallback is a judgement rather than arrival order —
 * a frequency-ordered union keeps that true now that no one states the
 * list. A legacy word a pre-vocabulary member still carries is dropped
 * rather than propagated upward: `normalizeTypeValues` would refuse it on
 * the next write, so storing it would make the segment unwritable.
 *
 * TICKET 07 (rubric-v10, "Segment tags and note-time membership") RETIRED
 * `tags` from this derivation. Before this ticket a segment's tags were the
 * same kind of member-frequency mush `type` still is — this function used
 * to compute both from the identical member sweep. Tags are now hand-curated
 * identity (`CreateSegmentInput.tags`, `setSegmentTags`): set at creation,
 * changed only through a deliberate `retag`, and never touched by a
 * membership change — this function no longer reads member tags at all.
 * `compareDerivedTags` survives as a general "frequency, then code-point
 * order" comparator, still used by `computeSegmentMemberFacetCounts`'s own
 * (display-only, non-persisting) tag tally below.
 *
 * Returns the recomputed row, or `null` if the segment is gone. Does NOT bump
 * `revision`: the revision fence exists for the model's body writes (whose CAS
 * would otherwise be invalidated by a facet recomputation it never made), and
 * a facet is no longer something a caller can state, so nothing can conflict.
 *
 * TICKET 15 (findings 1-3; `type`-only after ticket 07): this is the ONE
 * derivation, and it has THREE inputs, not one. Ticket 14 placed the only
 * call in `addSegmentMembers` and described that as the single invariant
 * point; it is the single point for a change of MEMBERSHIP, and the facet
 * derives from the members' CONTENT too. The inputs and who pays for each:
 *
 *   1. a membership arriving — `addSegmentMembers`, unchanged;
 *   2. a member turn's own `type` changing — the turn write path
 *      (`recomputeSegmentFacetsForTurn`, called from db/turns.ts);
 *   3. a membership LEAVING, which only ever happens through the
 *      `segment_members` FK cascade of a deleted turn or session — no
 *      TypeScript writer exists to hook, so SQLite records the debt
 *      (`segments.facets_stale`, schema.ts) and `repairStaleSegmentFacets`
 *      pays it.
 */
export function recomputeSegmentFacets(
  db: Database,
  segmentId: number,
): SegmentRecord | null {
  const members = db
    .query<{ type: string | null }, [number]>(
      `SELECT t.type AS type
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE sm.segment_id = ?`,
    )
    .all(segmentId);

  const typeCounts = new Map<string, number>();
  for (const member of members) {
    for (const word of new Set(parseMemberFacetArray(member.type))) {
      typeCounts.set(word, (typeCounts.get(word) ?? 0) + 1);
    }
  }

  const type = MEMORY_TYPES.filter((word) => typeCounts.has(word)).sort(
    (left, right) =>
      (typeCounts.get(right) ?? 0) - (typeCounts.get(left) ?? 0) ||
      MEMORY_TYPES.indexOf(left) - MEMORY_TYPES.indexOf(right),
  );

  const updated = mapSegmentRow(
    db
      .query<SegmentRow, [string, number]>(
        // `facets_stale = 0` in the same statement that stores the derivation:
        // the flag means "a derivation is owed", and this IS the derivation, so
        // whichever writer got here — membership, a member's own write, or the
        // repair sweep — settles the debt by the act of paying it. `tags` is
        // deliberately absent from this UPDATE (ticket 07) — that column is
        // hand-curated identity now, untouched by any facet recomputation.
        `UPDATE segments SET type = ?, facets_stale = 0 WHERE id = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(JSON.stringify(type), segmentId) ?? null,
  );

  if (updated) {
    // The whole reason the derived value is STORED rather than resolved at
    // read time (spec K5a): a segment is FTS-indexed with its type/tags, so
    // an un-reindexed recomputation leaves the search facet describing a
    // membership that no longer exists.
    indexSegment(db, updated);
  }
  return updated;
}

export interface SegmentMembershipGateViolation {
  turnId: number;
  /** "S<session>/T<prompt>" — the same address form every write surface renders; falls back to a bare id if the turn row is somehow gone. */
  turnAddress: string;
  missingTags: string[];
}

export interface SegmentMembershipGateResult {
  ok: boolean;
  segmentTags: string[];
  violations: SegmentMembershipGateViolation[];
}

/**
 * TICKET 07 (rubric-v10, "Segment tags and note-time membership"): the ONE
 * membership gate every NEW assignment write checks before it lands — a
 * member turn must carry ALL of the segment's own tags, the segment-level
 * twin of the edge subset invariant (shared/turn-phase.ts / the Memory
 * Rubric's "every tag on an edge must already exist on both endpoint turns'
 * tags"). Three call sites share this single function rather than each
 * re-deriving the rule — `mcp/remember.ts`'s `assign`,
 * `worker/note-settlement-membership-facade.ts`'s `reassign`, and
 * `mcp/note.ts`'s new `segment` parameter. The ticket's own mutation-check
 * acceptance criterion fails a test if ANY ONE of the three stops calling it.
 *
 * An EMPTY `segment.tags` gates nothing (vacuous pass) — the pre-backfill
 * state of every segment created before this ticket, and of any segment a
 * caller deliberately leaves untagged. This function is consulted only at
 * the moment a NEW assignment is about to land; it never re-checks a turn
 * already a member, which is exactly what "grandfathered" means (the
 * backfill campaign, not this gate, retro-tags those later).
 *
 * Reads `turns.tags` LIVE, not from a caller-supplied snapshot, so a call
 * that also writes this same turn's tags earlier in the SAME transaction
 * (`note`'s `segment` parameter alongside its own `tags` field) is judged
 * against the tags it is about to actually carry.
 */
export function checkSegmentMembershipTagGate(
  db: Database,
  segmentId: number,
  turnIds: readonly number[],
): SegmentMembershipGateResult {
  const segment = getSegment(db, segmentId);
  const segmentTags = segment?.tags ?? [];
  if (segmentTags.length === 0 || turnIds.length === 0) {
    return { ok: true, segmentTags, violations: [] };
  }

  const placeholders = turnIds.map(() => "?").join(",");
  const rows = db
    .query<
      { id: number; sessionId: number; promptNumber: number; tags: string | null },
      number[]
    >(
      `SELECT id, session_id AS sessionId, prompt_number AS promptNumber, tags
       FROM turns WHERE id IN (${placeholders})`,
    )
    .all(...turnIds);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const violations: SegmentMembershipGateViolation[] = [];
  for (const turnId of turnIds) {
    const row = byId.get(turnId);
    const turnTags = new Set(row ? parseMemberFacetArray(row.tags) : []);
    const missingTags = segmentTags.filter((tag) => !turnTags.has(tag));
    if (missingTags.length > 0) {
      violations.push({
        turnId,
        turnAddress: row ? `S${row.sessionId}/T${row.promptNumber}` : `turn ${turnId}`,
        missingTags,
      });
    }
  }
  return { ok: violations.length === 0, segmentTags, violations };
}

/** The gate's own rejection text — one register shared by all three call sites. */
export function formatSegmentMembershipGateRejection(
  segmentId: number,
  violations: readonly SegmentMembershipGateViolation[],
): string {
  const lines = violations.map((v) => `${v.turnAddress} is missing: ${v.missingTags.join(", ")}`);
  return (
    `E${segmentId} requires every member to carry its tags — ${lines.join("; ")}. ` +
    "Nothing was assigned."
  );
}

/**
 * `remember`'s `retag` verb (ticket 07): the segment tags' own edit path —
 * hand-curated identity, replaced WHOLE (no append/merge form; a caller
 * composes the finished set itself, the same "supply the finished text"
 * discipline `writeSegmentWorkingStateField` already applies to a Working
 * State field). `[]` clears every tag, which also clears the membership
 * gate (vacuous pass) — a deliberate, observable act, not a silent no-op.
 *
 * No revision fence and no write-gate check, matching
 * `appendSegmentWorkingStateRows`/`writeSegmentWorkingStateField` above:
 * ADR-0002 makes segment maintenance advisory and single-writer-per-session.
 */
/**
 * Lane-declaration ticket 01 (spec D1 "two vocabularies, one enforceable
 * invariant", peer P2-9): `retag`'s own cross-check against the OTHER
 * vocabulary — a word already declared as a LANE may not become a segment
 * tag too, or the separation between the two is a storage detail rather
 * than a concept.
 *
 * GLOBAL SINCE lane-model-v12 (peer A2). This used to ask only about the
 * retagged segment's OWN lanes, which left the collision that actually breaks
 * D3e wide open: E2's lane spelled like the word E1 is being named, so a turn
 * carrying both is either double-homed or silently migrates. The namespace is
 * one namespace across the whole database, so the question is one question —
 * `findTagNamespaceHolders`, the same helper `setSegmentTag` and `insertLane`
 * are the authority through. This remains a facade PRE-CHECK, kept for its
 * message; `setSegmentTag` re-asks it inside the write transaction.
 *
 * Returns the holders, in the order `tags` names the words — empty means no
 * collision.
 */
export function findRetagLaneCollisions(
  db: Database,
  tags: readonly string[],
): TagNamespaceHolder[] {
  return findTagNamespaceHolders(db, "segment", tags);
}

export function setSegmentTags(
  db: Database,
  segmentId: number,
  tags: readonly string[],
  nowEpoch: number,
): SegmentRecord | null {
  const normalized = normalizeSegmentTagValues(tags);
  const updated = mapSegmentRow(
    db
      .query<SegmentRow, [string, number, number]>(
        `UPDATE segments SET tags = ?, updated_at_epoch = ? WHERE id = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(JSON.stringify(normalized), nowEpoch, segmentId) ?? null,
  );
  if (updated) {
    indexSegment(db, updated);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// A segment is ONE globally unique tag (lane-model-v12 spec D3e, ticket 14)
// ---------------------------------------------------------------------------

/**
 * The segment's own tag, or `null` when nobody has named it yet.
 *
 * The column stays a JSON array (changing it would be a 12-step rebuild of a
 * table half the codebase reads, for no capability). What collapsed is the
 * MODEL and the write face: the array holds 0 or 1 element, `setSegmentTag`
 * below is the only writer that can put one there, and `idx_segments_tag_unique`
 * (schema.ts) makes a second segment claiming the same word a SQLite error
 * rather than a convention.
 *
 * Reads `$[0]` rather than the whole array so a legacy multi-tag row still
 * answers something rather than throwing — those rows exist only until the
 * one-tag migration empties them, and only on a database mid-upgrade.
 */
export function segmentTagOf(segment: Pick<SegmentRecord, "tags">): string | null {
  return segment.tags[0] ?? null;
}

export type SetSegmentTagResult =
  | { ok: true; segment: SegmentRecord }
  | { ok: false; message: string };

/**
 * `remember(retag)`'s write path: name a segment, or clear its name (`null`).
 *
 * ONE tag, GLOBALLY unique — the two halves of D3e's identity rule. The
 * collision pre-check exists for its message (it names the segment already
 * holding the word); the unique index is what makes the rule true even for a
 * caller who skipped this function. Clearing is always legal: an unnamed
 * container takes no derived members, which is exactly the state the seven
 * standing containers sit in until a human names them.
 *
 * THE LANE HALF OF THE SAME NAMESPACE (lane-model-v12, peer A2) is checked
 * HERE, in the primitive, through the shared `db/tag-namespace.ts` helper —
 * not in `remember(retag)`'s facade, which a migration or any direct caller
 * would walk around. Global, and deliberately including this segment's OWN
 * lanes: the word would then mean both "member of E<n>" and "in E<n>'s lane
 * X", read out of one column by one reader. `insertLane` (db/lanes.ts) is the
 * mirror, asking the same helper the other way.
 */
export function setSegmentTag(
  db: Database,
  segmentId: number,
  tag: string | null,
  nowEpoch: number,
): SetSegmentTagResult {
  const normalized = tag === null ? [] : normalizeSegmentTagValues([tag]);
  const wanted = normalized[0] ?? null;
  if (wanted !== null) {
    const holder = db
      .query<{ id: number }, [string, number]>(
        `SELECT id FROM segments
          WHERE json_array_length(tags) >= 1 AND json_extract(tags, '$[0]') = ? AND id <> ?`,
      )
      .get(wanted, segmentId);
    if (holder) {
      return {
        ok: false,
        message:
          `"${wanted}" is already E${holder.id}'s segment tag — a segment tag is globally unique, ` +
          "because a turn's segment is derived from it. Pick another word, or retag E" +
          `${holder.id} off it first.`,
      };
    }
    const laneHolder = findTagNamespaceHolder(db, "segment", wanted);
    if (laneHolder) {
      return { ok: false, message: formatTagNamespaceRefusal("segment", laneHolder) };
    }
  }
  const updated = setSegmentTags(db, segmentId, normalized, nowEpoch);
  return updated
    ? { ok: true, segment: updated }
    : { ok: false, message: `E${segmentId} no longer exists.` };
}

/**
 * Membership, DERIVED (spec D3e): a turn belongs to whichever segment's tag
 * it carries, and to no segment at all when it carries none. Called from the
 * one turn-write primitive (`updateTurnById`, db/turns.ts) whenever `tags`
 * actually moves — so there is no verb to call and none to forget.
 *
 * The explicit verbs this replaces (`note(segment=…)`, `remember(assign)`)
 * are retired in the same ticket. `reassignSegmentMembers` survives for
 * settlement's own `reassign` correction path, which still states a target.
 *
 * NOT routed through `reassignSegmentMembers`, deliberately: that function
 * carries the lane-stranding VETO, whose job is to stop an explicit MOVE from
 * breaking a stored edge. A derivation is not a move a caller chose — it is
 * the consequence of a tags write that already passed the tags gate — and a
 * veto here would leave a turn whose stored tags and stored membership
 * disagree, which is the one state derivation may never produce. Stranded
 * edges are the checker's report to raise, not this function's to prevent.
 *
 * Returns the segment the turn now belongs to (`null` = unowned).
 */
export function deriveTurnSegmentMembership(
  db: Database,
  turnId: number,
  tags: readonly string[],
  nowEpoch: number,
): number | null {
  const index = new Map<string, number>();
  for (const row of db
    .query<{ id: number; tag: string }, []>(
      `SELECT id, json_extract(tags, '$[0]') AS tag
         FROM segments WHERE json_array_length(tags) >= 1`,
    )
    .all()) {
    if (typeof row.tag === "string" && row.tag !== "" && !index.has(row.tag)) {
      index.set(row.tag, row.id);
    }
  }

  let target: number | null = null;
  for (const tag of tags) {
    const segmentId = index.get(tag);
    if (segmentId !== undefined) {
      target = segmentId;
      break;
    }
  }

  const priorSegmentIds = db
    .query<{ segmentId: number }, [number]>(
      "SELECT DISTINCT segment_id AS segmentId FROM segment_members WHERE turn_id = ?",
    )
    .all(turnId)
    .map((row) => row.segmentId);

  if (priorSegmentIds.length === (target === null ? 0 : 1) && priorSegmentIds[0] === target) {
    return target;
  }

  db.query<unknown, [number]>("DELETE FROM segment_members WHERE turn_id = ?").run(turnId);
  if (target !== null) {
    addSegmentMembers(db, target, [turnId], nowEpoch);
  }
  for (const segmentId of priorSegmentIds.filter((id) => id !== target)) {
    recomputeSegmentFacets(db, segmentId);
  }
  return target;
}

/**
 * Input 2 (ticket 15 finding 1): a member turn's `type` just moved, so every
 * segment holding that turn has to re-derive. (Ticket 07: `tags` retired from
 * this derivation — a member's tags changing no longer touches the segment's
 * own hand-curated tags at all.)
 *
 * Called from the turn write path rather than resolved when a segment is read,
 * because spec K5a already settled that question in the same breath as the
 * derivation rule: "a segment is indexed to FTS with its type, so the derived
 * value is stored and recomputed when membership changes, not resolved at read
 * time". A read-time derivation would still owe the FTS facet a write, so it
 * relocates the write rather than removing it — and leaves `type:`
 * search answering from the stale row in the meantime.
 *
 * Cheap by construction: one lookup on `idx_segment_members_turn`, which is
 * empty for the ~94% of turns that belong to no segment at all, and a
 * recomputation per segment for the rest (a turn in two segments pays twice,
 * which is the true cost of the many-to-many and not a reason to defer).
 */
export function recomputeSegmentFacetsForTurn(db: Database, turnId: number): void {
  const rows = db
    .query<{ segmentId: number }, [number]>(
      `SELECT segment_id AS segmentId FROM segment_members
       WHERE turn_id = ? ORDER BY segment_id ASC`,
    )
    .all(turnId);
  for (const row of rows) {
    recomputeSegmentFacets(db, row.segmentId);
  }
}

/**
 * Input 3 (ticket 15 findings 2-3): pay every derivation SQLite recorded as
 * owed. Returns how many segments were recomputed.
 *
 * The debt is written by the `segment_members` AFTER DELETE trigger (schema.ts)
 * — the only writer that sees a membership removed, because a turn or session
 * deletion never names `segment_members` at all, the FK cascade does — and once
 * by the migration that introduced the flag, which is how the segments written
 * before spec K5a get their model-stated facets replaced by derived ones.
 *
 * A trigger cannot do the derivation itself: the union's order comes from the
 * `MEMORY_TYPES` constant and the result has to be rewritten into the segment's
 * FTS row through `indexSegmentToFTS`, neither of which exists in SQL. So the
 * flag is the seam — SQLite records the FACT, which it alone can see, and this
 * runs the DERIVATION, which only TypeScript can express.
 *
 * The caller owns the transaction (schema.ts's initialisation sweep wraps it),
 * so a repair pass is all-or-nothing rather than half-applied.
 *
 * BATCHED, because the transaction is a write lock and the sweep runs from
 * schema initialisation, which every hook entry performs: the one-time backfill
 * on the live database is 45 segments at ~16 ms each (measured — nearly all of
 * it the FTS rewrite on a 1.9 GB trigram index), and holding the lock for the
 * whole ~880 ms would sit above the 800 ms busy timeout a hook connection
 * allows itself. A cap makes the hold ~250 ms and costs nothing, because the
 * flag is durable: whatever this pass leaves is still owed, and the next
 * process start — several per prompt — resumes it. Ordered by id so successive
 * passes advance instead of re-drawing the same batch.
 */
export const SEGMENT_FACET_REPAIR_BATCH = 16;

export function repairStaleSegmentFacets(
  db: Database,
  limit: number = SEGMENT_FACET_REPAIR_BATCH,
): number {
  const stale = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM segments WHERE facets_stale = 1 ORDER BY id ASC LIMIT ?",
    )
    .all(Math.max(1, Math.floor(limit)));
  for (const row of stale) {
    recomputeSegmentFacets(db, row.id);
  }
  return stale.length;
}

export function getSegment(db: Database, segmentId: number): SegmentRecord | null {
  return mapSegmentRow(
    db
      .query<SegmentRow, [number]>(
        `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE id = ?`,
      )
      .get(segmentId) ?? null,
  );
}

export function listOpenSegments(db: Database): SegmentRecord[] {
  return db
    .query<SegmentRow, []>(
      `SELECT ${SEGMENT_COLUMNS} FROM segments WHERE status = 'open'
       ORDER BY updated_at_epoch DESC, id DESC`,
    )
    .all()
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
}

/** The same columns as `SEGMENT_COLUMNS`, qualified for a join. */
const JOINED_SEGMENT_COLUMNS = `
  s.id,
  s.title,
  s.content,
  s.insight,
  s.type,
  s.tags,
  s.status,
  s.revision,
  s.goal,
  s.constraints,
  s.decisions,
  s.done,
  s.next_steps AS nextSteps,
  s.reference,
  s.created_at_epoch AS createdAtEpoch,
  s.updated_at_epoch AS updatedAtEpoch
`;

/**
 * The most recently active segments, whatever their status (ticket 14, spec
 * D9's anti-fragmentation surface). Deliberately NOT open-only: a DELIVERED
 * segment is evidence that a theme is already established (carried on its
 * tags — ticket 15 retired the topic registry that used to name it), which
 * is exactly what the caller has to see before it decides it needs a new
 * segment.
 */
export function listRecentSegments(
  db: Database,
  limit: number,
): SegmentRecord[] {
  if (limit <= 0) {
    return [];
  }
  return db
    .query<SegmentRow, [number]>(
      `SELECT ${JOINED_SEGMENT_COLUMNS}
       FROM segments s
       ORDER BY s.updated_at_epoch DESC, s.id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
}

/**
 * Idempotent membership assertion; returns the turn ids newly linked.
 *
 * Membership is ONE of the three inputs to `type` (spec K5a — see
 * `recomputeSegmentFacets` for the other two and who pays for each; ticket 07
 * retired `tags` from this derivation entirely — see that function's own doc
 * comment), so this is where the derivation runs for a membership that
 * arrives: a caller cannot land members and forget it, and the FTS facet can
 * never describe a membership the row does not have. Recomputation runs only
 * when this call actually linked something new: an idempotent re-assertion
 * changes no input and therefore needs no recomputation.
 *
 * TICKET 07 does NOT gate this function's own callers on the segment's tags
 * — this is the low-level write primitive `remember(create)`'s member
 * seeding and `evaluateCreate` (settlement's own `create` action) both use to
 * land a fresh segment's SEED members, and the ticket's own scope names only
 * three gated paths (`remember(assign)`, settlement's `reassign`, `note`'s
 * `segment` parameter) — a segment's first members are established together
 * with its identity, not assigned against an already-settled one. See
 * `checkSegmentMembershipTagGate`, called explicitly at each of those three
 * call sites instead of embedded here.
 *
 * Ticket 15 finding 8, checked rather than assumed: the partial-insert window
 * this loop opens (some memberships land, a later `turn_id` fails its foreign
 * key, the throw skips the recomputation) is not reachable from production.
 * The only production caller is `evaluateSettlementSegmentWrite(…, apply:
 * true)`, which runs exclusively inside the settlement commit's
 * `runWriteTransaction` (worker/note-settlement-staging.ts), so the throw
 * rolls the partial insert back with everything else. A future caller OUTSIDE
 * a transaction would need the `SAVEPOINT` idiom `applySegmentWrites` uses —
 * nest-safe, unlike a bare `BEGIN` — not one added here speculatively, where
 * on today's only path it would be a redundant savepoint per settlement write.
 */
export function addSegmentMembers(
  db: Database,
  segmentId: number,
  turnIds: readonly number[],
  nowEpoch: number,
): number[] {
  const statement = db.query<{ turnId: number }, [number, number, number]>(
    `INSERT INTO segment_members (segment_id, turn_id, created_at_epoch)
     VALUES (?, ?, ?)
     ON CONFLICT (segment_id, turn_id) DO NOTHING
     RETURNING turn_id AS turnId`,
  );

  const added: number[] = [];
  for (const turnId of turnIds) {
    const row = statement.get(segmentId, turnId, nowEpoch);
    if (row) {
      added.push(row.turnId);
    }
  }
  if (added.length > 0) {
    recomputeSegmentFacets(db, segmentId);
  }
  return added;
}

// ---------------------------------------------------------------------------
// The membership half of the lane gate (lane-declaration spec D2, ticket 02)
// ---------------------------------------------------------------------------

/**
 * A tagged edge is legal only while its tag names a lane DECLARED in the
 * segment of EVERY endpoint turn. The edge write path checks that at birth
 * (`db/lane-edge-gate.ts` -> `shared/turn-phase.ts`'s `validateRelationTarget`),
 * but a turn MOVING between segments can make a stored edge illegal with no
 * edge write involved at all (peer finding P1-2) — so the same question is
 * asked again HERE, on the one membership write primitive, in the same
 * transaction as the move it guards.
 *
 * ONE gate, not a check each caller remembers: `remember(assign)`,
 * ownership-clearing, `remember(create)`'s seed members, `note`'s own
 * `segment` parameter, and settlement's `reassign`/`create` all reach
 * `segment_members` through `reassignSegmentMembers` below and through nothing
 * else, which is what makes "no membership path can strand an edge" a
 * structural fact rather than five remembered call sites.
 *
 * DELTA, NOT ABSOLUTE. Only an edge this move BREAKS is reported — one already
 * stranded before the move (legacy stock, an unmigrated tag) stays stranded
 * and does not veto an unrelated reassignment. An absolute test would deadlock
 * exactly the repair moves that fix such stock.
 *
 * `lanes` is queried directly rather than through `db/lanes.ts`, the same
 * one-way dependency `findRetagLaneCollisions` above states its own reason
 * for: `db/lanes.ts` reads this module's `getOwningSegmentId`.
 *
 * PER SIDE since lane-model-v12 ticket 09, which is a correction and not a
 * column rename. This gate used to read the merged `tags` set and cross every
 * tag in it against BOTH endpoints — sound under v11, where a tag had to sit
 * on both ends to be legal at all. Under v12 an edge carries one lane per
 * END: `tail_tag` is the CITING turn's and is owed by the CITING turn's
 * segment, `head_tag` is the CITED turn's (spec D2 rule 2, the same per-side
 * obligation `shared/lane-checker.ts` states for E4).
 *
 * On today's stock nothing observable moves: a SAME-LANE edge names one word
 * on both sides, so per-side and cross-product agree row for row. What the
 * change actually buys is the shape the merged column could not hold at all —
 * a CROSS-LANE edge stores `tags = '[]'`, claiming neither lane, so the old
 * filter (`tags <> '[]'`) could not see it and a move stranding one of its
 * two declarations was waved through in silence. That is the same hole ticket
 * 08 found in `undeclare`'s guard, in a second reader. Reading it per side is
 * also the only correct way to report one: its two ends owe DIFFERENT words,
 * and checking each endpoint against both would invent an obligation neither
 * segment ever had.
 */
export interface MembershipLaneStranding {
  citingTurnId: number;
  citedTurnId: number;
  relation: string;
  tag: string;
  /** Which endpoint loses its declaration. */
  endpoint: "citing" | "cited";
  /** That endpoint's segment AFTER the move — `null` when the move leaves it homeless. */
  segmentIdAfter: number | null;
}

interface IncidentTaggedEdgeRow {
  citingId: number;
  citedId: number;
  relation: string;
  /** `memory_edges.tail_tag` — the CITING side's lane, `''` unsettled. */
  tailTag: string;
  /** `memory_edges.head_tag` — the CITED side's lane, `''` unsettled. */
  headTag: string;
}

/** `S<session>/T<prompt>` for a turn id, so a refusal is written in the address vocabulary the repair calls take. */
function turnAddress(db: Database, turnId: number): string {
  const row = db
    .query<{ sessionId: number; promptNumber: number }, [number]>(
      "SELECT session_id AS sessionId, prompt_number AS promptNumber FROM turns WHERE id = ?",
    )
    .get(turnId);
  return row ? `S${row.sessionId}/T${row.promptNumber}` : `turn #${turnId}`;
}

/**
 * Every (edge, tag, endpoint) this move would leave undeclared and that is
 * declared TODAY. Empty means the move strands nothing.
 */
export function findMembershipLaneStrandings(
  db: Database,
  turnIds: readonly number[],
  targetSegmentId: number | null,
): MembershipLaneStranding[] {
  const moving = new Set(turnIds);
  if (moving.size === 0) {
    return [];
  }
  const ids = [...moving];
  const placeholders = ids.map(() => "?").join(",");
  const edges = db
    .query<IncidentTaggedEdgeRow, number[]>(
      `SELECT citing_id AS citingId, cited_id AS citedId, relation,
              tail_tag AS tailTag, head_tag AS headTag
         FROM memory_edges
        WHERE citing_kind = 'turn' AND cited_kind = 'turn'
          AND relation IS NOT NULL
          AND (tail_tag <> '' OR head_tag <> '')
          AND (citing_id IN (${placeholders}) OR cited_id IN (${placeholders}))`,
    )
    .all(...ids, ...ids);
  if (edges.length === 0) {
    return [];
  }

  const owningBefore = new Map<number, number | null>();
  const segmentOf = (turnId: number, after: boolean): number | null => {
    if (after && moving.has(turnId)) {
      return targetSegmentId;
    }
    if (!owningBefore.has(turnId)) {
      owningBefore.set(turnId, getOwningSegmentId(db, turnId));
    }
    return owningBefore.get(turnId) ?? null;
  };

  const declaredCache = new Map<number, Set<string>>();
  const declares = (segmentId: number | null, tag: string): boolean => {
    if (segmentId === null) {
      return false;
    }
    let declared = declaredCache.get(segmentId);
    if (declared === undefined) {
      declared = new Set(
        db
          .query<{ tag: string }, [number]>("SELECT tag FROM lanes WHERE segment_id = ?")
          .all(segmentId)
          .map((row) => row.tag),
      );
      declaredCache.set(segmentId, declared);
    }
    return declared.has(tag);
  };

  const strandings: MembershipLaneStranding[] = [];
  for (const edge of edges) {
    // One obligation per SETTLED side, each owed by its own endpoint's
    // segment. An unsettled side (`''`) owes nothing — it is the absence of a
    // lane, not a lane named `''` — which is also what makes a half-settled
    // row (storable, though the write gate refuses to mint one) contribute
    // exactly its settled half here rather than nothing or two.
    const sides = [
      { endpoint: "citing" as const, turnId: edge.citingId, tag: edge.tailTag },
      { endpoint: "cited" as const, turnId: edge.citedId, tag: edge.headTag },
    ];
    for (const side of sides) {
      if (side.tag === "") {
        continue;
      }
      const before = segmentOf(side.turnId, false);
      const after = segmentOf(side.turnId, true);
      if (before === after) {
        continue;
      }
      // Delta only: an endpoint whose declaration was already missing keeps
      // its pre-existing violation and never vetoes this move.
      if (!declares(before, side.tag)) {
        continue;
      }
      if (declares(after, side.tag)) {
        continue;
      }
      strandings.push({
        citingTurnId: edge.citingId,
        citedTurnId: edge.citedId,
        relation: edge.relation,
        tag: side.tag,
        endpoint: side.endpoint,
        segmentIdAfter: after,
      });
    }
  }
  return strandings;
}

/** The refusal text: every edge it would break, the declaration each is missing, and the two moves that clear it. */
export function formatMembershipLaneStrandingRejection(
  db: Database,
  targetSegmentId: number | null,
  strandings: readonly MembershipLaneStranding[],
): string {
  const clauses = strandings.map((stranding) => {
    const arrow = `${turnAddress(db, stranding.citingTurnId)} --${stranding.relation}--> ${turnAddress(db, stranding.citedTurnId)} {${stranding.tag}}`;
    const where =
      stranding.segmentIdAfter === null
        ? `the ${stranding.endpoint} turn would belong to NO segment, and a lane is declared on a segment`
        : `E${stranding.segmentIdAfter} — the ${stranding.endpoint} turn's segment after this move — has not declared lane "${stranding.tag}"`;
    return `${arrow}: ${where}`;
  });
  const destination = targetSegmentId === null ? "no segment (homeless)" : `E${targetSegmentId}`;
  return (
    `Refused: moving to ${destination} would strand ${strandings.length} tagged edge(s), so nothing was moved — ` +
    `${clauses.join("; ")}. Mint the lane in the destination segment first (remember create, id="E<n>/#<tag>"), or retract the edge.`
  );
}

export type ReassignSegmentMembersResult =
  | {
      ok: true;
      /** The segment(s) these turns were removed FROM, distinct, excluding `targetSegmentId` itself. */
      vacatedSegmentIds: number[];
      /** Turn ids actually (re-)linked to `targetSegmentId` — empty when `targetSegmentId` is `null`. */
      addedTurnIds: number[];
      targetSegmentId: number | null;
    }
  | {
      /**
       * The move was REFUSED and `segment_members` is byte-identical to what
       * it was on entry — the lane check runs before the delete, so there is
       * no partial state to unwind and no transaction to depend on for it.
       */
      ok: false;
      message: string;
    };

/**
 * Ticket 02 (ownership-and-note-cadence spec, [S15069/T926], peer finding 3):
 * the ONE write path for "these turns belong here now" — single ownership
 * enforced by the WRITE, not a retroactive schema constraint (a legacy
 * segment may still share a turn with another; this function does not touch
 * that history, only what a NEW assignment does going forward). Every turn
 * named is first removed from EVERY segment it currently belongs to, then
 * (if `targetSegmentId` is not `null`) added to the target — one
 * transaction, so a turn is never observably a member of two segments at
 * once between the two halves.
 *
 * `targetSegmentId: null` is `remember`'s `assign` with no `id` — place the
 * named turns in NO segment (homeless). `remember`'s `create` seeds its
 * `members` through this SAME function (not `addSegmentMembers` directly):
 * a turn named in a fresh segment's `members` is evicted from wherever it
 * used to live, the identical single-ownership rule `assign` enforces, not a
 * second, looser path a caller could use to sidestep it.
 *
 * Facets are recomputed for every segment whose membership actually
 * changed — every vacated segment, and the target if anything landed there
 * (`addSegmentMembers` already does the target's own recomputation). A
 * segment reassigned to the SAME segment it already belonged to is a no-op
 * for `vacatedSegmentIds` (filtered out) but still exercises the delete+
 * re-insert cycle, which is harmless.
 *
 * Lane-declaration ticket 02 (spec D2): this is also where the lane gate's
 * MEMBERSHIP half runs — `findMembershipLaneStrandings` above, checked BEFORE
 * the delete, so a refusal leaves `segment_members` byte-identical without
 * depending on the caller's transaction to unwind anything. The result became
 * a discriminated union in the same change: a refusal a caller could ignore by
 * reading `addedTurnIds` off the old shape would be a gate in name only, and
 * the union makes every call site handle it or fail to compile.
 */
export function reassignSegmentMembers(
  db: Database,
  turnIds: readonly number[],
  targetSegmentId: number | null,
  nowEpoch: number,
): ReassignSegmentMembersResult {
  if (turnIds.length === 0) {
    return { ok: true, vacatedSegmentIds: [], addedTurnIds: [], targetSegmentId };
  }

  const strandings = findMembershipLaneStrandings(db, turnIds, targetSegmentId);
  if (strandings.length > 0) {
    return {
      ok: false,
      message: formatMembershipLaneStrandingRejection(db, targetSegmentId, strandings),
    };
  }

  const placeholders = turnIds.map(() => "?").join(",");
  const priorSegmentIds = db
    .query<{ segmentId: number }, number[]>(
      `SELECT DISTINCT segment_id AS segmentId FROM segment_members WHERE turn_id IN (${placeholders})`,
    )
    .all(...turnIds)
    .map((row) => row.segmentId);

  db.query<unknown, number[]>(
    `DELETE FROM segment_members WHERE turn_id IN (${placeholders})`,
  ).run(...turnIds);

  const addedTurnIds =
    targetSegmentId === null ? [] : addSegmentMembers(db, targetSegmentId, turnIds, nowEpoch);

  const vacatedSegmentIds = priorSegmentIds.filter((id) => id !== targetSegmentId);
  for (const segmentId of vacatedSegmentIds) {
    recomputeSegmentFacets(db, segmentId);
  }

  return { ok: true, vacatedSegmentIds, addedTurnIds, targetSegmentId };
}

export function getSegmentMemberTurnIds(
  db: Database,
  segmentId: number,
): number[] {
  return db
    .query<{ turnId: number }, [number]>(
      `SELECT sm.turn_id AS turnId
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE sm.segment_id = ?
       ORDER BY t.created_at_epoch ASC, t.id ASC`,
    )
    .all(segmentId)
    .map((row) => row.turnId);
}

export function getSegmentsForTurn(db: Database, turnId: number): SegmentRecord[] {
  return db
    .query<SegmentRow, [number]>(
      `SELECT ${JOINED_SEGMENT_COLUMNS}
       FROM segments s
       JOIN segment_members sm ON sm.segment_id = s.id
       WHERE sm.turn_id = ?
       ORDER BY s.id ASC`,
    )
    .all(turnId)
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
}

/**
 * The turn's OWNING segment id, or `null` when homeless (T1191, relation-
 * matrix spec's segment-crossing warning). Single ownership — a turn
 * belongs to at most one segment under the redesign, enforced by the WRITE
 * path (`reassignSegmentMembers`'s own doc comment) rather than a retroactive
 * constraint — is exactly what lets this collapse `getSegmentsForTurn`'s
 * array to one id instead of asking every caller to decide which of several
 * to use. A pre-redesign legacy turn that still carries more than one
 * membership row reads as its FIRST (lowest id) segment, the same tie-break
 * `getSegmentsForTurn`'s own `ORDER BY s.id ASC` already applies.
 */
export function getOwningSegmentId(db: Database, turnId: number): number | null {
  return getSegmentsForTurn(db, turnId)[0]?.id ?? null;
}

export interface SegmentWrite {
  segmentId: number;
  /** The revision the caller read before composing this body. */
  expectedRevision: number;
  title?: string;
  content?: string | null;
  /** Ticket 14 (spec K5). `null` clears; omitted leaves the stored value alone. */
  insight?: string | null;
  /** See `CreateSegmentInput` — storage mechanics only; the settlement tool states neither (spec K5a). */
  type?: string[];
  tags?: string[];
  status?: SegmentStatus;
}

export type SegmentWriteRejection =
  | "missing"
  | "revision-conflict"
  | "frozen"
  | "invalid-type";

export interface ExcludedSegmentWrite {
  write: SegmentWrite;
  reason: SegmentWriteRejection;
  /** The row as it stands now — what the caller replays its judgement against. */
  latest: SegmentRecord | null;
  detail?: string;
}

export interface ApplySegmentWritesResult {
  applied: SegmentRecord[];
  excluded: ExcludedSegmentWrite[];
}

export interface ApplySegmentWritesOptions {
  nowEpoch: number;
}

const SEGMENT_WRITE_SAVEPOINT = "mnemo_segment_writes";

/**
 * Compare-and-set writes over open segments (spec D9, 裁决 14).
 *
 * Concurrent settlements partition cleanly by session EXCEPT for open segments,
 * which any of them may rewrite. Rather than serialize every settlement behind
 * a global lock, each write declares the revision it was composed against: a
 * write whose revision moved on is EXCLUDED from this transaction and handed
 * back with the segment as it stands now, so the caller replays the judgement
 * for that one segment in a follow-up write. Everything else in the batch —
 * including the caller's other partition writes, which never enter this
 * savepoint's rollback path — commits.
 *
 * A non-open segment refuses writes outright: spec D6 overturns a closed
 * segment with an edge, never by rewriting history. (This CAS path is the
 * settlement writer's own — ticket 05's narrower "only `closed` blocks"
 * gate lives in `remember.ts`'s own append/replace handlers, not here.)
 */
export function applySegmentWrites(
  db: Database,
  writes: readonly SegmentWrite[],
  options: ApplySegmentWritesOptions,
): ApplySegmentWritesResult {
  const applied: SegmentRecord[] = [];
  const excluded: ExcludedSegmentWrite[] = [];

  db.exec(`SAVEPOINT ${SEGMENT_WRITE_SAVEPOINT}`);
  try {
    for (const write of writes) {
      const current = getSegment(db, write.segmentId);
      if (!current) {
        excluded.push({ write, reason: "missing", latest: null });
        continue;
      }
      if (current.status !== "open") {
        excluded.push({ write, reason: "frozen", latest: current });
        continue;
      }

      let type: MemoryType[];
      try {
        type = write.type ? normalizeTypeValues(write.type) : current.type;
      } catch (error) {
        excluded.push({
          write,
          reason: "invalid-type",
          latest: current,
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const updated = mapSegmentRow(
        db
          .query<
            SegmentRow,
            [
              string,
              string | null,
              string | null,
              string,
              string,
              SegmentStatus,
              number,
              number,
              number,
            ]
          >(
            `UPDATE segments
               SET title = ?,
                   content = ?,
                   insight = ?,
                   type = ?,
                   tags = ?,
                   status = ?,
                   revision = revision + 1,
                   updated_at_epoch = ?
             WHERE id = ? AND revision = ?
             RETURNING ${SEGMENT_COLUMNS}`,
          )
          .get(
            write.title ?? current.title,
            write.content === undefined ? current.content : write.content,
            write.insight === undefined ? current.insight : write.insight,
            JSON.stringify(type),
            JSON.stringify(write.tags ?? current.tags),
            write.status ?? current.status,
            options.nowEpoch,
            write.segmentId,
            write.expectedRevision,
          ) ?? null,
      );

      if (!updated) {
        excluded.push({ write, reason: "revision-conflict", latest: current });
        continue;
      }

      indexSegment(db, updated);
      reconcileSegmentCitedPairs(db, updated, options.nowEpoch);
      applied.push(updated);
    }
  } catch (error) {
    db.exec(`ROLLBACK TO ${SEGMENT_WRITE_SAVEPOINT}`);
    db.exec(`RELEASE ${SEGMENT_WRITE_SAVEPOINT}`);
    throw error;
  }
  db.exec(`RELEASE ${SEGMENT_WRITE_SAVEPOINT}`);

  return { applied, excluded };
}

// ---------------------------------------------------------------------------
// Working State (ADR-0001/0002, ticket 02) — the main agent's own write path
// through `remember`, disjoint from `applySegmentWrites` above (settlement's
// CAS path over the summary trio + structural fields). No revision fence
// here: ADR-0002 makes maintenance advisory and single-writer-per-session, not
// a concurrency domain the way an OPEN segment's settlement rewrites are.
// ---------------------------------------------------------------------------

/**
 * The stored shape of one row: a leading "- " (ADR-0001's "markdown row
 * lists"). Idempotent on a caller that already includes the dash, so
 * `remember(append)` never double-prefixes regardless of whether its caller
 * typed the bullet itself.
 */
export function normalizeWorkingStateRow(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("- ") ? trimmed : `- ${trimmed}`;
}

/**
 * Append one or more rows to an editable field (spec "Tools", `remember`
 * `append`). Newline-joined onto whatever the field already holds; a `null`/
 * empty field starts fresh. Returns the updated record, or `null` if the
 * segment does not exist.
 *
 * `field` is typed as `SegmentEditableField` — the closed eight-value union
 * `remember`'s own parameter schema enforces (ticket 05: the six Working
 * State fields plus `content`/`insight`) — so the column name interpolated
 * into the `UPDATE` below is never a caller-controlled string, the same
 * discipline `shouldRebuildSearchIndex` (schema.ts) applies to its own
 * whitelisted table names.
 */
export function appendSegmentWorkingStateRows(
  db: Database,
  segmentId: number,
  field: SegmentEditableField,
  rows: readonly string[],
  nowEpoch: number,
): SegmentRecord | null {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return null;
  }

  const property = SEGMENT_EDITABLE_PROPERTY[field];
  const existing = segment[property];
  const addition = rows.map(normalizeWorkingStateRow).join("\n");
  const merged =
    existing !== null && existing.trim() !== "" ? `${existing}\n${addition}` : addition;

  const updated = mapSegmentRow(
    db
      .query<SegmentRow, [string, number, number]>(
        `UPDATE segments SET ${field} = ?, updated_at_epoch = ? WHERE id = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(merged, nowEpoch, segmentId) ?? null,
  );

  if (updated) {
    reconcileSegmentCitedPairs(db, updated, nowEpoch);
    // Ticket 03: the only production writer of these fields never reindexed
    // — a row appended through `remember` was invisible to `recall(query=…)`
    // until the next full rebuild, which nothing schedules.
    indexSegment(db, updated);
  }
  return updated;
}

export type SegmentFieldReplaceRejection = "missing" | "ambiguous";

export interface ReplaceSegmentWorkingStateFieldResult {
  /** `null` only when the segment itself does not exist. */
  segment: SegmentRecord | null;
  /** Present iff the replace was rejected — `segment` is then the row AS IT STOOD, unchanged. */
  rejection?: SegmentFieldReplaceRejection;
  /** How many times `oldString` matched, when `rejection` is `"ambiguous"`. */
  occurrences?: number;
}

/**
 * `remember`'s `replace(old, new)` (ADR-0001): a literal, non-overlapping
 * substring find within one field's stored text. Rejects loudly rather than
 * guessing when `oldString` is absent (`"missing"`) or matches more than once
 * (`"ambiguous"`, with the count) — "replace forces read-before-write and
 * silence structurally cannot overwrite a statement" is only true if an
 * ambiguous match refuses rather than picks one silently.
 *
 * `newString: ""` deletes the matched text; when that leaves a wholly blank
 * line (the common case — `oldString` was an entire row, dash included), the
 * blank line is dropped rather than stored as a gap, and a field emptied to
 * nothing reverts to `null` — the same "empty means null" convention `note`'s
 * own field resolvers already use.
 */
export function replaceInSegmentWorkingStateField(
  db: Database,
  segmentId: number,
  field: SegmentEditableField,
  oldString: string,
  newString: string,
  nowEpoch: number,
): ReplaceSegmentWorkingStateFieldResult {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return { segment: null };
  }

  const property = SEGMENT_EDITABLE_PROPERTY[field];
  const current = segment[property] ?? "";
  const occurrences = current === "" ? 0 : current.split(oldString).length - 1;

  if (occurrences === 0) {
    return { segment, rejection: "missing" };
  }
  if (occurrences > 1) {
    return { segment, rejection: "ambiguous", occurrences };
  }

  const replaced = current.split(oldString).join(newString);
  // A line is gone when nothing but bullet furniture remains: `append`
  // normalizes a bare row INTO `- ` form, so a caller deleting by the same
  // bare text leaves `- ` behind — furniture the trim()-only filter kept as
  // a phantom empty bullet ([S15069/T1022], two of them live on E60).
  const cleaned = replaced
    .split("\n")
    .filter((line) => line.replace(/^\s*-\s*/, "").trim() !== "")
    .join("\n");

  const updated = mapSegmentRow(
    db
      .query<SegmentRow, [string | null, number, number]>(
        `UPDATE segments SET ${field} = ?, updated_at_epoch = ? WHERE id = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(cleaned === "" ? null : cleaned, nowEpoch, segmentId) ?? null,
  );

  if (updated) {
    reconcileSegmentCitedPairs(db, updated, nowEpoch);
    // Ticket 03 — see `appendSegmentWorkingStateRows`'s own note.
    indexSegment(db, updated);
  }
  return { segment: updated };
}

/**
 * `remember`'s `write` verb (write-mode-edit-semantics ticket 03, spec D11):
 * whole-field replacement — the one capability append/replace never gave the
 * segment surface. Covers every one of `SEGMENT_EDITABLE_FIELDS`' eight
 * columns, the same scope `SEGMENT_EDITABLE_PROPERTY` already maps.
 *
 * `value === null`, or an all-whitespace string, clears the field to `NULL` —
 * the same "empty string is a synonym for null" convention
 * `updateSessionFields` (db/sessions.ts) already applies to its own seven
 * text fields (spec D2: "可空字段配显式 null 表示清空"). A non-empty value is
 * stored exactly as given — `write` replaces the field's full text, not a row
 * within it, so no bullet-list normalization or blank-line cleanup applies
 * (those exist on `append`/`replace` because THEY compose onto an existing
 * list; `write` supplies the finished text itself).
 *
 * The clear is a real write, not a no-op the caller can't observe: this
 * function always issues the `UPDATE` and always advances `updated_at_epoch`,
 * even when the computed value is byte-identical to what is already
 * stored — including clearing a field that was already `NULL` — matching
 * `updateSessionFields`'s own "D5: even a byte-identical rewrite must clear
 * the staleness reminder" discipline. That is what makes a cleared field
 * "被写过的空" (written-empty) rather than "从未写过" (never-written) even
 * though the two are indistinguishable by VALUE alone: the write gate
 * (ticket 06, write-gate.ts) is what stamps a field as written, on top of
 * this call, and it can only do that if this layer never turns a clear into
 * a skipped statement.
 *
 * Reuses the exact citation-reconciliation and FTS-reindex calls
 * `appendSegmentWorkingStateRows`/`replaceInSegmentWorkingStateField` already
 * make. A whole-field overwrite is the write shape most likely to both drop
 * a citation (the old text naming it is gone) and orphan a search hit (the
 * old text stays indexed) if either step is skipped — the trap this ticket
 * exists to close.
 *
 * No revision fence and no read-authorization check, matching the two
 * siblings above and NOT `applySegmentWrites`: ADR-0002 makes Working State
 * maintenance advisory and single-writer-per-session, and gating this call is
 * ticket 06's job, not this function's — the caller is assumed to have
 * already been admitted.
 *
 * Returns the updated record, or `null` if the segment does not exist — the
 * same contract as `appendSegmentWorkingStateRows`.
 */
export function writeSegmentWorkingStateField(
  db: Database,
  segmentId: number,
  field: SegmentEditableField,
  value: string | null,
  nowEpoch: number,
): SegmentRecord | null {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return null;
  }

  const stored = value === null || value.trim() === "" ? null : value;

  const updated = mapSegmentRow(
    db
      .query<SegmentRow, [string | null, number, number]>(
        `UPDATE segments SET ${field} = ?, updated_at_epoch = ? WHERE id = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(stored, nowEpoch, segmentId) ?? null,
  );

  if (updated) {
    reconcileSegmentCitedPairs(db, updated, nowEpoch);
    indexSegment(db, updated);
  }
  return updated;
}

/**
 * `remember`'s `close` verb (ticket 05, ADR-0005: "A finished task is
 * manually closed through remember and leaves the roster"). The status
 * vocabulary is two values with no state machine, so `close` is a TOGGLE
 * rather than a one-way transition: called on a segment that is not
 * currently `closed`, it closes; called again on an already-`closed` one, it
 * reopens — this IS the checklist's "拒绝时给出重开的出口" (the exit is the
 * same verb, called again), not a second verb.
 *
 * No revision fence, matching `appendSegmentWorkingStateRows` /
 * `replaceInSegmentWorkingStateField` above and NOT `applySegmentWrites`:
 * ADR-0002 makes maintenance advisory and single-writer-per-session, not a
 * CAS domain.
 *
 * Returns the updated record, or `null` if the segment does not exist.
 */
export function toggleSegmentStatus(
  db: Database,
  segmentId: number,
  nowEpoch: number,
): SegmentRecord | null {
  const segment = getSegment(db, segmentId);
  if (!segment) {
    return null;
  }
  const next: SegmentStatus = segment.status === "closed" ? "open" : "closed";

  return mapSegmentRow(
    db
      .query<SegmentRow, [SegmentStatus, number, number]>(
        `UPDATE segments SET status = ?, updated_at_epoch = ? WHERE id = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(next, nowEpoch, segmentId) ?? null,
  );
}

/**
 * `remember(clear)`'s task-tier primitive (container-unification ticket 07,
 * spec D5b) — the caller has already re-checked, INSIDE the same write
 * transaction, that the segment declares no lane, which is `clear`'s own
 * precondition at this tier (D5b: "任务级 clear 的前置是「泳道已清空」,
 * 不是递归销毁"). With no lane declared, a member turn's own `tags` can hold
 * nothing but this segment's word — the write gate refuses a lane tag
 * without its lane declared — so un-homing every member is exactly "strip
 * this segment's tag off each one", touching `tags` alone; no edge side
 * holds a TASK tag at all (D5b), so there is nothing else for this tier to
 * clear.
 *
 * MEMBERS ARE TAKEN BY OWNERSHIP (`getSegmentMemberTurnIds`, the same
 * `segment_members`-derived read `delete`'s own task-tier guard uses), not by
 * a tag scan: `create(members=[...])` seeds `segment_members` WITHOUT ever
 * writing the segment's tag onto the turn (ticket 05's own seeding path), so
 * such a member's `tags` may not even mention this segment's word. Every
 * member still gets `deriveTurnSegmentMembership` called on it regardless —
 * that is what actually wipes its `segment_members` row, whether or not the
 * `tags` UPDATE above it changed anything — because a stale ownership row a
 * tag never produced is not a fact a tag-only strip could ever undo.
 *
 * Returns the number of member turns released.
 */
export function clearSegmentMembers(db: Database, segmentId: number, nowEpoch: number): number {
  const memberTurnIds = getSegmentMemberTurnIds(db, segmentId);
  if (memberTurnIds.length === 0) {
    return 0;
  }
  const segment = getSegment(db, segmentId);
  const ownTag = segment ? segmentTagOf(segment) : null;

  const readTags = db.query<{ tags: string | null }, [number]>(
    "SELECT tags FROM turns WHERE id = ?",
  );
  const updateTurnTags = db.query<unknown, [string, number]>(
    "UPDATE turns SET tags = ? WHERE id = ?",
  );
  for (const turnId of memberTurnIds) {
    const raw = readTags.get(turnId)?.tags ?? "[]";
    let stored: string[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      stored = Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      stored = [];
    }
    const next = ownTag !== null ? stored.filter((value) => value !== ownTag) : stored;
    if (next.length !== stored.length) {
      updateTurnTags.run(JSON.stringify(next), turnId);
    }
    deriveTurnSegmentMembership(db, turnId, next, nowEpoch);
  }
  return memberTurnIds.length;
}

/**
 * `remember(delete)`'s task-tier primitive (container-unification ticket 06,
 * spec D4) — the caller has already re-checked, INSIDE the same write
 * transaction, that the segment owns no member turn and declares no lane;
 * this function only ever removes a row that guard has just cleared.
 *
 * MOST OF THE CLEANUP IS ALREADY STRUCTURAL. `segment_members`,
 * `segment_attachments`, `segment_detachments` and `lanes` all declare
 * `REFERENCES segments(id) ON DELETE CASCADE` (schema.ts), and
 * `db/database.ts` turns `PRAGMA foreign_keys` ON for every connection, so
 * the plain `DELETE` below already takes them with it — harmlessly, since the
 * guard means the first two are empty for this row anyway. The
 * `memory_edges_prune_deleted_segment` trigger (schema.ts) fires on the same
 * delete and removes every edge naming this segment as either side; that
 * trigger's own child tables (`memory_edge_tags`/`memory_edge_side_tags`)
 * cascade off THEIR OWN FK in turn.
 *
 * `memory_fts` IS NOT. It is a virtual table with no foreign key and no
 * delete trigger, and every segment gets a row there unconditionally at
 * creation (`indexSegment`) — so a segment deleted without this second
 * statement goes on returning phantom search hits for a row `getSegment`
 * can no longer find. This is one of two populations this function has to
 * clear by hand.
 *
 * `write_gate_reads` / `write_gate_stamps` / `write_gate_field_completeness`
 * (container-unification ticket 09, spec D6 population 5) are the other:
 * three MORE polymorphic tables keyed on `(entity_type, entity_id)` with no
 * FK of their own — a segment deleted without these three leaves every read
 * grant, field stamp and completeness record it ever earned pointing at a
 * row nothing can find any more, the identical leak `memory_fts` has above.
 * `mergeSegments` (this file, population 6b) reaches this same function for
 * `from`'s removal, so fixing the leak here — rather than a second cleanup
 * living only in the merge path — closes it for the plain `delete` verb
 * (D4) too, the same shared-primitive discipline this module already
 * follows elsewhere (`makeSideOwnershipResolver`'s own doc comment, `db/lanes.ts`).
 *
 * `true` iff a row was actually removed (`false` only when the id was
 * already gone — the caller's own transaction already re-read the row a
 * moment earlier, so this is a defensive answer, not an expected path).
 */
export function deleteSegmentRow(db: Database, segmentId: number): boolean {
  const removed =
    db
      .query<{ id: number }, [number]>(`DELETE FROM segments WHERE id = ? RETURNING id`)
      .get(segmentId) !== null;
  if (removed) {
    db.query<unknown, [string, number]>(
      `DELETE FROM memory_fts WHERE layer = ? AND source_id = ?`,
    ).run("segment", segmentId);
    db.query<unknown, [string, number]>(
      `DELETE FROM write_gate_reads WHERE entity_type = ? AND entity_id = ?`,
    ).run("segment", segmentId);
    db.query<unknown, [string, number]>(
      `DELETE FROM write_gate_stamps WHERE entity_type = ? AND entity_id = ?`,
    ).run("segment", segmentId);
    db.query<unknown, [string, number]>(
      `DELETE FROM write_gate_field_completeness WHERE entity_type = ? AND entity_id = ?`,
    ).run("segment", segmentId);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// merge — one task's members, lanes, fields and derived state handed to
// another (container-unification tickets 08-10, spec D6/D7/D8).
// `remember(merge)` reaches this through `mcp/remember.ts`'s task-tier
// handler when the call carries no `tag` — a `tag` still routes to the
// pre-existing LANE-tier fold (`db/lanes.ts`'s `mergeLaneTag`), which this
// function does not replace.
// ---------------------------------------------------------------------------

/**
 * Raised when `mergeSegments` reaches either of its own last steps —
 * undeclaring a force-folded, now-empty colliding source lane (population
 * 6a), or taking `from` off the roster (population 6b) — while the
 * population it is about to remove is not actually empty yet. Same shape as
 * `db/lanes.ts`'s `LaneMergeInvariantError`: an INVARIANT, not a caller
 * mistake (every population the guard counts was rewritten a few statements
 * earlier in this SAME transaction), so it throws rather than returning a
 * refusal a caller could plausibly fix by retrying.
 */
export class SegmentMergeInvariantError extends Error {}

export interface SegmentMergeReceipt {
  from: number;
  into: number;
  /** Member turns whose OWNERSHIP moved from `from` to `into` — selected by `getOwningSegmentId`, never by tag (see this function's own doc comment, population 2). */
  membersMoved: number;
  /** `from`'s own declared lanes — relocated onto `into`'s registry when the name was free, force-consolidated onto `into`'s own same-named lane when it collided (ticket 10). */
  lanesMoved: number;
  /**
   * Turns that still carry `from`'s own task tag after the merge
   * (lane-merge-skip-receipt ticket 01, criterion 4 — the SAME hole
   * `db/lanes.ts`'s `mergeLaneTag` reports as `stillCarrying`). Population
   * 2's member SELECT is purely `segment_members`-shaped (no tag predicate to
   * subtract), so this is a fresh query rather than that one with a clause
   * removed — but it answers the identical question: turns whose own `tags`
   * still name `from` after the retag loop ran, meaning they fell outside
   * `segment_members` membership and were never moved. Unlike the lane tier,
   * no OTHER segment's turn can ever match this string by coincidence — a
   * segment tag is GLOBALLY unique (`idx_segments_tag_unique`, `setSegmentTag`'s
   * own doc comment) — so every address here is a genuine orphan. Empty when
   * `from` had no task tag at all (nothing to have gone missing).
   */
  stillCarrying: readonly string[];
}

export type SegmentMergeOutcome =
  | { kind: "lane-collision"; tags: string[] }
  | { kind: "members-blocked"; message: string }
  | { kind: "merged"; receipt: SegmentMergeReceipt };

export interface SegmentMergeOptions {
  /**
   * D8: a same-name lane collision refuses by default and NAMES every
   * colliding tag — that list is the refusal's OWN product, printed whether
   * or not `force` is sent (D8: "不带 force 的调用仍然必须打印完整清单").
   * `force: true` proceeds despite the collision instead of refusing; it
   * does NOT claim the caller has read that list — a boolean cannot carry
   * that — it means only "proceed despite the warning", the same weak
   * reading `remember(clear)`'s own `force` already has. Ignored when there
   * is no collision to begin with.
   */
  force?: boolean;
  /**
   * The write-gate identity `into`'s rewritten fields (population 5, D6)
   * are stamped under — `db/write-gate.ts`'s `sessionWriterId(callerSessionId)`,
   * the same identity every other segment-field writer in `mcp/remember.ts`
   * stamps under. `null`/omitted (the default) skips every stamp, the same
   * "an unidentified caller is never gated, so a stamp attributed to nobody
   * would license nothing" latitude the ordinary `write`/`edit` handlers
   * already give (`mcp/remember.ts`'s `stampSegmentField`).
   */
  writer?: string | null;
}

/**
 * D7's row-list merge (the six Working State fields): `from`'s rows appended
 * after `into`'s, dropping any row BYTE-IDENTICAL to one already kept — a
 * row the source repeats is absorbed silently rather than doubled.
 * Comparison is the stored row text exactly as written (every writer that
 * put a row there already ran it through `normalizeWorkingStateRow`), not a
 * trimmed or case-folded form: spec D7 says "完全相同" (byte-identical), not
 * "相似". `null`/empty inputs contribute nothing; both empty returns `null`,
 * the "empty means null" convention every editable field already follows.
 */
function mergeRowListField(intoText: string | null, fromText: string | null): string | null {
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const text of [intoText, fromText]) {
    if (text === null || text === "") {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line === "" || seen.has(line)) {
        continue;
      }
      seen.add(line);
      rows.push(line);
    }
  }
  return rows.length > 0 ? rows.join("\n") : null;
}

/**
 * D7's prose merge (`content`/`insight`): `from`'s text appended after
 * `into`'s, separated by one blank line — two independent paragraphs, not
 * rows of the same list, so nothing is deduplicated. Either side's exact
 * bytes survive untouched when the other is blank — a one-sided carry gains
 * no gratuitous leading/trailing blank line.
 */
function mergeProseField(intoText: string | null, fromText: string | null): string | null {
  const intoBlank = intoText === null || intoText.trim() === "";
  const fromBlank = fromText === null || fromText.trim() === "";
  if (intoBlank && fromBlank) {
    return null;
  }
  if (intoBlank) {
    return fromText;
  }
  if (fromBlank) {
    return intoText;
  }
  return `${intoText}\n\n${fromText}`;
}

/**
 * `remember(merge)`'s TASK tier (container-unification tickets 08-10, spec
 * D6/D7/D8): `from` hands its members, its lanes, its fields and its derived
 * state to `into`, then leaves the roster. Caller owns existence and
 * `into`-must-be-open checks, re-verified INSIDE the same write transaction
 * this function runs in — the same discipline every other lane/task verb in
 * `mcp/remember.ts` already follows.
 *
 * D6's OWN accounting, in its OWN numbering — the order is hard, and each
 * step's own comment below says why swapping it produces the SAME final
 * state inside one transaction but makes a wrong ordering unobservable
 * rather than merely untested:
 *
 *   1a/1b. LANES FIRST, branching on collision (ticket 10, D8). A free name
 *          relocates onto `into`'s registry by a plain `segment_id` UPDATE —
 *          never a rename, so no edge needs rewriting (see step 2's own
 *          note). A colliding name leaves BOTH rows declared for now, no
 *          new primitive: `mergeLaneTag` (`db/lanes.ts`) takes ONE
 *          `segmentId`, the settlement facade explicitly refuses a
 *          cross-segment lane fold, and `UNIQUE(segment_id, tag)` would
 *          reject relocating `from`'s row onto a name `into` already has.
 *          Without `force` this branch never runs — collision refuses the
 *          WHOLE merge, naming every colliding tag.
 *
 *   2.     MEMBERS SECOND, THROUGH THE GATED WRITE PATH — NEVER EARLIER.
 *          `reassignSegmentMembers` re-asks its own lane-stranding gate
 *          (`findMembershipLaneStrandings`) as it moves `segment_members`,
 *          the SAME gate a plain `note` retag answers to. A member turn
 *          carrying `[from, alpha]`'s "alpha" lane tag can only become
 *          `[into, alpha]` once `into`'s OWN registry already declares
 *          "alpha" — which step 1 is what makes true, colliding or not: a
 *          colliding "alpha" was ALREADY declared on `into` before this
 *          merge started, so the gate needs no special case for it.
 *          Reversing steps 1 and 2 does not silently produce a worse
 *          result: it makes THIS call fail, on exactly the turn whose edge
 *          would otherwise be stranded, and nothing lands.
 *
 *          MEMBERS ARE SELECTED BY OWNERSHIP, NEVER BY TAG. `create`'s own
 *          `members=[...]` seeds `segment_members` WITHOUT adding the
 *          segment's tag to the seeded turns (`handleCreate`'s own doc
 *          comment) — a selection keyed off `turns.tags` would move NONE of
 *          those turns, and this function's own final delete would then
 *          cascade their `segment_members` rows away, leaving them
 *          homeless. `getOwningSegmentId` (the same `MIN(segment_id)`
 *          tie-break `mergeLaneTag` keys its own member query on) is the
 *          read used here instead; the two stores are then reconciled by
 *          BACKFILLING every moved member's own `tags` — dropping `from`'s
 *          word if present, adding `into`'s if it has one — through
 *          `deriveTurnSegmentMembership`, never a bare `UPDATE`, so
 *          `segment_members` is re-confirmed rather than raced against.
 *          This is also where `into`'s `type` facet gets its first
 *          recompute (`addSegmentMembers` -> `recomputeSegmentFacets`,
 *          `db/segments.ts`): every ORDINARY membership move already
 *          recomputes it, `type` being derived from `segment_members`, not
 *          a state column a merge could choose to leave alone.
 *
 *   3.     FIELDS (ticket 09, D7). The eight editable fields — six
 *          row-lists appended-and-deduplicated, `content`/`insight`
 *          appended with a blank line between — land in ONE `UPDATE`.
 *          `title` is untouched: the merged container keeps `into`'s name.
 *
 *   4.     SEGMENT-LEVEL EDGES (D9). No write at all: a stored edge side
 *          resolves through its ENDPOINT's OWNING segment, never a segment
 *          id of its own (`db/lanes.ts`'s `makeSideOwnershipResolver` is the
 *          identical judgment), so the moment a member's ownership moved in
 *          step 2, any edge naming its lane already resolves to `into`
 *          without a byte changing on the edge row itself.
 *
 *   5.     DERIVED STATE + WRITE AUTHORIZATION (ticket 09, D6). `into`'s
 *          `type` recompute (step 2) ran its OWN FTS reindex BEFORE step 3
 *          landed the field text — a premature projection that would show
 *          `from`'s prose on the card while `recall(query=…)` still could
 *          not find it. So: `into` is reindexed and its citations
 *          reconciled AGAIN here, once, now that fields have settled — the
 *          corrected, final projection. Then every one of the eight fields
 *          this merge actually changed is write-gate STAMPED (never
 *          checked — merge is a structural act the caller invoked directly,
 *          not a value it typed over content it read, so there is nothing
 *          to require a complete read of): otherwise a writer who fully
 *          read `into`'s pre-merge content still holds a valid grant and
 *          can silently overwrite the just-imported text with what it read
 *          before the merge landed.
 *
 *   6a.    COLLIDING SOURCE LANES, emptied by step 2, undeclared under a
 *          guard PAIRED with the delete (ticket 10) — `from`'s copy only;
 *          `into`'s own same-named lane survives untouched, exactly as if
 *          the two had always been one.
 *
 *   6b.    `from` LEAVES THE ROSTER, guard paired with the delete
 *          (`deleteEmptiedSegment` below, unchanged since ticket 08) — the
 *          same shape `db/lanes.ts`'s `undeclareEmptiedLane` is. Checking
 *          "is `from` empty" any earlier than the statement that removes it
 *          produces, inside one transaction, the SAME final state as
 *          checking it here — nothing observable afterwards could tell the
 *          two apart. The pairing is what makes the ordering above
 *          checkable at all: move the check above the member move and it
 *          THROWS (evaluated while `from` still owns members), rather than
 *          silently leaving a task nobody can remove. `deleteSegmentRow`
 *          (this file) is what actually clears `from`'s `memory_fts` row
 *          and its three `write_gate_*` rows — the SOURCE side of
 *          population 5's cleanup, no foreign key reaching either.
 *
 * SESSION ATTACHMENTS DO NOT MIGRATE (user ruling, no numbered step of its
 * own in D6's list). `segment_attachments`/`segment_detachments` both carry
 * `REFERENCES segments(id) ON DELETE CASCADE` (schema.ts,
 * `deleteSegmentRow`'s own doc comment) — neither is touched anywhere in
 * this function; they vanish with `from`'s row in step 6b, which is exactly
 * what "does not migrate" asks for.
 */
export function mergeSegments(
  db: Database,
  fromId: number,
  intoId: number,
  nowEpoch: number,
  options: SegmentMergeOptions = {},
): SegmentMergeOutcome {
  const force = options.force === true;
  const writer = options.writer ?? null;

  // --- 1a/1b. lanes, branching on collision (ticket 10, D8) --------------
  const fromLaneTags = db
    .query<{ tag: string }, [number]>(
      "SELECT tag FROM lanes WHERE segment_id = ? ORDER BY tag ASC",
    )
    .all(fromId)
    .map((row) => row.tag);

  let colliding: string[] = [];
  if (fromLaneTags.length > 0) {
    const intoLaneTags = new Set(
      db
        .query<{ tag: string }, [number]>("SELECT tag FROM lanes WHERE segment_id = ?")
        .all(intoId)
        .map((row) => row.tag),
    );
    colliding = fromLaneTags.filter((tag) => intoLaneTags.has(tag));
    if (colliding.length > 0 && !force) {
      return { kind: "lane-collision", tags: colliding };
    }
    const collidingSet = new Set(colliding);
    const relocateLane = db.query<unknown, [number, number, string]>(
      "UPDATE lanes SET segment_id = ? WHERE segment_id = ? AND tag = ?",
    );
    for (const tag of fromLaneTags) {
      if (collidingSet.has(tag)) {
        // 1b: leave BOTH registry rows declared for now — `into`'s copy is
        // what satisfies step 2's write gate for a member carrying this
        // tag; `from`'s copy is undeclared later, in step 6a, once it is
        // provably empty.
        continue;
      }
      relocateLane.run(intoId, fromId, tag);
    }
  }

  // --- 2. members -------------------------------------------------------
  const memberTurnIds = db
    .query<{ id: number }, [number]>(
      `SELECT t.id AS id FROM turns t
        WHERE (SELECT MIN(sm.segment_id) FROM segment_members sm WHERE sm.turn_id = t.id) = ?
        ORDER BY t.id ASC`,
    )
    .all(fromId)
    .map((row) => row.id);

  // `from`'s own task tag, read now, before anything below rewrites a turn's
  // `tags` — population 2b needs it whether or not `memberTurnIds` found
  // anyone, because an orphan turn (tag present, no `segment_members` row)
  // is exactly what that SELECT above cannot see.
  const fromSegmentForTag = getSegment(db, fromId);
  const fromTag = fromSegmentForTag ? segmentTagOf(fromSegmentForTag) : null;

  let membersMoved = 0;
  if (memberTurnIds.length > 0) {
    // AN UNNAMED DESTINATION CANNOT HOLD MEMBERS (peer review [S15069/T1773],
    // reproduced). Membership is DERIVED from a turn's own task tag, so the
    // backfill below strips `fromTag` and has no `intoTag` to put in its
    // place; `deriveTurnSegmentMembership` then deletes the very rows
    // `reassignSegmentMembers` just wrote. The merge went on to delete the
    // source and hand back `kind: "merged", membersMoved: 1` — a success
    // receipt over an orphaned turn and a destroyed container. Refused before
    // anything moves, because there is no ordering of these writes that
    // preserves the invariant: the destination has to be nameable first.
    const destination = getSegment(db, intoId);
    if (destination !== null && segmentTagOf(destination) === null) {
      return {
        kind: "members-blocked",
        message:
          `E${intoId} has no task tag, and membership is derived from one — moving E${fromId}'s ` +
          `${memberTurnIds.length} member turn(s) there would leave every one of them unowned. ` +
          `Name E${intoId} first (remember(retag, id="E${intoId}", tag=…)), then merge.`,
      };
    }

    const moved = reassignSegmentMembers(db, memberTurnIds, intoId, nowEpoch);
    if (!moved.ok) {
      return { kind: "members-blocked", message: moved.message };
    }
    membersMoved = memberTurnIds.length;

    const intoSegment = getSegment(db, intoId);
    const intoTag = intoSegment ? segmentTagOf(intoSegment) : null;

    const readTags = db.query<{ tags: string | null }, [number]>(
      "SELECT tags FROM turns WHERE id = ?",
    );
    const updateTurnTags = db.query<unknown, [string, number]>(
      "UPDATE turns SET tags = ? WHERE id = ?",
    );
    for (const turnId of memberTurnIds) {
      const raw = readTags.get(turnId)?.tags ?? "[]";
      let stored: string[];
      try {
        const parsed = JSON.parse(raw) as unknown;
        stored = Array.isArray(parsed)
          ? parsed.filter((value): value is string => typeof value === "string")
          : [];
      } catch {
        stored = [];
      }
      let next = fromTag !== null ? stored.filter((value) => value !== fromTag) : stored.slice();
      if (intoTag !== null && !next.includes(intoTag)) {
        // Prepended, not appended — the segment's own tag leads the array in
        // every other write path this codebase has (`create`, `mergeLaneTag`'s
        // own fixtures), and `deriveTurnSegmentMembership` reads the FIRST
        // tag naming a segment, so leading position is also where a reader
        // looks first for "whose segment is this".
        next = [intoTag, ...next];
      }
      const changed =
        next.length !== stored.length || next.some((value, index) => value !== stored[index]);
      if (changed) {
        updateTurnTags.run(JSON.stringify(next), turnId);
      }
      deriveTurnSegmentMembership(db, turnId, next, nowEpoch);
    }
  }

  // --- 2b. turns still carrying `fromTag` after the retag (lane-merge-
  //         skip-receipt ticket 01, criterion 4) --------------------------
  // Read AFTER the loop above: every turn it actually moved lost `fromTag` a
  // few statements earlier, so a match here is not a prediction — it fell
  // outside population 2's `segment_members` restriction and was never
  // touched.
  const stillCarrying =
    fromTag !== null
      ? db
          .query<{ id: number }, [string]>(
            `SELECT t.id AS id FROM turns t
              WHERE CASE
                      WHEN json_valid(t.tags) AND json_type(t.tags) = 'array'
                        THEN EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)
                      ELSE 0
                    END
              ORDER BY t.id ASC`,
          )
          .all(fromTag)
          .map((row) => turnAddress(db, row.id))
      : [];

  // --- 3. fields (ticket 09, D7) ------------------------------------------
  const fromForFields = getSegment(db, fromId);
  const intoForFields = getSegment(db, intoId);
  if (!fromForFields || !intoForFields) {
    throw new SegmentMergeInvariantError(
      `merge could not read E${fromId} or E${intoId} for its own field merge — ` +
        "one disappeared mid-transaction.",
    );
  }
  const mergedFields = mapSegmentRow(
    db
      .query<
        SegmentRow,
        [
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          number,
          number,
        ]
      >(
        `UPDATE segments SET
           goal = ?, constraints = ?, decisions = ?, done = ?,
           next_steps = ?, reference = ?, content = ?, insight = ?,
           updated_at_epoch = ?
         WHERE id = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(
        mergeRowListField(intoForFields.goal, fromForFields.goal),
        mergeRowListField(intoForFields.constraints, fromForFields.constraints),
        mergeRowListField(intoForFields.decisions, fromForFields.decisions),
        mergeRowListField(intoForFields.done, fromForFields.done),
        mergeRowListField(intoForFields.nextSteps, fromForFields.nextSteps),
        mergeRowListField(intoForFields.reference, fromForFields.reference),
        mergeProseField(intoForFields.content, fromForFields.content),
        mergeProseField(intoForFields.insight, fromForFields.insight),
        nowEpoch,
        intoId,
      ) ?? null,
  );
  if (!mergedFields) {
    throw new SegmentMergeInvariantError(
      `merge could not rewrite E${intoId}'s fields — the row disappeared mid-transaction.`,
    );
  }

  // --- 4. segment-level edges (D9): no write — see this function's own doc
  //        comment. Nothing to do here.

  // --- 5. derived state + write authorization (ticket 09, D6) -------------
  // FTS + citation reconciliation, ONCE, now that step 3 has settled every
  // field — the corrected, final projection over step 2's premature one.
  indexSegment(db, mergedFields);
  reconcileSegmentCitedPairs(db, mergedFields, nowEpoch);

  if (writer) {
    const stampIfChanged = (
      field: SegmentEditableField,
      before: string | null,
      after: string | null,
    ): void => {
      if (before !== after) {
        stampField(db, "segment", intoId, field, writer, nowEpoch);
      }
    };
    stampIfChanged("goal", intoForFields.goal, mergedFields.goal);
    stampIfChanged("constraints", intoForFields.constraints, mergedFields.constraints);
    stampIfChanged("decisions", intoForFields.decisions, mergedFields.decisions);
    stampIfChanged("done", intoForFields.done, mergedFields.done);
    stampIfChanged("next_steps", intoForFields.nextSteps, mergedFields.nextSteps);
    stampIfChanged("reference", intoForFields.reference, mergedFields.reference);
    stampIfChanged("content", intoForFields.content, mergedFields.content);
    stampIfChanged("insight", intoForFields.insight, mergedFields.insight);
  }

  // --- 6a. colliding source lanes, emptied by step 2, undeclared under a
  //         guard paired with the delete (ticket 10) ----------------------
  for (const tag of colliding) {
    const remaining =
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
        .get(fromId, tag)?.n ?? 0;
    if (remaining > 0) {
      throw new SegmentMergeInvariantError(
        `merge (force) would undeclare E${fromId}'s lane "${tag}" while ${remaining} member turn(s) ` +
          "still carry it — members are rewritten in step 2, BEFORE a colliding source lane is taken away.",
      );
    }
    db.query<unknown, [number, string]>(
      "DELETE FROM lanes WHERE segment_id = ? AND tag = ?",
    ).run(fromId, tag);
  }

  // --- 6b. the guard, paired with the delete ------------------------------
  deleteEmptiedSegment(db, fromId);

  return {
    kind: "merged",
    receipt: {
      from: fromId,
      into: intoId,
      membersMoved,
      lanesMoved: fromLaneTags.length,
      stillCarrying,
    },
  };
}

/**
 * THE ONLY PATH BY WHICH `mergeSegments` TAKES `from` OFF THE ROSTER, and the
 * check and the delete are one statement on purpose — see population 6b of
 * `mergeSegments`'s own doc comment above; this is the same pairing
 * `db/lanes.ts`'s `undeclareEmptiedLane` is, for the identical reason.
 */
function deleteEmptiedSegment(db: Database, segmentId: number): void {
  const remainingMembers = getSegmentMemberTurnIds(db, segmentId).length;
  const remainingLanes =
    db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM lanes WHERE segment_id = ?")
      .get(segmentId)?.n ?? 0;
  if (remainingMembers > 0 || remainingLanes > 0) {
    throw new SegmentMergeInvariantError(
      `merge would remove E${segmentId} while it still owns ${remainingMembers} member turn(s) and ` +
        `${remainingLanes} lane(s) — the members and lanes are handed to the survivor BEFORE this task ` +
        "leaves the roster, never after.",
    );
  }
  deleteSegmentRow(db, segmentId);
}

// ---------------------------------------------------------------------------
// Attachment (ADR-0005) — the session↔segment binding. `attachSegmentToSession`
// is a pure idempotent assertion, the same `ON CONFLICT … DO NOTHING` idiom
// `addSegmentMembers` uses for membership. Consulted-only attachments (zero
// members) are legal by construction — this table has no relationship to
// `segment_members` at all.
//
// lane-model-v12 ticket 17 amends ADR-0005's "rows accumulate, never expire, no
// detach verb" on ONE point: `detachSegmentFromSession` exists now. The reason
// the original rule held was that every row was a deliberate human act, so
// nothing accumulated that the session had not asked for. Auto-attach (ruling
// [S15069/T1663]) breaks that premise — a tags write now mints a binding as a
// side effect — so the session needs a way back. Detach deletes the binding
// row; it touches NOTHING else (membership is derived from a turn's own tags
// and is unaffected, and no grant, stamp or member row keys off attachment).
//
// TICKET 23 gives that way back a stable meaning. Detach used to delete a row
// the very next tags write would mint again, which made the verb an undo of one
// call rather than a decision — so a detach now also RECORDS itself, in
// `segment_detachments`, and auto-attach refuses a pair that carries such a
// record. The two tables are mutually exclusive per pair by construction: each
// writer below deletes the other's row in the same call, so no reader ever has
// to decide which of two contradictory rows wins.
//
// PER (session, segment), not per session: the verb's object is a segment, and
// a session-wide "auto-attach off" switch would veto segments the user never
// named — killing, for those, the circular dependency auto-attach exists to
// dissolve (you need a card to know a segment's lanes, ticket 17). Detaching
// E5 says nothing about E9.
// ---------------------------------------------------------------------------

export interface AttachSegmentResult {
  /** `false` when the binding already existed — idempotent, not an error. */
  attached: boolean;
}

/**
 * Assert the binding. Ticket 23: this also CLEARS any recorded detachment for
 * the pair — attaching is the way back the ticket names ("要回来走菜单或
 * `remember(attach)`"), and a pair that is attached cannot also be refused.
 * Auto-attach reaches this function only after `isSegmentDetachedFromSession`
 * has already said there is nothing to clear, so in practice the delete fires
 * for the explicit paths (`remember(attach)` and the menu behind it) alone.
 */
export function attachSegmentToSession(
  db: Database,
  sessionId: number,
  segmentId: number,
  nowEpoch: number,
): AttachSegmentResult {
  db.query<unknown, [number, number]>(
    "DELETE FROM segment_detachments WHERE session_id = ? AND segment_id = ?",
  ).run(sessionId, segmentId);
  const row = db
    .query<{ inserted: number }, [number, number, number]>(
      `INSERT INTO segment_attachments (session_id, segment_id, created_at_epoch)
       VALUES (?, ?, ?)
       ON CONFLICT (session_id, segment_id) DO NOTHING
       RETURNING 1 AS inserted`,
    )
    .get(sessionId, segmentId, nowEpoch);
  return { attached: row !== null };
}

function recordSegmentDetachment(
  db: Database,
  sessionId: number,
  segmentId: number,
  nowEpoch: number,
): void {
  db.query<unknown, [number, number, number]>(
    `INSERT INTO segment_detachments (session_id, segment_id, created_at_epoch)
     VALUES (?, ?, ?)
     ON CONFLICT (session_id, segment_id) DO NOTHING`,
  ).run(sessionId, segmentId, nowEpoch);
}

/**
 * The inverse of `attachSegmentToSession` (lane-model-v12 ticket 17): drop one
 * of this session's bindings, or — with `segmentId` omitted — every one of
 * them. Idempotent in the same sense attach is: `detached` is the number of
 * rows that actually went away, and zero is a fact to report, not an error.
 *
 * Ticket 23 — WHICH pairs the refusal is recorded for:
 *
 *  - the NAMED form records `segmentId` whether or not a binding was there to
 *    delete. The caller named a segment and asked for an end state; "S<n> is
 *    not attached to E<m>" is that end state, and making the record conditional
 *    on the binding existing at that instant would mean the same call sticks or
 *    does not depending on ordering the caller cannot see.
 *  - the BARE form records exactly the pairs it removed, because it names no
 *    segment and a session with no bindings has nothing to refuse. Bare detach
 *    on an unattached session is therefore a true no-op, not a standing
 *    "never auto-attach me" — there is no verb for that and ticket 23 does not
 *    ask for one.
 */
export function detachSegmentFromSession(
  db: Database,
  sessionId: number,
  segmentId?: number,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): { detached: number } {
  const rows =
    segmentId === undefined
      ? db
          .query<{ segmentId: number }, [number]>(
            `DELETE FROM segment_attachments WHERE session_id = ?
             RETURNING segment_id AS segmentId`,
          )
          .all(sessionId)
      : db
          .query<{ segmentId: number }, [number, number]>(
            `DELETE FROM segment_attachments WHERE session_id = ? AND segment_id = ?
             RETURNING segment_id AS segmentId`,
          )
          .all(sessionId, segmentId);

  if (segmentId === undefined) {
    for (const row of rows) {
      recordSegmentDetachment(db, sessionId, row.segmentId, nowEpoch);
    }
  } else {
    recordSegmentDetachment(db, sessionId, segmentId, nowEpoch);
  }
  return { detached: rows.length };
}

/**
 * Ticket 23's second boundary, asked at the one place that needs it: has this
 * session explicitly refused this segment? `true` means auto-attach must leave
 * the binding alone — the session comes back through the menu or
 * `remember(attach)`, both of which clear the record above.
 */
export function isSegmentDetachedFromSession(
  db: Database,
  sessionId: number,
  segmentId: number,
): boolean {
  return (
    db
      .query<{ one: number }, [number, number]>(
        "SELECT 1 AS one FROM segment_detachments WHERE session_id = ? AND segment_id = ?",
      )
      .get(sessionId, segmentId) !== null
  );
}

/** Every segment id the session has ever attached, oldest attachment first. */
export function getAttachedSegmentIds(db: Database, sessionId: number): number[] {
  return db
    .query<{ segmentId: number }, [number]>(
      `SELECT segment_id AS segmentId FROM segment_attachments
       WHERE session_id = ? ORDER BY created_at_epoch ASC, segment_id ASC`,
    )
    .all(sessionId)
    .map((row) => row.segmentId);
}

/**
 * The full records behind `getAttachedSegmentIds`, same ordering (ticket 08)
 * — settlement's own membership scope needs the title/status to RENDER a
 * pickable list, not just the ids `SettlementTurnFacadeContext.attachedSegmentIds`
 * validates against. A row whose segment has since been deleted (no
 * production writer does this today, but the FK has no ON DELETE guarantee
 * of its own beyond CASCADE on the attachment row itself) is silently
 * skipped rather than surfaced as a null gap — the same "a stale id is not
 * this reader's problem to explain" discipline `listRecentSegments` already
 * keeps.
 */
export function listAttachedSegments(db: Database, sessionId: number): SegmentRecord[] {
  return getAttachedSegmentIds(db, sessionId)
    .map((segmentId) => getSegment(db, segmentId))
    .filter((segment): segment is SegmentRecord => segment !== null);
}

/**
 * The reverse of `getAttachedSegmentIds` (ticket 03): every session that has
 * ever attached THIS segment, oldest attachment first — the segment card's
 * `sessions` line needs the opposite direction from what remember's own
 * write path ever needed.
 */
export function getAttachedSessionIds(db: Database, segmentId: number): number[] {
  return db
    .query<{ sessionId: number }, [number]>(
      `SELECT session_id AS sessionId FROM segment_attachments
       WHERE segment_id = ? ORDER BY created_at_epoch ASC, session_id ASC`,
    )
    .all(segmentId)
    .map((row) => row.sessionId);
}

export interface SegmentFacetCount {
  word: string;
  count: number;
}

export interface SegmentMemberFacetCounts {
  type: SegmentFacetCount[];
  tags: SegmentFacetCount[];
}

/**
 * Per-word/per-tag MEMBER counts (ticket 03), era-scoped to match whatever
 * member set the card's own member listing renders — a reader-facing tally,
 * "how many members carry each type word / tag", independent of
 * `recomputeSegmentFacets`. Its `type` half orders the same way that
 * function's own persisted `segment.type` does (frequency descending, ties by
 * `MEMORY_TYPES`' own order), so a type count line's ORDER never disagrees
 * with the stored array it is elaborating on.
 *
 * TICKET 07 (rubric-v10): its `tags` half is now display-only and
 * DELIBERATELY UNRELATED to `segment.tags` — that column is hand-curated
 * identity (never derived from members, see `recomputeSegmentFacets`'s own
 * doc comment), while this tally still counts every MEMBER's own tags,
 * frequency-ordered (`compareDerivedTags`), the way a card reader inspects
 * what the membership actually looks like regardless of what the segment's
 * own tags say a member is required to carry.
 */
export function computeSegmentMemberFacetCounts(
  db: Database,
  segmentId: number,
  eraCutoffEpoch: number | null = null,
): SegmentMemberFacetCounts {
  const era = eraVisibleMemberSqlClause("t", eraCutoffEpoch);
  const members = db
    .query<{ type: string | null; tags: string | null }, number[]>(
      // Facets summarise the CONTENT INDEX, not the graph, so they follow the
      // member listing ([S15069/T915]: a rewound member stays visible, marked)
      // rather than law 8's node set. Same reason as `rankSegmentMembers`.
      //
      // Era-scoped through `eraVisibleMemberSqlClause` (era-grant-by-settlement
      // ticket 01), the same clause `rankSegmentMembers` filters on: this tally
      // elaborates on the member listing, so counting a member set that listing
      // does not render would make the card contradict itself.
      `SELECT t.type AS type, t.tags AS tags
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE sm.segment_id = ?
         ${era.clause === "" ? "" : `AND ${era.clause}`}`,
    )
    .all(segmentId, ...era.params);

  const typeCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const member of members) {
    for (const word of new Set(parseMemberFacetArray(member.type))) {
      typeCounts.set(word, (typeCounts.get(word) ?? 0) + 1);
    }
    for (const tag of new Set(parseMemberFacetArray(member.tags))) {
      if (tag.includes(":") || tag.trim() === "") {
        continue;
      }
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const type = MEMORY_TYPES.filter((word) => typeCounts.has(word))
    .map((word) => ({ word, count: typeCounts.get(word)! }))
    .sort((left, right) => right.count - left.count);
  const tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort(compareDerivedTags)
    .map(({ tag, count }) => ({ word: tag, count }));

  return { type, tags };
}

/**
 * Segments ordered by activity (ticket 03, spec ADR-0005's roster rule
 * generalised to the bare `recall()` listing): the more recent of the
 * segment's OWN last field edit (`updated_at_epoch`) and its most recently
 * added member turn. Membership does not bump `updated_at_epoch` (see
 * `addSegmentMembers`), so a segment whose Working State has gone quiet but
 * which just gained a new member still reads as active — the roster's own
 * "recency of last member or state edit" rule (ADR-0005), not just the
 * column `listRecentSegments` already sorts by.
 */
export function listSegmentsByActivity(db: Database, limit: number): SegmentRecord[] {
  if (limit <= 0) {
    return [];
  }
  return db
    .query<SegmentRow, [number]>(
      `SELECT ${JOINED_SEGMENT_COLUMNS} FROM segments s
       LEFT JOIN (
         SELECT sm.segment_id AS segmentId, MAX(t.created_at_epoch) AS lastMemberEpoch
         FROM segment_members sm
         JOIN turns t ON t.id = sm.turn_id
         GROUP BY sm.segment_id
       ) activity ON activity.segmentId = s.id
       ORDER BY MAX(s.updated_at_epoch, COALESCE(activity.lastMemberEpoch, 0)) DESC, s.id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
}

/**
 * The one "live" predicate `listLiveSegmentsByActivity` and
 * `countLiveSegments` both filter on (ticket 02's own acceptance criterion:
 * "溢出计数与候选集用同一判据" — the overflow count and the candidate set
 * must never disagree about the total). Two facts, not one: `status =
 * 'open'` (ticket 05 — a `closed` segment leaves the roster) AND, when an
 * era cutoff is given, `created_at_epoch >= eraCutoffEpoch` (ticket 02 — a
 * pre-redesign legacy arc-segment never belongs on the roster, whatever its
 * status). Neither fact substitutes for the other: a legacy row can carry
 * `status = 'open'` (the bug this ticket fixes), and a brand-new segment can
 * be `closed`.
 *
 * `eraCutoffEpoch: null` (the default on both public functions below) is
 * INERT — status-only, byte-for-byte the predicate both functions used
 * before this ticket — same "null means every row reads as it always did"
 * idiom `computeSegmentMemberFacetCounts` above and `isSegmentEra`
 * (segment-era.ts) already use. This is deliberate, not a placeholder to
 * finish later: the one production caller, `renderSegmentRoster`
 * (hooks/session-composition.ts), is outside this ticket's file scope, so
 * threading the real cutoff into ITS call sites is a follow-up one line
 * away (`countLiveSegments(db, SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH)` /
 * `listLiveSegmentsByActivity(db, limit, SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH)`)
 * rather than something this change can silently do FOR that file without
 * risking exactly the collision it was told to avoid.
 */
function liveSegmentWhereClause(eraCutoffEpoch: number | null): {
  clause: string;
  params: number[];
} {
  return eraCutoffEpoch === null
    ? { clause: "s.status = 'open'", params: [] }
    : {
        clause: "s.status = 'open' AND s.created_at_epoch >= ?",
        params: [eraCutoffEpoch],
      };
}

/**
 * The SessionStart roster's candidate set (ticket 10): live segments only,
 * activity-ordered like `listSegmentsByActivity`.
 *
 * "Live" excludes the frozen pre-redesign rows ADR-0005 counted at 47 and
 * ruled "absent from the roster" — see `SEGMENT_CONTAINER_ERA_CUTOFF_EPOCH`
 * for why this can no longer be inferred from `status` alone, and
 * `liveSegmentWhereClause` above for why `eraCutoffEpoch` defaults to `null`
 * (inert) rather than that constant.
 */
export function listLiveSegmentsByActivity(
  db: Database,
  limit: number,
  eraCutoffEpoch: number | null = null,
): SegmentRecord[] {
  if (limit <= 0) {
    return [];
  }
  const where = liveSegmentWhereClause(eraCutoffEpoch);
  return db
    .query<SegmentRow, number[]>(
      `SELECT ${JOINED_SEGMENT_COLUMNS}
       FROM segments s
       LEFT JOIN (
         SELECT sm.segment_id AS segmentId, MAX(t.created_at_epoch) AS lastMemberEpoch
         FROM segment_members sm
         JOIN turns t ON t.id = sm.turn_id
         GROUP BY sm.segment_id
       ) activity ON activity.segmentId = s.id
       WHERE ${where.clause}
       ORDER BY MAX(s.updated_at_epoch, COALESCE(activity.lastMemberEpoch, 0)) DESC, s.id DESC
       LIMIT ?`,
    )
    .all(...where.params, limit)
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
}

/** Same predicate as `listLiveSegmentsByActivity` (`liveSegmentWhereClause`), unpaged — the roster's overflow count. */
export function countLiveSegments(
  db: Database,
  eraCutoffEpoch: number | null = null,
): number {
  const where = liveSegmentWhereClause(eraCutoffEpoch);
  return (
    db
      .query<{ count: number }, number[]>(
        `SELECT COUNT(*) AS count FROM segments s WHERE ${where.clause}`,
      )
      .get(...where.params)?.count ?? 0
  );
}

/**
 * The session's attached segments, activity-ordered (ticket 10) — which
 * attachments fill the fixed SessionStart block-slot pool when the session
 * has attached more segments than the pool has slots for. Unlike the
 * roster this is NOT status-filtered: an attachment is loaded working
 * memory regardless of the segment's status — a session that attached a
 * segment before it froze still gets its fields and milestones rendered.
 */
export function listAttachedSegmentsByActivity(
  db: Database,
  sessionId: number,
  limit: number,
): SegmentRecord[] {
  if (limit <= 0) {
    return [];
  }
  return db
    .query<SegmentRow, [number, number]>(
      `SELECT ${JOINED_SEGMENT_COLUMNS} FROM segments s
       JOIN segment_attachments sa ON sa.segment_id = s.id AND sa.session_id = ?
       LEFT JOIN (
         SELECT sm.segment_id AS segmentId, MAX(t.created_at_epoch) AS lastMemberEpoch
         FROM segment_members sm
         JOIN turns t ON t.id = sm.turn_id
         GROUP BY sm.segment_id
       ) activity ON activity.segmentId = s.id
       ORDER BY MAX(s.updated_at_epoch, COALESCE(activity.lastMemberEpoch, 0)) DESC, s.id DESC
       LIMIT ?`,
    )
    .all(sessionId, limit)
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
}
