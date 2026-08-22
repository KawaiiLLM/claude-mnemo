/**
 * v10 lane-model INTERPRETATION CORE (rubric-v10 ticket 05; concept doc
 * `.scratch/rubric-v10/draft-lane-model.md`, "统一解读原则" + "校验体系"). Pure
 * derivation over plain arrays — no database, no I/O, no module-level state,
 * the same contract `shared/flows.ts`'s `deriveFlows` follows for the
 * decision layer this module supersedes at lane granularity (ticket 01 gave
 * an edge row an immutable canonical tag set; this module is the first
 * reader of that identity).
 *
 * ## The unified interpretation principle (the draft's own anchor)
 *
 * A TAGGED same-phase edge acts on the LANE its exact tag set identifies; an
 * UNTAGGED same-phase edge acts on the cited TURN itself (global, free
 * aggregation) — every taggable word (override/narrows/extends/consume/
 * indexes) reads this ONE rule, no per-word special case. Only `indexes` and
 * `override` carry graph-STATE for a lane (a terminus); `narrows`/`extends`/
 * `consume` are structural — they matter to path counting (`lane-checker.ts`)
 * but never move a lane's terminus:
 *
 *   - tagged indexes     -> DECLARATION: the citing turn becomes the lane's
 *                           terminus. Latest wins, reduced in CITING-TURN
 *                           order — never edge array order (draft: "一切 lane
 *                           事件…按 turn 序归约").
 *   - tagged override,    -> lane-local correction: the cited turn loses its
 *     same tag as this        EFFECTIVE status in this lane (a dead node)
 *     lane                    regardless of whether it currently is the
 *                              terminus. If it WAS the terminus, the lane
 *                              enters REOPENED state (terminus-less until a
 *                              new declaration).
 *   - untagged override  -> GLOBAL kill: the cited turn dies in EVERY lane it
 *                           is a member of (not only where it terminates);
 *                           every lane it currently terminates loses that
 *                           terminus (reopened).
 *   - override tagged     -> indifferent to THIS lane — it is another lane's
 *     with a DIFFERENT         event entirely.
 *     lane's tag set
 *
 * A lane never enumerates from an untagged or single-endpoint product: the
 * write-time self-citation gate (`turn-phase.ts`'s `validateRelationTarget`)
 * already refuses every taggable (same-phase) relation a self target, so a
 * tagged edge always spans two DISTINCT turns — a lane born from any edge
 * structurally has >= 2 members, and a tag set with no edge at all is simply
 * never grouped. No separate "single-node lane" case needs handling here.
 *
 * ## declared / reopened / undeclared
 *
 * "收敛不因沉默成立" — convergence is never established by silence. A lane
 * reaches `"declared"` ONLY through an explicit tagged-indexes event; a
 * narrows/extends chain, however long, sets no terminus on its own.
 * `"reopened"` therefore requires a PRIOR declaration since overridden
 * (`everDeclared && terminus === null`). A lane that never declared at all
 * is `"undeclared"` — whether or not an override ever touched it: a
 * same-tag override on a lane's latest structural node, with no declaration
 * EVER made for that lane, still marks that node dead (it lost its
 * effective status) but creates no terminus to reopen FROM, because none
 * ever existed. `latestEventTurn` is what distinguishes the two undeclared
 * sub-cases for a caller that cares (`null` = no reduction event ever
 * touched the lane; a turn id = an override touched it without ever
 * declaring it — exactly this fixture's `{write-gate}`, T958's override of
 * T957 with no `indexes` ever tagged `write-gate`).
 *
 * ## dead status is a final-state snapshot, not an online flag
 *
 * `dead` only ever gets ADDED to (global kill, in-lane override), never
 * removed — so reading it after the whole reduction pass is equivalent to
 * reading it "as of" any later point; no per-event ordering subtlety exists
 * for membership status itself, only for the terminus/declaration state.
 */

import type { TurnPhase } from "./turn-phase";

// Re-exported so a consumer that only wants the phase vocabulary need not
// also import turn-phase.ts directly (`flows.ts`'s convention).
export type { TurnPhase };

/** Segment sentinel a turn with no `segment` field shares — "the fixture has no segments" reads as one default scope. */
export const DEFAULT_SEGMENT = "\u0000default";

/** One taggable input turn. `id` doubles as the turn-order key (ascending = later) — `flows.ts`'s `FlowTurnInput` convention: "whatever id space the caller addresses turns by", assumed order-comparable. */
export interface LaneTurnInput {
  id: number;
  type: readonly string[];
  /** Lane identity's segment half. Omitted turns share `DEFAULT_SEGMENT`. */
  segment?: string;
}

