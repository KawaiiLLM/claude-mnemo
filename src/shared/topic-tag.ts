/**
 * The `topic:` grammar — one closed contract (staged-settlement spec Rev 5,
 * §"`topic:` grammar", ticket 01).
 *
 * A turn carries ONE free word saying what it is about, written live by the
 * main agent (and supplied by settlement stage 1 as backfill). It is raw
 * material, not taxonomy: no closed vocabulary, drift across turns is expected
 * and cheap, and the word is PERMANENT [S15069/T1995].
 *
 * WHY A PREFIX AT ALL, when `tags`'s whole point is that it draws from two
 * closed vocabularies (a task's own tag, and lanes that task declared). The
 * prefix is what lets one column hold a word that is deliberately NOT in
 * either vocabulary without the reader having to guess which kind it is
 * looking at: a bare word is membership, a `topic:` word is subject matter,
 * and no read path has to match two spellings of anything. Membership stays
 * derived from bare words alone — a `topic:` word never names a task, never
 * names a lane, never rides an edge side, and is never injected or scored.
 *
 * THE NAMESPACE WAS ONCE RETIRED, and its history is why this module exists
 * rather than a `startsWith` sprinkled around. `spec B6` retired the prefix
 * and a schema migration stripped it off every stored row; this contract
 * re-admits it for the ONE meaning above, deletes that migration, and leaves
 * the already-stripped historical words bare — there is no resurrection pass,
 * and a bare legacy word is simply a tag that lost its namespace.
 *
 * REFUSE, NEVER NORMALIZE — the lane-tag precedent (`checkCanonicalLaneTag`,
 * db/lanes.ts). A silently normalized word is a word the author never wrote,
 * and the author is the one live context that knows what the turn was about.
 * The refusal's DISPLAY has a boundary, though, and it is the round-4 rule
 * this module implements literally: when the repair is mechanically derivable
 * AND unique (case folding, NFC, whitespace trim, hyphen placement) the
 * refusal shows the derived candidate, so the caller retries by copying it;
 * when it is not (illegal charset, CJK, arbitrary symbols — any repair would
 * be a new judgment about what the author meant) it shows the canonical
 * pattern and the offending characters, and NEVER fabricates a candidate.
 */

/** The one namespace this module governs. Compared case-INSENSITIVELY when detecting, exactly when judging. */
export const TOPIC_TAG_PREFIX = "topic:";

/**
 * The phase-token predicate's CLOSED set (spec Rev 5, copied VERBATIM —
 * changing it is a spec revision, not an implementation choice).
 *
 * Construction rule, stated so the boundary is inspectable: the eleven `type`
 * words, their English inflections, and the verify/test families this corpus's
 * own titles use as phase markers. DELIBERATELY EXCLUDED: words like delivery,
 * release, audit, debug — they are not type words, and in meta-projects (this
 * one included) they can be legitimate SUBJECTS; banning them would overreach
 * the orthogonality law into topic space.
 *
 * Known cost: occasional false positives (`visual-design`) are refused with
 * reason and rewritten (`visual-direction`).
 */
export const TOPIC_PHASE_TOKENS: ReadonlySet<string> = new Set([
  "discuss", "discussion", "discussions", "discussing", "discussed",
  "research", "researches", "researching", "researched",
  "measure", "measures", "measuring", "measured", "measurement", "measurements",
  "design", "designs", "designing", "designed",
  "correction", "corrections", "correct", "corrects", "correcting", "corrected",
  "implement", "implements", "implementing", "implemented", "implementation",
  "implementations",
  "refactor", "refactors", "refactoring", "refactored",
  "fix", "fixes", "fixing", "fixed", "bugfix", "bugfixes", "hotfix", "hotfixes",
  "delegate", "delegates", "delegating", "delegated", "delegation",
  "review", "reviews", "reviewing", "reviewed", "reviewer", "reviewers",
  "ops", "op", "operation", "operations",
  "verify", "verifies", "verifying", "verified", "verification",
  "test", "tests", "testing", "tested",
]);

/**
 * The orthogonality law, one register for every refusal that cites it
 * [S15069/T1996]: `type` is the PHASE axis, `tags` is the TOPIC axis. A topic
 * word carrying a phase makes one line's identity change when its phase does,
 * which is exactly the horizontal slicing lanes exist to avoid.
 */
