import type { Database } from "bun:sqlite";

/**
 * The TAGS write gate (lane-model-v12 spec D3b/D3e, ticket 14).
 *
 * A turn's `tags` is no longer free-form text. It draws from exactly TWO
 * closed vocabularies:
 *
 *   1. the ONE globally unique tag of the segment this turn belongs to;
 *   2. the lane tags DECLARED in that same segment.
 *
 * Membership is DERIVED from (1) rather than assigned by a verb
 * (`deriveTurnSegmentMembership`, db/segments.ts), which is what makes the
 * three refusals below a closed set:
 *
 *   - a SECOND segment tag — refused naming both segments, so "a turn matches
 *     at most one segment" is a structural fact rather than a convention;
 *   - a lane tag whose OWNING segment's tag is absent from the same write —
 *     refused naming the missing segment tag, so "an unowned turn cannot join
 *     any lane" is structural too;
 *   - anything outside both vocabularies — refused listing what is legal now.
 *
 * Together: at most one segment tag; every lane tag matches that segment;
 * therefore no segment tag means no lane tags.
 *
 * NOT A SCHEMA ENUM, deliberately (spec D3b). MCP advertises a tool's shape
 * ONCE per connection, while lanes are declared mid-session and a turn's
 * segment changes mid-session too — an enum would be stale the moment either
 * happened. This is a write-time check whose vocabulary is read fresh from the
 * database on every call, and whose rejection text carries the vocabulary the
 * caller should have used.
 *
 * WHAT IT JUDGES, and why the two halves differ:
 *
 *   - the two STRUCTURAL refusals judge the RESULTING tag set. They are what
 *     membership derivation rests on, so a write may not leave a turn in a
 *     state derivation cannot read, whatever it inherited.
 *   - the VOCABULARY refusal judges only the values this write INTRODUCES
 *     (resulting set minus what the turn already stored). Spec D3b: "遗留的
 *     自由 tag 值一律不清除,只禁新写" — the 7694 legacy free-form values stay
 *     exactly where they are, and an undeclared word counts for nothing in
 *     membership anyway. Re-stating one is not a new write; adding one is.
 *
 * Machine tags (`compact:` / `invalidated:` / `delivery:`) never reach here —
 * hooks write them straight to the column. An AGENT introducing a prefixed
 * value is refused by the vocabulary rule like any other non-vocabulary word,
 * which is the same rule `checkCanonicalLaneTag`'s prefix clause states from
 * the declaration side.
 */

/** Every segment's own one tag -> the segment holding it. Globally unique by schema (`idx_segments_tag_unique`). */
export type SegmentTagIndex = ReadonlyMap<string, number>;

export function loadSegmentTagIndex(db: Database): SegmentTagIndex {
  const rows = db
    .query<{ id: number; tag: string }, []>(
      `SELECT id, json_extract(tags, '$[0]') AS tag
         FROM segments
        WHERE json_array_length(tags) >= 1`,
    )
    .all();
  const index = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.tag === "string" && row.tag !== "" && !index.has(row.tag)) {
      index.set(row.tag, row.id);
    }
  }
  return index;
}

/** The lane tags declared on one segment. */
export function loadDeclaredLaneTags(db: Database, segmentId: number): Set<string> {
  return new Set(
    db
      .query<{ tag: string }, [number]>("SELECT tag FROM lanes WHERE segment_id = ? ORDER BY tag")
      .all(segmentId)
      .map((row) => row.tag),
  );
}

/** Which segment declares a lane tag — every one of them, ascending, for the "missing segment tag" refusal. */
function segmentsDeclaringLane(db: Database, tag: string): number[] {
  return db
    .query<{ segmentId: number }, [string]>(
      "SELECT segment_id AS segmentId FROM lanes WHERE tag = ? ORDER BY segment_id",
    )
    .all(tag)
    .map((row) => row.segmentId);
}