/** One edge assertion row (ticket 01's shape): `tags` is the row's own IMMUTABLE canonical tag set, `[]` for untagged. `citingId` is always the LATER turn (`turn-phase.ts`'s direction convention). */
export interface LaneEdgeInput {
  citingId: number;
  citedId: number;
  relation: string;
  tags: readonly string[];
}

export type LaneDeclarationState = "declared" | "reopened" | "undeclared";

/** A lane's machine identity: segment + exact canonical tag set. No subset/hierarchy is read here — that is a human layer over this exact-set data (draft: "层级是解读,不是机制"). */
export interface LaneKey {
  segment: string;
  /** Canonical: deduped, ascending. */
  tagSet: readonly string[];
}

export interface LaneMember {
  id: number;
  /** true when globally killed (untagged override) or lane-locally overridden (same-tag override) — see module header. */
  dead: boolean;
}

export interface LaneDeclaration {
  state: LaneDeclarationState;
  /** The current terminus, or `null` when reopened/undeclared. */
  terminus: number | null;
  /** citing turn id of the most recent reduction event touching this lane (a declaration, an in-lane override, or a global kill that closed it). `null` if no event ever touched the lane at all. */
  latestEventTurn: number | null;
}

export interface Lane {
  key: LaneKey;
  /** Ascending by id, dead members included (separated by the `dead` flag, never dropped — "被推翻的节点留在图中,作为死节点承载纠正叙事"). */
  members: readonly LaneMember[];
  declaration: LaneDeclaration;
  /** This lane's own tagged edges (exact tag-set match), input order. */
  taggedEdges: readonly LaneEdgeInput[];
}

export interface LaneInterpretation {
  /** Every enumerated lane, ordered by segment then canonical tag key — deterministic, not input order. */
  lanes: readonly Lane[];
  laneByToken: ReadonlyMap<string, Lane>;
}

/** Dedupe + sort — the row's own canonical form (mirrors `db/memory-edges.ts`'s `canonicalizeTagSet`, redeclared here so this module stays free of any DB-layer dependency). */
export function canonicalTagSet(tags: readonly string[]): string[] {
  return [...new Set(tags)].sort();
}

function tagSetKey(tags: readonly string[]): string {
  return canonicalTagSet(tags).join("\u0001");
}

/** The token a lane is grouped and looked up by: segment + canonical tag set, joined so neither half can collide into the other. */
export function laneToken(segment: string, tags: readonly string[]): string {
  return `${segment}\u0000${tagSetKey(tags)}`;
}

interface MutableLaneGroup {
  segment: string;
  tagSet: string[];
  edges: LaneEdgeInput[];
}

interface ReduceEvent {
  citingId: number;
  citedId: number;
  relation: "indexes" | "override";
  /** `null` for an untagged override (global-kill event); the lane token for every tagged event. */
  token: string | null;
}

/**
 * Derive every lane's membership, tagged edges, and declaration state from
 * one turn/edge set. Pure and stateless — a caller that changed an edge
 * simply calls this again (same "derived view, recompute on read" contract
 * as `deriveFlows`).
 */
