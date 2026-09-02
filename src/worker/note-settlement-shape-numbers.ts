import type { Database } from "bun:sqlite";

import {
  resolveActiveHomelessDisposition,
  loadHomelessRetractionAuditsForGroup,
  type HomelessRetractionAuditRow,
} from "../db/homeless-record";
import {
  laneSnapshotKey,
  readNoteSettlementLaneMemberSnapshot,
  readNoteSettlementWorklistSnapshot,
  readNoteSettlementWritableSnapshot,
  type NoteSettlementRemovedSideDebt,
  type NoteSettlementWorklistLane,
  type SettlementWritableProvenance,
} from "../db/note-settlement-snapshots";
import { loadEndpointLaneFacts, resolveEdgeSides } from "../db/edge-side-resolution";
import { getTurnById } from "../db/turns";
import { edgeRelationClass, formatRelationClass, relationClassBearingSql } from "../shared/relation-class";
import type { SettlementScopeProvenance } from "./note-settlement-context";

/**
 * THE FROZEN STAGE-2 SCOPE, AND THE SHAPE NUMBERS PROJECTED FROM IT
 * (staged-settlement spec Rev 5, §Persisted snapshots, §Shape numbers v1;
 * ticket 07).
 *
 * Two things live here because they are the same thing seen twice. Stage 2's
 * whole authority — whose turns it may write, which `(task, lane)` pairs it
 * owes work on, and which turns are the vertices of each of those lanes — is
 * the three snapshots the transition persisted, READ and never re-derived. The
 * shape numbers are that same frozen record projected onto the live edge
 * table: vertices frozen, edges as they now stand.
 *
 * REVIEWER GUARDRAIL 2 (spec §Further Notes): the live lane CHECKER widens
 * membership as it loads (each touched lane's whole edge set, the component
 * closure). The grammar gate may keep that — it is answering "what is wrong
 * here". The shape numbers may NOT: they answer "what shape did the partition
 * this job settled turn out to have", and a widening membership would let a
 * concurrent write move a number this job's own commit reports. So this module
 * takes its own snapshot-induced projection and shares no loader with the
 * checker.
 */

// ---------------------------------------------------------------------------
// The frozen scope — read once, at the top of a stage-2 run
// ---------------------------------------------------------------------------

/** `Map<turnId, provenance classes>` — the shape `db/write-gate.ts` reads. */
export type SettlementFrozenProvenance = ReadonlyMap<
  number,
  ReadonlySet<SettlementWritableProvenance>
>;

export interface SettlementFrozenScope {
  /** Snapshot #1's ids, flat. */
  writableTurnIds: Set<number>;
  /** Snapshot #1 whole — every id with the SET of classes that put it there. */
  writableProvenance: SettlementFrozenProvenance;
  /**
   * The same ids in the three-bucket shape the refusal renderer and the
   * phase-connectivity window take, derived from the SNAPSHOT's own classes
   * rather than recomputed from the context: `removed-side-citer`-only ids
   * file under `closureOnly`, the same catch-all
   * `resolveSettlementScopeProvenance` uses for an id it cannot place.
   */
  scopeProvenance: SettlementScopeProvenance;
  /** Snapshot #2, in the order stage 1 judged the lanes. */
  worklist: NoteSettlementWorklistLane[];
  /** Snapshot #2's travelling companion: the debts stage 1's own removals created. */
  debts: NoteSettlementRemovedSideDebt[];
  /** Snapshot #3, keyed by `laneSnapshotKey`. */
  laneMembers: Map<string, number[]>;
}

/**
 * Read all three snapshots for one job, or `null` when this job never
 * transitioned.
 *
 * `null` is not an error and not an empty scope — it is the honest answer for
 * a job still on stage 1, or one from before staged settlement existed. Its
 * callers fall back to the values the dispatch computed live, which is exactly
 * the pre-staging behaviour.
 */
export function readSettlementFrozenScope(
  db: Database,
  jobId: number,
): SettlementFrozenScope | null {
  const writableProvenance = readNoteSettlementWritableSnapshot(db, jobId);
  if (writableProvenance.size === 0) {
    return null;
  }
  const window = new Set<number>();
  const baseLookback = new Set<number>();
  const closureOnly = new Set<number>();
  for (const [turnId, provenances] of writableProvenance) {
    if (provenances.has("window")) {
      window.add(turnId);
    } else if (provenances.has("lookback")) {
      baseLookback.add(turnId);
    } else {
      closureOnly.add(turnId);
    }
  }
  const { lanes, debts } = readNoteSettlementWorklistSnapshot(db, jobId);
  return {
    writableTurnIds: new Set(writableProvenance.keys()),
    writableProvenance,
    scopeProvenance: { window, baseLookback, closureOnly },
    worklist: lanes,
    debts,
    laneMembers: readNoteSettlementLaneMemberSnapshot(db, jobId),
  };
}

