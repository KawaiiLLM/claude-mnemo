/**
 * THE ONE PARSER for `turns.tags` (main-agent-edges spec D9, transform 1;
 * acceptance R9-8 / R10-10).
 *
 * Before the cutover, four readers parsed this column four different ways —
 * `db/turns.ts` cast whatever JSON it found to `string[]`, `db/segments.ts`
 * dropped non-string members and swallowed parse errors, `db/lanes.ts` cast
 * to `unknown[]` and filtered, `db/edge-side-resolution.ts` swallowed errors
 * into `[]` — so the same row could be a member of a lane for one reader and
 * of nothing for another. The cutover makes the invariant a DATABASE fact:
 * `tags` is `NOT NULL DEFAULT '[]'` and a BEFORE INSERT/UPDATE trigger raises
 * unless the value is a JSON array whose every member is a string. With the
 * storage refusing the malformed value, no reader has any business coercing
 * one; it THROWS, by name, so the defect is found where it was written rather
 * than silently read as "no tags".
 *
 * `null` is NOT malformed here. It is the one value a reader can still meet on
 * a database the cutover has not reached yet (D9's fence defers the migration
 * while a settlement claim is live, and every initializer proceeds on the OLD
 * schema in that window); it means "no tags" — which is exactly what the
 * cutover normalises it to (`NULL -> '[]'`). After the cutover the column is
 * NOT NULL and this arm is unreachable.
 */

export class MalformedTurnTagsError extends Error {
  constructor(
    readonly raw: string,
    detail: string,
  ) {
    super(`turns.tags is not a JSON array of strings (${detail}): ${JSON.stringify(raw)}`);
    this.name = "MalformedTurnTagsError";
  }
}

/** The stored column value -> the tag list. Throws `MalformedTurnTagsError` on anything that is not a JSON array of strings. */
export function readTurnTags(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedTurnTagsError(raw, "not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new MalformedTurnTagsError(raw, "not an array");
  }
  for (const member of parsed) {
    if (typeof member !== "string") {
      throw new MalformedTurnTagsError(raw, "a member is not a string");
    }
  }
  return parsed as string[];
}
