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

/*
 * THE `topic:` COMPATIBILITY SHIM STOOD HERE and is deleted (staged-settlement
 * ticket 08). Ticket 01 left `findRetiredTopicTag`/`retiredTopicTagMessage`
 * re-exported from `./topic-tag` with inverted semantics — the namespace is
 * live now, and what those names find is a tag claiming it ILLEGALLY — because
 * `worker/note-settlement-turn-facade.ts` was under a concurrent ticket's pen
 * and could not be edited. It has been edited: the facade imports
 * `findIllegalTopicTag`/`topicTagRefusalMessage` from `shared/topic-tag.ts`,
 * which is where the whole grammar lives (canonical form, the
 * derivable/non-derivable refusal boundary, the phase-token predicate). This
 * file is back to what its name says: stripping tag pairs out of text.
 */
