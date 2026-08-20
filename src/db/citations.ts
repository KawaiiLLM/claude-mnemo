import type { Database } from "bun:sqlite";

import {
  getOutgoingEdges,
  pairKey,
  reconcileCitedPairs,
  retractMemoryEdges,
  writeMemoryEdges,
  type CitingNode,
  type EdgeNode,
  type EdgeProvenance,
  type MemoryEdge,
  type RetractEdgeInput,
  type WriteEdgeInput,
} from "./memory-edges";
import {
  parseBareAddressReference,
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
// Ticket 01 (turn-edge-mechanism spec): `refines`/`override`/`encodes`/
// `grounded-on` join the storage vocabulary alongside the original four.
// `supersedes` STAYS — existing edges are frozen-readable (10 measured
// `supersedes` edges, none of which actually invalidated a predecessor's
// whole conclusion, so it is not remapped to `override` either) — but it is
// no longer a relation a NEW write may request: `mcp/note.ts` dropped it from
// its own parameter list, so the only surviving writer of `supersedes` is
// settlement's own facade (`worker/note-settlement-turn-facade.ts`, outside
// this ticket). The seven-word CLOSED set a fresh write may carry lives in
// `shared/turn-phase.ts`'s `EDGE_RELATIONS` — narrower than this storage-level
// list on purpose.
export const CITATION_RELATIONS = [
  "evidence-for",
  "evidence-against",
  "supersedes",
  "depends-on",
  "refines",
  "override",
  "encodes",
  "grounded-on",
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
   * Null = a bare, unattributed citation — a real, storable state that the
   * generic readers below (`getTurnCitations`, `getSessionEffectiveCitations`)
   * must surface, not filter out. Only relation-SPECIFIC logic (e.g. the
   * `supersedes` branch in `mcp/timeline.ts`) may narrow on this field.
   *
   * Retired history: C5 (write-mode-edit-semantics era) read `relation` as an
   * attribute of the pair, not part of its identity — at most one relation
   * per (citing, cited) pair. edge-mechanism-revision ticket 01's D2 (multi-
   * relation) superseded that: `relation` is now part of the row's identity,
   * and the same pair may carry several relation rows at once (a bare,
   * relation-NULL row still capped to one per pair by a partial unique
   * index) — see this file's own edge-write path and the retraction mirrors
   * in `mcp/note.ts`.
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
  /** BARE rows dropped because no field names them any more; relation rows survive prose drift (edge-revision D1). */
  deleted: MemoryEdge[];
  /** References the body named that did not resolve, or that this session was never shown. */
  rejected: RejectedReference[];
}

/**
 * Spec C6, narrowed to the BARE layer by edge-mechanism-revision D1: a bare
 * `[S<session>/T<n>]`/`[E<n>]` in ANY of a turn's citation-bearing fields is
 * a real, storable citation, and a rewrite that drops the reference drops the
 * BARE row. Relation rows are standalone claims (attachTurnRelations below)
 * and survive any prose rewrite — an ordinary note correction must never
 * silently destroy edges nobody retracted; a wrong relation dies by
 * retraction, not prose drift.
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
 * record, only a bare textual reference.
 *
 * Edge-mechanism-revision D4 (ticket 02) DEMOTED what that bare row means: it
 * is a display signal (the ↳ pull-through, cited counts) and nothing else. It
 * is no longer the substrate a relation has to be "upgraded" from — a relation
 * write (`attachTurnRelations` below) neither needs a bare row to exist nor
 * consults one, so prose citation and edge declaration are two independent
 * acts on the same turn.
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

// ---------------------------------------------------------------------------
// Relation attach and retraction (edge-mechanism-revision D1/D3, ticket 02;
// relation vocabulary spec C1)
// ---------------------------------------------------------------------------

/**
 * Edge-mechanism-revision D1 (ticket 02) RETIRED two of the four reasons this
 * union used to carry, and neither is bypassed — both checks are gone:
 *
 *   - `not-cited`, spec C7's co-occurrence rule ("a relation may only attach
 *     to a pair this same call's body already names"). Prose and edges are
 *     decoupled now: content carries no citation obligation at all, so a rule
 *     that made the body the licence for an edge could only be satisfied by
 *     writing citations nobody reads.
 *   - `duplicate-target`, the tool-surface half of "one relation per pair".
 *     Storage stopped enforcing it in ticket 01 (D2: one row per (pair,
 *     relation)), and a landing turn genuinely both `depends-on` a plan and
 *     `encodes` a ruling about the same target.
 *
 * `self-loop` is the pre-check for the primitive's own refusal, raised here so
 * the caller can name the address instead of reporting a silent drop.
 * `no-such-edge` is RETRACTION-only: an address that resolved but carries no
 * such relation on this turn.
 */
