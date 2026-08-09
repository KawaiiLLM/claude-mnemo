import type { Database } from "bun:sqlite";

import { getExposedTurnIds } from "./note-debt";
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
const REFERENCE_PATTERN =
  /\[[ \t]*(?:S(\d+)[ \t]*\/[ \t]*T(\d+)|E(\d+))(?:[ \t]+(?![,\-])[^\]\n\r]*)?[ \t]*\]/g;

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

  REFERENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_PATTERN.exec(content)) !== null) {
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
  /** The session whose exposure ledger governs — the WRITER's session. */
  writerSessionId: number;
  /**
   * Segment ids the writer was shown. The exposure ledger (note_id_exposures)
   * only records turns, so a segment reference is existence-checked unless the
   * caller supplies this set — passing one turns the same gate on for segments.
   */
  exposedSegmentIds?: ReadonlySet<number>;
  logger?: Pick<Console, "warn">;
}

export interface ValidateReferencesResult {
  accepted: ResolvedReference[];
  rejected: RejectedReference[];
}

/**
 * Resolve references to database nodes, dropping anything the writer could not
 * legitimately have cited.
 *
 * Two gates, both required (spec D7, the inverse design of the 0.2.34 bug where
 * a model invented plausible-looking ids):
 *
 *   1. the address must resolve to a row — an id naming nothing is not a
 *      citation;
 *   2. the id must appear in the writer's EXPOSURE LEDGER — the record of what
 *      this session actually rendered into the model's context. A turn the
 *      writer was never shown cannot be something it built on; at best it is a
 *      lucky guess, and a citation graph built out of lucky guesses is worse
 *      than one with holes.
 *
 * Illegal references go to the log and NOWHERE else. They are never written to
 * the edge table, and they never abort the write they came with: a hallucinated
 * citation must not cost the note it was attached to.
 */
export function validateReferences(
  db: Database,
  references: readonly ParsedReference[],
  options: ValidateReferencesOptions,
): ValidateReferencesResult {
  const accepted: ResolvedReference[] = [];
  const rejected: RejectedReference[] = [];

  if (references.length === 0) {
    return { accepted, rejected };
  }

  const exposedTurnIds = getExposedTurnIds(db, options.writerSessionId);
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
      if (!exposedTurnIds.has(row.id)) {
        rejected.push({ reference, reason: "unexposed" });
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
    if (
      options.exposedSegmentIds !== undefined &&
      !options.exposedSegmentIds.has(reference.segmentId)
    ) {
      rejected.push({ reference, reason: "unexposed" });
      continue;
    }
    accepted.push({ reference, node: { kind: "segment", id: row.id } });
  }

  if (rejected.length > 0) {
    const logger = options.logger ?? console;
    logger.warn?.(
      `[claude-mnemo] S${options.writerSessionId}: dropped ${rejected.length} illegal reference(s): ${rejected
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
  options: ValidateReferencesOptions,
): ValidateReferencesResult {
  return validateReferences(db, parseQualifiedReferences(content), options);
}