// ---------------------------------------------------------------------------
// Shape numbers v1
// ---------------------------------------------------------------------------

export interface SettlementLaneShape {
  segmentId: number;
  laneTag: string;
  /** The FROZEN member count — the denominator, never a live re-count. */
  memberCount: number;
  /** WEAK components over the induced subgraph; an edgeless member is its own. */
  componentCount: number;
  /** In-lane edges that survived the induction, for the report's own arithmetic. */
  edgeCount: number;
}

export interface SettlementLanePairShape {
  a: NoteSettlementWorklistLane;
  b: NoteSettlementWorklistLane;
  /** Ascending by relation word — the grouping the spec asks for. */
  byRelation: Array<{ relation: string; count: number }>;
  total: number;
}

export interface SettlementShapeNumbers {
  lanes: SettlementLaneShape[];
  pairs: SettlementLanePairShape[];
}

interface ShapeEdgeRow {
  id: number;
  citingId: number;
  citedId: number;
  relationClass: string | null;
  relationCoverage: string | null;
  /** The row's STORED declarations — resolved into `tailLane`/`headLane` below and never compared directly. */
  tailTag: string;
  headTag: string;
}

/** One shape edge with its two sides RESOLVED to lane tags (`''` = attributes to none) and its class token. */
interface ResolvedShapeEdge {
  id: number;
  citingId: number;
  citedId: number;
  /** `correct(full)` / `correct(partial)` / `verify` / `use` — what the cross counts group by since main-agent-edges ticket 02; they grouped by stored word before. */
  relationClass: string;
  tailTag: string;
  headTag: string;
}

/** SQLite's parameter ceiling, the only reason the edge read is chunked. */
const SHAPE_VERTEX_CHUNK = 400;

/**
 * THE INDUCED SUBGRAPH ON THE FROZEN VERTICES (spec §Shape numbers v1).
 *
 * An in-lane edge counts iff BOTH endpoint ids sit in THAT lane's frozen member
 * snapshot AND both sides name that lane's tag. Membership in the snapshot
 * already carries the task half of lane identity — `snapshotLaneMembers` admits
 * a turn only when its OWNING segment is the lane's — so tag equality completes
 * "both sides resolve to that `(task, lane)`" without a second ownership read
 * that could disagree with the frozen one.
 *
 * Three exclusions, each load-bearing:
 *
 *   - AN UNATTRIBUTABLE SIDE. Both sides are RESOLVED first
 *     (`db/edge-side-resolution.ts`), and a side that attributes to no lane
 *     carries `''`, which equals no lane tag — so it is excluded by the same
 *     predicate rather than by a special case. What CHANGED (main-agent-edges
 *     spec D2) is that a side nobody declared no longer means "no lane": it
 *     derives one when its endpoint is in exactly one, and those edges are
 *     induced now where they used to be invisible.
 *   - BARE ROWS. A row with no relation class is a citation, not a claim about
 *     the lane's structure, and the cross counts are grouped BY class.
 *   - A CONCURRENTLY ADDED MEMBER. It is not in the frozen set, so no edge
 *     touching it is induced — invisible to these numbers BY DEFINITION, which
 *     is the property that makes a retry's numbers identical to the first
 *     run's over the same edge state.
 *
 * Liveness is deliberately NOT re-checked here. The transition already applied
 * it when it froze the vertices; asking again at commit time would make the
 * vertex set a live computation again, which is the one thing these snapshots
 * exist to prevent.
 */