export type TurnRelationRejectionReason =
  | "malformed"
  | "unresolved"
  | "self-loop"
  | "no-such-edge";

export interface TurnRelationRejection {
  relation: CitationRelation;
  /** The token as the caller supplied it, for the message the tool layer builds. */
  raw: string;
  reason: TurnRelationRejectionReason;
}

/**
 * One named relation field's raw targets — mcp/note.ts's `evidenceFor` etc.,
 * and (ticket 02) its `retractEvidenceFor` mirror, which addresses the same
 * (relation, addresses) shape at `retractTurnRelations` instead.
 */
export interface TurnRelationFieldInput {
  relation: CitationRelation;
  targets: readonly string[];
}

export interface AttachTurnRelationsResult {
  /** The (pair, relation) rows this call actually ADDED — one per accepted, not-already-stored input. */
  written: MemoryEdge[];
  /**
   * Accepted inputs whose (pair, relation) row was ALREADY stored, so nothing
   * changed. Reported rather than folded into `written` because D2 makes a
   * relation write additive and idempotent: the caller's receipt has to be
   * able to say "added" and "already there" apart, or a model re-asserting a
   * relation it wrote yesterday reads its own no-op as new work.
   */
  restated: MemoryEdge[];
  /**
   * Non-empty means the WHOLE call is invalid, and `written`/`restated` are
   * always empty alongside it. Unlike a bare `[S/T]` reference in prose —
   * dropped and logged, never a reason to fail the note it arrived with — a
   * relation field is structured caller input, not text a model might
   * hallucinate a bracket into. A caller that gets back a malformed address
   * or an unresolvable one gets ALL of them, to fix in one pass, rather than
   * a write that silently applied the three relations that happened to be
   * valid.
   */
  rejected: TurnRelationRejection[];
}

/** An address token resolved to an edge endpoint, or the reason it could not be. */
function resolveRelationTargetNode(
  db: Database,
  raw: string,
): EdgeNode | "malformed" | "unresolved" {
  const reference = parseBareAddressReference(raw);
  if (!reference) {
    return "malformed";
  }
  const { accepted } = validateReferences(db, [reference]);
  return accepted[0]?.node ?? "unresolved";
}

/** `(pair, relation)` as one string — the identity D2 gave a stored row. */
function relationRowKey(
  citing: CitingNode,
  cited: EdgeNode,
  relation: CitationRelation | null,
): string {
  return `${pairKey({ citing, cited })}|${relation ?? ""}`;
}

function storedRelationRowKeys(db: Database, citing: CitingNode): Set<string> {
  return new Set(
    getOutgoingEdges(db, citing).map((edge) =>
      relationRowKey(citing, edge.cited, edge.relation),
    ),
  );
}