export const ORTHOGONALITY_LAW =
  "type is the phase axis and a topic word is the subject axis — a subject that " +
  "carries its own phase stops being true the moment the work moves on";

/**
 * THE PHASE-TOKEN PREDICATE ITSELF, as a function rather than as a loop inlined
 * in `checkTopicTag` (staged-settlement spec Rev 5, reviewer guardrail 3: "the
 * phase-token predicate is shared into stage-1's lane create/retag entry
 * points, not wired to the `topic:` write face alone").
 *
 * The two faces judge DIFFERENT strings — a `topic:` payload and a lane tag —
 * and produce different refusal texts, but the question they ask is one
 * question, so it is one implementation. Tokenize on `-`; the first token in
 * the closed set is the offender, `null` when the word carries no phase.
 *
 * Takes a bare PAYLOAD (no namespace prefix), which is what a lane tag already
 * is; `checkTopicTag` strips its own prefix before calling.
 */
export function findPhaseToken(payload: string): string | null {
  for (const token of payload.split("-")) {
    if (TOPIC_PHASE_TOKENS.has(token)) {
      return token;
    }
  }
  return null;
}

/**
 * The CONTAINER-NAME face of the same predicate, as one sentence every entry
 * point can print (staged-settlement ticket 08's mount of ticket 06's handoff).
 *
 * Three call sites share it — stage 1's lane `create`, and the main agent's
 * `remember(retag)` at both tiers — because a rename is the same act as a
 * creation from the predicate's point of view: it puts a NEW name into the
 * registry. Without the retag face, stage 1's refusal is one `remember(retag)`
 * away from being laundered.
 *
 * `noun` names what is being refused ("lane name", "task tag"), since the two
 * tiers hold different kinds of container and a message that guessed would be
 * wrong on one of them. Returns `null` when the name carries no phase word;
 * callers add their own "Refused:"/"nothing was written" framing, which differs
 * per surface.
 */
export function phaseBearingNameRefusal(noun: string, name: string): string | null {
  const phaseToken = findPhaseToken(name);
  if (phaseToken === null) {
    return null;
  }
  return (
    `${noun} ${JSON.stringify(name)} contains the phase word ${JSON.stringify(phaseToken)} — ` +
    `${ORTHOGONALITY_LAW}. Name the subject it is about and let each member's own type carry ` +
    "its phase."
  );
}

const CANONICAL_PATTERN_TEXT =
  'topic:<word>, where <word> is lowercase letters, digits and "-" only ' +
  "(NFC, no leading or trailing hyphen, non-empty)";

/** Case-insensitive, because `Topic:x` claims the identical namespace — it is a malformed topic word, not a stray free-form tag. */
export function isTopicTag(tag: string): boolean {
  return tag.toLocaleLowerCase("en-US").startsWith(TOPIC_TAG_PREFIX);
}

/** Everything after the namespace, exactly as written. */
export function topicTagPayload(tag: string): string {
  return tag.slice(TOPIC_TAG_PREFIX.length);
}

export type TopicTagCheck =
  | { ok: true; tag: string; payload: string }
  | {
      ok: false;
      /**
       * `non-canonical` when only the spelling is wrong, `phase-token` when the
       * spelling is right and the WORD is. Callers that want to react
       * differently (a settlement backfill retrying its own casing versus one
       * rethinking its word) have the distinction without parsing prose.
       */
      violation: "non-canonical" | "phase-token";
      /** The mechanically derived unique repair, or `null` when deriving one would be a new judgment. */
      candidate: string | null;
      message: string;
    };

/** The canonical payload shape — the lane-tag charset, which is the charset this namespace borrows wholesale. */
const CANONICAL_PAYLOAD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The four mechanical repairs, applied together, in the only order that makes
 * each of them unique: trim, then case, then NFC, then hyphen placement
 * (collapse runs, drop the edges). Interior whitespace is NOT repaired — a
 * space could become a hyphen or nothing at all, and choosing is a judgment
 * about the author's word, so a payload holding one falls to the
 * no-candidate branch by the charset rule below.
 */
