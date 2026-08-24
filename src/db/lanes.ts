import type { Database } from "bun:sqlite";

import { runWriteTransaction } from "./database";
import { getEdgesByTag } from "./memory-edges";
import { getOwningSegmentId } from "./segments";

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
 * `undeclare`'s own guard (D4): how many turn↔turn edges still carry `tag`
 * with AT LEAST ONE endpoint owned by `segmentId` — cross-segment edges
 * count for BOTH segments (D2's "consulted once per endpoint" rule), so an
 * edge does not have to belong wholly to this segment to keep its lane
 * alive here. Reads through `getEdgesByTag` (memory-edges.ts) rather than a
 * second tag index, so this can never disagree with what that module
 * itself considers "carrying" a tag.
 */
export function countEdgesCarryingTagInSegment(
  db: Database,
  segmentId: number,
  tag: string,
): number {
  let count = 0;
  for (const edge of getEdgesByTag(db, tag)) {
    if (edge.citing.kind !== "turn" || edge.cited.kind !== "turn") {
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
  /** Tags this pass could not canonicalize; empty when the whole column was unreadable. */
  droppedTags: string[];
  reason: "malformed-tags-column" | "no-canonical-tag";
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
 */
function classifyTaggedEdges(db: Database): LaneMigrationClassification {
  const rows = db
    .query<TaggedEdgeRow, []>(
      `SELECT id, citing_id AS citingId, cited_id AS citedId, relation, tags
       FROM memory_edges
       WHERE citing_kind = 'turn' AND cited_kind = 'turn'
         AND relation IS NOT NULL
         AND json_array_length(tags) > 0`,
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
    // survived, and the ones that did not are named beside it.
    if (droppedTags.length > 0) {
      rejected.push({
        edgeId: row.id,
        citingTurnId: row.citingId,
        citedTurnId: row.citedId,
        relation: row.relation,
        rawTags: row.tags,
        droppedTags,
        reason: "no-canonical-tag",
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
// M4 — illegal edges, by relation class
// ---------------------------------------------------------------------------

export const LANE_REGISTRY_M4_DISPOSAL_RECEIPT = "lane-declaration-m4-disposal";

/**
 * D6/M4 (peer P1-3). `extends`/`narrows` are the checker's own CONTINUATION
 * relations: an UNTAGGED one is itself rejected by the checker (E1), the same
 * way a tagged one with an undeclared endpoint is — so stripping tags off one
 * of these would trade one illegal shape for another, not repair it. Every
 * other relation carries no such constraint untagged, so it downgrades
 * instead of being deleted.
 */
const CONTINUATION_RELATIONS: ReadonlySet<string> = new Set(["extends", "narrows"]);

export interface LaneMigrationDeletedEdge {
  edgeId: number;
  citingTurnId: number;
  citingAddress: string;
  citedTurnId: number;
  citedAddress: string;
  relation: string;
  tags: string[];
}

export interface LaneMigrationDowngradedEdge {
  edgeId: number;
  citingTurnId: number;
  citingAddress: string;
  citedTurnId: number;
  citedAddress: string;
  relation: string;
  tags: string[];
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
  deleted: LaneMigrationDeletedEdge[];
  downgraded: LaneMigrationDowngradedEdge[];
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

/**
 * M4 (spec D6, ticket 04): disposes of every edge M0 classified
 * `notPlaceable` — a homeless endpoint can never gain a segment declaration
 * through this migration (that is a live `assign` operator act, not a
 * repair), so every entry here is PERMANENTLY illegal under D2 rule 2, not
 * merely illegal today. Ticket 01's own doc comment on the orchestrator named
 * this exactly: "a later ticket consumes `notPlaceable` off the M0 receipt."
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
 * DELETE (continuation relation, or a merge collision) already cascades via
 * `memory_edge_tags.edge_row_id REFERENCES memory_edges(id) ON DELETE CASCADE`
 * (schema.ts); only the in-place downgrade needs its own tag-index row
 * cleared explicitly, since that edge survives with a different tag set.
 */
function disposeIllegalEdges(
  db: Database,
  notPlaceable: readonly LaneMigrationClassifiedEdge[],
): LaneMigrationDisposalReceipt {
  const deleted: LaneMigrationDeletedEdge[] = [];
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

  for (const entry of notPlaceable) {
    const row = readEdge.get(entry.edgeId);
    if (!row) {
      continue;
    }
    const citingAddress = resolveTurnAddress(db, row.citingId);
    const citedAddress = resolveTurnAddress(db, row.citedId);
    const tags = JSON.parse(row.tags) as string[];

    if (CONTINUATION_RELATIONS.has(row.relation)) {
      deleteEdge.run(row.id);
      deleted.push({
        edgeId: row.id,
        citingTurnId: row.citingId,
        citingAddress,
        citedTurnId: row.citedId,
        citedAddress,
        relation: row.relation,
        tags,
      });
      continue;
    }

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
        disposition: "downgraded",
      });
    }
  }

  return { deleted, downgraded };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

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
 * classification. M4 (ticket 04) consumes M0's `notPlaceable` bucket, per
 * ticket 01's own note above this function's earlier revision. Ordered M3
 * before M4 to match D6's own enumeration; the two touch disjoint columns
 * (`turns.tags` vs `memory_edges`) so their relative order carries no
 * functional weight of its own.
 */
export function runLaneRegistryMigration(
  db: Database,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): void {
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
    const disposalReceipt = disposeIllegalEdges(db, classification?.notPlaceable ?? []);
    writeMigrationReceipt(db, LANE_REGISTRY_M4_DISPOSAL_RECEIPT, nowEpoch, disposalReceipt);
  });
}