/**
 * Edge-mechanism-revision D1 (ticket 02): a relation is declared on its own,
 * with NO reference to what the citing turn's prose says. The spec's own
 * words — "正文与边彻底脱钩" — retire the C7 co-occurrence contract this
 * function used to enforce through a `bodyCitedPairs` parameter: content is
 * prose again, and an edge is a structured claim beside it. What survives as
 * a machine check is only what a claim cannot be wrong about by construction:
 * the address resolves (references.ts), it is not this turn itself, and — one
 * layer up, at the tool surface — the phase pair is legal and the citing
 * turn's write gate admits the writer.
 *
 * Provenance (spec C12) says WHICH writer filed the claim, and is the only
 * thing that differs between the two callers: `asserted` — the default — is
 * the main agent's own classification, `judged` is settlement's hindsight
 * attribution (ticket 04 routes the settlement facade through this same
 * function rather than a second copy of it), and both are distinct from a bare
 * textual reference (`text-ref`, what `recomputeTurnCitedPairs` writes for the
 * pairs a body happens to name). Nothing downstream RANKS the two — a
 * settlement relation is not weaker than an agent one ([S15069/T1124]: both
 * writers hold the same power) — it is an audit fact about origin.
 *
 * Eligibility is this function's own checks and nothing else: after D1 there IS
 * no pre-existing-pair premise left to state, and ticket 04 deleted the
 * parameter that used to carry one into `writeMemoryEdges`.
 */
export function attachTurnRelations(
  db: Database,
  citingTurnId: number,
  fields: readonly TurnRelationFieldInput[],
  nowEpoch: number,
  provenance: EdgeProvenance = "asserted",
): AttachTurnRelationsResult {
  const citing: CitingNode = { kind: "turn", id: citingTurnId };

  const rejected: TurnRelationRejection[] = [];
  const inputs: WriteEdgeInput[] = [];
  const claimed = new Set<string>();

  for (const field of fields) {
    for (const raw of field.targets) {
      const node = resolveRelationTargetNode(db, raw);
      if (typeof node === "string") {
        rejected.push({ relation: field.relation, raw, reason: node });
        continue;
      }
      // Pre-check of `writeMemoryEdges`' own refusal, so the message can name
      // the address the caller sent — the primitive's `rejected` entry knows
      // only nodes, and a turn confirming itself would inflate the one
      // mechanical confirmation signal the ranking has.
      if (node.kind === "turn" && node.id === citingTurnId) {
        rejected.push({ relation: field.relation, raw, reason: "self-loop" });
        continue;
      }
      const key = relationRowKey(citing, node, field.relation);
      // The same claim twice in one call is one claim. Two DIFFERENT relations
      // on the same pair are two claims and both land (D2).
      if (claimed.has(key)) {
        continue;
      }
      claimed.add(key);
      inputs.push({ citing, cited: node, relation: field.relation, provenance });
    }
  }

  if (rejected.length > 0 || inputs.length === 0) {
    return { written: [], restated: [], rejected };
  }

  const alreadyStored = storedRelationRowKeys(db, citing);
  const { written } = writeMemoryEdges(db, inputs, nowEpoch);

  const added: MemoryEdge[] = [];
  const restated: MemoryEdge[] = [];
  for (const edge of written) {
    const key = relationRowKey(citing, edge.cited, edge.relation);
    (alreadyStored.has(key) ? restated : added).push(edge);
  }
  return { written: added, restated, rejected: [] };
}

export interface RetractTurnRelationsResult {
  deleted: MemoryEdge[];
  /**
   * Ticket 10: BARE rows put back because the retraction emptied a pair the
   * citing node's prose still names. Reported separately from `deleted` — a
   * receipt has to be able to say "the classification is gone but the citation
   * stands", which is a different fact from either "removed" or "nothing
   * happened".
   */
  restored: MemoryEdge[];
  /** Same all-or-nothing contract as the attach path: non-empty means nothing was deleted. */
  rejected: TurnRelationRejection[];
}

/** The citing node's citation-bearing text, as it stands at retraction time. */
type CitingBodyFields = RecomputeTurnCitedPairsFields;

