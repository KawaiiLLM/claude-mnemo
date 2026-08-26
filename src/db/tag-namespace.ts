import type { Database } from "bun:sqlite";

/**
 * ONE NAMESPACE, TWO TABLES (lane-model-v12 spec D3e; peer review A2 and its
 * second-round appendix).
 *
 * A segment's tag is globally unique and CARRYING IT IS MEMBERSHIP —
 * `deriveTurnSegmentMembership` (db/segments.ts) reads a turn's own `tags` and
 * takes the first word that names a segment. A lane tag lives in the same
 * column on the same turn. So the two vocabularies are not merely "kept apart
 * by intent": if E2 may declare a lane spelled like E1's segment tag, a turn
 * can end up carrying `[alpha, beta]` where `alpha` names E1 and `beta` is
 * E2's lane, and that turn is either in an illegal double-membership state or
 * silently migrates between segments on its next tags write — with no write
 * anyone would call a move.
 *
 * WHERE THE INVARIANT LIVES, and why not in `merge`. `merge` never creates a
 * name; it folds one lane into a lane that must ALREADY exist. Only two
 * primitives mint a name at all — `insertLane` (db/lanes.ts) and
 * `setSegmentTag` (db/segments.ts) — so both directions of the invariant are
 * closed by making those two ask this one question, inside their existing
 * IMMEDIATE write transactions. A facade may pre-ask it for a friendlier
 * refusal, but the facade cannot BE the authority: a migration, a repair
 * script or any direct caller walks around a facade and reaches the primitive.
 *
 * This module deliberately imports neither db/lanes.ts nor db/segments.ts and
 * queries both tables with its own SQL — those two modules already have a
 * one-way dependency (lanes -> segments), and a shared helper that imported
 * either would either close that cycle or force this rule into the module that
 * only enforces half of it.
 */

/** Which vocabulary a word is being claimed for — the tables are its two halves. */
export type TagNamespace = "segment" | "lane";

export interface TagNamespaceHolder {
  /** The vocabulary that ALREADY holds the word (always the other one from the claim). */
  namespace: TagNamespace;
  /** The segment holding it: its own tag when `namespace` is `segment`, the lane's declaring segment when `lane`. */
  segmentId: number;
  tag: string;
}

/**
 * Every holder, in the OTHER namespace, of any word in `tags`. Empty means the
 * claim is free to proceed.
 *
 * GLOBAL, INCLUDING THE CLAIMANT'S OWN SEGMENT — there is no `excludeSegmentId`
 * on purpose. A lane declared on E1 named after E1's OWN segment tag is just as
 * illegal as one named after E2's: the word would mean "member of E1" and "in
 * E1's lane X" at once, which is the same conflation read from one column.
 *
 * A segment's tag is `$[0]` (`segmentTagOf`'s own reading, and the reading
 * `deriveTurnSegmentMembership` derives membership by), so a legacy multi-tag
 * row contributes exactly the one word that can actually claim a turn.
 *
 * Holders come back in the order `tags` names the words, so a caller reporting
 * the first one reports the first word its caller wrote.
 */
export function findTagNamespaceHolders(
  db: Database,
  claiming: TagNamespace,
  tags: readonly string[],
): TagNamespaceHolder[] {
  const wanted: string[] = [];
  for (const tag of tags) {
    if (tag !== "" && !wanted.includes(tag)) {
      wanted.push(tag);
    }
  }
  if (wanted.length === 0) {
    return [];
  }
  const placeholders = wanted.map(() => "?").join(",");
  const rows =
    claiming === "lane"
      ? db
          .query<{ segmentId: number; tag: string }, string[]>(
            `SELECT id AS segmentId, json_extract(tags, '$[0]') AS tag
               FROM segments
              WHERE json_array_length(tags) >= 1
                AND json_extract(tags, '$[0]') IN (${placeholders})
              ORDER BY id ASC`,
          )
          .all(...wanted)
      : db
          .query<{ segmentId: number; tag: string }, string[]>(
            `SELECT segment_id AS segmentId, tag FROM lanes
              WHERE tag IN (${placeholders})
              ORDER BY segment_id ASC, id ASC`,
          )
          .all(...wanted);

  const namespace: TagNamespace = claiming === "lane" ? "segment" : "lane";
  const holders: TagNamespaceHolder[] = [];
  for (const tag of wanted) {
    for (const row of rows) {
      if (row.tag === tag) {
        holders.push({ namespace, segmentId: row.segmentId, tag });
      }
    }
  }
  return holders;
}

/** The single-word form — `null` when nothing in the other namespace holds it. */
export function findTagNamespaceHolder(
  db: Database,
  claiming: TagNamespace,
  tag: string,
): TagNamespaceHolder | null {
  return findTagNamespaceHolders(db, claiming, [tag])[0] ?? null;
}

/**
 * The refusal text — ONE register for both directions, so a refusal reads the
 * same whichever primitive raised it. Names the gap the ticket asks it to
 * name: which namespace already holds the word, which segment holds it, and
 * the word itself.
 */
export function formatTagNamespaceRefusal(
  claiming: TagNamespace,
  holder: TagNamespaceHolder,
): string {
  const shared =
    "a segment tag and a lane tag are ONE namespace — a turn carries both in its own tags, and " +
    "the reader that derives a turn's segment from them cannot tell the two apart";
  return claiming === "lane"
    ? `"${holder.tag}" is already E${holder.segmentId}'s segment tag — ${shared}. ` +
        `Pick another word for the lane, or retag E${holder.segmentId} off it first.`
    : `"${holder.tag}" is already a lane declared on E${holder.segmentId} — ${shared}. ` +
        `Pick another word for the segment, or undeclare E${holder.segmentId}'s lane first.`;
}

/**
 * Thrown by `insertLane` when a caller reaches the primitive with a word the
 * segment namespace already holds.
 *
 * It THROWS rather than returning a refusal because `insertLane`'s `null`
 * already means something else entirely ("that exact lane exists"), and a
 * caller that read a namespace collision as "already exists" would carry on as
 * if the lane it wanted were there. The throw also rolls the caller's write
 * transaction back, which is what makes the invariant hold for a caller that
 * never pre-checked. `setSegmentTag` needs no such class: its return type is
 * already a refusal union, so it answers in the shape it always had.
 */
export class TagNamespaceCollisionError extends Error {
  readonly claiming: TagNamespace;
  readonly holder: TagNamespaceHolder;

  constructor(claiming: TagNamespace, holder: TagNamespaceHolder) {
    super(formatTagNamespaceRefusal(claiming, holder));
    this.name = "TagNamespaceCollisionError";
    this.claiming = claiming;
    this.holder = holder;
  }
}
