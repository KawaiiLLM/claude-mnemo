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