/**
 * Ticket 10 (peer 终审必改 3): a retraction must not make a citation the prose
 * still asserts DISAPPEAR.
 *
 * Three separately-correct rules compose into one wrong outcome: a relation
 * write REPLACES the pair's bare row (D2 — one fact, one row); a retraction
 * HARD-DELETES the addressed row and refuses to downgrade it to a bare one
 * (D3 — a retraction claims nothing); and the bare layer is only re-derived
 * when prose is REWRITTEN (`recomputeTurnCitedPairs`, which in `mcp/note.ts`
 * runs under `touchedProse` and, in both live callers, BEFORE the retraction
 * anyway). So classifying a citation and then retracting the classification
 * left the pair with no row at all, and the `↳` pull-through and the cited
 * counts silently lost a target the body still names.
 *
 * The repair is at the retraction path rather than in the primitive: only here
 * is it known that a pair was emptied BY a retraction, and only here is the
 * citing node's body in reach. Rules unchanged: the bare row stays the pair's
 * existence record OF LAST RESORT — it is put back only for a pair that now
 * holds NO row, so a pair keeping another relation gains nothing, and bare and
 * relation rows still never coexist (ticket 01's one-fact-one-row de-dup, which
 * "keep both permanently" would have reversed at the cost of doubling every
 * reader's row count).
 *
 * `fields` is the citing node's body, so this is kind-agnostic on purpose: a
 * future segment- or session-citing retraction facade passes ITS OWN
 * title/content/insight here and gets the same treatment, and a bodyless
 * citing construct (a mechanical anchor) passes nulls and restores nothing —
 * there is no prose to re-assert the citation.
 *
 * Provenance is `text-ref` (spec C12): what is being recorded is that the body
 * names the target, which is exactly what a bare textual reference means. It
 * is NOT the retracted row's provenance — the writer's assertion is what was
 * just withdrawn.
 */
function restoreBareRowsForEmptiedPairs(
  db: Database,
  citing: CitingNode,
  emptiedCandidates: readonly EdgeNode[],
  fields: CitingBodyFields,
  nowEpoch: number,
): MemoryEdge[] {
  if (emptiedCandidates.length === 0) {
    return [];
  }

  const surviving = new Set(
    getOutgoingEdges(db, citing).map((edge) => `${edge.cited.kind}:${edge.cited.id}`),
  );
  const emptied = new Map<string, EdgeNode>();
  for (const node of emptiedCandidates) {
    const key = `${node.kind}:${node.id}`;
    if (!surviving.has(key)) {
      emptied.set(key, node);
    }
  }
  if (emptied.size === 0) {
    return [];
  }

  // The body is RE-read, not diffed: the same whole-node rescan
  // `reconcileCitedPairs` does, over the same three fields.
  //
  // Rejections are swallowed rather than logged. This rescan re-derives a body
  // that was already validated (and its illegal references already reported)
  // by the write that stored it; re-announcing them on an unrelated retraction
  // would be noise attributed to the wrong act. No exposure-ledger gate exists
  // any more (references.ts), so resolution here is exactly "does the address
  // name a row".
  const { accepted } = validateReferences(
    db,
    [
      ...parseQualifiedReferences(fields.title),
      ...parseQualifiedReferences(fields.content),
      ...parseQualifiedReferences(fields.insight),
    ],
    { logger: { warn: () => {} } },
  );

  const inputs: WriteEdgeInput[] = [];
  const claimed = new Set<string>();
  for (const entry of accepted) {
    const key = `${entry.node.kind}:${entry.node.id}`;
    const node = emptied.get(key);
    if (node === undefined || claimed.has(key)) {
      continue;
    }
    claimed.add(key);
    inputs.push({ citing, cited: node, relation: null, provenance: "text-ref" });
  }
  if (inputs.length === 0) {
    return [];
  }

  return writeMemoryEdges(db, inputs, nowEpoch).written;
}

