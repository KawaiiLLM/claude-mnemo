import type { Database } from "bun:sqlite";

import { reconcileCitedPairs, type MemoryEdge } from "./memory-edges";
import {
  parseQualifiedReferences,
  validateReferences,
  type RejectedReference,
} from "./references";
import type { TurnRecord } from "./turns";

/**
 * Structured causal edges between turns (spec §B; identity/storage narrowed
 * by ticket 05/spec C5, C13). `memory_edges` (db/memory-edges.ts) is the sole
 * physical table — the legacy `turn_citations` table is retired outright
 * (spec C13: two tables holding edges, with two consumers disagreeing about
 * which one is current, was the bug). This module is the turn-scoped
 * convenience API over it: every function here filters `memory_edges` to
 * `turn`↔`turn` pairs and speaks in bare turn ids, the shape the rest of the
 * codebase (remember.ts, timeline.ts) already expects. The inline `[T<n>]`
 * forms stay in prose for human readers and remain the only signal for turns
 * extracted before the edge table existed.
 */
export const CITATION_RELATIONS = [
  "evidence-for",
  "evidence-against",
  "supersedes",
  "depends-on",
] as const;

export type CitationRelation = (typeof CITATION_RELATIONS)[number];

export function isCitationRelation(value: unknown): value is CitationRelation {
  return (
    typeof value === "string" &&
    (CITATION_RELATIONS as readonly string[]).includes(value)
  );
}

export interface TurnCitationEdge {
  citingTurnId: number;
  citedTurnId: number;
  /**
   * C5: an attribute of the pair, not part of its identity. Null = a bare,
   * unattributed citation — a real, storable state that the generic readers
   * below (`getTurnCitations`, `getSessionEffectiveCitations`) must surface,
   * not filter out. Only relation-SPECIFIC logic (e.g. the `supersedes`
   * branch in `mcp/timeline.ts`) may narrow on this field.
   */
  relation: CitationRelation | null;
  createdAtEpoch: number;
}

/**
 * An inclusive `[T<a>-T<b>]` range expands in full only while it names at most
 * this many turns; a wider range keeps its two endpoints. Ranges are written by
 * hand ("the T8942-T8964 sweep") and a 20-turn span is a gesture at a block of
 * work, not 20 individual causal claims — expanding it would swamp the citation
 * signal with incidental turns.
 *
 * This is the ONLY cap the grammar imposes (spec §B). A body may name any number
 * of ids across singles, lists and brackets; a consumer that wants a ceiling
 * passes `maxRefs` to `parseInlineCitations`.
 */
export const INLINE_RANGE_EXPANSION_CAP = 8;

const RANGE_PATTERN = /^T(\d+)\s*-\s*T(\d+)$/;
const LIST_PATTERN = /^T\d+(?:\s*,\s*T\d+)+$/;
const LIST_ELEMENT_PATTERN = /T(\d+)/g;
const SINGLE_PATTERN = /^T(\d+)$/;
/**
 * Annotated form: the id, whitespace, then free text on the SAME line. The
 * negative lookahead is what stops a broken list or range (`[T12 , foo]`,
 * `[T12 - 13]`) from being salvaged down to its leading id — those bodies are
 * malformed instances of another form, not annotations.
 */
const ANNOTATED_PATTERN = /^T(\d+)\s+(?![,\-])\S/;

