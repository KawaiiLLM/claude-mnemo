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
 *
 * Case-INSENSITIVE (round-5 review #16a): `Topic:routing`/`TOPIC:routing`
 * carry the identical retired namespace as `topic:routing` — a
 * case-sensitive `startsWith` let a caller through the gate by nothing more
 * than a capital letter. The comparison lowercases before matching; the
 * RETURNED tag keeps its original casing (`retiredTopicTagMessage` slices by
 * a fixed index, not by matched text, so it still names the bare word
 * correctly regardless of the namespace's casing).
 */
export function findRetiredTopicTag(
  tags: readonly string[],
): string | null {
  return (
    tags.find((tag) => tag.toLocaleLowerCase("en-US").startsWith(RETIRED_TAG_NAMESPACE)) ?? null
  );
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