/** The turn's citation-bearing fields as stored — the text a restore rescans. */
function readTurnBodyFields(db: Database, turnId: number): CitingBodyFields {
  return (
    db
      .query<CitingBodyFields, [number]>(
        "SELECT title, content, insight FROM turns WHERE id = ?",
      )
      .get(turnId) ?? { title: null, content: null, insight: null }
  );
}

/**
 * Edge-mechanism-revision D3 (ticket 02): remove one turn's relation,
 * addressed by (pair, relation) — the corrective half of D2's additive write.
 * A relation is never overwritten, so a wrong one is retracted and the right
 * one written: two auditable acts instead of a silent replacement. Both
 * writers have the same power here ([S15069/T1124]) — the main agent may
 * retract what settlement judged and vice versa, because a false assertion
 * must not outlive its refutation on account of who filed it.
 *
 * Existence is checked BEFORE anything is deleted, so a call naming one live
 * relation and one that was never there deletes neither and reports the
 * second by name (`no-such-edge`). A caller told only "0 deleted" cannot tell
 * "already gone" from "wrong address", and a model given that answer guesses.
 *
 * Retracting a pair's last relation leaves the pair with NO row from the
 * primitive's point of view — it is never DOWNGRADED to a bare row, because a
 * retraction claims nothing about whether the citation still exists. What
 * decides that is the citing turn's own prose, which this function re-reads
 * for exactly the emptied pairs (ticket 10, `restoreBareRowsForEmptiedPairs`):
 * a body that still names the target gets its bare row back under provenance
 * `text-ref`, and a body that does not leaves the pair gone. The old
 * behaviour — wait for the next prose rewrite — meant a retraction-only call
 * (which never recomputes) silently dropped a citation the body asserts.
 *
 * `nowEpoch` stamps any such restored row and is optional only because both
 * live callers predate it; it is the ordinary injected clock everywhere else.
 */
export function retractTurnRelations(
  db: Database,
  citingTurnId: number,
  fields: readonly TurnRelationFieldInput[],
  nowEpoch: number = Math.floor(Date.now() / 1000),
): RetractTurnRelationsResult {
  const citing: CitingNode = { kind: "turn", id: citingTurnId };

  const rejected: TurnRelationRejection[] = [];
  const targets: RetractEdgeInput[] = [];
  const addressed = new Set<string>();
  const stored = storedRelationRowKeys(db, citing);

  for (const field of fields) {
    for (const raw of field.targets) {
      const node = resolveRelationTargetNode(db, raw);
      if (typeof node === "string") {
        rejected.push({ relation: field.relation, raw, reason: node });
        continue;
      }
      const key = relationRowKey(citing, node, field.relation);
      if (!stored.has(key)) {
        rejected.push({ relation: field.relation, raw, reason: "no-such-edge" });
        continue;
      }
      if (addressed.has(key)) {
        continue;
      }
      addressed.add(key);
      targets.push({ citing, cited: node, relation: field.relation });
    }
  }

  if (rejected.length > 0 || targets.length === 0) {
    return { deleted: [], restored: [], rejected };
  }

  const { deleted } = retractMemoryEdges(db, targets);
  const restored = restoreBareRowsForEmptiedPairs(
    db,
    citing,
    deleted.map((edge) => edge.cited),
    readTurnBodyFields(db, citingTurnId),
    nowEpoch,
  );
  return { deleted, restored, rejected: [] };
}

/**
 * Every structured edge written by one turn, cross-session edges included.
 *
 * A relationless (bare) pair is a real citation (spec C5) and is returned
 * here same as any other — filtering it out would empty C5 of its content,
 * since the whole point of pair identity is that an unattributed citation
 * exists. The `relation` tiebreak in the ORDER BY became load-bearing with
 * edge-mechanism-revision D2: a pair may now hold several rows (one per
 * relation, plus at most one bare), so `cited_id ASC` alone is no longer a
 * total order. NULLs sort first, which keeps a pair's bare row ahead of its
 * classified ones.
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

/**
 * Deliberately does NOT include `citesRecorded`. That flag used to choose
 * between the two sources below and no longer participates — narrowing the
 * type is what stops a future reader reaching for it again.
 */
