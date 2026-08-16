import type { Database } from "bun:sqlite";

import type { EdgeNode } from "./memory-edges";

/**
 * The one address space the model ever writes (spec D7, 裁决 15).
 *
 * Every reference a writer produces is FULLY QUALIFIED: `[S15069/T332]` for a
 * turn, `[E47]` for a segment. The bare `[T332]` relative form is abolished —
 * it was the ambiguity source behind the 0.2.34 mis-citation bug, because the
 * same number names a different turn in every session and a reader (human or
 * machine) has to guess which one was meant.
 *
 * S is a session's database id and T is that turn's prompt number within it, so
 * resolution is a lookup on the UNIQUE(session_id, prompt_number) index — the
 * same pair `note`/`recall` render with. Global database ids never appear in a
 * prompt or a note; they exist only after resolution, here and in the edge
 * table.
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
 * accident, not a different claim. Everything else is prose: a bare `[T332]`
 * (abolished by 裁决 15 — the same number names a different turn in every
 * session), `[S15069]`, `[see S1/T2]`, `[S1/T2, S1/T3]`. A malformed bracket is
 * skipped WHOLE rather than salvaged down to its leading id, because salvaging
 * would mint a citation out of a construct the writer did not intend as one.
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
 */
function topLevelBracketGroups(content: string): string[] {
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
 * Every qualified reference in a body, in first-seen order, de-duplicated on
 * the resolved address (so `[S1/T2]` written twice is one reference).
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

  for (const group of topLevelBracketGroups(content)) {
    const match = REFERENCE_PATTERN.exec(group);
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