function parsePositiveId(digits: string): number | null {
  const id = Number.parseInt(digits, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Yields the bodies of the brackets that are even eligible to be a citation.
 *
 * A bracket that contains another bracket (`[[T12]]`, `[foo [T12]]`) is
 * malformed as a whole and BOTH levels are skipped: the inner form is part of
 * the outer body, so salvaging it would mint a citation out of a construct the
 * writer plainly did not intend as one. Scanning resumes past the outer close.
 */
function* citationBracketBodies(content: string): Generator<string> {
  let index = 0;
  while (index < content.length) {
    const open = content.indexOf("[", index);
    if (open === -1) {
      return;
    }
    const close = content.indexOf("]", open + 1);
    if (close === -1) {
      // Unterminated: nothing after this point can close a bracket.
      return;
    }

    const body = content.slice(open + 1, close);
    index = close + 1;
    if (body.includes("[")) {
      continue;
    }
    yield body;
  }
}

/**
 * Expands one bracket body into the DB turn ids it names, per the literal
 * grammar (spec §B):
 *
 *   - single      `[T8501]`
 *   - comma list  `[T8075, T9824]`   (spaces optional)
 *   - range       `[T8942-T8964]`    (inclusive; see INLINE_RANGE_EXPANSION_CAP)
 *   - annotated   `[T9019 approval]` (leading id wins, annotation ignored)
 *
 * Anything else — no digits, a stray token in a list, a descending range,
 * `[dbid:T12]`, `[see T12]`, a body that wraps a line break — is malformed and
 * the WHOLE bracket is ignored rather than salvaged: a partial salvage would
 * invent citations out of prose that merely mentions a turn.
 */
function expandBracketBody(body: string): number[] {
  // Every form is a single-line token. A body carrying a line break is prose
  // that happens to sit inside brackets, so the whole bracket is malformed.
  if (/[\n\r]/.test(body)) {
    return [];
  }

  const inner = body.trim();

  const range = RANGE_PATTERN.exec(inner);
  if (range) {
    const start = parsePositiveId(range[1]!);
    const end = parsePositiveId(range[2]!);
    // A descending pair is not an inclusive range; treat it as malformed.
    if (start === null || end === null || end < start) {
      return [];
    }
    const span = end - start + 1;
    if (span > INLINE_RANGE_EXPANSION_CAP) {
      return [start, end];
    }
    const ids: number[] = [];
    for (let id = start; id <= end; id += 1) {
      ids.push(id);
    }
    return ids;
  }

  if (LIST_PATTERN.test(inner)) {
    const ids: number[] = [];
    LIST_ELEMENT_PATTERN.lastIndex = 0;
    let element: RegExpExecArray | null;
    while ((element = LIST_ELEMENT_PATTERN.exec(inner)) !== null) {
      const id = parsePositiveId(element[1]!);
      if (id === null) {
        return [];
      }
      ids.push(id);
    }
    return ids;
  }

  const single = SINGLE_PATTERN.exec(inner);
  if (single) {
    const id = parsePositiveId(single[1]!);
    return id === null ? [] : [id];
  }

  const annotated = ANNOTATED_PATTERN.exec(inner);
  if (annotated) {
    const id = parsePositiveId(annotated[1]!);
    return id === null ? [] : [id];
  }

  return [];
}

/**
 * Parses inline `[T<n>]`-family causal references out of a turn's content.
 * Returns DB turn ids (the agent's id space, the same id passed to `remember()`)
 * in first-seen order, de-duplicated ACROSS forms.
 *
 * `maxRefs` is a CONSUMER ceiling, not part of the grammar: the milestone view
 * bounds how many raw candidates it will validate per milestone, so it passes
 * one. Left undefined, every id the content names comes back.
 *
 * Dangling ids are the caller's concern: this function does not touch the DB, so
 * an id that names no turn, a different session, or a later turn still comes
 * back. `getEffectiveCitations` / `getSessionEffectiveCitations` resolve them;
 * the milestone consumers apply their own existence/session/predecessor guards.
 */
export function parseInlineCitations(
  content: string | null,
  maxRefs?: number,
): number[] {
  if (!content) {
    return [];
  }
  const cap = maxRefs ?? Number.POSITIVE_INFINITY;
  if (cap <= 0) {
    return [];
  }

  const ids: number[] = [];
  const seen = new Set<number>();
  for (const body of citationBracketBodies(content)) {
    for (const id of expandBracketBody(body)) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
      if (ids.length >= cap) {
        return ids;
      }
    }
  }

  return ids;
}

export interface RecomputeTurnCitedPairsFields {
  title: string | null;
  content: string | null;
  insight: string | null;
}

export interface RecomputeTurnCitedPairsResult {
  /** The turn's full outgoing pair set after reconciliation. */
  written: MemoryEdge[];
  /** Pairs dropped because no field supports them any more, relation included (spec C6). */
  deleted: MemoryEdge[];
  /** References the body named that did not resolve, or that this session was never shown. */
  rejected: RejectedReference[];
}

/**
 * Spec C6: a bare `[S<session>/T<n>]`/`[E<n>]` in ANY of a turn's
 * citation-bearing fields is a real, storable citation, and a rewrite that
 * drops the reference drops the pair — relation included, since a relation
 * cannot outlive the pair that carries it. This is the sole write path left
 * for a turn's outgoing edges: the earlier `replaceTurnCitations` accepted a
 * bare `{turn, relation}` list with no prose backing it at all, which made
 * every rule below bypassable in one call (spec C6's "generic body-free
 * structured edge write is removed").
 *
 * `fields` is the turn's title/content/insight AS THEY STAND after the
 * caller's own write — `note`/`remember` pass the row a prior write in the
 * same transaction just returned, so this always rescans the true post-state
 * rather than the caller's possibly-partial input (a `remember` call that
 * only touches `content` must still see title/insight's stored text).
 *
 * References are resolved through the SAME two gates every writer-attributed
 * citation goes through (references.ts: existence, then this turn's own
 * session's exposure ledger) — a hallucinated or unshown id is dropped and
 * logged, never written. Provenance is always `text-ref` (spec C12): nothing
 * in this call carries a relation, so there is no main-agent ASSERTION to
 * record, only a bare textual reference. Attaching a relation to a pair a
 * body creates is spec C7/ticket 07's, not this function's.
 */
export function recomputeTurnCitedPairs(
  db: Database,
  turnId: number,
  fields: RecomputeTurnCitedPairsFields,
  nowEpoch: number,
  writerSessionId: number,
  logger?: Pick<Console, "warn">,
): RecomputeTurnCitedPairsResult {
  const references = [
    ...parseQualifiedReferences(fields.title),
    ...parseQualifiedReferences(fields.content),
    ...parseQualifiedReferences(fields.insight),
  ];

  const { accepted, rejected } = validateReferences(db, references, {
    writerSessionId,
    logger,
  });

  const { written, deleted } = reconcileCitedPairs(
    db,
    { kind: "turn", id: turnId },
    accepted.map((entry) => entry.node),
    nowEpoch,
    "text-ref",
  );

  return { written, deleted, rejected };
}

/**
 * Every structured edge written by one turn, cross-session edges included.
 *
 * A relationless (bare) pair is a real citation (spec C5) and is returned
 * here same as any other — filtering it out would empty C5 of its content,
 * since the whole point of pair identity is that an unattributed citation
 * exists. Ordering needs no `relation` tiebreak beyond the one already
 * written below: the pair's PRIMARY KEY (citing, cited) means at most one row
 * exists per `cited_id` for a fixed `citing_id`, so `cited_id ASC` alone is
 * already a total order and stays deterministic with NULLs present.
 */
export function getTurnCitations(
  db: Database,
  citingTurnId: number,
): TurnCitationEdge[] {
  return db
    .query<TurnCitationEdge, [number]>(
      `SELECT
         citing_id AS citingTurnId,
         cited_id AS citedTurnId,
         relation,
         created_at_epoch AS createdAtEpoch
       FROM memory_edges
       WHERE citing_kind = 'turn' AND citing_id = ?
         AND cited_kind = 'turn'
       ORDER BY cited_id ASC, relation ASC`,
    )
    .all(citingTurnId);
}

export type CitationSubject = Pick<
  TurnRecord,
  "id" | "content" | "citesRecorded"
>;

export interface EffectiveCitations {
  /** `structured` = read from the edge table; `inline` = legacy content parse. */
  source: "structured" | "inline";
  /** Cited DB turn ids, de-duplicated, resolved, in a stable order. */
  citedTurnIds: number[];
  /** Structured edges; always empty when `source` is `inline`. */
  edges: TurnCitationEdge[];
}

function dedupeCitedIds(edges: readonly TurnCitationEdge[]): number[] {
  const citedTurnIds: number[] = [];
  const seen = new Set<number>();
  for (const edge of edges) {
    if (seen.has(edge.citedTurnId)) {
      continue;
    }
    seen.add(edge.citedTurnId);
    citedTurnIds.push(edge.citedTurnId);
  }
  return citedTurnIds;
}

/**
 * The fallback predicate (spec §B). `cites_recorded = 1` means the extractor
 * spoke: the edge table is authoritative and an EMPTY edge set means this turn
 * genuinely cites nothing. `cites_recorded = 0` means it never spoke, so the
 * inline `[T<n>]` grammar is the only signal available.
 *
 * The flag — never a created-at epoch — decides, because a turn created before
 * the deployment can be extracted after it, and an explicit `cites: []` is
 * otherwise indistinguishable from legacy absence.
 *
 * This is the layer that RESOLVES ids: the parser is deliberately DB-blind and
 * keeps returning raw ids, but a citation that names no turn is not a citation,
 * so dangling ids (and a legacy self-citation, which the structured write path
 * already refuses) are dropped here. Cross-session edges survive as provenance —
 * `getSessionEffectiveCitations` is the session-local view that drops them.
 */
export function getEffectiveCitations(
  db: Database,
  turn: CitationSubject,
): EffectiveCitations {
  if (turn.citesRecorded) {
    const edges = getTurnCitations(db, turn.id);
    return { source: "structured", citedTurnIds: dedupeCitedIds(edges), edges };
  }

  const turnExists = db.query<{ id: number }, [number]>(
    "SELECT id FROM turns WHERE id = ?",
  );
  const citedTurnIds = parseInlineCitations(turn.content).filter(
    (id) => id !== turn.id && turnExists.get(id) != null,
  );

  return { source: "inline", citedTurnIds, edges: [] };
}

/**
 * Every turn of one session mapped to its EFFECTIVE citations — the batched,
 * session-local form of `getEffectiveCitations`, keyed by citing turn id in
 * prompt order. One query for the turns and one for the edges: a session
 * consumer (in-degree, victim demotion, ↳ pull-through) never needs N+1.
 *
 * A relationless (bare) edge is included same as any other (spec C5) — it is
 * not one of the three exclusions below, and it still contributes to
 * `citedTurnIds` / in-degree; only relation-SPECIFIC consumers (e.g. victim
 * demotion's `supersedes` check) have any reason to ignore it.
 *
 * Session-local means three exclusions, applied to BOTH the structured and the
 * legacy inline path so the two can never disagree about what a session's graph
 * contains:
 *
 *   - dangling ids — an id naming no turn is not an edge;
 *   - cross-session ids — written as provenance, but inert for every
 *     session-local algorithm (§B) and unfollowable in a one-session view;
 *   - self-citations — a turn confirming its own in-degree would break the one
 *     mechanical confirmation rule the settle pass has (§A).
 *
 * Turns with no effective citations are present with an empty list, so a caller
 * can also read `source` (did this turn's extractor speak?) per turn.
 */
export function getSessionEffectiveCitations(
  db: Database,
  sessionId: number,
): Map<number, EffectiveCitations> {
  const turns = db
    .query<
      { id: number; content: string | null; citesRecorded: number },
      [number]
    >(
      `SELECT id, content, cites_recorded AS citesRecorded
       FROM turns
       WHERE session_id = ?
       ORDER BY prompt_number ASC, id ASC`,
    )
    .all(sessionId);

  const sessionTurnIds = new Set(turns.map((turn) => turn.id));

  const edgesByCiter = new Map<number, TurnCitationEdge[]>();
  const edgeRows = db
    .query<TurnCitationEdge, [number, number]>(
      `SELECT
         e.citing_id AS citingTurnId,
         e.cited_id AS citedTurnId,
         e.relation,
         e.created_at_epoch AS createdAtEpoch
       FROM memory_edges e
       JOIN turns citing ON citing.id = e.citing_id AND e.citing_kind = 'turn'
       JOIN turns cited ON cited.id = e.cited_id AND e.cited_kind = 'turn'
       WHERE citing.session_id = ? AND cited.session_id = ?
       ORDER BY e.citing_id ASC, e.cited_id ASC, e.relation ASC`,
    )
    .all(sessionId, sessionId);
  for (const edge of edgeRows) {
    if (edge.citedTurnId === edge.citingTurnId) {
      continue;
    }
    const bucket = edgesByCiter.get(edge.citingTurnId);
    if (bucket) {
      bucket.push(edge);
    } else {
      edgesByCiter.set(edge.citingTurnId, [edge]);
    }
  }

  const effective = new Map<number, EffectiveCitations>();
  for (const turn of turns) {
    if (turn.citesRecorded === 1) {
      const edges = edgesByCiter.get(turn.id) ?? [];
      effective.set(turn.id, {
        source: "structured",
        citedTurnIds: dedupeCitedIds(edges),
        edges,
      });
      continue;
    }

    effective.set(turn.id, {
      source: "inline",
      citedTurnIds: parseInlineCitations(turn.content).filter(
        (id) => id !== turn.id && sessionTurnIds.has(id),
      ),
      edges: [],
    });
  }

  return effective;
}

/**
 * Session-local in-degree: for each cited turn in this session, how many turns
 * OF THE SAME SESSION cite it. Multiple relations between the same pair cannot
 * exist any more (spec C5), but the same pair discovered through two sources
 * still counts once — in-degree answers "how many turns consumed this", not
 * "how many claims were filed".
 *
 * Derived from the effective citations, NOT from the edge table alone: a legacy
 * turn (`cites_recorded = 0`) cites through its inline `[T<n>]` prose, and a
 * mechanical confirmation signal that ignored those would read zero in-degree
 * for every pre-deployment citer.
 */
export function getSessionCitationInDegree(
  db: Database,
  sessionId: number,
): Map<number, number> {
  const inDegree = new Map<number, number>();
  for (const entry of getSessionEffectiveCitations(db, sessionId).values()) {
    // citedTurnIds is already de-duplicated per citing turn, so each citer
    // contributes at most 1 — this IS the DISTINCT-citer count.
    for (const citedTurnId of entry.citedTurnIds) {
      inDegree.set(citedTurnId, (inDegree.get(citedTurnId) ?? 0) + 1);
    }
  }
  return inDegree;
}
