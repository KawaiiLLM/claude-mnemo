import type { Database } from "bun:sqlite";

import {
  getIncomingEdges,
  getOutgoingEdges,
  pairKey,
  retractMemoryEdges,
  selectLogicalEdgeRow,
  updateEdgeSides,
  writeMemoryEdges,
  RELATION_CLASS_SPECIFICITY,
  UNSETTLED_SIDE_TAG,
  type CitingNode,
  type EdgeNode,
  type EdgeProvenance,
  type EdgeSide,
  type MemoryEdge,
  type RetractEdgeInput,
  type WriteEdgeInput,
} from "./memory-edges";
import { EDGE_RELATIONS, type TurnEdgeRelation } from "../shared/turn-phase";
import {
  checkRelationCoverage,
  edgeRelationClass,
  interimLegacyRelation,
  isRelationCoverage,
  LEGACY_RELATIONS_BY_CLASS,
  NO_RELATION_COVERAGE,
  RELATION_CLASSES,
  type RelationClass,
  type RelationCoverageValue,
} from "../shared/relation-class";
import {
  parseBareAddressReference,
  parseQualifiedReferences,
  validateReferences,
} from "./references";
import { loadDeclaredLaneTags, loadSegmentTagIndex } from "./turn-tag-gate";
import { stampTurnRelationsRevision } from "./write-gate";
import type { TurnRecord } from "./turns";
import { liveTurnSql } from "./turn-liveness";

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
// Flow-relations spec, ticket 03 (the "contract half" — `.scratch/flow-
// relations/spec.md`'s migration item 3): narrowed to the eight-word
// vocabulary + `supersedes`, matching `schema.ts`'s now-narrow
// `memory_edges` CHECK (`MEMORY_EDGES_CONTRACT_RELATION_WORDS`). Ticket 02
// (the "expand half") widened this to old∪new for one release so a
// still-in-flight rename could not be rejected by a CHECK narrowed out from
// under it; that window is over — the seven retired words (evidence-for/
// evidence-against/depends-on/refines/encodes/grounded-on, plus `override`
// which never moved) are gone from BOTH the DB CHECK and this constant, kept
// in lockstep on purpose: a value this constant still accepted but the CHECK
// no longer does would let `writeMemoryEdges`' `isCitationRelation` gate pass
// a row through to an uncaught SQLite CHECK-constraint exception instead of
// a clean `invalid-relation` rejection (this is the live write-path gate,
// not a storage-layer historical record — contrast schema.ts's own
// migration-internal remaps, which resolve every retired word to its
// current replacement before it ever reaches this gate, precisely so they
// never need to hand this constant an old word to recognize).
// `supersedes` and `refutes` used to sit below as frozen-readable: words no
// write could request but stored rows still carried, so the read path had to
// recognise them. Lane-model v12 ticket 03 ended that state — M-B rewrites
// every such row onto `override` and M-D takes both words out of the table's
// own CHECK — so the storage vocabulary equals `shared/turn-phase.ts`'s
// `EDGE_RELATIONS`. It is still spelled out here rather than imported, so this
// storage-layer module keeps its zero runtime dependency on that constant; the
// guard test that used to pin the DIFFERENCE between the two now pins their
// EQUALITY.
//
// RELATION-VOCABULARY-V13 TICKET 02: this is the STORAGE vocabulary and no
// longer the WRITE vocabulary. A write asks for one of three CLASSES
// (`shared/relation-class.ts`) and lands under this list's interim equivalent,
// so nothing here moves — which is exactly the point: the `memory_edges` CHECK,
// the row identity key and every reader still keyed on these seven words are
// untouched by the vocabulary change, and ticket 03's migration of the existing
// corpus stays additive because their stored word is never rewritten.
export const CITATION_RELATIONS = [
  "override",
  "narrows",
  "extends",
  "indexes",
  "consume",
  "grounds",
  "verifies",
] as const;

export type CitationRelation = (typeof CITATION_RELATIONS)[number];

export function isCitationRelation(value: unknown): value is CitationRelation {
  return (
    typeof value === "string" &&
    (CITATION_RELATIONS as readonly string[]).includes(value)
  );
}

/**
 * RETRACTION-ONLY words (peer round T1466, finding P1-2): storable and
 * therefore RETRACTABLE, never assertable. Exactly `CITATION_RELATIONS` minus
 * `shared/turn-phase.ts`'s `EDGE_RELATIONS` — **empty since lane-model v12
 * ticket 03**, and empty is a meaningful value here, not a placeholder.
 *
 * WHY THE SET EXISTED, and why nothing is lost by its being empty. It was a
 * fix for a DEADLOCK: `supersedes` (later `refutes`) was frozen out of the
 * write vocabulary while stored rows carrying it still stood; E2 (a relation
 * word outside the write vocabulary) anchors at the citing turn, and the
 * settlement commit gate refuses while any E2 anchors inside the writable
 * set. With no way to delete such a row, a window owning one could never
 * commit — a permanently failing job, the terminal-state trap. The retraction
 * MIRRORS therefore extended to those words while the assertion fields never
 * did: both write surfaces derive their `retract…` parameters from
 * `EDGE_RELATIONS` ∪ this list, and their relation parameters from
 * `EDGE_RELATIONS` alone.
 *
 * Ticket 03's migration is what discharged it. M-B rewrites every stored row
 * onto `override`, and M-D removes both words from `memory_edges`' CHECK — so
 * no such row exists and none can be created, on any database `initializeSchema`
 * has opened. A word left in this list past that point is a `retract…`
 * parameter the tool keeps TEACHING and no call can ever act on, which is the
 * stale-teacher failure this project has been bitten by before.
 *
 * The list stays (rather than the machinery being inlined) because the DECISION
 * it encodes is still live: adding a word here re-opens a deletion path, adding
 * one to `EDGE_RELATIONS` re-opens a WRITE path, and those remain different
 * decisions. Any future word frozen out of the vocabulary with rows still
 * standing belongs here for exactly as long as those rows do.
 *
 * RELATION-VOCABULARY-V13 TICKET 02 CHECKED THIS AGAIN AND IT STAYS EMPTY.
 * The three-class write surface no longer offers `consume`/`grounds`/`indexes`,
 * which would ordinarily strand their stored rows in exactly the E2 deadlock
 * described above — a row nothing can delete. It does not, because retraction
 * moved to the CLASS level: `retractUse` resolves through
 * `shared/relation-class.ts`'s `LEGACY_RELATIONS_BY_CLASS` to every stored word
 * that means `use`, so all seven remain deletable through the three mirrors.
 * That resolution IS the fix; if it is ever narrowed back to one word per
 * mirror, the four words it covers belong in this list the same day.
 */
export const RETRACTION_ONLY_RELATIONS: readonly CitationRelation[] = [];

