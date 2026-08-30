import type { Database } from "bun:sqlite";

import { checkTopicTag, isTopicTag, topicTagsOf } from "../shared/topic-tag";

/**
 * The TAGS write gate (lane-model-v12 spec D3b/D3e, ticket 14).
 *
 * THE ONE SEAM BOTH WRITERS PASS THROUGH — `mcp/note.ts` (the main agent) and
 * `worker/note-settlement-turn-facade.ts` (settlement) each call this before
 * anything lands, which is why the `topic:` contract (staged-settlement spec
 * Rev 5, ticket 01) is enforced HERE rather than on either face: "for every
 * writer" is a property of the seam, not a rule two call sites promise to keep
 * in step.
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
 *
 * THE ONE EXCEPTION IS `topic:` (staged-settlement spec Rev 5), and it is an
 * exception to the VOCABULARY rule only:
 *
 *   - a `topic:` word is admitted past the closed vocabulary — that is the
 *     point of the namespace, a subject word no container has to exist for;
 *   - it is judged by its own grammar instead (`shared/topic-tag.ts`), on the
 *     values this write INTRODUCES, exactly like the vocabulary rule it
 *     replaces for these tags;
 *   - it never counts as a segment tag or a lane tag, so it moves no
 *     membership and satisfies no lane's ownership requirement. A turn whose
 *     only tag is a topic word is unowned, and the two structural refusals
 *     above read exactly as they did before the namespace existed;
 *   - it is PERMANENT [S15069/T1995]: a whole-set write that simply omits one
 *     is REFUSED naming it. Silence is never removal, because the writer that
 *     drops a word by accident is the writer least able to notice. The only
 *     way out is the explicit correction form (`retiringTopicTag`), which
 *     names the old word AND requires the same call to introduce a new one —
 *     a correction, not a deletion.
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

/**
 * What this write did to the turn's topic words, for the caller's receipt.
 * `alreadyPresent` is the success no-op the contract asks for: re-writing a
 * word the turn already carries is not an error and not a duplicate row, and a
 * writer that cannot tell it from new work reads its own no-op as progress.
 */
export interface TurnTopicTagOutcome {
  added: string[];
  alreadyPresent: string[];
  /** The word the explicit correction form retired, or `null` when none was named. */
  retired: string | null;
}

export type TurnTagWriteCheck =
  | {
      ok: true;
      /**
       * The segment this write makes the turn a member of — `null` when the
       * tags carry no segment tag at all, which is what "unowned" means. A
       * `topic:` word never answers this question.
       */
      segmentId: number | null;
      topics: TurnTopicTagOutcome;
      /**
       * The tag set the caller must actually STORE: the (deduped) replacement
       * set plus every machine tag the turn already carries that the write
       * omitted. The machine namespace is hook-owned — an agent write can
       * neither introduce one (the vocabulary rule refuses it) nor remove one
       * (this union restores it) — so a whole-set REPLACEMENT write is only
       * ever a replacement of the agent's own vocabularies. Silent rather
       * than a refusal like the topic invariant's, because a topic word is
       * the AGENT's word to restate; a machine tag was never the agent's to
       * manage at all, and demanding its restatement would teach every writer
       * a namespace the write faces refuse to let them touch on purpose.
       */
      effectiveTags: string[];
    }
  | { ok: false; message: string };

export interface CheckTurnTagWriteInput {
  /** The full tag set this write would store. */
  nextTags: readonly string[];
  /** What the turn stores TODAY — the values exempt from the vocabulary rule. */
  priorTags: readonly string[];
  /**
   * The explicit correction form (spec Rev 5): the ONE stored `topic:` word
   * this write retires. Omitted on every ordinary write, which is what makes
   * the preservation invariant hold by default rather than by vigilance.
   */
  retiringTopicTag?: string;
}

/**
 * The machine namespace: any prefixed tag that is not a `topic:` word —
 * `compact:` / `invalidated:` / `delivery:` today, and whatever a future hook
 * mints. Hooks write these straight to the column; the agent faces can
 * neither introduce one (the vocabulary rule refuses a prefixed value like
 * any other non-vocabulary word) nor remove one (`checkTurnTagWrite` unions
 * the stored ones back into `effectiveTags`). Exported for the stage-1
 * transition gate, whose stray-tag audit must not raise a debt no agent
 * write could discharge.
 */
export function isMachineTag(tag: string): boolean {
  return tag.includes(":") && !isTopicTag(tag);
}