export function computeSettlementShapeNumbers(
  db: Database,
  jobId: number,
): SettlementShapeNumbers {
  const { lanes: worklist } = readNoteSettlementWorklistSnapshot(db, jobId);
  const laneMembers = readNoteSettlementLaneMemberSnapshot(db, jobId);
  if (worklist.length === 0) {
    return { lanes: [], pairs: [] };
  }

  const memberSets = worklist.map(
    (lane) => new Set(laneMembers.get(laneSnapshotKey(lane.segmentId, lane.laneTag)) ?? []),
  );
  const allVertices = new Set<number>();
  for (const members of memberSets) {
    for (const id of members) {
      allVertices.add(id);
    }
  }

  const edges = readShapeEdges(db, allVertices);
  // ONE batched endpoint-facts load for the whole frozen vertex set, then a
  // pure per-side projection — the same seam every other lane reader uses.
  const laneFacts = loadEndpointLaneFacts(db, [
    ...new Set(edges.flatMap((row) => [row.citingId, row.citedId])),
  ]);
  const resolved: ResolvedShapeEdge[] = [];
  for (const row of edges) {
    const relationClass = edgeRelationClass({
      relationClass: (row.relationClass ?? "") as never,
      relationCoverage: (row.relationCoverage ?? "") as never,
    });
    if (relationClass === null) {
      continue;
    }
    const sides = resolveEdgeSides(
      { citingId: row.citingId, citedId: row.citedId, tailTag: row.tailTag, headTag: row.headTag },
      laneFacts,
    );
    resolved.push({
      id: row.id,
      citingId: row.citingId,
      citedId: row.citedId,
      relationClass: formatRelationClass(
        relationClass.relationClass,
        relationClass.relationCoverage,
      ),
      tailTag: sides.tail.lane?.tag ?? "",
      headTag: sides.head.lane?.tag ?? "",
    });
  }

  const lanes: SettlementLaneShape[] = worklist.map((lane, index) => {
    const members = memberSets[index]!;
    const induced = resolved.filter(
      (edge) =>
        edge.tailTag === lane.laneTag &&
        edge.headTag === lane.laneTag &&
        members.has(edge.citingId) &&
        members.has(edge.citedId),
    );
    return {
      segmentId: lane.segmentId,
      laneTag: lane.laneTag,
      memberCount: members.size,
      componentCount: countWeakComponents(members, induced),
      edgeCount: induced.length,
    };
  });

  // UNORDERED pairs, in worklist order: `(i, j)` with `i < j` visits each pair
  // once, and an edge is counted for the pair whichever way it points.
  const pairs: SettlementLanePairShape[] = [];
  for (let i = 0; i < worklist.length; i += 1) {
    for (let j = i + 1; j < worklist.length; j += 1) {
      const laneA = worklist[i]!;
      const laneB = worklist[j]!;
      const membersA = memberSets[i]!;
      const membersB = memberSets[j]!;
      const byRelation = new Map<string, number>();
      let total = 0;
      for (const edge of resolved) {
        const forward =
          edge.tailTag === laneA.laneTag &&
          edge.headTag === laneB.laneTag &&
          membersA.has(edge.citingId) &&
          membersB.has(edge.citedId);
        const backward =
          edge.tailTag === laneB.laneTag &&
          edge.headTag === laneA.laneTag &&
          membersB.has(edge.citingId) &&
          membersA.has(edge.citedId);
        if (!forward && !backward) {
          continue;
        }
        byRelation.set(edge.relationClass, (byRelation.get(edge.relationClass) ?? 0) + 1);
        total += 1;
      }
      if (total === 0) {
        continue;
      }
      pairs.push({
        a: laneA,
        b: laneB,
        byRelation: [...byRelation.entries()]
          .map(([relation, count]) => ({ relation, count }))
          .sort((left, right) => left.relation.localeCompare(right.relation)),
        total,
      });
    }
  }

  return { lanes, pairs };
}

/**
 * Every class-carrying turn→turn row whose CITING end is a frozen vertex. The
 * cited end is filtered in JS rather than in a second `IN` list: chunking both
 * sides against SQLite's parameter ceiling would multiply the chunk count for
 * a filter one `Set.has` answers.
 *
 * The `tail_tag <> '' AND head_tag <> ''` predicate is gone with the
 * stored-side model (main-agent-edges D2): attribution is decided by the
 * resolver against the endpoints' own membership, and selecting on a
 * declaration here would drop every derived edge before that decision was
 * ever made.
 */
