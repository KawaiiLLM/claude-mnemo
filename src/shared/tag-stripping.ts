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

const RETIRED_TAG_NAMESPACE = "topic:";

/**
 * The retired `topic:` namespace (spec B6) stays retired at the WRITE
 * boundary, not just in the one-time migration. `stripRetiredTopicTagNamespace`
 * (db/schema.ts) strips the prefix off every existing row once; nothing
 * stopped a caller from writing it straight back in until this check landed
 * (peer review item 3 on ticket 02) — an existing `remember` test even
 * expected `topic:a&b` to persist. Returns the first offending tag, or null.
 */
export function findRetiredTopicTag(
  tags: readonly string[],
): string | null {
  return tags.find((tag) => tag.startsWith(RETIRED_TAG_NAMESPACE)) ?? null;
}

/**
 * Shared wording for both public write tools (`note`, `remember`): reject
 * loudly rather than silently strip. Silent stripping — which the migration
 * and the settlement write-back both do, correctly, to a value that already
 * has to be dealt with one way or another — would hide the fact that the
 * CALLER sent a tag the schema no longer accepts, on a fresh write where
 * silence has no excuse.
 */
export function retiredTopicTagMessage(tag: string): string {
  const bare = tag.slice(RETIRED_TAG_NAMESPACE.length);
  return (
    `tag "${tag}" uses the retired topic: namespace (spec B6) — tags are bare` +
    ` subject words now. Use "${bare}" instead.`
  );
}
