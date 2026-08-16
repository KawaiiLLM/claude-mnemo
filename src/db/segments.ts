import type { Database } from "bun:sqlite";

import { reconcileCitedPairs } from "./memory-edges";
import { parseQualifiedReferences, validateReferences } from "./references";
import { indexSegmentToFTS } from "./search";
import {
  MEMORY_TYPES,
  normalizeTypeValues,
  type MemoryType,
} from "../shared/type-vocabulary";

/**
 * Segments and the topic registry (spec D6).
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

export const SEGMENT_STATUSES = ["open", "delivered", "abandoned"] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

export const TOPIC_STATUSES = ["active", "dormant", "retired"] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export interface TopicRecord {
  id: number;
  name: string;
  aliases: string[];
  status: TopicStatus;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface SegmentRecord {
  id: number;
  topicId: number | null;
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
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface TopicRow {
  id: number;
  name: string;
  aliases: string;
  status: TopicStatus;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface SegmentRow {
  id: number;
  topicId: number | null;
  title: string;
  content: string | null;
  insight: string | null;
  type: string;
  tags: string;
  status: SegmentStatus;
  revision: number;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

const TOPIC_COLUMNS = `
  id,
  name,
  aliases,
  status,
  created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;

const SEGMENT_COLUMNS = `
  id,
  topic_id AS topicId,
  title,
  content,
  insight,
  type,
  tags,
  status,
  revision,
  created_at_epoch AS createdAtEpoch,
  updated_at_epoch AS updatedAtEpoch
`;

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
 * (schema.ts's `stripRetiredTopicTagNamespace` carries the same P1 note and the
 * same guard), and `turns.type` only gained its array CHECK in ticket 02 — a
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

function mapTopicRow(row: TopicRow | null): TopicRecord | null {
  return row ? { ...row, aliases: parseStringArray(row.aliases) } : null;
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

/** Alias lookup is case- and width-insensitive; the stored spelling is kept. */
function normalizeTopicKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export interface UpsertTopicInput {
  name: string;
  aliases?: string[];
  status?: TopicStatus;
  nowEpoch: number;
}

/**
 * Register a topic, or fold a new spelling into the one that already owns this
 * name (spec D6/D9's anti-fragmentation rule: search before minting). Returns
 * the surviving topic either way, so a caller never has to branch on whether it
 * won the race.
 */
export function upsertTopic(db: Database, input: UpsertTopicInput): TopicRecord {
  const existing = findTopic(db, input.name);
  if (existing) {
    const merged = [...existing.aliases];
    for (const alias of input.aliases ?? []) {
      if (
        normalizeTopicKey(alias) !== normalizeTopicKey(existing.name) &&
        !merged.some((known) => normalizeTopicKey(known) === normalizeTopicKey(alias))
      ) {
        merged.push(alias);
      }
    }
    // The name a caller arrives with becomes an alias when the match came
    // through an existing alias — otherwise the spelling would be lost.
    if (
      normalizeTopicKey(input.name) !== normalizeTopicKey(existing.name) &&
      !merged.some((known) => normalizeTopicKey(known) === normalizeTopicKey(input.name))
    ) {
      merged.push(input.name);
    }

    const updated = mapTopicRow(
      db
        .query<TopicRow, [string, TopicStatus, number, number]>(
          `UPDATE topics SET aliases = ?, status = ?, updated_at_epoch = ?
           WHERE id = ? RETURNING ${TOPIC_COLUMNS}`,
        )
        .get(
          JSON.stringify(merged),
          input.status ?? existing.status,
          input.nowEpoch,
          existing.id,
        ) ?? null,
    );
    if (!updated) {
      throw new Error(`Failed to update topic ${existing.id}.`);
    }
    return updated;
  }

  const inserted = mapTopicRow(
    db
      .query<TopicRow, [string, string, TopicStatus, number, number]>(
        `INSERT INTO topics (name, aliases, status, created_at_epoch, updated_at_epoch)
         VALUES (?, ?, ?, ?, ?)
         RETURNING ${TOPIC_COLUMNS}`,
      )
      .get(
        input.name,
        JSON.stringify(input.aliases ?? []),
        input.status ?? "active",
        input.nowEpoch,
        input.nowEpoch,
      ) ?? null,
  );

  if (!inserted) {
    throw new Error(`Failed to register topic ${input.name}.`);
  }
  return inserted;
}

