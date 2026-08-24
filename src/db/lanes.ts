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
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * D6/M0-M2: ordered, durable, per-phase receipts — a phase is skipped only
 * when ITS OWN receipt row exists, never inferred from `lanes` having rows
 * (the first process to open an upgraded database is often a hook, and a
 * crash between phases must not silently skip the rest forever). `lanes`
 * and `migration_receipts` themselves are unconditional
 * `CREATE TABLE IF NOT EXISTS` DDL in SCHEMA_SQL (schema.ts) — already
 * idempotent, so table creation needs no receipt of its own.
 *
 * M0 and M2 run in SEPARATE transactions (not one): M0's classification must
 * be fully committed before M2 reads it back, so a crash between the two
 * leaves M0's receipt durable and M2 still pending on the NEXT process to
 * open this database — never re-classifying, never silently skipping the
 * seed.
 *
 * M3/M4 (legal membership by allowlist; illegal edges by relation class) are
 * OUT OF SCOPE for this ticket (issue 01: "D1, D4, D6/M0-M2") — a later
 * ticket consumes `notPlaceable` off the M0 receipt.
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
}