function readShapeEdges(db: Database, vertices: ReadonlySet<number>): ShapeEdgeRow[] {
  const ids = [...vertices];
  const rows: ShapeEdgeRow[] = [];
  for (let offset = 0; offset < ids.length; offset += SHAPE_VERTEX_CHUNK) {
    const chunk = ids.slice(offset, offset + SHAPE_VERTEX_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(
      ...db
        .query<ShapeEdgeRow, number[]>(
          `SELECT id,
                  citing_id AS citingId,
                  cited_id AS citedId,
                  relation_class AS relationClass,
                  relation_coverage AS relationCoverage,
                  tail_tag AS tailTag,
                  head_tag AS headTag
             FROM memory_edges
            WHERE citing_kind = 'turn' AND cited_kind = 'turn'
              AND ${relationClassBearingSql("memory_edges")}
              AND citing_id IN (${placeholders})
            ORDER BY id ASC`,
        )
        .all(...chunk),
    );
  }
  return rows.filter((row) => vertices.has(row.citedId));
}

/**
 * WEAK connected components: direction is ignored, and a member no induced edge
 * touches is its own component (spec: "a member with no edge is its own
 * component"). Plain union-find over the frozen vertex set, so the answer is a
 * function of that set plus the induced edges and of nothing else.
 */
function countWeakComponents(
  members: ReadonlySet<number>,
  edges: readonly { citingId: number; citedId: number }[],
): number {
  const parent = new Map<number, number>();
  for (const id of members) {
    parent.set(id, id);
  }
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  let components = members.size;
  for (const edge of edges) {
    const left = find(edge.citingId);
    const right = find(edge.citedId);
    if (left === right) {
      continue;
    }
    parent.set(left, right);
    components -= 1;
  }
  return components;
}

/** The lane's canonical address, the same string the member snapshot is keyed by. */
export function laneAddress(lane: NoteSettlementWorklistLane): string {
  return laneSnapshotKey(lane.segmentId, lane.laneTag);
}

/**
 * The shape numbers as the commit report carries them. NO thresholds, NO
 * candidate labels, NO persistence (spec): three numbers per lane and a
 * per-relation crossing count per pair, stated for a human to read.
 */
export function renderSettlementShapeNumbers(shape: SettlementShapeNumbers): string {
  if (shape.lanes.length === 0) {
    return "";
  }
  const lines: string[] = [
    "SHAPE NUMBERS (v1 — the induced subgraph on the transition's FROZEN lane members; " +
      "a member added since is invisible here by definition):",
  ];
  for (const lane of shape.lanes) {
    lines.push(
      `  E${lane.segmentId}/#${lane.laneTag} — ${lane.memberCount} member(s), ` +
        `${lane.componentCount} weak component(s), ${lane.edgeCount} in-lane edge(s)`,
    );
  }
  if (shape.pairs.length === 0) {
    lines.push("  crossings: none between worklist lanes");
    return lines.join("\n");
  }
  lines.push("  crossings (unordered lane pairs, by relation word):");
  for (const pair of shape.pairs) {
    lines.push(
      `    ${laneAddress(pair.a)} <-> ${laneAddress(pair.b)}: ` +
        pair.byRelation.map((entry) => `${entry.relation} ${entry.count}`).join(", "),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The homeless-motivated retractions this job made, for the commit report
// ---------------------------------------------------------------------------

export interface SettlementHomelessRetraction extends HomelessRetractionAuditRow {
  /** The cause group's own label, resolved for the report line. */
  causeLabel: string;
}

/**
 * Every retraction audit row THIS job wrote, found through the ACTIVE
 * DISPOSITION VIEW and nothing else (spec §Homeless record: the reduction is
 * implemented once and is the sole entry point for every consumer).
 *
 * The route is deliberately indirect. `resolveActiveHomelessDisposition` over
 * the writable set yields the groups this job's own turns are actually
 * homeless under; the audit rows are then loaded per group and filtered to this
 * job. Asking the audit table directly for "rows with my job id" would be one
 * line shorter and would read the record WITHOUT the reduction — which is
 * precisely the duplication that produced the round-3 covering-group bug.
 */
export function collectSettlementHomelessRetractions(
  db: Database,
  jobId: number,
  writableTurnIds: Iterable<number>,
): SettlementHomelessRetraction[] {
  const groups = new Map<number, string>();
  for (const turnId of writableTurnIds) {
    const disposition = resolveActiveHomelessDisposition(db, turnId);
    if (disposition) {
      groups.set(disposition.groupId, disposition.canonicalLabel);
    }
  }
  const found: SettlementHomelessRetraction[] = [];
  for (const [groupId, causeLabel] of groups) {
    for (const row of loadHomelessRetractionAuditsForGroup(db, groupId)) {
      if (row.jobId === jobId) {
        found.push({ ...row, causeLabel });
      }
    }
  }
  return found.sort((left, right) => left.id - right.id);
}

/** One retraction per line: the deleted row's identity, its cause, and whether a bare citation survived it. */
export function renderSettlementHomelessRetractions(
  db: Database,
  retractions: readonly SettlementHomelessRetraction[],
): string {
  if (retractions.length === 0) {
    return "";
  }
  const lines = [
    `HOMELESS-MOTIVATED RETRACTIONS (${retractions.length}), each recorded with its cause:`,
  ];
  for (const row of retractions) {
    lines.push(
      `  [edge #${row.edgeId}] ${turnAddress(db, row.citingId)} -${row.relationWord}-> ` +
        `${turnAddress(db, row.citedId)} {${row.tailTag || "-"},${row.headTag || "-"}} — cause: ` +
        `homeless group #${row.causeGroupId} ${JSON.stringify(row.causeLabel)}` +
        (row.outcome === "retracted-bare-restored"
          ? "; relation retracted, bare restored"
          : ""),
    );
  }
  return lines.join("\n");
}

function turnAddress(db: Database, turnId: number): string {
  const turn = getTurnById(db, turnId);
  return turn ? `S${turn.sessionId}/T${turn.promptNumber}` : `turn #${turnId}`;
}

// ---------------------------------------------------------------------------
// The prompt's own view of the frozen worklist
// ---------------------------------------------------------------------------

export interface SettlementWorklistLaneRendering {
  address: string;
  memberAddresses: string[];
}

export interface SettlementWorklistRendering {
  lanes: SettlementWorklistLaneRendering[];
  debts: Array<{ edgeId: number; removedLaneTag: string; citingAddress: string }>;
  homeless: Array<{ label: string; reason: string; memberAddresses: string[] }>;
}

/**
 * The worklist as the stage-2 PROMPT declares it — addresses, never row ids,
 * because this is the vocabulary every `note`/`remember` call takes.
 *
 * TOTAL since ticket 08, where it used to answer `null` for a job with no
 * frozen scope and the prompt then printed no worklist section at all. That
 * missing section was the last rendering of the SINGLE-PASS settlement run, and
 * it is retired: stage 2 is reached only through a landed transition, so the
 * question is never "did stage 1 happen" but "what did it freeze", and an empty
 * answer to that is a real answer. The transition-only default stage 1 (a
 * worker nobody handed a stage-1 payload to) is exactly the job that lands here
 * with nothing frozen, and "no lanes to work" is what it honestly judged.
 *
 * Distinct from `readSettlementFrozenScope`'s own `null`, which stays: that one
 * feeds the sdk-query's authority fallback, where "never transitioned" and
 * "froze an empty set" are genuinely different and must not be conflated.
 */
export function buildSettlementWorklistRendering(
  db: Database,
  jobId: number,
): SettlementWorklistRendering {
  const scope = readSettlementFrozenScope(db, jobId);
  if (!scope) {
    return { lanes: [], debts: [], homeless: [] };
  }
  const homelessByGroup = new Map<
    number,
    { label: string; reason: string; memberAddresses: string[] }
  >();
  for (const turnId of [...scope.writableTurnIds].sort((a, b) => a - b)) {
    const disposition = resolveActiveHomelessDisposition(db, turnId);
    if (!disposition) {
      continue;
    }
    const existing = homelessByGroup.get(disposition.groupId);
    if (existing) {
      existing.memberAddresses.push(turnAddress(db, turnId));
      continue;
    }
    homelessByGroup.set(disposition.groupId, {
      label: disposition.canonicalLabel,
      reason: disposition.reason,
      memberAddresses: [turnAddress(db, turnId)],
    });
  }
  return {
    lanes: scope.worklist.map((lane) => ({
      address: laneAddress(lane),
      memberAddresses: (
        scope.laneMembers.get(laneSnapshotKey(lane.segmentId, lane.laneTag)) ?? []
      ).map((turnId) => turnAddress(db, turnId)),
    })),
    debts: scope.debts.map((debt) => ({
      edgeId: debt.edgeId,
      removedLaneTag: debt.removedLaneTag,
      citingAddress: turnAddress(db, debt.citingTurnId),
    })),
    homeless: [...homelessByGroup.values()],
  };
}
