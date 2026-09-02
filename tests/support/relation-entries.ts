/**
 * relation-vocabulary-v13 ticket 02: the one place a test builds a `correct`
 * relation entry.
 *
 * `correct` is the only class that carries a coverage bit, and the write path
 * REFUSES an entry without one, so a bare address string — legal for `verify`
 * and `use` — is not a legal `correct` target. Every fixture that used to send
 * `override: ["S1/T2"]` or `narrows: [...]` sends `correct` through here
 * instead, so the FULL-versus-PARTIAL distinction each one meant is stated at
 * the call site rather than lost in a rename.
 *
 * The two lane sides default to `''` (unsettled) — exactly what a bare address
 * used to mean — so a fixture converted through this helper keeps testing the
 * same DRAFT shape it always did. A fixture that placed its edge in lanes
 * passes its own sides.
 */
export interface CorrectRelationEntry {
  turn: string;
  tailTag: string;
  headTag: string;
  coverage: "full" | "partial";
}

export function correctEntry(
  target: string | { turn: string; tailTag?: string; headTag?: string },
  coverage: "full" | "partial",
): CorrectRelationEntry {
  if (typeof target === "string") {
    return { turn: target, tailTag: "", headTag: "", coverage };
  }
  return {
    turn: target.turn,
    tailTag: target.tailTag ?? "",
    headTag: target.headTag ?? "",
    coverage,
  };
}
