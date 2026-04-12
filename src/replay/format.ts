export function truncateText(
  text: string,
  preview: number,
  raw = false,
): string {
  if (raw || preview === 0 || text.length <= preview) {
    return text;
  }

  return `${text.slice(0, Math.max(0, preview - 1))}…`;
}

export function truncateJsonValue(
  value: unknown,
  preview = 60,
): string {
  const stringified = JSON.stringify(value);
  if (stringified.length <= preview) {
    return stringified;
  }

  if (
    preview >= 4 &&
    stringified.startsWith("\"") &&
    stringified.endsWith("\"")
  ) {
    const inner = stringified.slice(1, -1);
    return `"${inner.slice(0, preview - 3)}…"`;
  }

  return truncateText(stringified, preview);
}
