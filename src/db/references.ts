import type { Database } from "bun:sqlite";

import type { EdgeNode } from "./memory-edges";

/**
 * The one address space the model ever writes (spec D7, 裁决 15).
 *
 * Every reference a writer produces is FULLY QUALIFIED: `S15069/T332` for a
 * turn, `E47` for a segment. The RELATIVE `T332` form (a turn's prompt number
 * alone, with no session) is abolished — it was the ambiguity source behind
 * the 0.2.34 mis-citation bug, because the same number names a different turn
 * in every session and a reader (human or machine) has to guess which one was
 * meant. Do not confuse this retired RELATIVE form with the "bare" word used
 * below and throughout this module for ticket 11's unbracketed `S15069/T332` —
 * two unrelated senses of the same English word: one is abolished, the other
 * is the taught format.
 *
 * S is a session's database id and T is that turn's prompt number within it, so
 * resolution is a lookup on the UNIQUE(session_id, prompt_number) index — the
 * same pair `note`/`recall` render with. Global database ids never appear in a
 * prompt or a note; they exist only after resolution, here and in the edge
 * table.
 *
 * Ticket 11 (staged-settlement spec, USER RULING S15069/T2016): a qualified
 * address may be written bracketed (`[S15069/T332]`, the original, still-legal
 * form — historical notes carry it and it must keep resolving forever) OR
 * bare (`S15069/T332`, no brackets, the form taught going forward — see
 * `BARE_REFERENCE_PATTERN` below). Both grammars resolve identically; a body
 * may freely mix them.
 */

export interface TurnReference {
  kind: "turn";
  raw: string;
  sessionId: number;
  promptNumber: number;
}

export interface SegmentReference {
  kind: "segment";
  raw: string;
  segmentId: number;
}

export type ParsedReference = TurnReference | SegmentReference;

/**
 * Three legal shapes, and only three:
 *
 *   - qualified turn      `[S15069/T332]`
 *   - annotated turn      `[S15069/T332 approval]`  (the id wins, the note is
 *                                                    for the human reader)
 *   - segment             `[E47]` / `[E47 the retry arc]`
 *
 * Whitespace around the slash is tolerated — a wrapped line is a typography
 * accident, not a different claim. Everything else is prose: a RELATIVE
 * `[T332]` (abolished by 裁决 15 — the same number names a different turn in
 * every session), `[S15069]`, `[see S1/T2]`, `[S1/T2, S1/T3]`. A malformed
 * bracket is skipped WHOLE rather than salvaged down to its leading id,
 * because salvaging would mint a citation out of a construct the writer did
 * not intend as one — this holds regardless of ticket 11's unbracketed
 * grammar below, since a malformed bracket's interior is never exposed to
 * that scan either (`splitBracketSegments`'s own doc comment).
 *
 * This pattern is ONLY the bracketed half of the grammar; ticket 11's bare
 * (unbracketed) sibling — `BARE_REFERENCE_PATTERN`, applied to the text
 * BETWEEN bracket groups by `parseQualifiedReferences` — has no annotation
 * clause at all, since a bare address has no closing delimiter to hold
 * trailing prose apart from it.
 */
// Horizontal whitespace only ([ \t], never \s): a bracket that wraps a line
// break is prose that happens to sit inside brackets, not a reference — the
// same call the legacy inline grammar makes.
//
// Anchored, and NOT global: it is applied to one already-isolated bracket
// group rather than scanned across prose. Scanning was what made "skipped
// WHOLE" a comment rather than a behaviour — a global scan starts at ANY `[`,
// so `[[S1/T2]]` matched at the inner bracket and `[see [S1/T2] and [S1/T3]]`
// matched in the middle, salvaging citations out of exactly the constructs the
// doc comment above says must not yield one.
const REFERENCE_PATTERN =
  /^\[[ \t]*(?:S(\d+)[ \t]*\/[ \t]*T(\d+)|E(\d+))(?:[ \t]+(?![,\-])[^\]\n\r]*)?[ \t]*\]$/;

/**
 * The address-token grammar: the same shapes as a body citation, MINUS the
 * annotation.
 *
 * The two strictnesses are deliberate rather than a duplicated grammar. An
 * annotation exists so a human reading PROSE can see why a turn is cited —
 * `[S15069/T332 approval]` reads better than a bare id in a sentence. An
 * address FIELD has no prose and no reader: it carries one address and
 * nothing else, so words inside it are a writer that misread the schema, and
 * parsing past them would accept the misreading silently.
 */