/** `"a", "b" and "c"` — one register for every list this gate prints. */
function quoteList(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  if (quoted.length <= 1) {
    return quoted[0] ?? "(none)";
  }
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * The `topic:` half of the gate, whole (staged-settlement spec Rev 5). It
 * answers three questions in the order they depend on each other: is every
 * word this write INTRODUCES a legal topic word; is the correction form, if
 * used at all, a correction; and does the resulting set still hold every word
 * the turn already had.
 *
 * Words the turn ALREADY carries are exempt from the grammar, the same
 * exemption and for the same reason as the vocabulary rule's: restating a
 * stored value is not a new write, and a word that somehow predates this
 * contract must stay restatable or its own turn could never be edited again.
 */
function judgeTopicTags(
  next: readonly string[],
  priorTags: readonly string[],
  retiringTopicTag: string | undefined,
): { ok: true; topics: TurnTopicTagOutcome } | { ok: false; message: string } {
  const priorTopics = topicTagsOf(priorTags);
  const priorSet = new Set(priorTopics);
  const nextTopics = topicTagsOf(next);
  const nextSet = new Set(nextTopics);

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const tag of nextTopics) {
    if (priorSet.has(tag)) {
      alreadyPresent.push(tag);
      continue;
    }
    const verdict = checkTopicTag(tag);
    if (!verdict.ok) {
      return { ok: false, message: `Refused: ${verdict.message} Nothing was written.` };
    }
    added.push(tag);
  }

  if (retiringTopicTag !== undefined) {
    if (!isTopicTag(retiringTopicTag)) {
      return {
        ok: false,
        message:
          `Refused: ${JSON.stringify(retiringTopicTag)} is not a topic word, and the correction ` +
          "form retires topic words only. Nothing was written.",
      };
    }
    if (!priorSet.has(retiringTopicTag)) {
      const carried =
        priorTopics.length === 0 ? "none at all" : quoteList(priorTopics);
      return {
        ok: false,
        message:
          `Refused: this turn does not carry ${JSON.stringify(retiringTopicTag)} — it carries ${carried}. ` +
          "A correction retires a word that is actually there. Nothing was written.",
      };
    }
    if (nextSet.has(retiringTopicTag)) {
      return {
        ok: false,
        message:
          `Refused: ${JSON.stringify(retiringTopicTag)} is named for retirement and is also in the ` +
          "replacement set — one call cannot both drop and keep it. Nothing was written.",
      };
    }
    if (added.length === 0) {
      return {
        ok: false,
        message:
          `Refused: retiring ${JSON.stringify(retiringTopicTag)} needs the word that replaces it in the ` +
          "SAME call — the correction form names old and new together, so a turn is never left " +
          "with a subject its author silently withdrew. Nothing was written.",
      };
    }
  }

  // The preservation invariant, last: by here the retirement (if any) is a
  // legitimate one, so exactly one omission can be excused and every other is
  // the accident this rule exists to catch.
  for (const tag of priorTopics) {
    if (nextSet.has(tag) || tag === retiringTopicTag) {
      continue;
    }
    return {
      ok: false,
      message:
        `Refused: this write drops the topic word ${JSON.stringify(tag)} the turn already carries. ` +
        "A topic word is permanent — a whole-set tags write must restate every one of them. " +
        "To replace it, name it for retirement in the same call that writes its successor. " +
        "Nothing was written.",
    };
  }

  return {
    ok: true,
    topics: {
      added,
      alreadyPresent,
      retired: retiringTopicTag ?? null,
    },
  };
}

export function checkTurnTagWrite(
  db: Database,
  input: CheckTurnTagWriteInput,
): TurnTagWriteCheck {
  const segmentTags = loadSegmentTagIndex(db);
  const deduped = [...new Set(input.nextTags)];
  const prior = new Set(input.priorTags);

  // The topic pass runs FIRST and takes its own words off the table. What is
  // left is the tag set the two closed vocabularies were always about, so
  // every refusal below reads exactly as it did before the namespace existed
  // — a topic word can neither satisfy nor violate a membership rule.
  const topicVerdict = judgeTopicTags(deduped, input.priorTags, input.retiringTopicTag);
  if (!topicVerdict.ok) {
    return { ok: false, message: topicVerdict.message };
  }
  const next = deduped.filter((tag) => !isTopicTag(tag));

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

  // Machine preservation, last: the union runs only on a write the gate has
  // already fully admitted, so a refusal above never reports an effective set
  // that was never going to land.
  const effectiveTags = [...deduped];
  const nextSet = new Set(deduped);
  for (const tag of input.priorTags) {
    if (isMachineTag(tag) && !nextSet.has(tag)) {
      effectiveTags.push(tag);
      nextSet.add(tag);
    }
  }

  return { ok: true, segmentId, topics: topicVerdict.topics, effectiveTags };
}