/**
 * The THREE named relation PARAMETERS, field name -> the CLASS it means —
 * DERIVED from `shared/relation-class.ts`'s `RELATION_CLASSES` rather than a
 * second hand-kept literal, so the closed set and its parameter spelling cannot
 * drift apart.
 *
 * RELATION-VOCABULARY-V13 TICKET 02: it used to be seven entries keyed on the
 * storage words. What made the seven-field surface wrong is not that it was
 * long — it is that the writer was taught one vocabulary and every reader
 * harvested another. The class carries the whole judgment now, and `correct`'s
 * FULL/PARTIAL bit rides on the ENTRY (`SidedRelationTarget.coverage`) rather
 * than splitting into two fields, so the precedence a writer runs
 * (CORRECT > VERIFY > USE) is the same shape as the parameter list it writes.
 *
 * THE ONE SOURCE FOR EVERY SURFACE. `mcp/definitions.ts`'s two zod shapes,
 * `mcp/note.ts`'s field loop, the settlement facade's own loop, and BOTH of
 * `worker/note-settlement-sdk-query.ts`'s allowlists (the stage-2 field
 * allowlist and the pre-`finalize` refusal) read this list. A vocabulary change
 * that reaches only some of them produces refusals on fields the model was just
 * taught to send — the exact failure the v13 shadow run hit.
 *
 * LIVES HERE since lane-model-v12 ticket 08. It used to live in `mcp/note.ts`
 * and be imported BY the settlement facade, which stopped making sense the
 * moment ruling [S15069/T1651] took relation fields off `note` entirely: the
 * one surviving edge writer would have been importing its whole vocabulary
 * from a module that no longer writes edges. This module already owns the
 * storage vocabulary (`CITATION_RELATIONS`), the entry union and the two write
 * primitives' turn-scoped wrappers, so it is where the parameter names belong.
 */
export const RELATION_FIELD_ENTRIES: ReadonlyArray<
  readonly [key: string, relationClass: RelationClass]
> = RELATION_CLASSES.map((relationClass) => [relationClass, relationClass] as const);

/**
 * The retraction surface, DERIVED from the relation field names above rather
 * than spelled out a second time — `correct` -> `retractCorrect`. One
 * mechanical rule for all three, so a class added tomorrow gets its retraction
 * parameter for free.
 *
 * PEER ROUND T1466 (finding P1-2): the mirror set used to be WIDER than the
 * relation set by exactly `RETRACTION_ONLY_RELATIONS` — a word storage still
 * holds rows for and no write surface may assert. That set is EMPTY, and under
 * v13 it stays empty for a NEW reason worth stating: a mirror addresses a
 * CLASS, and a class resolves to every stored word that means it
 * (`LEGACY_RELATIONS_BY_CLASS`), so the four words the write surface dropped —
 * `consume`, `grounds`, `indexes`, and `extends` beside them — are still
 * deletable through `retractUse`. Never invert this into a relation field: the
 * E2 deadlock the mirrors exist for is repaired by DELETING the frozen row, not
 * by re-admitting the word.
 *
 * NO COVERAGE ON A RETRACTION. `retractCorrect` removes this turn's correct
 * edge at the addressed placement whichever bit it carries: the bit says what
 * KIND of correction was asserted, and withdrawing an assertion does not need
 * to restate it. Demanding the bit back would also make a legacy `override`
 * row un-retractable by anyone who had not first read which word it stored.
 */
export const RETRACTION_FIELD_ENTRIES: ReadonlyArray<
  readonly [key: string, relationClass: RelationClass]
> = RELATION_FIELD_ENTRIES.map(
  ([key, relationClass]) =>
    [`retract${key.charAt(0).toUpperCase()}${key.slice(1)}`, relationClass] as const,
);

/**
 * The degree caps (settlement-read-once spec D0, USER RULING T2404): at most
 * this many RELATION-CARRYING atoms out of any one citing turn, and this many
 * into any one cited turn. With both, a node's direct edge set is at most 40
 * atoms — which is what lets the `relations` field be SIZED (spec D1) instead
 * of hoping. Production carries no violator (read-only, 2026-09-02: max
 * outgoing 18, max incoming 7), so this bounds new work rather than
 * invalidating stored rows.
 *
 * The COUNT is what is bounded, not the rendered width: lane tags are
 * canonical but unbounded in length, so a wide legal atom can still make the
 * field `cut` — which D2 reports and which, by D0, still grants.
 */
export const MAX_TURN_RELATION_DEGREE = 20;

const RELATION_REJECTION_TEXT: Record<TurnRelationRejectionReason, string> = {
  malformed: 'is not a valid address ("S<session>/T<prompt>" or "E<segment>")',
  unresolved: "does not resolve to a turn or segment",
  // lane-model-v12 D2 (ticket 04): an edge's two ends must be DIFFERENT
  // turns, for every relation. The write surface's own pre-check ordinarily
  // catches a self target first (with the shared validator's wording); this is
  // the storage layer's backstop for a caller reaching `attachTurnRelations`
  // directly.
  // [S15069/T1728], container-unification D10: a segment is a CONTAINER, not a
  // relation node. It may still be CITED — prose naming `[E<n>]` records a bare
  // `text-ref` row — but no relation word may point at one. The storage CHECK
  // enforces the same rule one layer down; this message is what a caller sees
  // instead of a constraint failure.
  "segment-not-a-relation-node":
    "names a segment — a segment is a container, not a relation node, so no relation may point at it (prose naming it still records a bare citation)",
  "self-edge":
    "is this turn's own address; an edge's two ends must be DIFFERENT turns, for every relation",
  "no-such-edge":
    "is not a relation this turn currently carries — nothing was retracted; read the turn to see what it does carry",
  // relation-vocabulary-v13 ticket 02: the FULL/PARTIAL bit is a stored field,
  // so a `correct` that never said which kind of correction it was is refused
  // here rather than stored half-answered. The message names the missing bit
  // and both legal values, because a writer told only "coverage required" has
  // to go read a schema to find out what to send.
  "coverage-required":
    'is a `correct` edge with no coverage bit — add `"coverage": "full"` (no substantial part of the cited principal result may still serve as a premise) or `"coverage": "partial"` (a definite non-empty part still stands)',
  "coverage-not-allowed":
    "carries a coverage bit, and only `correct` has one — `verify` and `use` make no claim about how much of the cited result survives",
  // Settlement-read-once ticket 00 (USER RULING T2404). The message names the
  // node the cap is being counted on, because a call refused for a CITED
  // turn's incoming degree is a different repair from one refused for the
  // citing turn's own outgoing degree, and neither is fixed by re-sending.
  "outgoing-degree-cap": `would take this turn past ${MAX_TURN_RELATION_DEGREE} outgoing relations, the cap — retract one before adding another; nothing in this call was written`,
  "incoming-degree-cap": `would take that turn past ${MAX_TURN_RELATION_DEGREE} incoming relations, the cap — nothing in this call was written`,
  // main-agent-edges D5. One pair, one row, one claim: `correct(full)` says no
  // substantial part of the cited result may still serve as a premise and
  // `correct(partial)` says a definite part still may, so a call asserting
  // both about the same pair has not stated a stronger and a weaker claim —
  // it has stated two incompatible ones, and there is no most-specific to
  // collapse onto.
  "coverage-conflict":
    "is named `correct` twice in this call under BOTH coverage bits — `full` and `partial` are the same specificity and contradict each other, so nothing in this call was written; send the one you mean",
  // main-agent-edges D4/D5, T2432 P1. `formatRelationRejections` fills the
  // CURRENT class in instead of this fallback whenever the rejection carries
  // one, which is the only reason this refusal is worth more than "no such
  // edge": the edge is there, and it is not what you read.
  "stale-class":
    "is not the class this pair carries any more — read the edge again before acting on it",
};

