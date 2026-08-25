import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { getEdgesByTag } from "./memory-edges";
import { getOwningSegmentId } from "./segments";
import { liveTurnSql } from "./turn-liveness";

/**
 * Lane registry (lane-declaration spec Rev 2, D1). A lane is a DECLARED
 * object identified by `(segment, ONE tag)` — no title, the tag is the name
 * (the card pays per character, D1's own note). `declare`/`undeclare`
 * (mcp/remember.ts) are this ticket's only writers. Membership — which
 * edges carry the tag — is never mirrored here: it lives entirely in
 * `memory_edges.tags`, and D2's edge-write gate (a later ticket) is what
 * makes declaration a PRECONDITION of that membership.
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
// Canonical tag predicate (D1, peer P2-10). Stored form: NFC-normalized,
// trimmed, lowercase, non-empty, no interior whitespace. `declare` (and,
// this module's own symmetric choice, `undeclare`) REFUSE a value that is
// not ALREADY in this exact form — never silently canonicalize — so
// "write-gate" / "Write-Gate" / " write-gate " can never become three
// lanes. Checked in a fixed order so a value failing several rules at once
// still gets ONE clear, reproducible reason.
// ---------------------------------------------------------------------------

export type LaneTagCanonicalViolation =
  | "empty"
  | "not-trimmed"
  | "interior-whitespace"
  | "mixed-case"
  | "not-nfc";

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
  return { ok: true };
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

/** Idempotent insert — `null` when `(segmentId, tag)` already exists (a caller lost a race, or never pre-checked). */
export function insertLane(
  db: Database,
  segmentId: number,
  tag: string,
  nowEpoch: number,
): LaneRecord | null {
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
 * `undeclare`'s own guard (D4): how many LIVE turn↔turn edges still carry
 * `tag` with AT LEAST ONE endpoint owned by `segmentId` — cross-segment edges
 * count for BOTH segments (D2's "consulted once per endpoint" rule), so an
 * edge does not have to belong wholly to this segment to keep its lane
 * alive here. Reads through `getEdgesByTag` (memory-edges.ts) rather than a
 * second tag index, so this can never disagree with what that module
 * itself considers "carrying" a tag.
 *
 * LAW 8 (rubric v11, `skip/rewind`: "被 skip 或 rewind 的 turn 不是节点，不得
 * 作为边的端点"; `db/turn-liveness.ts`). Both endpoints are checked with
 * `liveTurnSql`, the SAME predicate the checker's own loader
 * (`db/lane-checker-load.ts`'s `loadTaggedEdgesTouching`/`loadEdgesForTag`)
 * applies to both endpoints of every edge it reads. Without this the guard
 * counted rows that exist in no graph any reader can see and refused the
 * `undeclare` that would clear them — a lane used normally and then skipped
 * deadlocked permanently, with no repair path at all (its edges are dormant,
 * so nothing can retag them either).
 *
 * WHY THE FILTER LIVES HERE AND NOT IN `getEdgesByTag`. That query is the tag
 * INDEX's own read-back — "which rows does `memory_edge_tags` currently name"
 * — and both its tests and `rebuildMemoryEdgeTagsIndex`'s round-trip read it
 * that way; a liveness filter there would silently redefine "carries this
 * tag" for the index itself. It is also kind-agnostic by construction, so the
 * filter could not be a plain join to `turns` anyway (that would drop every
 * non-turn-endpoint row outright, and a note id colliding with a turn id
 * would match the wrong row) — it would have to become a kind-aware graph
 * query for the benefit of its single caller. The GRAPH question ("is this
 * lane still in use") is this function's, so the graph's own liveness law is
 * applied at this level, one layer above the index.
 */
export function countEdgesCarryingTagInSegment(
  db: Database,
  segmentId: number,
  tag: string,
): number {
  const liveTurn = db.query<{ x: number }, [number]>(
    `SELECT 1 AS x FROM turns WHERE id = ? AND ${liveTurnSql()}`,
  );
  let count = 0;
  for (const edge of getEdgesByTag(db, tag)) {
    if (edge.citing.kind !== "turn" || edge.cited.kind !== "turn") {
      continue;
    }
    // LAW 8: a skipped or rolled-back endpoint means this row is not an edge
    // in any graph, so it holds no lane open.
    if (liveTurn.get(edge.citing.id) === null || liveTurn.get(edge.cited.id) === null) {
      continue;
    }
    const citingSegmentId = getOwningSegmentId(db, edge.citing.id);
    const citedSegmentId = getOwningSegmentId(db, edge.cited.id);
    if (citingSegmentId === segmentId || citedSegmentId === segmentId) {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Migration receipts (D6, shared shell)
// ---------------------------------------------------------------------------

interface MigrationReceiptPayloadRow {
  payload: string;
}

function hasMigrationReceipt(db: Database, name: string): boolean {
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
function writeMigrationReceipt(
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
  let totalSeeded = 0;
  const segmentIds = [...wantedTagsBySegment.keys()].sort((a, b) => a - b);
  for (const segmentId of segmentIds) {
    const tags = [...wantedTagsBySegment.get(segmentId)!].sort();
    let count = 0;
    for (const tag of tags) {
      if (insertLane(db, segmentId, tag, nowEpoch)) {
        count += 1;
        totalSeeded += 1;
      }
    }
    perSegment.push({ segmentId, count });
  }

  return { perSegment, totalSeeded };
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
function resolveTurnAddress(db: Database, turnId: number): string {
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
const EMPTY_SEED_RECEIPT: LaneMigrationSeedReceipt = { perSegment: [], totalSeeded: 0 };
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
 * forbids. `memory_edge_tags` rows go with it (that table cascades on
 * `memory_edges(id)`, but the delete is issued explicitly so the phase does
 * not depend on `PRAGMA foreign_keys` being on).
 *
 * READS NO LANE COLUMN, deliberately — not `tags`, not `tail_tag`/`head_tag`.
 * This phase shares `runLaneModelV12EdgeMigration` with the expand/contract
 * work of v12 tickets 05/09, so whichever side of that contraction it happens
 * to run on, its query must still resolve. The receipt therefore records the
 * endpoint, the relation and the provenance, and no tag payload.
 *
 * Idempotent by receipt, and independently idempotent by predicate: a second
 * run finds no self rows even if the receipt were lost.
 */
export function runLaneModelV12SelfEdgeRetraction(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
  runWriteTransaction(db, () => {
    if (hasMigrationReceipt(db, LANE_MODEL_V12_SELF_EDGE_RETRACTION_RECEIPT)) {
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

    const clearTagIndex = db.query<unknown, [number]>(
      "DELETE FROM memory_edge_tags WHERE edge_row_id = ?",
    );
    const deleteEdge = db.query<unknown, [number]>("DELETE FROM memory_edges WHERE id = ?");

    const retracted: LaneModelV12RetractedSelfEdge[] = [];
    for (const row of rows) {
      clearTagIndex.run(row.id);
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