/** Resolve a name through the registry: exact name first, then aliases. */
export function findTopic(db: Database, name: string): TopicRecord | null {
  const key = normalizeTopicKey(name);
  const rows = db.query<TopicRow, []>(`SELECT ${TOPIC_COLUMNS} FROM topics`).all();

  const byName = rows.find((row) => normalizeTopicKey(row.name) === key);
  if (byName) {
    return mapTopicRow(byName);
  }

  const byAlias = rows.find((row) =>
    parseStringArray(row.aliases).some((alias) => normalizeTopicKey(alias) === key),
  );
  return mapTopicRow(byAlias ?? null);
}

export function getTopic(db: Database, topicId: number): TopicRecord | null {
  return mapTopicRow(
    db
      .query<TopicRow, [number]>(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = ?`)
      .get(topicId) ?? null,
  );
}

export function listTopics(db: Database, status?: TopicStatus): TopicRecord[] {
  const rows = status
    ? db
        .query<TopicRow, [TopicStatus]>(
          `SELECT ${TOPIC_COLUMNS} FROM topics WHERE status = ? ORDER BY id ASC`,
        )
        .all(status)
    : db
        .query<TopicRow, []>(`SELECT ${TOPIC_COLUMNS} FROM topics ORDER BY id ASC`)
        .all();

  return rows
    .map((row) => mapTopicRow(row))
    .filter((topic): topic is TopicRecord => topic !== null);
}

export interface CreateSegmentInput {
  title: string;
  topicId?: number | null;
  content?: string | null;
  /** Ticket 14 (spec K5). */
  insight?: string | null;
  /**
   * Storage mechanics only. The settlement tool no longer states either of
   * these (spec K5a) — `recomputeSegmentFacets` derives both from the members
   * the moment membership exists — so in production this arrives `[]` and is
   * overwritten by the first `addSegmentMembers` call. It stays on the INSERT
   * for a caller that has no members to derive from (a fixture, a repair).
   */
  type?: string[];
  tags?: string[];
  status?: SegmentStatus;
  nowEpoch: number;
}

export function createSegment(
  db: Database,
  input: CreateSegmentInput,
): SegmentRecord {
  const type = normalizeTypeValues(input.type ?? []);

  const inserted = mapSegmentRow(
    db
      .query<
        SegmentRow,
        [
          number | null,
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
           topic_id, title, content, insight, type, tags, status,
           created_at_epoch, updated_at_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(
        input.topicId ?? null,
        input.title,
        input.content ?? null,
        input.insight ?? null,
        JSON.stringify(type),
        JSON.stringify(input.tags ?? []),
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

/** Keep the segment's search row in step with the row it was written from. */
function indexSegment(db: Database, segment: SegmentRecord): void {
  indexSegmentToFTS(db, {
    id: segment.id,
    title: segment.title,
    content: segment.content,
    insight: segment.insight,
    type: JSON.stringify(segment.type),
    tags: JSON.stringify(segment.tags),
  });
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
function compareDerivedTags(
  left: { tag: string; count: number },
  right: { tag: string; count: number },
): number {
  return right.count - left.count || (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0);
}

/**
 * A segment's `type` and `tags` computed from its members (spec K5a: "a value
 * the system can compute is a value the model can only get wrong"). A6 has
 * asserted the type union since it was written and nothing ever checked it —
 * this is the check.
 *
 *   - `type` is the UNION of the members' stated activities, ordered by the
 *     same frequency rule as the tags (most member turns first), with ties
 *     broken by the vocabulary's own canonical order (`MEMORY_TYPES`) so the
 *     value never depends on which member happened to be added first. The
 *     ordering is load-bearing, not cosmetic: `deriveDominantType`
 *     (db/segment-rank.ts) falls back to a segment's FIRST type word when the
 *     member mode is tied, and its whole contract is that the fallback is a
 *     judgement rather than arrival order — a frequency-ordered union keeps
 *     that true now that no one states the list. A legacy word a
 *     pre-vocabulary member still carries is dropped rather than propagated
 *     upward: `normalizeTypeValues` would refuse it on the next write, so
 *     storing it would make the segment unwritable.
 *   - `tags` are the members' tags ordered by FREQUENCY, most frequent first
 *     (ties by `compareDerivedTags`), which is also the natural truncation
 *     under a budget. Colon-namespaced tags are bookkeeping, not subject
 *     matter (`compact:`, `invalidated:`, `delivery:` — see db/turns.ts, which
 *     keeps exactly those on an invalidation and drops the freeform ones), so
 *     they never become what a segment is "about".
 *
 * Returns the recomputed row, or `null` if the segment is gone. Does NOT bump
 * `revision`: the revision fence exists for the model's body writes (whose CAS
 * would otherwise be invalidated by a facet recomputation it never made), and
 * a facet is no longer something a caller can state, so nothing can conflict.
 *
 * TICKET 15 (findings 1-3): this is the ONE derivation, and it has THREE
 * inputs, not one. Ticket 14 placed the only call in `addSegmentMembers` and
 * described that as the single invariant point; it is the single point for a
 * change of MEMBERSHIP, and a facet derives from the members' CONTENT too. The
 * inputs and who pays for each:
 *
 *   1. a membership arriving — `addSegmentMembers`, unchanged;
 *   2. a member turn's own `type`/`tags` changing — the turn write path
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
    .query<{ type: string | null; tags: string | null }, [number]>(
      `SELECT t.type AS type, t.tags AS tags
       FROM segment_members sm
       JOIN turns t ON t.id = sm.turn_id
       WHERE sm.segment_id = ?`,
    )
    .all(segmentId);

  const typeCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const member of members) {
    for (const word of new Set(parseMemberFacetArray(member.type))) {
      typeCounts.set(word, (typeCounts.get(word) ?? 0) + 1);
    }
    // Per MEMBER, deduplicated: a turn that repeats a tag is still one turn
    // carrying it, so frequency counts turns and not array entries.
    for (const tag of new Set(parseMemberFacetArray(member.tags))) {
      if (tag.includes(":") || tag.trim() === "") {
        continue;
      }
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const type = MEMORY_TYPES.filter((word) => typeCounts.has(word)).sort(
    (left, right) =>
      (typeCounts.get(right) ?? 0) - (typeCounts.get(left) ?? 0) ||
      MEMORY_TYPES.indexOf(left) - MEMORY_TYPES.indexOf(right),
  );
  const tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort(compareDerivedTags)
    .map((entry) => entry.tag);

  const updated = mapSegmentRow(
    db
      .query<SegmentRow, [string, string, number]>(
        // `facets_stale = 0` in the same statement that stores the derivation:
        // the flag means "a derivation is owed", and this IS the derivation, so
        // whichever writer got here — membership, a member's own write, or the
        // repair sweep — settles the debt by the act of paying it.
        `UPDATE segments SET type = ?, tags = ?, facets_stale = 0 WHERE id = ?
         RETURNING ${SEGMENT_COLUMNS}`,
      )
      .get(JSON.stringify(type), JSON.stringify(tags), segmentId) ?? null,
  );

  if (updated) {
    // The whole reason the derived value is STORED rather than resolved at
    // read time (spec K5a): a segment is FTS-indexed with its tags, so an
    // un-reindexed recomputation leaves the search facet describing a
    // membership that no longer exists.
    indexSegment(db, updated);
  }
  return updated;
}

/**
 * Input 2 (ticket 15 finding 1): a member turn's `type`/`tags` just moved, so
 * every segment holding that turn has to re-derive.
 *
 * Called from the turn write path rather than resolved when a segment is read,
 * because spec K5a already settled that question in the same breath as the
 * derivation rule: "a segment is indexed to FTS with its tags, so the derived
 * value is stored and recomputed when membership changes, not resolved at read
 * time". A read-time derivation would still owe the FTS facet a write, so it
 * relocates the write rather than removing it — and leaves `tag:`/`type:`
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
  s.topic_id AS topicId,
  s.title,
  s.content,
  s.insight,
  s.type,
  s.tags,
  s.status,
  s.revision,
  s.created_at_epoch AS createdAtEpoch,
  s.updated_at_epoch AS updatedAtEpoch
`;

export interface SegmentWithTopic {
  segment: SegmentRecord;
  /** The registry name, resolved here so a reader does not re-query per row. */
  topicName: string | null;
}

/**
 * The most recently active segments, whatever their status (ticket 14, spec
 * D9's anti-fragmentation surface). Deliberately NOT open-only: a DELIVERED
 * segment is the evidence that a topic name is established, which is exactly
 * what the caller has to see before it decides it needs a new one.
 */
export function listRecentSegments(
  db: Database,
  limit: number,
): SegmentWithTopic[] {
  if (limit <= 0) {
    return [];
  }
  return db
    .query<SegmentRow & { topicName: string | null }, [number]>(
      `SELECT ${JOINED_SEGMENT_COLUMNS}, tp.name AS topicName
       FROM segments s
       LEFT JOIN topics tp ON tp.id = s.topic_id
       ORDER BY s.updated_at_epoch DESC, s.id DESC
       LIMIT ?`,
    )
    .all(limit)
    .flatMap((row) => {
      const segment = mapSegmentRow(row);
      return segment ? [{ segment, topicName: row.topicName }] : [];
    });
}

export interface TopicFrequency {
  topic: TopicRecord;
  /** How many segments carry this topic — an established name vs. a one-off. */
  segmentCount: number;
}

/**
 * The topic registry ordered by how many segments carry each name (ticket 14).
 * A bare alphabetical list makes a name minted once look exactly like the name
 * five segments share, which is the reading that lets a near-duplicate get
 * minted next to an established word. Ties break on name, ascending, so the
 * rendering is stable between two calls that see the same counts.
 */
export function listTopicsByFrequency(
  db: Database,
  status?: TopicStatus,
): TopicFrequency[] {
  const columns = `
    t.id,
    t.name,
    t.aliases,
    t.status,
    t.created_at_epoch AS createdAtEpoch,
    t.updated_at_epoch AS updatedAtEpoch,
    COUNT(s.id) AS segmentCount
  `;
  const sql = `SELECT ${columns}
     FROM topics t
     LEFT JOIN segments s ON s.topic_id = t.id
     ${status ? "WHERE t.status = ?" : ""}
     GROUP BY t.id
     ORDER BY segmentCount DESC, t.name ASC`;
  const rows = status
    ? db.query<TopicRow & { segmentCount: number }, [TopicStatus]>(sql).all(status)
    : db.query<TopicRow & { segmentCount: number }, []>(sql).all();

  return rows.flatMap((row) => {
    const topic = mapTopicRow(row);
    return topic ? [{ topic, segmentCount: row.segmentCount }] : [];
  });
}

/**
 * Idempotent membership assertion; returns the turn ids newly linked.
 *
 * Membership is ONE of the three inputs to `type` and `tags` (spec K5a — see
 * `recomputeSegmentFacets` for the other two and who pays for each), so this
 * is where the derivation runs for a membership that arrives: a caller cannot
 * land members and forget it, and the FTS facet can never describe a
 * membership the row does not have. Recomputation runs only when this call
 * actually linked something new: an idempotent re-assertion changes no input
 * and therefore needs no recomputation.
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
      `SELECT
         s.id,
         s.topic_id AS topicId,
         s.title,
         s.content,
         s.insight,
         s.type,
         s.tags,
         s.status,
         s.revision,
         s.created_at_epoch AS createdAtEpoch,
         s.updated_at_epoch AS updatedAtEpoch
       FROM segments s
       JOIN segment_members sm ON sm.segment_id = s.id
       WHERE sm.turn_id = ?
       ORDER BY s.id ASC`,
    )
    .all(turnId)
    .map((row) => mapSegmentRow(row))
    .filter((segment): segment is SegmentRecord => segment !== null);
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
 * A frozen (delivered/abandoned) segment refuses writes outright: spec D6
 * overturns a closed segment with an edge, never by rewriting history.
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