export type TurnTagWriteCheck =
  | {
      ok: true;
      /**
       * The segment this write makes the turn a member of — `null` when the
       * tags carry no segment tag at all, which is what "unowned" means.
       */
      segmentId: number | null;
    }
  | { ok: false; message: string };

export interface CheckTurnTagWriteInput {
  /** The full tag set this write would store. */
  nextTags: readonly string[];
  /** What the turn stores TODAY — the values exempt from the vocabulary rule. */
  priorTags: readonly string[];
}

/** `"a", "b" and "c"` — one register for every list this gate prints. */
function quoteList(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  if (quoted.length <= 1) {
    return quoted[0] ?? "(none)";
  }
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

export function checkTurnTagWrite(
  db: Database,
  input: CheckTurnTagWriteInput,
): TurnTagWriteCheck {
  const segmentTags = loadSegmentTagIndex(db);
  const next = [...new Set(input.nextTags)];
  const prior = new Set(input.priorTags);

  // (1) At most one segment tag — judged on the RESULTING set, in the order
  // the caller wrote them so the refusal reads back against its own input.
  const matchedSegmentTags = next.filter((tag) => segmentTags.has(tag));
  if (matchedSegmentTags.length > 1) {
    const named = matchedSegmentTags
      .map((tag) => `"${tag}" (E${segmentTags.get(tag)!})`)
      .join(" and ");
    return {
      ok: false,
      message:
        `Refused: these tags name ${matchedSegmentTags.length} segments — ${named}. ` +
        "A turn belongs to at most one segment, and its segment is DERIVED from its tags, " +
        "so at most one segment tag may appear. Nothing was written.",
    };
  }

  const segmentTag = matchedSegmentTags[0] ?? null;
  const segmentId = segmentTag === null ? null : segmentTags.get(segmentTag)!;
  const declaredHere = segmentId === null ? new Set<string>() : loadDeclaredLaneTags(db, segmentId);

  for (const tag of next) {
    if (tag === segmentTag) {
      continue;
    }
    if (declaredHere.has(tag)) {
      continue;
    }

    // (2) A lane tag needs its own segment's tag in the SAME write. Judged on
    // the resulting set like (1): this is the rule that makes "an unowned turn
    // cannot join any lane" structural, so an inherited value may not dodge it.
    const owners = segmentsDeclaringLane(db, tag);
    if (owners.length > 0) {
      const clauses = owners.map((owner) => {
        const ownerTag = [...segmentTags.entries()].find(([, id]) => id === owner)?.[0] ?? null;
        return ownerTag === null
          ? `E${owner} (which has no segment tag of its own yet — name one with remember(retag))`
          : `E${owner}, whose segment tag "${ownerTag}" is not in these tags`;
      });
      return {
        ok: false,
        message:
          `Refused: "${tag}" is a lane declared on ${clauses.join(" and ")}. ` +
          "A lane tag rides only on a turn that already carries its segment's tag — " +
          `add that segment tag, or drop "${tag}". Nothing was written.`,
      };
    }

    // (3) Outside both vocabularies. Only a value this write INTRODUCES is
    // refused — a legacy free-form value the turn already carries survives
    // being restated (spec D3b).
    if (prior.has(tag)) {
      continue;
    }
    const legal =
      segmentId === null
        ? [...segmentTags.keys()].sort()
        : [segmentTag!, ...[...declaredHere].sort()];
    const legalText =
      legal.length === 0
        ? "nothing — no segment has been named yet (remember(retag) names one)"
        : quoteList(legal);
    const where =
      segmentId === null
        ? "no segment tag is present, so the only legal values are the segment tags themselves"
        : `E${segmentId} is this turn's segment, so the legal values are its own tag and the lanes it has declared`;
    return {
      ok: false,
      message:
        `Refused: "${tag}" is neither a segment tag nor a lane declared where this turn lives. ` +
        `${where} — legal now: ${legalText}. Nothing was written.`,
    };
  }

  return { ok: true, segmentId };
}