const ADDRESS_TOKEN_PATTERN =
  /^\[[ \t]*(?:S\d+[ \t]*\/[ \t]*T\d+|E\d+)[ \t]*\]$/;

/** True when `bracketed` is one bare address and nothing else. */
export function isBareAddressToken(bracketed: string): boolean {
  return ADDRESS_TOKEN_PATTERN.test(bracketed);
}

/**
 * Parse ONE caller-supplied address token — `S12/T30`, `[S12/T30]`, `E47`,
 * `[E47]` — brackets optional, annotation never allowed (this is a
 * structured field value, not prose). For a write path that takes a bare
 * address as a PARAMETER rather than as an inline citation: ticket 07's
 * relation-attach fields (db/citations.ts's `attachTurnRelations`) are the
 * caller today.
 *
 * `note-settlement-writeback.ts` carries its own private copy of this exact
 * logic (`parseAddressToken`, predating this export) for its `members`/
 * `edges` tokens. The duplication is deliberate rather than an oversight:
 * ticket 10 moves settlement onto these same public write paths, and that is
 * the point where the two collapse into one — not before, when the two
 * callers' surrounding code is still being rewritten out from under it.
 */
export function parseBareAddressReference(token: string): ParsedReference | null {
  const trimmed = token.trim();
  const bracketed = trimmed.startsWith("[") ? trimmed : `[${trimmed}]`;
  if (!isBareAddressToken(bracketed)) {
    return null;
  }
  const parsed = parseQualifiedReferences(bracketed);
  return parsed.length === 1 ? parsed[0]! : null;
}

/**
 * The top-level bracket groups of a body, each returned with its offset.
 *
 * A group that contains a nested `[` is dropped ENTIRELY rather than descended
 * into — that is what "a malformed bracket is skipped whole" means, and it
 * cannot be expressed by a pattern that scans, because the inner bracket looks
 * innocent from the inside. An unterminated `[` yields no group at all.
 *
 * Exported (ticket 10d): the settlement segment facade's `E#<handle>` run-
 * scoped citation needs the identical "only a real bracket group, never a
 * bare substring in running prose" discipline this project's own address
 * grammar already applies to `[S<n>/T<n>]`/`[E<n>]` — reusing this rather
 * than a second bracket-scanner is what keeps the two grammars from silently
 * drifting apart.
 */
export function topLevelBracketGroups(content: string): string[] {
  const groups: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "[") {
      continue;
    }
    const start = index;
    let depth = 0;
    let nested = false;
    let cursor = index;
    for (; cursor < content.length; cursor += 1) {
      const char = content[cursor];
      if (char === "[") {
        depth += 1;
        if (depth > 1) {
          nested = true;
        }
      } else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    if (depth !== 0) {
      // Unterminated: nothing from here on is a well-formed group.
      break;
    }
    if (!nested) {
      groups.push(content.slice(start, cursor + 1));
    }
    index = cursor;
  }
  return groups;
}