export type CitationSubject = Pick<TurnRecord, "id" | "content">;

export interface EffectiveCitations {
  /** Cited DB turn ids, de-duplicated, resolved, in a stable order. */
  citedTurnIds: number[];
  /** Structured edges backing some of those ids; a prose-only pair has none. */
  edges: TurnCitationEdge[];
}

/** Append ids not already present, preserving first-seen order. */
function appendUnseen(into: number[], ids: readonly number[]): void {
  const seen = new Set(into);
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      into.push(id);
    }
  }
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
 * Both sources, always, unioned by target id — no gate.
 *
 * There used to be one: `cites_recorded` picked the edge table when a writer
 * had "spoken" and the inline `[T<n>]` grammar otherwise. Ticket 06 removed
 * the last writer that set the flag, which would have left every ordinary turn
 * reading prose alone; but restoring a setter was the wrong repair, because
 * the flag conflates "a writer enumerated this turn's citations" with "this
 * turn has structured edges" and cannot express "some structured edges, plus
 * prose that may hold more". A flag that can be forgotten, or can lie, is
 * stored state protecting a derivation — and after ticket 06 both sources
 * derive from the SAME body, so the union cannot invent a pair and a rewrite
 * that drops a reference removes it from both. Correctness now follows from
 * what is in the tables at read time rather than from a bit somebody had to
 * remember to set. The column outlived its reader for a while as inert
 * history and ticket 10c has since dropped it outright.
 *
 * Structured first, then prose the edges did not already cover: the recompute
 * parses title, content and insight while the inline grammar sees `content`
 * alone, so the edge set is the wider of the two for anything written since
 * ticket 06, and the prose is the only signal for anything older.
 *
 * This is the layer that RESOLVES ids: the parser is deliberately DB-blind and
 * keeps returning raw ids, but a citation that names no turn is not a citation,
 * so dangling ids (and a self-citation, which the write path already refuses)
 * are dropped here. Cross-session edges survive as provenance —
 * `getSessionEffectiveCitations` is the session-local view that drops them.
 */
export function getEffectiveCitations(
  db: Database,
  turn: CitationSubject,
): EffectiveCitations {
  const edges = getTurnCitations(db, turn.id);
  const citedTurnIds = dedupeCitedIds(edges);

  const turnExists = db.query<{ id: number }, [number]>(
    "SELECT id FROM turns WHERE id = ?",
  );
  appendUnseen(
    citedTurnIds,
    parseInlineCitations(turn.content).filter(
      (id) => id !== turn.id && turnExists.get(id) != null,
    ),
  );

  return { citedTurnIds, edges };
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
 * Session-local means three exclusions, applied to BOTH sources of the union so
 * they can never disagree about what a session's graph contains:
 *
 *   - dangling ids — an id naming no turn is not an edge;
 *   - cross-session ids — written as provenance, but inert for every
 *     session-local algorithm (§B) and unfollowable in a one-session view;
 *   - self-citations — a turn confirming its own in-degree would break the one
 *     mechanical confirmation rule the settle pass has (§A).
 *
 * Turns with no effective citations are present with an empty list.
 */
export function getSessionEffectiveCitations(
  db: Database,
  sessionId: number,
): Map<number, EffectiveCitations> {
  const turns = db
    .query<
      { id: number; content: string | null },
      [number]
    >(
      `SELECT id, content
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
    const edges = edgesByCiter.get(turn.id) ?? [];
    const citedTurnIds = dedupeCitedIds(edges);
    appendUnseen(
      citedTurnIds,
      parseInlineCitations(turn.content).filter(
        (id) => id !== turn.id && sessionTurnIds.has(id),
      ),
    );
    effective.set(turn.id, { citedTurnIds, edges });
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
