const MAX_TAG_OCCURRENCES = 100;

function stripTag(text: string, tagName: string): string {
  const openTagPattern = new RegExp(`<${tagName}\\b`, "g");
  const matches = text.match(openTagPattern);

  if ((matches?.length ?? 0) > MAX_TAG_OCCURRENCES) {
    return text;
  }

  return text.replace(
    new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "g"),
    "",
  );
}

export function stripPrivateTags(text: string): string {
  return stripTag(text, "private");
}

export function stripClaudeMnemoContextTags(text: string): string {
  return stripTag(text, "claude-mnemo-context");
}

/**
 * THE `topic:` NAMESPACE IS NO LONGER RETIRED (staged-settlement spec Rev 5,
 * ticket 01). It carries one free subject word per turn, and the grammar that
 * judges it lives in `shared/topic-tag.ts` — a whole contract (canonical form,
 * the derivable/non-derivable refusal boundary, the phase-token predicate),
 * not the blanket rejection that used to sit here.
 *
 * These two names are a COMPATIBILITY SHIM, and the only reason they still
 * exist is that `worker/note-settlement-turn-facade.ts` imports them and is
 * under a concurrent ticket's pen. Their SEMANTICS changed with the contract:
 * `findRetiredTopicTag` now finds a tag claiming the namespace ILLEGALLY
 * (non-canonical, or phase-bearing), so the facade's early check went from
 * "refuse every topic word" to "refuse a malformed one" without an edit — the
 * same verdict `checkTurnTagWrite` reaches a few lines later. The integration
 * ticket should switch that import to the real names and delete this shim.
 */
export {
  findIllegalTopicTag as findRetiredTopicTag,
  topicTagRefusalMessage as retiredTopicTagMessage,
} from "./topic-tag";