function parsePositiveId(digits: string | undefined): number | null {
  if (digits === undefined) {
    return null;
  }
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Ticket 11 (staged-settlement spec, USER RULING S15069/T2016): the citation
 * format simplifies to the bare address — `S18993/T31`, no brackets — for
 * token economy. The bracket form is not abolished (historical notes still
 * carry it and must keep resolving forever); this is the SECOND grammar a
 * prose body may use, word-boundary delimited so it cannot fire inside a
 * longer identifier (`\b` requires a non-word/word transition on each side,
 * which letter-to-letter runs like "TYPE47" never produce). No annotation
 * form exists for it — unlike a bracketed citation, a bare one has no closing
 * delimiter to hold trailing prose apart from the sentence that follows it.
 *
 * A literal mention of the grammar itself ("cite as S<n>/T<m>") can never
 * match: `<n>`/`<m>` are not digits, and this pattern requires `\d+`. Only a
 * REAL address — concrete digits — matches, and a real address appearing in
 * running prose has always been treated as a citation once it stood inside
 * brackets; this is that same rule extended to the address standing alone.
 */
const BARE_REFERENCE_PATTERN = /\bS(\d+)\/T(\d+)\b|\bE(\d+)\b/g;

/** One (possibly empty) run of text with no top-level bracket in it, or one top-level bracket group INCLUDING its own `[`/`]`. */
type ContentSegment =
  | { kind: "text"; text: string }
  | { kind: "bracket"; group: string };

/**
 * The same top-level-bracket walk `topLevelBracketGroups` performs, but
 * interleaved with the free-text gaps between (and around) the bracket
 * groups it finds, in document order.
 *
 * A bracket is OPAQUE to the bare grammar, well-formed or not: the interior
 * of `[see S1/T2]` or `[S1/T2, S1/T3]` is bracket-grammar prose that happens
 * to name digits, not a bare citation standing on its own, so it is never
 * handed to `BARE_REFERENCE_PATTERN` — only the gaps between brackets are. A
 * nested bracket (`[foo [S1/T2]]`) is malformed as a whole under the
 * bracket grammar (see `topLevelBracketGroups`'s own doc comment) and its
 * ENTIRE span, interior included, is dropped here for the same reason: the
 * writer wrapped it in a construct that was never meant to read as a bare
 * mention either.
 *
 * Not built on top of `topLevelBracketGroups` itself: that function's own
 * contract (its doc comment: ticket 10d's settlement facade) is "just the
 * bracket bodies", and widening its return shape to carry offsets/gaps would
 * ripple into that caller for no reason of its own. The walk is short enough
 * that a second copy is cheaper than a shared abstraction neither caller
 * actually wants both halves of.
 */
function splitBracketSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let index = 0;
  let textStart = 0;
  while (index < content.length) {
    if (content[index] !== "[") {
      index += 1;
      continue;
    }
    const start = index;
    let depth = 0;
    let nested = false;
    let cursor = index;
    for (; cursor < content.length; cursor += 1) {
      const char = content[cursor];
      if (char === "[") {
        depth += 1;
        if (depth > 1) {
          nested = true;
        }
      } else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    if (depth !== 0) {
      // Unterminated: nothing after this point can close a bracket, so the
      // stray `[` and everything after it is free text — handled by the
      // trailing push below.
      break;
    }
    if (textStart < start) {
      segments.push({ kind: "text", text: content.slice(textStart, start) });
    }
    // A nested bracket's whole span (interior included) is dropped rather
    // than exposed as text — see the doc comment above.
    if (!nested) {
      segments.push({ kind: "bracket", group: content.slice(start, cursor + 1) });
    }
    index = cursor + 1;
    textStart = index;
  }
  if (textStart < content.length) {
    segments.push({ kind: "text", text: content.slice(textStart) });
  }
  return segments;
}

function collectBareReferences(
  text: string,
  references: ParsedReference[],
  seen: Set<string>,
): void {
  BARE_REFERENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_REFERENCE_PATTERN.exec(text)) !== null) {
    const segmentId = parsePositiveId(match[3]);
    if (segmentId !== null) {
      const key = `E${segmentId}`;
      if (!seen.has(key)) {
        seen.add(key);
        references.push({ kind: "segment", raw: match[0], segmentId });
      }
      continue;
    }

    const sessionId = parsePositiveId(match[1]);
    const promptNumber = parsePositiveId(match[2]);
    if (sessionId === null || promptNumber === null) {
      continue;
    }
    const key = `S${sessionId}/T${promptNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push({ kind: "turn", raw: match[0], sessionId, promptNumber });
    }
  }
}

/**
 * Every reference in a body, bracketed or bare, in first-seen order,
 * de-duplicated on the resolved address (so `[S1/T2]` and a later bare
 * `S1/T2` are one reference — whichever came first keeps its `raw`).
 *
 * DB-blind by design: whether the address exists, and whether its writer was
 * ever shown it, are `validateReferences`' questions.
 */
export function parseQualifiedReferences(
  content: string | null | undefined,
): ParsedReference[] {
  if (!content) {
    return [];
  }

  const references: ParsedReference[] = [];
  const seen = new Set<string>();

  for (const segment of splitBracketSegments(content)) {
    if (segment.kind === "text") {
      collectBareReferences(segment.text, references, seen);
      continue;
    }

    const match = REFERENCE_PATTERN.exec(segment.group);
    if (match === null) {
      continue;
    }
    const raw = match[0];
    const segmentId = parsePositiveId(match[3]);
    if (segmentId !== null) {
      const key = `E${segmentId}`;
      if (!seen.has(key)) {
        seen.add(key);
        references.push({ kind: "segment", raw, segmentId });
      }
      continue;
    }

    const sessionId = parsePositiveId(match[1]);
    const promptNumber = parsePositiveId(match[2]);
    if (sessionId === null || promptNumber === null) {
      continue;
    }
    const key = `S${sessionId}/T${promptNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push({ kind: "turn", raw, sessionId, promptNumber });
    }
  }

  return references;
}