export function deriveLaneInterpretation(
  turns: readonly LaneTurnInput[],
  edges: readonly LaneEdgeInput[],
): LaneInterpretation {
  const segmentOf = new Map<number, string>();
  for (const turn of turns) {
    segmentOf.set(turn.id, turn.segment ?? DEFAULT_SEGMENT);
  }
  // A turn absent from `turns` (partial-coverage input, `lane-checker.ts`'s
  // coverage report) still needs a segment to group by — it falls into the
  // CITING side's own segment lookup, defaulting when even the citing turn
  // is unknown, so an incomplete projection degrades to "one extra default
  // scope" rather than throwing.
  const segmentFor = (id: number): string => segmentOf.get(id) ?? DEFAULT_SEGMENT;

  // ---- lane enumeration: group by (citing turn's segment, exact tag set) ----
  // A cross-segment tagged edge (citing/cited segments differ) is a real,
  // allowed shape (draft: "偶尔耦合允许") — this module assigns it to the
  // CITING side's lane only; a dual-appearance / cross-segment warning view
  // is left to a caller that wants it (out of this ticket's required scope).
  const groups = new Map<string, MutableLaneGroup>();
  for (const edge of edges) {
    const canon = canonicalTagSet(edge.tags);
    if (canon.length === 0) continue; // untagged: forms no lane (requirement 2)
    const segment = segmentFor(edge.citingId);
    const token = laneToken(segment, canon);
    let group = groups.get(token);
    if (group === undefined) {
      group = { segment, tagSet: canon, edges: [] };
      groups.set(token, group);
    }
    group.edges.push(edge);
  }

  // ---- unified event reduction, in CITING-TURN order (never edge array order) ----
  const events: ReduceEvent[] = [];
  for (const edge of edges) {
    if (edge.relation !== "indexes" && edge.relation !== "override") continue;
    const canon = canonicalTagSet(edge.tags);
    if (canon.length === 0) {
      if (edge.relation === "override") {
        events.push({ citingId: edge.citingId, citedId: edge.citedId, relation: "override", token: null });
      }
      // an untagged indexes is free aggregation — no lane event at all.
      continue;
    }
    const segment = segmentFor(edge.citingId);
    const token = laneToken(segment, canon);
    if (!groups.has(token)) continue; // defensive: every tagged indexes/override is itself a tagged edge, so its group always exists — kept for robustness against malformed input.
    events.push({ citingId: edge.citingId, citedId: edge.citedId, relation: edge.relation as "indexes" | "override", token });
  }
  events.sort((a, b) => a.citingId - b.citingId);

  const terminusOf = new Map<string, number | null>();
  const everDeclared = new Map<string, boolean>();
  const deadInLane = new Map<string, Set<number>>();
  const latestEventTurn = new Map<string, number | null>();
  for (const token of groups.keys()) {
    terminusOf.set(token, null);
    everDeclared.set(token, false);
    deadInLane.set(token, new Set());
    latestEventTurn.set(token, null);
  }
  const globallyDead = new Set<number>();

  let index = 0;
  while (index < events.length) {
    const citingId = events[index]!.citingId;
    let end = index;
    while (end < events.length && events[end]!.citingId === citingId) {
      end += 1;
    }
    const batch = events.slice(index, end);
    index = end;

    // Phase 1 — overrides, effects computed against the state as of the
    // START of this turn's batch (same-turn events are on one axis, no
    // sub-order between them; see module header).
    for (const event of batch) {
      if (event.relation !== "override") continue;
      if (event.token === null) {
        // untagged: GLOBAL kill.
        globallyDead.add(event.citedId);
        for (const [token, terminus] of terminusOf) {
          if (terminus === event.citedId) {
            terminusOf.set(token, null);
            latestEventTurn.set(token, citingId);
          }
        }
      } else {
        deadInLane.get(event.token)!.add(event.citedId);
        if (terminusOf.get(event.token) === event.citedId) {
          terminusOf.set(event.token, null);
        }
        latestEventTurn.set(event.token, citingId);
      }
    }

    // Phase 2 — declarations. Latest wins; a turn declaring itself terminus
    // for the same lane twice in one batch (redundant `indexes` rows citing
    // different targets) is idempotent.
    for (const event of batch) {
      if (event.relation !== "indexes" || event.token === null) continue;
      terminusOf.set(event.token, citingId);
      everDeclared.set(event.token, true);
      latestEventTurn.set(event.token, citingId);
    }
  }

  // ---- assemble lanes, deterministic order (segment, then tag key) ----
  const tokens = [...groups.keys()].sort();
  const lanes: Lane[] = [];
  const laneByToken = new Map<string, Lane>();
  for (const token of tokens) {
    const group = groups.get(token)!;
    const memberIds = new Set<number>();
    for (const edge of group.edges) {
      memberIds.add(edge.citingId);
      memberIds.add(edge.citedId);
    }
    const dead = deadInLane.get(token)!;
    const members: LaneMember[] = [...memberIds]
      .sort((a, b) => a - b)
      .map((id) => ({ id, dead: globallyDead.has(id) || dead.has(id) }));
    const terminus = terminusOf.get(token) ?? null;
    const state: LaneDeclarationState =
      terminus !== null ? "declared" : everDeclared.get(token) ? "reopened" : "undeclared";
    const lane: Lane = {
      key: { segment: group.segment, tagSet: group.tagSet },
      members,
      declaration: {
        state,
        terminus,
        latestEventTurn: latestEventTurn.get(token) ?? null,
      },
      taggedEdges: group.edges,
    };
    lanes.push(lane);
    laneByToken.set(token, lane);
  }

  return { lanes, laneByToken };
}