/**
 * An address-level edge rejection, in ONE register. It moved here from
 * `mcp/note.ts` with the field tables above (ticket 08) — the settlement
 * facade is now its only caller, and it was never about the note tool.
 */
export function formatRelationRejections(
  rejections: readonly TurnRelationRejection[],
  surface: "relation" | "retraction",
): string {
  const lines = rejections.map((entry) => {
    const text =
      entry.reason === "stale-class" && entry.currentClass !== undefined
        ? `is now ${
            entry.currentClass === null ? "unclassified" : `\`${entry.currentClass}\``
          }, not \`${entry.relation}\` — read the edge again before acting on it`
        : RELATION_REJECTION_TEXT[entry.reason];
    return `${entry.relation} "${entry.raw}" ${text}`;
  });
  return `${surface} field rejected: ${lines.join("; ")}.`;
}

/**
 * The retraction receipt's one register (edge-mechanism-revision ticket 11).
 *
 * ONE NUMBER since main-agent-edges D1. It used to carry a second, `restored`
 * — bare rows put back for a pair the citing prose still named, so that "the
 * classification is gone but the citation stands" was a third outcome distinct
 * from both "removed" and "nothing happened". The wordless population is
 * retired, so that outcome no longer exists: a retraction removes the edge,
 * and the prose that names the target is still the prose that names it.
 *
 * Returns null when nothing was deleted: the whole call is refused by name
 * before any delete (`no-such-edge`, `stale-class`), so there is no line to
 * print.
 */