export type ReferenceRejection = "unresolved" | "unexposed";

export interface ResolvedReference {
  reference: ParsedReference;
  node: EdgeNode;
}

export interface RejectedReference {
  reference: ParsedReference;
  reason: ReferenceRejection;
}

export interface ValidateReferencesOptions {
  /** Optional, for the drop log's session prefix. */
  writerSessionId?: number;
  logger?: Pick<Console, "warn">;
}

export interface ValidateReferencesResult {
  accepted: ResolvedReference[];
  rejected: RejectedReference[];
}

/**
 * Resolve references to database nodes, dropping any address that names
 * nothing.
 *
 * ONE gate: the address must resolve to a row. An id naming nothing is not a
 * citation, and that is the whole question a pair's existence turns on
 * (spec C6).
 *
 * There used to be a second gate — the id had to appear in the writer's
 * exposure ledger. It is removed, for two reasons that arrived together. The
 * ledger records only the addresses the note machinery hands over (the owed
 * turn, the backlog-relief block), never what a session actually read, so once
 * ticket 06 made prose citations the only way to create an edge it rejected a
 * citation of anything found through recall or timeline — 55% of this
 * project's own turns at time of writing. And the deeper reason, the user's:
 * whether an agent saw something is not auditable. Attention inside a large
 * context is not observable, so any ledger of it approximates in both
 * directions, while existence is a fact storage answers exactly.
 *
 * The anti-hallucination job the second gate was doing now rests where it can
 * actually be checked: the address grammar (ticket 01) refuses a bare or
 * annotated form, so a guess must be a fully qualified address that resolves.
 *
 * Illegal references go to the log and NOWHERE else. They never reach the edge
 * table and they never abort the write they came with: a hallucinated citation
 * must not cost the note it was attached to.
 */
export function validateReferences(
  db: Database,
  references: readonly ParsedReference[],
  options: ValidateReferencesOptions = {},
): ValidateReferencesResult {
  const accepted: ResolvedReference[] = [];
  const rejected: RejectedReference[] = [];

  if (references.length === 0) {
    return { accepted, rejected };
  }

  const turnLookup = db.query<{ id: number }, [number, number]>(
    "SELECT id FROM turns WHERE session_id = ? AND prompt_number = ?",
  );
  const segmentLookup = db.query<{ id: number }, [number]>(
    "SELECT id FROM segments WHERE id = ?",
  );

  for (const reference of references) {
    if (reference.kind === "turn") {
      const row = turnLookup.get(reference.sessionId, reference.promptNumber);
      if (!row) {
        rejected.push({ reference, reason: "unresolved" });
        continue;
      }
      accepted.push({ reference, node: { kind: "turn", id: row.id } });
      continue;
    }

    const row = segmentLookup.get(reference.segmentId);
    if (!row) {
      rejected.push({ reference, reason: "unresolved" });
      continue;
    }
    accepted.push({ reference, node: { kind: "segment", id: row.id } });
  }

  if (rejected.length > 0) {
    const logger = options.logger ?? console;
    logger.warn?.(
      `[claude-mnemo] S${options.writerSessionId ?? "?"}: dropped ${rejected.length} illegal reference(s): ${rejected
        .map((entry) => `${entry.reference.raw} (${entry.reason})`)
        .join(", ")}`,
    );
  }

  return { accepted, rejected };
}


/** Parse + validate in one step, the shape every write path wants. */
export function resolveContentReferences(
  db: Database,
  content: string | null | undefined,
  options: ValidateReferencesOptions = {},
): ValidateReferencesResult {
  return validateReferences(db, parseQualifiedReferences(content), options);
}