function deriveCandidatePayload(payload: string): string {
  return payload
    .trim()
    .toLocaleLowerCase("en-US")
    .normalize("NFC")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** Every character outside the canonical charset, first occurrence order, de-duplicated — what the caller has to decide about. */
function offendingCharacters(payload: string): string[] {
  const seen: string[] = [];
  for (const ch of payload) {
    if (!/^[a-z0-9-]$/.test(ch) && !seen.includes(ch)) {
      seen.push(ch);
    }
  }
  return seen;
}

/**
 * Judge one `topic:`-namespaced tag. The caller decides WHICH tags reach here
 * (`isTopicTag`); everything this sees is claiming the namespace, so a
 * non-topic string is a caller bug rather than a verdict.
 */
export function checkTopicTag(raw: string): TopicTagCheck {
  const payload = topicTagPayload(raw);
  const namespaceIsCanonical = raw.startsWith(TOPIC_TAG_PREFIX);
  const derivedPayload = deriveCandidatePayload(payload);

  if (!namespaceIsCanonical || payload !== derivedPayload) {
    // Two sub-cases, and the split is the whole point of the round-4 boundary:
    // the derived payload is either a legal word (so the repair IS the
    // candidate) or it still is not (so no candidate exists that this code
    // could claim the author meant).
    if (derivedPayload !== "" && CANONICAL_PAYLOAD_PATTERN.test(derivedPayload)) {
      const candidate = `${TOPIC_TAG_PREFIX}${derivedPayload}`;
      return {
        ok: false,
        violation: "non-canonical",
        candidate,
        message:
          `topic tag ${JSON.stringify(raw)} is not in canonical form — write ` +
          `${JSON.stringify(candidate)} instead. A topic word is refused rather than ` +
          "silently normalized, so the word stored is always the word written.",
      };
    }
    return nonDerivableRefusal(raw, payload);
  }

  if (payload === "" || !CANONICAL_PAYLOAD_PATTERN.test(payload)) {
    return nonDerivableRefusal(raw, payload);
  }

  const phaseToken = findPhaseToken(payload);
  if (phaseToken !== null) {
    return {
      ok: false,
      violation: "phase-token",
      candidate: null,
      message:
        `topic tag ${JSON.stringify(raw)} contains the phase word ${JSON.stringify(phaseToken)} — ` +
        `${ORTHOGONALITY_LAW}. Name the subject alone and let type carry the phase.`,
    };
  }

  return { ok: true, tag: raw, payload };
}

/**
 * The no-candidate refusal: the pattern, plus exactly which characters put the
 * word outside it. It never guesses — an empty payload and a CJK one are the
 * same kind of problem here, a word this code cannot write on the author's
 * behalf.
 */
function nonDerivableRefusal(raw: string, payload: string): TopicTagCheck {
  const offending = offendingCharacters(deriveCandidatePayload(payload));
  const offendingText =
    offending.length === 0
      ? "it is empty once trimmed"
      : `these characters have no place in it: ${offending.map((ch) => JSON.stringify(ch)).join(", ")}`;
  return {
    ok: false,
    violation: "non-canonical",
    candidate: null,
    message:
      `topic tag ${JSON.stringify(raw)} is not in canonical form — ${offendingText}. ` +
      `The canonical form is ${CANONICAL_PATTERN_TEXT}. No replacement is suggested: ` +
      "repairing this would be a new judgment about what the word should say, and that is yours.",
  };
}

/**
 * The first tag in `tags` that claims the `topic:` namespace ILLEGALLY, or
 * `null` when every one of them is a legal topic word (and when there are
 * none at all). This is the shape a write boundary wants: "is anything here
 * refusable", asked without the boundary knowing the grammar.
 */
export function findIllegalTopicTag(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (isTopicTag(tag) && !checkTopicTag(tag).ok) {
      return tag;
    }
  }
  return null;
}

/** The refusal text for a tag `findIllegalTopicTag` returned. */
export function topicTagRefusalMessage(tag: string): string {
  const verdict = checkTopicTag(tag);
  return verdict.ok
    ? `topic tag ${JSON.stringify(tag)} is legal.`
    : verdict.message;
}

/** Just the `topic:` entries of a tag set, in the order they appear. */
export function topicTagsOf(tags: readonly string[]): string[] {
  return tags.filter((tag) => isTopicTag(tag));
}