export function formatRetractionReceipt(counts: {
  retracted: number;
}): string | null {
  if (counts.retracted === 0) {
    return null;
  }
  return `Retracted ${counts.retracted} relation(s).`;
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

// `recomputeTurnCitedPairs` (spec C6) is DELETED by main-agent-edges D1 /
// R10-2, together with the primitive under it (`reconcileCitedPairs`,
// db/memory-edges.ts) and the "Cites N pair(s)" receipt line it fed
// (mcp/note.ts). It rescanned a turn's title/content/insight on every prose
// write and kept ONE wordless `text-ref` row per address the body named —
// 1,187 of production's 1,883 wordless rows — recording that a citation
// exists without saying what it claims. Nothing acts on that fact: an edge is
// a class, and a pair with no class is not an edge.
//
// The `↳` pull-through and session in-degree, its only real consumers, read
// the PROSE directly through `getEffectiveCitations` /
// `getSessionEffectiveCitations` below, which already union
// `parseInlineCitations(content)` onto the edge set. `parseInlineCitations`
// itself STAYS — it is that union's own parser and the milestone view's, and
// it never wrote a row.


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
 * `self-edge` (lane-model-v12 D2, ticket 04 — this reason used to carve
 * `grounds` out and was named for that carve-out; both are deleted
 * together): an edge's two ends must be DIFFERENT turns, for
 * EVERY relation. A hard, word-blind and phase-blind refusal raised here
 * rather than left to the table CHECK (which
 * admits any relation-carrying self row) or to a silent drop. Whether a
 * self-`grounds` is ACTUALLY legal — the citing turn must be both a flow's
 * settlement and that settlement's implementer — is a graph question this
 * function cannot answer on its own (no flow derivation in scope) — that
 * check runs one layer up, in `mcp/note.ts`'s `checkRelationTargetLegality` /
 * `shared/turn-phase.ts`'s `validateRelationTarget`, BEFORE this function is
 * ever called, so an illegal self-`grounds` never reaches here at all through
 * that caller. `no-such-edge` is RETRACTION-only: an address that resolved
 * but carries no such relation on this turn.
 */
export type TurnRelationRejectionReason =
  | "malformed"
  | "unresolved"
  | "self-edge"
  | "segment-not-a-relation-node"
  | "no-such-edge"
  /** relation-vocabulary-v13 ticket 02: a `correct` entry with no FULL/PARTIAL bit. */
  | "coverage-required"
  /** relation-vocabulary-v13 ticket 02: a `verify`/`use` entry carrying a bit only `correct` has. */
  | "coverage-not-allowed"
  /** Settlement-read-once ticket 00: the CITING turn would end this call over the outgoing cap. */
  | "outgoing-degree-cap"
  /** Settlement-read-once ticket 00: a CITED turn would end this call over the incoming cap. */
  | "incoming-degree-cap"
  /**
   * main-agent-edges D5: one pair named `correct` under BOTH coverage bits in
   * one call. Not a precedence question — the two bits are the same
   * specificity and contradict each other — so the call is refused rather than
   * resolved.
   */
  | "coverage-conflict"
  /**
   * main-agent-edges D4/D5 with the T2432 P1 pin: the class supplied as a
   * compare-and-swap precondition is not the class the pair now carries. The
   * message names the CURRENT one, because the repair is to re-read the edge,
   * not to re-send.
   */
  | "stale-class";

export interface TurnRelationRejection {
  /** The CLASS the caller asked for (`correct`/`verify`/`use`), which is what its own message names back at it. */
  relation: RelationClass;
  /** The token as the caller supplied it, for the message the tool layer builds. */
  raw: string;
  reason: TurnRelationRejectionReason;
  /**
   * `stale-class` only: what the pair actually carries now (`null` when it
   * carries a word outside the vocabulary). The refusal's whole value is that
   * it names this — "not `use`" tells a caller nothing it can act on.
   */
  currentClass?: RelationClass | null;
}

/**
 * lane-model-v12 ticket 08 (spec D1/D7): one relation TARGET, either a bare
 * address (BOTH sides unsettled — the draft form) or a two-sided assertion
 * placing each end in its own lane. `tailTag` is the CITING side, `headTag`
 * the CITED side; the same literal word on both sides means one lane spanning
 * the edge, two different words mean a CROSSING, and `''` on either means
 * that end is not placed.
 *
 * WHAT THIS REPLACES: the v11 `{turn, tags}` form, one SET for the whole edge.
 * That form could not say which lane a reference came FROM versus pointed AT,
 * so every cross-lane relation had to be stored untagged and the fact was lost
 * (spec 问题 2). Only ONE surface offers this shape now — the settlement
 * facade — because ruling [S15069/T1651] took relation fields off the main
 * agent's `note` entirely.
 *
 * This type is declared here, one layer below the tool's own zod shape,
 * because the write surface hands entries of exactly this shape to
 * `attachTurnRelations`/`retractTurnRelations`, and a second, independently
 * hand-kept copy of the union in the caller is exactly the drift risk
 * `RELATION_FIELD_NAME`/`RELATION_FIELD_ENTRIES` already exist to prevent for
 * the word list itself.
 */
export interface SidedRelationTarget {
  turn: string;
  tailTag: string;
  headTag: string;
  /**
   * relation-vocabulary-v13 ticket 02: CORRECT's FULL-or-PARTIAL bit, carried
   * on the ENTRY rather than split into two fields.
   *
   * On the entry because it is a property of THIS edge, not of the field: one
   * `correct` call may fully overturn one predecessor and partially limit
   * another, and two fields would have made the writer sort its own targets by
   * a distinction the precedence never asks it to make at field level.
   *
   * Required on a `correct` entry, refused on `verify`/`use` — both by
   * `shared/relation-class.ts`'s `checkRelationCoverage`, the one place the
   * pairing is stated.
   */
  coverage?: RelationCoverageValue;
}
export type RelationTargetEntry = string | SidedRelationTarget;

/**
 * One named relation field's raw targets — the settlement facade's `correct`
 * etc., and its `retractCorrect` mirror, which addresses the same
 * (class, addresses) shape at `retractTurnRelations` instead.
 *
 * relation-vocabulary-v13 ticket 02: keyed on the CLASS, not on a storage word.
 * The write path resolves the class (plus the entry's coverage bit) to the
 * storage word the row lands under; retraction resolves it to EVERY storage
 * word that means it, which is what keeps a legacy `grounds` row deletable.
 */
export interface TurnRelationFieldInput {
  relationClass: RelationClass;
  targets: readonly RelationTargetEntry[];
}

/** One edge's two sides, canonical `''`-for-unsettled form. */
export interface RelationTargetSides {
  tailTag: string;
  headTag: string;
}

/**
 * lane-model-v12 ticket 08: bare string -> both sides unsettled; the two-sided
 * object -> its two values, each normalized to the `''` sentinel so every
 * downstream comparison (`relationRowKey` below, the write primitive's own
 * identity key) sees one spelling of "not placed".
 *
 * NO canonicalization of the tag VALUE happens here, deliberately: a
 * non-canonical lane tag is REFUSED by the write gate naming the exact
 * problem, never silently normalized (spec D2 check 1, the same posture
 * `remember(declare)` takes). Quietly lowercasing here would make the gate
 * unable to see what the caller actually wrote.
 */
export function normalizeRelationTargetEntry(
  entry: RelationTargetEntry,
): { raw: string; coverage: RelationCoverageValue } & RelationTargetSides {
  if (typeof entry === "string") {
    return {
      raw: entry,
      tailTag: UNSETTLED_SIDE_TAG,
      headTag: UNSETTLED_SIDE_TAG,
      coverage: NO_RELATION_COVERAGE,
    };
  }
  return {
    raw: entry.turn,
    tailTag: entry.tailTag ?? UNSETTLED_SIDE_TAG,
    headTag: entry.headTag ?? UNSETTLED_SIDE_TAG,
    // Normalized to the `''` sentinel the same way the two sides are, so the
    // coverage check and the storage layer see ONE spelling of "not stated" —
    // and so a bare-address entry (the draft form) is a `correct` with no bit,
    // which is refused rather than silently stored as an unqualified overturn.
    coverage: isRelationCoverage(entry.coverage) ? entry.coverage : NO_RELATION_COVERAGE,
  };
}

export interface AttachTurnRelationsResult {
  /**
   * The logical edges this call CHANGED — one per pair it created or promoted
   * (main-agent-edges D5). A promotion belongs here rather than beside a
   * restatement because it is a real mutation: the citing turn owes it a
   * relations stamp, and a reader's view of the set moved.
   */
  written: MemoryEdge[];
  /**
   * Accepted inputs whose pair already carried a class at least as specific,
   * with the same coverage — so nothing changed. Reported rather than folded
   * into `written` because a caller's receipt has to be able to say "added"
   * and "already there" apart, or a model re-asserting a relation it wrote
   * yesterday reads its own no-op as new work.
   */
  restated: MemoryEdge[];
  /**
   * Non-empty means the WHOLE call is invalid, and `written`/`restated` are
   * always empty alongside it. A relation field is structured caller input,
   * not text a model might hallucinate a bracket into. A caller that gets back
   * a malformed address or an unresolvable one gets ALL of them, to fix in one
   * pass, rather than a write that silently applied the three relations that
   * happened to be valid.
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

/**
 * main-agent-edges D5: THE ROW'S IDENTITY IS THE PAIR, and `pairKey` already
 * spells a pair. The `relationRowKey` this replaced folded the relation word
 * and both lane sides into the key — which is precisely what let one logical
 * edge become several physical rows (109 such pairs in production), and what
 * made a retraction's address depend on facts the retracting writer had no
 * reason to know.
 */
function citedPairKey(citing: CitingNode, cited: EdgeNode): string {
  return pairKey({ citing, cited });
}

/** The pairs this citing node already carries a CLASS on — the caps' and the dedupe's stored set. */
function storedRelationPairs(db: Database, citing: CitingNode): Set<string> {
  return new Set(
    getOutgoingEdges(db, citing)
      .filter((edge) => edge.relation !== null)
      .map((edge) => citedPairKey(citing, edge.cited)),
  );
}

/**
 * main-agent-edges D5: THE CAPS COUNT LOGICAL EDGES. A node's degree is how
 * many distinct pairs it carries a class on, not how many rows the table
 * happens to hold for them — a pre-cutover pair stored as three rows is one
 * edge and must count as one, or a turn with legacy stock would find itself
 * refused a write it is nowhere near the cap for.
 *
 * Wordless rows are not counted at all: they are not edges (D1).
 */
function countLogicalOutgoingEdges(db: Database, citing: CitingNode): number {
  return storedRelationPairs(db, citing).size;
}

function countLogicalIncomingEdges(db: Database, cited: EdgeNode): number {
  return new Set(
    getIncomingEdges(db, cited)
      .filter((edge) => edge.relation !== null)
      .map((edge) => pairKey({ citing: edge.citing, cited })),
  ).size;
}

/** `db/lanes.ts`'s `resolveTurnAddress`, re-stated rather than imported: that module already imports THIS one. */
function turnAddress(db: Database, turnId: number): string {
  const row = db
    .query<{ sessionId: number; promptNumber: number }, [number]>(
      `SELECT session_id AS sessionId, prompt_number AS promptNumber FROM turns WHERE id = ?`,
    )
    .get(turnId);
  return row ? `S${row.sessionId}/T${row.promptNumber}` : `turn ${turnId}`;
}

/**
 * The ONE place the caps are enforced (spec D0: "enforced ONCE in the shared
 * `attachTurnRelations`"). Both write faces — `note` and the settlement turn
 * facade — reach the graph through that function, so one check here is one
 * check everywhere; a second copy at either tool surface would be the drift
 * this ticket exists to prevent.
 *
 * It counts PROSPECTIVE post-call degrees, which is why it runs where it does:
 *
 *   - AFTER the caller's own address/legality dedupe, so the same claim sent
 *     twice in one call is one atom;
 *   - AFTER this call's retractions, which is free — both faces retract before
 *     they attach, so the rows this reads are already the post-retraction set,
 *     and "retract one, attach one" at the cap succeeds;
 *   - EXCLUDING pairs the node ALREADY carries an edge on (`alreadyStored`),
 *     because promoting a stored edge's class adds no degree to anything.
 *     main-agent-edges D5 widened this from "excluding restatements" for
 *     exactly that reason: a PROMOTION used to mint a second row and now does
 *     not, so it must not be counted as one.
 *
 * The whole call is refused with zero writes — this returns before
 * `writeMemoryEdges` is reached — and every offending endpoint is named at
 * once, so one repair call fixes the batch rather than discovering the cap one
 * turn at a time.
 */
function checkRelationDegreeCaps(
  db: Database,
  citing: CitingNode,
  inputs: readonly WriteEdgeInput[],
  alreadyStored: ReadonlySet<string>,
): TurnRelationRejection[] {
  const additions = inputs.filter(
    (input) => !alreadyStored.has(citedPairKey(citing, input.cited)),
  );
  if (additions.length === 0) {
    return [];
  }

  const rejections: TurnRelationRejection[] = [];
  const classOf = (input: WriteEdgeInput): RelationClass =>
    (input.relationClass || "use") as RelationClass;

  if (citing.kind === "turn") {
    const stored = countLogicalOutgoingEdges(db, citing);
    if (stored + additions.length > MAX_TURN_RELATION_DEGREE) {
      rejections.push({
        relation: classOf(additions[0]!),
        raw: turnAddress(db, citing.id),
        reason: "outgoing-degree-cap",
      });
    }
  }

  const addedPerCited = new Map<number, WriteEdgeInput[]>();
  for (const input of additions) {
    if (input.cited.kind !== "turn") {
      continue;
    }
    const bucket = addedPerCited.get(input.cited.id);
    if (bucket) {
      bucket.push(input);
    } else {
      addedPerCited.set(input.cited.id, [input]);
    }
  }
  for (const [citedId, added] of addedPerCited) {
    const stored = countLogicalIncomingEdges(db, { kind: "turn", id: citedId });
    if (stored + added.length > MAX_TURN_RELATION_DEGREE) {
      rejections.push({
        relation: classOf(added[0]!),
        raw: turnAddress(db, citedId),
        reason: "incoming-degree-cap",
      });
    }
  }

  return rejections;
}

/** One pair's resolved claim for THIS call, before anything is written. */
interface ResolvedPairClaim {
  cited: EdgeNode;
  relationClass: RelationClass;
  coverage: RelationCoverageValue;
  tailTag: string;
  headTag: string;
  /** The address the caller used for this pair — what a refusal names back at it. */
  raw: string;
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
 * MAIN-AGENT-EDGES D5 — PRECEDENCE, WITHIN THE CALL AND ACROSS CALLS:
 *
 *   - SEVERAL CLASSES ON ONE PAIR IN ONE CALL collapse to the MOST SPECIFIC
 *     (`correct` > `verify` > `use`). One pair carries one claim, and a call
 *     that names the same target under two classes has stated the weaker one
 *     redundantly, not asked for two edges.
 *   - `correct(full)` AND `correct(partial)` ON ONE PAIR IN ONE CALL REFUSE
 *     THE WHOLE CALL, naming the pair. The two bits are the same specificity
 *     and contradict each other outright — one says no substantial part of the
 *     cited result may still serve as a premise, the other that a definite
 *     part still may — so there is no "most specific" to pick and picking one
 *     silently would store a judgment nobody made.
 *   - ACROSS CALLS the storage primitive decides (`writeMemoryEdges`): a
 *     stronger class or a coverage change promotes the stored row IN PLACE, a
 *     weaker one is a no-op, and neither can produce a second row.
 *
 * Provenance (spec C12) says WHICH writer filed the claim, and is the only
 * thing that differs between the two callers: `asserted` — the default — is
 * the main agent's own classification, `judged` is settlement's hindsight
 * attribution, and it is PRESERVED across a promotion: the row records who
 * first filed the claim, not who last sharpened it. Nothing downstream RANKS
 * the two ([S15069/T1124]: both writers hold the same power) — it is an audit
 * fact about origin.
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
  const claims = new Map<string, ResolvedPairClaim>();

  for (const field of fields) {
    for (const entry of field.targets) {
      const { raw, tailTag, headTag, coverage } = normalizeRelationTargetEntry(entry);
      // relation-vocabulary-v13 ticket 02: the coverage contract runs FIRST,
      // before the address is even resolved. It is a property of the caller's
      // own input — a `correct` with no bit is malformed whatever it points at
      // — and checking it here rather than at one tool surface is what makes
      // both writers owe it.
      const coverageIssue = checkRelationCoverage(field.relationClass, coverage);
      if (coverageIssue) {
        rejected.push({ relation: field.relationClass, raw, reason: coverageIssue });
        continue;
      }
      const node = resolveRelationTargetNode(db, raw);
      if (typeof node === "string") {
        rejected.push({ relation: field.relationClass, raw, reason: node });
        continue;
      }
      // lane-model-v12 D2 (ticket 04): word-blind and phase-blind — NO
      // relation may cite the citing turn itself (see
      // `TurnRelationRejectionReason`'s doc comment above).
      if (node.kind === "turn" && node.id === citingTurnId) {
        rejected.push({ relation: field.relationClass, raw, reason: "self-edge" });
        continue;
      }
      // [S15069/T1728]: refused HERE, beside the other reference-level
      // refusals, so the caller is told which address is the problem. The
      // schema CHECK and `writeMemoryEdges`' own guard are the layers below;
      // reaching either of those means this one was bypassed.
      if (node.kind !== "turn") {
        rejected.push({
          relation: field.relationClass,
          raw,
          reason: "segment-not-a-relation-node",
        });
        continue;
      }

      const key = citedPairKey(citing, node);
      const held = claims.get(key);
      if (held === undefined) {
        claims.set(key, {
          cited: node,
          relationClass: field.relationClass,
          coverage,
          tailTag,
          headTag,
          raw,
        });
        continue;
      }
      // D5's contradiction: the same pair asserted both fully and partially
      // corrected in one call. Refused by NAME on the pair, and refused for
      // the WHOLE call — a caller that meant one of them can say which.
      if (
        held.relationClass === "correct" &&
        field.relationClass === "correct" &&
        held.coverage !== coverage
      ) {
        rejected.push({
          relation: field.relationClass,
          raw,
          reason: "coverage-conflict",
        });
        continue;
      }
      // D5's within-call collapse: the most specific wins, and the weaker
      // statement of the same pair is simply absorbed. Side placements follow
      // the class that won, so a caller cannot smuggle a second placement in
      // under a weaker word.
      if (
        RELATION_CLASS_SPECIFICITY[field.relationClass] >
        RELATION_CLASS_SPECIFICITY[held.relationClass]
      ) {
        claims.set(key, {
          cited: node,
          relationClass: field.relationClass,
          coverage,
          tailTag,
          headTag,
          raw,
        });
      }
    }
  }

  if (rejected.length > 0 || claims.size === 0) {
    return { written: [], restated: [], rejected };
  }

  const inputs: WriteEdgeInput[] = [...claims.values()].map((claim) => ({
    citing,
    cited: claim.cited,
    // relation-vocabulary-v13 ticket 02, THE INTERIM EQUIVALENCE'S ONE CALL
    // SITE (main-agent-edges ticket 02 deletes it with the column): the class
    // plus its bit resolves to the seven-word value the `relation` column
    // carries, so the table's CHECK and every reader still keyed on those
    // words see a new edge exactly as they saw its old-vocabulary counterpart.
    relation: interimLegacyRelation(claim.relationClass, claim.coverage),
    provenance,
    tailTag: claim.tailTag,
    headTag: claim.headTag,
    relationClass: claim.relationClass,
    relationCoverage: claim.coverage,
  }));

  const alreadyStored = storedRelationPairs(db, citing);

  // Settlement-read-once ticket 00 (spec D0): the degree caps, checked HERE —
  // after the dedupe above and before the first row is written, so a refusal
  // costs nothing and lands nothing.
  const overCap = checkRelationDegreeCaps(db, citing, inputs, alreadyStored);
  if (overCap.length > 0) {
    return { written: [], restated: [], rejected: overCap };
  }

  // [S15069/T1728]: `rejected`, not just `written`. A write that lands nothing
  // and reports nothing is the exact silent-drop shape this codebase keeps
  // paying for; anything reaching here is a bypassed pre-check, and it is
  // surfaced rather than swallowed.
  const {
    written,
    promoted,
    rejected: storageRejected,
  } = writeMemoryEdges(db, inputs, nowEpoch);
  if (storageRejected.length > 0) {
    return {
      written: [],
      restated: [],
      rejected: storageRejected.map((entry) => ({
        // The CLASS the caller asked for, not the interim storage word it
        // resolved to: the message goes back to a writer that has never been
        // taught the seven words.
        relation: (entry.input.relationClass || "use") as RelationClass,
        raw: `${entry.input.cited.kind} ${entry.input.cited.id}`,
        reason: "segment-not-a-relation-node" as const,
      })),
    };
  }

  // main-agent-edges D5: CHANGED versus UNCHANGED, decided on what the storage
  // primitive actually did. A pair the call created is new; one it promoted is
  // changed; one it found already at least as specific is a restatement, and
  // owes no stamp.
  const promotedIds = new Set(promoted.map((edge) => edge.id));
  const added: MemoryEdge[] = [];
  const restated: MemoryEdge[] = [];
  for (const edge of written) {
    const isNew = !alreadyStored.has(citedPairKey(citing, edge.cited));
    (isNew || promotedIds.has(edge.id) ? added : restated).push(edge);
  }
  return { written: added, restated, rejected: [] };
}

export interface RetractTurnRelationsResult {
  deleted: MemoryEdge[];
  /** Same all-or-nothing contract as the attach path: non-empty means nothing was deleted. */
  rejected: TurnRelationRejection[];
}

/**
 * One retraction field's raw targets. Separate from `TurnRelationFieldInput`
 * because of the T2432 P1 pin: on the ASSERT side a class is what is being
 * asserted and is mandatory; on the RETRACT side it is an optional
 * COMPARE-AND-SWAP PRECONDITION on the pair's current class, and `null` means
 * "remove the edge, whatever it now says".
 */
export interface TurnRetractionFieldInput {
  /**
   * The class the caller believes the pair carries, or `null` for no check.
   * The three `retract…` parameters supply their own class; a caller that
   * holds the pair and not the class (ticket 04's closure paths) passes
   * `null`.
   */
  relationClass: RelationClass | null;
  targets: readonly RelationTargetEntry[];
}

/**
 * Edge-mechanism-revision D3, re-addressed by main-agent-edges D4/D5 and the
 * T2432 P1 pin: remove one turn's logical edge, addressed by the PAIR, with
 * the class as an OPTIONAL compare-and-swap precondition.
 *
 * WHAT THE PIN CHANGES, and why it is not a loosening. The address used to be
 * (pair, class, tail, head): the class resolved through
 * `LEGACY_RELATIONS_BY_CLASS` to every storage word that means it, and the two
 * sides had to match the row's stored placement exactly. Under one-pair-one-
 * row there is one edge to remove and the pair names it, so the sides drop out
 * of the address entirely — a retraction no longer fails because somebody else
 * declared a lane on the edge since. The class stays, as a PRECONDITION rather
 * than a selector:
 *
 *   - supplied and MATCHING the pair's materialized class -> the edge goes;
 *   - supplied and NOT matching -> the whole call is refused, `stale-class`,
 *     naming what the pair now carries. This is the case that matters: an edge
 *     the caller last saw as `use` and another writer has since PROMOTED to
 *     `correct` is a different claim, and deleting it on the strength of a
 *     stale read is exactly the silent loss the write gate exists to stop;
 *   - omitted (`null`) -> no check, the pair's edge goes whatever it says.
 *
 * COVERAGE IS NOT PART OF THE PRECONDITION. `retractCorrect` removes the
 * pair's correct edge whichever bit it carries: the bit says what KIND of
 * correction was asserted, and withdrawing an assertion does not need to
 * restate it.
 *
 * Existence and the precondition are both checked BEFORE anything is deleted,
 * so a call naming one live edge and one that was never there deletes neither
 * and reports the second by name (`no-such-edge`). A caller told only
 * "0 deleted" cannot tell "already gone" from "wrong address", and a model
 * given that answer guesses.
 *
 * Both writers have the same power here ([S15069/T1124]) — the main agent may
 * retract what settlement judged and vice versa, because a false assertion
 * must not outlive its refutation on account of who filed it.
 *
 * NOTHING IS RESTORED BEHIND A RETRACTION any more. The bare row a retraction
 * used to put back for a pair the prose still names is retired with the whole
 * wordless population (main-agent-edges D1): the prose still names the target,
 * and `getEffectiveCitations` still reads the prose.
 */
export function retractTurnRelations(
  db: Database,
  citingTurnId: number,
  fields: readonly TurnRetractionFieldInput[],
  nowEpoch: number = Math.floor(Date.now() / 1000),
): RetractTurnRelationsResult {
  void nowEpoch;
  const citing: CitingNode = { kind: "turn", id: citingTurnId };

  const rejected: TurnRelationRejection[] = [];
  const targets: RetractEdgeInput[] = [];
  const addressed = new Set<string>();

  const stored = new Map<string, MemoryEdge>();
  for (const edge of getOutgoingEdges(db, citing)) {
    if (edge.relation === null) {
      continue;
    }
    const key = citedPairKey(citing, edge.cited);
    const held = stored.get(key);
    // The same "which row IS the edge" rule the write path uses, so a legacy
    // multi-row pair answers one question here rather than several.
    if (held === undefined) {
      stored.set(key, edge);
    } else {
      const winner = selectLogicalEdgeRow([held, edge]);
      if (winner) {
        stored.set(key, winner);
      }
    }
  }

  for (const field of fields) {
    for (const entry of field.targets) {
      const { raw } = normalizeRelationTargetEntry(entry);
      const node = resolveRelationTargetNode(db, raw);
      if (typeof node === "string") {
        rejected.push({
          relation: field.relationClass ?? "use",
          raw,
          reason: node,
        });
        continue;
      }
      const key = citedPairKey(citing, node);
      const edge = stored.get(key);
      if (edge === undefined) {
        rejected.push({
          relation: field.relationClass ?? "use",
          raw,
          reason: "no-such-edge",
        });
        continue;
      }
      if (field.relationClass !== null) {
        // The CAS. Read through `edgeRelationClass` so a row stored under one
        // of the seven words answers the same question a v13 row does.
        const current = edgeRelationClass(edge);
        if (current === null || current.relationClass !== field.relationClass) {
          rejected.push({
            relation: field.relationClass,
            raw,
            reason: "stale-class",
            currentClass: current?.relationClass ?? null,
          });
          continue;
        }
      }
      if (addressed.has(key)) {
        continue;
      }
      addressed.add(key);
      targets.push({ citing, cited: node });
    }
  }

  if (rejected.length > 0 || targets.length === 0) {
    return { deleted: [], rejected };
  }

  const { deleted } = retractMemoryEdges(db, targets);
  return { deleted, rejected: [] };
}

/**
 * main-agent-edges D4: DECLARE A LANE SIDE ON THE EDGE THAT IS ALREADY THERE.
 *
 * A stored side tag means exactly one thing — "this endpoint is in several
 * lanes and THIS is the one" — so declaring is not a write of a new fact
 * beside the edge, it is a patch of the edge itself: same row id, same class
 * and coverage, same provenance, same creation time. Everything a reader has
 * already cited about this edge stays true; only the attribution moves.
 *
 * ADDRESS (T2432 P1): the PAIR, with `relationClass` as an OPTIONAL
 * compare-and-swap precondition — supplied and not matching refuses by name
 * with what the pair now carries, omitted checks nothing. Same contract as
 * `retractTurnRelations` above, for the same reason: a declaration made on a
 * stale reading of the class is a declaration about an edge that no longer
 * exists as read.
 *
 * PATCH, THREE STATES PER SIDE:
 *
 *   - OMITTED (`undefined`) -> that side is not touched. This is what makes
 *     the call a patch and not a replacement: settlement declaring the head
 *     must not silently clear a tail somebody else declared.
 *   - A STRING -> set, after two checks against the endpoint's OWN current
 *     lane facts: the tag must be among that endpoint's lane tags in its task
 *     (else `invalid-declaration`), and the endpoint must be in AT LEAST TWO
 *     lanes (else `derivable`, named as such — a declaration on a uniquely
 *     laned endpoint is exactly the redundant stock the cutover clears, and
 *     re-admitting it here would refill what D9 just emptied).
 *   - EXPLICIT `null` -> cleared to `''`. The endpoint's lane set decides the
 *     side from then on.
 *
 * SIDE EFFECTS, ALL IN THE CALLER'S TRANSACTION: the side index
 * (`memory_edge_side_tags`) is rewritten for the sides that changed; the
 * citing turn's relations revision is stamped ONCE for the whole call, and
 * only when something actually changed; and the OLD and NEW qualified lanes of
 * every changed side come back as `touches` for the caller's own ledger — both
 * of them, because moving a declaration from `#alpha` to `#beta` leaves
 * `#alpha` owed exactly as much as it commits `#beta`.
 *
 * A call that changes nothing (both sides omitted, or every patch already the
 * stored value) succeeds, reports `changed: false`, and stamps nothing.
 */
export type EdgeSidePatch = string | null | undefined;

export interface DeclareEdgeSidesInput {
  citingTurnId: number;
  citedTurnId: number;
  /** The T2432 P1 CAS precondition; omitted or `null` checks nothing. */
  relationClass?: RelationClass | null;
  tailTag?: EdgeSidePatch;
  headTag?: EdgeSidePatch;
}

export type DeclareEdgeSidesRefusal =
  | { reason: "no-such-edge" }
  | { reason: "stale-class"; currentClass: RelationClass | null }
  | { reason: "invalid-declaration"; side: EdgeSide; tag: string; endpoint: string }
  | { reason: "derivable"; side: EdgeSide; tag: string; endpoint: string };

export interface DeclareEdgeSidesResult {
  ok: boolean;
  /** The row as it now stands — absent only when the call was refused. */
  edge?: MemoryEdge;
  /** Did this call actually mutate the row? A no-op patch is a success that stamped nothing. */
  changed: boolean;
  /** Old and new qualified lanes of every side this call moved, for the caller's touch ledger. */
  touches: Array<{ turnId: number; tag: string }>;
  refusal?: DeclareEdgeSidesRefusal;
  /** The refusal in one sentence, ready for a tool receipt. */
  message?: string;
}

/**
 * One endpoint's lane facts: the lane tags it carries in its own task.
 *
 * 03b F5 (peer implementation review escape): this duplicates the
 * segment-resolution-then-intersect-with-declared shape `lane-edge-gate.ts`'s
 * `collectEdgeSideFacts` already does for the attach path — a second reader
 * doing the same two-step read is exactly the kind of drift risk the ticket
 * flagged, and the shared shape is worth naming rather than leaving as a
 * coincidence.
 *
 * It stays a second reader anyway, for three reasons none of which is
 * inertia: (1) `collectEdgeSideFacts` takes BOTH sides' `{address, tags}` at
 * once and returns `undefined` when neither side is settled — `declareEdgeSides`
 * asks about ONE endpoint at a time, up to twice per call, and an endpoint
 * with no patch on its side is never asked at all; (2) the caller-supplied
 * `tags` array `collectEdgeSideFacts` takes exists so the CITING side can be
 * judged against a tag correction the SAME call is about to store (an attach
 * that also retags) — `declareEdgeSides` never rewrites tags, so the live row
 * is always the current truth and there is nothing to pass in; (3) this
 * function alone needs the `lanes.size < 2` derivable check (a stored side
 * means "several lanes, this is the one" — `collectEdgeSideFacts` has no such
 * concept, because a first-time attach establishes no side at all without a
 * patch). Folding the two would mean threading a derivable-only branch and an
 * optional both-sides-at-once calling convention through a module whose other
 * caller needs neither — the coupling the read-heavy split (`lane-edge-gate.ts`'s
 * own doc: "caller pre-computes, the shared module judges") exists to avoid.
 * What DOES have to hold, and is pinned by the two-segment fixture in
 * `tests/db/logical-edge-writes.test.ts` ("a lane word declared in two
 * different tasks"), is that both readers resolve the SAME endpoint to the
 * SAME segment from the SAME `loadSegmentTagIndex`/`loadDeclaredLaneTags`
 * primitives — the one part where a second implementation actually could
 * drift from the first.
 */
function endpointLaneTags(db: Database, turnId: number): Set<string> {
  const row = db
    .query<{ tags: string | null }, [number]>("SELECT tags FROM turns WHERE id = ?")
    .get(turnId);
  let tags: unknown;
  try {
    tags = row?.tags == null ? [] : JSON.parse(row.tags);
  } catch {
    tags = [];
  }
  const own = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
  const segmentTags = loadSegmentTagIndex(db);
  let segmentId: number | null = null;
  for (const tag of own) {
    const owner = segmentTags.get(tag);
    if (owner !== undefined) {
      segmentId = owner;
      break;
    }
  }
  if (segmentId === null) {
    return new Set<string>();
  }
  const declared = loadDeclaredLaneTags(db, segmentId);
  return new Set(own.filter((tag) => declared.has(tag)));
}

export function declareEdgeSides(
  db: Database,
  input: DeclareEdgeSidesInput,
  writer: string | null,
  nowEpoch: number,
): DeclareEdgeSidesResult {
  const citing: CitingNode = { kind: "turn", id: input.citingTurnId };
  const cited: EdgeNode = { kind: "turn", id: input.citedTurnId };
  const key = citedPairKey(citing, cited);

  const edge = selectLogicalEdgeRow(
    getOutgoingEdges(db, citing).filter(
      (row) => citedPairKey(citing, row.cited) === key,
    ),
  );
  if (edge === null) {
    return {
      ok: false,
      changed: false,
      touches: [],
      refusal: { reason: "no-such-edge" },
      message:
        `${turnAddress(db, input.citingTurnId)} carries no edge to ` +
        `${turnAddress(db, input.citedTurnId)} — there is nothing to declare a side on.`,
    };
  }

  const current = edgeRelationClass(edge);
  if (
    input.relationClass !== undefined &&
    input.relationClass !== null &&
    (current === null || current.relationClass !== input.relationClass)
  ) {
    return {
      ok: false,
      changed: false,
      touches: [],
      refusal: { reason: "stale-class", currentClass: current?.relationClass ?? null },
      message:
        `stale: the pair is now ` +
        `${current === null ? "unclassified" : `\`${current.relationClass}\``}, ` +
        `not \`${input.relationClass}\` — read the edge again before declaring a side on it.`,
    };
  }

  const patches: Array<{
    side: EdgeSide;
    patch: EdgeSidePatch;
    endpointTurnId: number;
    storedTag: string;
  }> = [
    {
      side: "tail",
      patch: input.tailTag,
      endpointTurnId: input.citingTurnId,
      storedTag: edge.tailTag,
    },
    {
      side: "head",
      patch: input.headTag,
      endpointTurnId: input.citedTurnId,
      storedTag: edge.headTag,
    },
  ];

  const applied: Array<{ side: EdgeSide; endpointTurnId: number; from: string; to: string }> = [];
  for (const entry of patches) {
    if (entry.patch === undefined) {
      continue;
    }
    const next = entry.patch ?? UNSETTLED_SIDE_TAG;
    if (next !== UNSETTLED_SIDE_TAG) {
      const lanes = endpointLaneTags(db, entry.endpointTurnId);
      if (!lanes.has(next)) {
        return {
          ok: false,
          changed: false,
          touches: [],
          refusal: {
            reason: "invalid-declaration",
            side: entry.side,
            tag: next,
            endpoint: turnAddress(db, entry.endpointTurnId),
          },
          message:
            `${entry.side} "${next}" is not one of ` +
            `${turnAddress(db, entry.endpointTurnId)}'s own lane tags in its task — a declaration ` +
            `names a lane that endpoint is actually in.`,
        };
      }
      if (lanes.size < 2) {
        return {
          ok: false,
          changed: false,
          touches: [],
          refusal: {
            reason: "derivable",
            side: entry.side,
            tag: next,
            endpoint: turnAddress(db, entry.endpointTurnId),
          },
          message:
            `${turnAddress(db, entry.endpointTurnId)} is in exactly one lane, so its ${entry.side} ` +
            `side is derivable; no declaration needed. A stored side means "this endpoint is in ` +
            `several lanes and this is the one".`,
        };
      }
    }
    if (next !== entry.storedTag) {
      applied.push({
        side: entry.side,
        endpointTurnId: entry.endpointTurnId,
        from: entry.storedTag,
        to: next,
      });
    }
  }

  if (applied.length === 0) {
    return { ok: true, edge, changed: false, touches: [] };
  }

  const nextTail =
    applied.find((entry) => entry.side === "tail")?.to ?? edge.tailTag;
  const nextHead =
    applied.find((entry) => entry.side === "head")?.to ?? edge.headTag;

  // IN PLACE (D4), through the storage layer's own primitive: `relation`,
  // `relation_class`, `relation_coverage`, `provenance` and
  // `created_at_epoch` are not among the columns it assigns, and that absence
  // is the contract. It rewrites the side index for the sides that moved.
  const updated = updateEdgeSides(db, edge.id, { tailTag: nextTail, headTag: nextHead });

  const touches: Array<{ turnId: number; tag: string }> = [];
  for (const entry of applied) {
    // BOTH lanes: the one the side is leaving is owed a look exactly as much
    // as the one it is joining.
    for (const tag of [entry.from, entry.to]) {
      touches.push({ turnId: entry.endpointTurnId, tag });
    }
  }

  // ONE stamp for the whole call (D4), and only because something changed.
  stampTurnRelationsRevision(db, input.citingTurnId, writer, nowEpoch);

  return {
    ok: true,
    edge: updated ?? edge,
    changed: true,
    touches,
  };
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
// Indexes-rescope spec law 8 / ticket 03: joined against `turns` on BOTH ends
// and gated by the shared liveness predicate — a rolled-back or skipped turn
// contributes no edge, whether it is the one asking (`citingTurnId` itself
// dead/dormant) or the one being cited. Read live on every call, so a
// skipped turn's edges reappear untouched the instant a late note promotes
// it back (`db/turns.ts`'s `promoteTurnFromNote`) — nothing here needs to
// know that happened.
export function getTurnCitations(
  db: Database,
  citingTurnId: number,
): TurnCitationEdge[] {
  return db
    .query<TurnCitationEdge, [number]>(
      `SELECT
         e.citing_id AS citingTurnId,
         e.cited_id AS citedTurnId,
         e.relation,
         e.created_at_epoch AS createdAtEpoch
       FROM memory_edges e
       JOIN turns citing ON citing.id = e.citing_id
       JOIN turns cited ON cited.id = e.cited_id
       WHERE e.citing_kind = 'turn' AND e.citing_id = ?
         AND e.cited_kind = 'turn'
         AND ${liveTurnSql("citing")} AND ${liveTurnSql("cited")}
       ORDER BY e.cited_id ASC, e.relation ASC`,
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
 * so dangling ids (and a bare self-citation, which the write path already
 * refuses regardless of ticket 05's narrower relation-carrying exception) are
 * dropped here. Cross-session edges survive as provenance —
 * `getSessionEffectiveCitations` is the session-local view that drops them.
 */
export function getEffectiveCitations(
  db: Database,
  turn: CitationSubject,
): EffectiveCitations {
  const edges = getTurnCitations(db, turn.id);
  const citedTurnIds = dedupeCitedIds(edges);

  // Ticket 03: a prose id resolving to a rolled-back or skipped turn is the
  // same as a dangling one here — the structured side already excludes them
  // via `getTurnCitations`'s liveness join above, and this predicate keeps
  // the prose side agreeing (`liveTurnSql`, indexes-rescope spec law 8).
  const liveTurnExists = db.query<{ id: number }, [number]>(
    `SELECT id FROM turns WHERE id = ? AND ${liveTurnSql()}`,
  );
  appendUnseen(
    citedTurnIds,
    parseInlineCitations(turn.content).filter(
      (id) => id !== turn.id && liveTurnExists.get(id) != null,
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
 * Turns with no effective citations are present with an empty list. A
 * rolled-back or skipped turn (indexes-rescope spec law 8 / ticket 03) is a
 * DIFFERENT thing from that: it holds no key at all — it is not a node, so
 * it cannot be "present with nothing". Both the turn listing and the edge
 * join below apply the shared liveness predicate to every side they touch,
 * so a dormant turn's citations of/by live turns vanish along with it and
 * come back untouched the moment it is promoted.
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
       WHERE session_id = ? AND ${liveTurnSql()}
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
         AND ${liveTurnSql("citing")} AND ${liveTurnSql("cited")}
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
 * OF THE SAME SESSION cite it. A pair may now carry SEVERAL relation rows at
 * once (edge-mechanism-revision ticket 01, D2 — retired C5's "at most one
 * relation per pair"), but a citing turn still counts once toward its target
 * regardless of how many relation rows or discovery sources back that
 * citation — in-degree answers "how many turns consumed this", not "how many
 * claims were filed".
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
