/**
 * The shared `type` vocabulary (spec §B, ticket 02). One word list serves both
 * levels: a turn's type and a segment's type (the union of its members'), so
 * recall's `type:` filter means the same thing whichever granularity it lands
 * on. Both columns are multi-valued JSON arrays (spec B5).
 *
 * Eleven peers, no qualifier class (spec B2) — see the ticket/spec for each
 * word's definition and the boundaries measurement showed failing (B3).
 * `write`, `chat` and `rolled-back` left the vocabulary this ticket:
 * spec-and-ticket authoring is `design` (often `design`+`implement`) and
 * explaining is `discuss`; `chat` is renamed `discuss`; a reversal is
 * knowable only after the fact and is carried by a `supersedes` edge, not a
 * retroactively-maintained type (B4) — `correction` states that THIS turn
 * reversed something, never that an earlier turn was the casualty.
 *
 * `compact` is NOT a member of this vocabulary and never has been — it is a
 * legacy sentinel a small number of readers check directly (the mechanical
 * PreCompact marker row). It is read-legal on any turn regardless of era; see
 * `hooks/capture-repair.ts` and `db/note-debt.ts`'s `realPromptPredicate`.
 *
 * The mechanical title-to-type derivation this vocabulary used to carry
 * (`draftTypeFromTitle` / `draftTurnFactsFromTitle`) is retired, not kept as a
 * fallback (spec B1): a title-based count of `implement` over-counted
 * implementation activity by about a quarter, and of 427 `<activity>+<topic>:`
 * titles measured, 74 never resolved. The writer states `type` directly when
 * it writes the note.
 */

export const MEMORY_TYPES = [
  "discuss",
  "research",
  "design",
  "implement",
  "refactor",
  "fix",
  "measure",
  "review",
  "ops",
  "delegate",
  "correction",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(value: unknown): value is MemoryType {
  return (
    typeof value === "string" &&
    (MEMORY_TYPES as readonly string[]).includes(value)
  );
}

/** Current-vocabulary glyphs. `correction` reuses `rolled-back`'s old ↩️: both name a reversal, one from the corrector's side. */
export const TYPE_GLYPH: Record<MemoryType, string> = {
  discuss: "💬",
  research: "🔍",
  design: "⚖️",
  implement: "🔧",
  refactor: "🔄",
  fix: "🔴",
  measure: "📊",
  review: "✅",
  ops: "⚙️",
  delegate: "🤝",
  correction: "↩️",
};

/** The compact-marker glyph (⏸): outside the vocabulary, always legal. */
export const COMPACT_TYPE_GLYPH = "⏸";

/**
 * Retired-vocabulary glyphs, for a legacy row a render surface may still meet
 * (spec's Out of Scope: existing rows keep their pre-migration words as-is —
 * neither this column nor a re-labelling pass touches them). `refactor`
 * re-enters the current vocabulary with the SAME glyph it wore here, so a
 * turn's glyph does not change meaning across the migration.
 */
export const LEGACY_TYPE_GLYPH: Record<string, string> = {
  bugfix: "🔴",
  feature: "🟣",
  refactor: "🔄",
  change: "✅",
  discovery: "🔵",
  decision: "⚖️",
  compact: COMPACT_TYPE_GLYPH,
};

/**
 * The glyph for one activity word, current vocabulary first, then the legacy
 * map, `•` when neither recognises it. One resolver for every render surface
 * (the turn table, the phase table, the segment spine) so a word's glyph
 * cannot drift between them.
 */
export function typeWordGlyph(word: string): string {
  if (isMemoryType(word)) {
    return TYPE_GLYPH[word];
  }
  return LEGACY_TYPE_GLYPH[word] ?? "•";
}

/**
 * The glyph for a turn or segment's whole type LIST (spec B5: multi-valued).
 * `[]` — no type was stated — is `•`, never a positive value (spec B7); a
 * multi-valued list joins each word's own glyph with no separator, so two
 * simultaneous activities read as two glyphs rather than one arbitrarily
 * chosen "primary" one.
 */
export function typeListGlyph(types: readonly string[] | null | undefined): string {
  if (!types || types.length === 0) {
    return "•";
  }
  return types.map(typeWordGlyph).join("");
}

/**
 * Validate and de-duplicate a multi-value type list, order-preserving.
 *
 * Throws on an unknown word (a typo silently dropped would make `type:`
 * filters quietly lossy) — the caller is expected to catch this and answer
 * with a parameter error rather than let a bad word reach storage; an absent
 * or illegal activity word is a caller decision to write `[]`, not this
 * function's to make (spec B7: empty is never a claim, never a guess).
 */
export function normalizeTypeValues(values: readonly string[]): MemoryType[] {
  const normalized: MemoryType[] = [];

  for (const raw of values) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    if (!isMemoryType(value)) {
      throw new Error(`unknown type value: ${raw}`);
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }

  return normalized;
}

/**
 * Order-sensitive equality over two type lists (spec's phase-grouping rule,
 * ticket 02: "two turns share a phase iff their type lists are identical").
 * Order-sensitive rather than set-equality on purpose — a list is the
 * writer's own stated order, and treating `["review","ops"]` and
 * `["ops","review"]` as the same phase would be inventing a normalization
 * nobody asked for.
 */
export function typeListsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
