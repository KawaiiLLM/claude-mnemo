import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";

import {
  loadDeclaredLaneRegistry,
  loadDownstreamTurns,
  loadLaneCheckScope,
  loadLaneControlCapability,
  loadLaneControlEdges,
  loadLaneTagsForTurns,
  loadSegmentsWithDeclaredLanes,
  type LaneControlCapability,
  type LaneControlEdge,
} from "../db/lane-checker-load";
import { checkLanes } from "../shared/lane-checker";
import { buildLaneAnchorAddresses, formatLaneKey, formatLaneSide } from "../shared/lane-checker-render";
import {
  DEFAULT_SEGMENT,
  laneToken,
  UNSETTLED_LANE_TAG,
  type LaneOrderKey,
} from "../shared/lane-interpretation";
import { resolveDatabasePath } from "../shared/paths";
import { openReadOnlyLaneCheckDatabase, type OpenLaneCheckDatabase } from "./lane-check-cli";

/**
 * THE ATTRIBUTION CONTROLS (lane-model-v12 spec "验证", ticket 13).
 *
 * ## What this tool is for, and why it is not a checker report
 *
 * The v12 checker's reports are about to be read for the first time. A report
 * that reads as NOISE has two possible causes and, on its own, no way to tell
 * them apart: the DEFINITION is wrong, or the ATTRIBUTION is simply not done
 * yet. Get that ordering wrong and a correct model is thrown away because
 * nobody had settled the edges first.
 *
 * These four controls answer "is the attribution finished?" — the question that
 * has to be settled BEFORE a report is evidence about anything. They are
 * deliberately NOT new checker reports (spec D6's "不重新设计报表结构"): they
 * live in their own CLI, they read the database directly, and no gate, prompt
 * or renderer of the checker's consumes them.
 *
 *   C1  edges with either side the `''` sentinel                    target 0
 *   C2  per-side declaration/subset violations on SETTLED edges      target 0
 *   C3  nodes that have edges but carry no declared lane             target 0
 *   C4  two-sided-tag accuracy on a hand-graded, stratified sample   NO TARGET
 *
 * C4 sets no threshold and never will: the spec's own do-not list forbids
 * inventing a bar where there is neither a denominator nor a ruling ("不发明门
 * 限"). It is reported, and that is the whole of it.
 *
 * ## Every finding carries an address and BOTH side LaneKeys
 *
 * `LaneControlFinding` has no shape in which either can be missing. That is the
 * ticket's own requirement and it is what makes the causal matrix usable: a
 * reader judges "is THIS attribution right" from the address (which turn) and
 * the two side LaneKeys (which lane each end claims), and only then judges the
 * definition. A finding that named a count without an address would force the
 * reader back to step 2 with nothing to look at.
 *
 * ## NEVER A ZERO STANDING IN FOR AN UNMEASURABLE
 *
 * `LaneControl.measured` is `number | null`. `null` means COULD NOT MEASURE and
 * always arrives with `unmeasurableReason`; a control never reports `0` unless
 * it actually counted zero. This is not defensive decoration — the production
 * database has NOT run the v12 edge migration (verified read-only: `tail_tag`/
 * `head_tag` absent, `memory_edge_side_tags` and `lanes` absent), so the FIRST
 * live run of this tool is exactly the case where a fabricated zero would read
 * as "the attribution is finished".
 *
 * ## READ-ONLY, and how that is established
 *
 *   1. the opener is `openReadOnlyLaneCheckDatabase` — IMPORTED from
 *      `lane-check-cli.ts`, not re-declared, so there is one `readonly: true`
 *      in the lane tooling and no second place to get it wrong;
 *   2. every statement this tool reaches (`db/lane-checker-load.ts`'s control
 *      loaders and the projection loader they share) is a `SELECT`;
 *   3. the only file this tool ever writes is the one `--export` names, which
 *      is never the database — and it is written through `node:fs`, not
 *      through the handle.
 *
 * `tests/cli/lane-controls-cli.test.ts` pins all three, the third by hashing
 * the database file before and after a full run WITH `--export`.
 */

// ------------------------------------------------------------------ shapes

export type LaneControlId = "C1" | "C2" | "C3" | "C4";

/**
 * ONE control finding. The three identity fields are mandatory BY TYPE: the
 * ticket's requirement is that a reader can judge the attribution before the
 * definition, and that judgement needs the source address and the lane each
 * SIDE claims. `tailLane`/`headLane` are always both present — an unsettled
 * side prints `<unsettled>` (`formatLaneSide`), never an empty string, because
 * "this side names no lane" is itself the finding in control 1.
 */
export interface LaneControlFinding {
  /** `S<session>/T<prompt>` for a node, `S<n>/T<m> --relation--> S<n>/T<m>` for an edge — the ONE address vocabulary the checker's renderer already speaks. */
  address: string;
  /** The TAIL side's `LaneKey`, spelled exactly as every checker report spells one. */
  tailLane: string;
  /** The HEAD side's `LaneKey`. */
  headLane: string;
  /** What is wrong with THIS row, in one clause — never a restatement of the control's own title. */
  note: string;
}

export interface LaneControl {
  id: LaneControlId;
  title: string;
  /** The ticket's own target for this control, printed with it so a reader never has to remember which ones aim at 0. */
  target: string;
  /**
   * The measured quantity, or `null` for COULD NOT MEASURE — never `0` for an
   * unmeasurable. `unmeasurableReason` is non-null exactly when this is.
   */
  measured: number | null;
  /** What `measured` counts, in the reader's words ("edge(s)", "violation(s)", …). */
  unit: string;
  /** Non-null exactly when `measured` is null. */
  unmeasurableReason: string | null;
  /** Denominators and breakdowns — facts, never verdicts. */
  context: string[];
  /** Capped for display; `findingCount` is always the TRUE total. */
  findings: LaneControlFinding[];
  findingCount: number;
}

/** One closed lane whose terminus nobody outside cites, with the downstream addresses requirement 4 exists for. */
export interface LaneTerminusSampleEntry {
  /** The lane, `E<n>:{tag}`. */
  lane: string;
  /** The terminus turn's address. */
  terminus: string;
  terminusId: number;
  /** Live turns of the same segment written AFTER the terminus, ascending, capped by `--downstream`. Addresses, because the point is that a human goes and READS them. */
  downstream: string[];
}

export type LaneGoldVerdict = "" | "correct" | "wrong" | "unsure";

/** The full STORAGE identity of one edge (spec D1: `(citing, cited, relation, tail_tag, head_tag)`) — a graded row names an exact row, so a re-tagged one reads as STALE rather than silently scoring the old verdict against new tags. */
export interface LaneGoldSampleEdgeId {
  citingId: number;
  citedId: number;
  relation: string;
  tailTag: string;
  headTag: string;
}

export interface LaneGoldSampleRow {
  edge: LaneGoldSampleEdgeId;
  /** `<relation> @ <segment>` — the stratum this row was drawn for. */
  stratum: string;
  address: string;
  tailLane: string;
  headLane: string;
  /** The CITING turn's own stored tags — carried so a grader can judge the subset half without a second query. `null` = unparseable. */
  citingTurnTags: readonly string[] | null;
  citedTurnTags: readonly string[] | null;
  /** The grader fills these. `""` = not yet graded, and an ungraded row is EXCLUDED from the accuracy denominator rather than counted wrong. */
  verdict: { tail: LaneGoldVerdict; head: LaneGoldVerdict };
}

export interface LaneGoldSample {
  kind: "lane-model-v12 gold sample";
  /** Stated in the artifact, not only in the ticket: a sample whose stratification is unknown cannot be read later. */
  stratifiedBy: string;
  perStratum: number;
  strata: number;
  rows: LaneGoldSampleRow[];
}

export interface LaneGoldStratumScore {
  stratum: string;
  graded: number;
  bothSidesCorrect: number;
}

export interface LaneGoldScore {
  /** Rows whose BOTH verdicts are a decision (`correct`/`wrong`) and whose edge still exists as graded — the accuracy denominator. */
  graded: number;
  bothSidesCorrect: number;
  /** Percentage, or `null` when nothing is gradable — never `0` for "nobody graded anything". */
  accuracy: number | null;
  /** At least one side left `""`. */
  ungraded: number;
  /** No blank, at least one `unsure` — a grader's honest refusal, excluded from the denominator and named. */
  unsure: number;
  /** The graded row's exact stored identity is no longer in the database (retracted, or re-tagged since the draw). Excluded whatever its verdict says. */
  stale: number;
  /** Per-side supporting counts over the graded rows. */
  tailCorrect: number;
  headCorrect: number;
  perStratum: LaneGoldStratumScore[];
}

export interface LaneControlsReport {
  databasePath: string;
  capability: LaneControlCapability;
  /** `null` when the capability probe stopped the load. */
  edgeCount: number | null;
  /** Provenance breakdown of the domain — a denominator fact, never a filter. */
  provenanceCounts: Record<string, number>;
  controls: LaneControl[];
  terminus: {
    entries: LaneTerminusSampleEntry[];
    /** True total of uncited closed termini; `entries` is capped for display. */
    entryCount: number;
    closedLanesScanned: number;
    unmeasurableReason: string | null;
  };
  /** The freshly drawn sample, `null` when it could not be drawn. */
  sample: LaneGoldSample | null;
  /** Where `--export` wrote, or `null`. */
  exportPath: string | null;
  /** What `--graded` was read from, or `null`. */
  gradedPath: string | null;
}

// ----------------------------------------------------------- capabilities

/**
 * Why each absent capability blocks a measurement, in the reader's words. This
 * text is what appears where a number would have been, so it must say what is
 * missing AND what to do about it — a bare "cannot measure" would leave a
 * reader unable to tell a broken tool from an unmigrated database.
 */
const CAPABILITY_REASON: Record<keyof LaneControlCapability, string> = {
  edgeSideTagColumns:
    "memory_edges has no tail_tag/head_tag column -- the v12 edge migration (spec M-A) has not run on this database, so no edge here has a side to be settled or unsettled",
  edgeSideTagIndex:
    "the memory_edge_side_tags index table is absent -- the v12 edge migration has not run on this database",
  laneRegistry:
    'the lanes registry table is absent -- nothing has ever been declared here, so "declared" has nothing to be checked against',
};

function missingCapabilityReason(
  capability: LaneControlCapability,
  needed: readonly (keyof LaneControlCapability)[],
): string | null {
  const missing = needed.filter((name) => !capability[name]).map((name) => CAPABILITY_REASON[name]);
  return missing.length === 0 ? null : missing.join("; ");
}

/** A control that could not run: `measured` null, the reason attached, no findings. The ONE constructor for that state, so no call site can accidentally emit a zero instead. */
function unmeasurable(
  id: LaneControlId,
  title: string,
  target: string,
  unit: string,
  reason: string,
): LaneControl {
  return {
    id,
    title,
    target,
    measured: null,
    unit,
    unmeasurableReason: reason,
    context: [],
    findings: [],
    findingCount: 0,
  };
}

// --------------------------------------------------------------- addresses

/**
 * `turns.id` -> `S<session>/T<prompt>`, through `buildLaneAnchorAddresses` —
 * the checker renderer's OWN address builder, reused rather than re-spelled, so
 * a control finding and a checker report name the same turn the same way. The
 * bare-id fallback is the same marked last resort that renderer documents.
 */
function addressLookup(
  entries: readonly { id: number; order: LaneOrderKey }[],
): (id: number) => string {
  const map = buildLaneAnchorAddresses(
    entries.map((entry) => ({ id: entry.id, type: [] as string[], order: entry.order })),
  );
  return (id) => map.get(id) ?? "T" + id;
}

function addressLookupForEdges(edges: readonly LaneControlEdge[]): (id: number) => string {
  return addressLookup(
    edges.flatMap((edge) => [
      { id: edge.citingId, order: edge.citingOrder },
      { id: edge.citedId, order: edge.citedOrder },
    ]),
  );
}

/** `S<n>/T<m> --relation--> S<n>/T<m>` — one edge's source address, the same arrow the checker's own error lines draw. */
function edgeAddress(edge: LaneControlEdge, addressOf: (id: number) => string): string {
  return addressOf(edge.citingId) + " --" + edge.relation + "--> " + addressOf(edge.citedId);
}

function tailLaneOf(edge: LaneControlEdge): string {
  return formatLaneSide(edge.citingSegment, edge.tailTag);
}

function headLaneOf(edge: LaneControlEdge): string {
  return formatLaneSide(edge.citedSegment, edge.headTag);
}

/** The findings a control prints, plus the true total the cap hides. */
function cap(findings: readonly LaneControlFinding[], limit: number): {
  findings: LaneControlFinding[];
  findingCount: number;
} {
  return { findings: findings.slice(0, limit), findingCount: findings.length };
}

// -------------------------------------------------------------- control 1

/**
 * C1 — edges with EITHER side the `''` sentinel (target 0).
 *
 * Two shapes are counted, and the context line keeps them apart because their
 * repairs differ:
 *
 *   - BOTH sides unsettled: the legal draft state (spec D3c) and settlement's
 *     own to-do queue. This is the number that goes to 0 when attribution is
 *     finished.
 *   - EXACTLY ONE side unsettled: the half-settled shape spec D2 forbids
 *     outright ("两侧要么都有 tag,要么都没有"). No write face can produce one,
 *     so any occurrence is pre-gate stock or a migration defect — a different
 *     finding wearing the same count.
 */
export function controlUnsettledSides(
  edges: readonly LaneControlEdge[],
  capability: LaneControlCapability,
  findingLimit: number,
): LaneControl {
  const title = "edges with either side unsettled ('')";
  const target = "0";
  const unit = "edge(s)";
  const reason = missingCapabilityReason(capability, ["edgeSideTagColumns"]);
  if (reason !== null) {
    return unmeasurable("C1", title, target, unit, reason);
  }
  const addressOf = addressLookupForEdges(edges);
  const findings: LaneControlFinding[] = [];
  let both = 0;
  let half = 0;
  for (const edge of edges) {
    const tailUnsettled = edge.tailTag === UNSETTLED_LANE_TAG;
    const headUnsettled = edge.headTag === UNSETTLED_LANE_TAG;
    if (!tailUnsettled && !headUnsettled) continue;
    if (tailUnsettled && headUnsettled) {
      both += 1;
    } else {
      half += 1;
    }
    findings.push({
      address: edgeAddress(edge, addressOf),
      tailLane: tailLaneOf(edge),
      headLane: headLaneOf(edge),
      note:
        tailUnsettled && headUnsettled
          ? "both sides unsettled -- settlement has not decided this row"
          : "HALF-SETTLED: only the " +
            (tailUnsettled ? "head" : "tail") +
            " side names a lane, a shape spec D2 forbids outright",
    });
  }
  return {
    id: "C1",
    title,
    target,
    measured: findings.length,
    unit,
    unmeasurableReason: null,
    context: [
      both + " with BOTH sides unsettled (settlement's own queue)",
      half + " HALF-settled (the shape D2's write gate refuses; stock or migration defect)",
      "out of " + edges.length + " live relation-carrying turn->turn edge(s)",
    ],
    ...cap(findings, findingLimit),
  };
}

// -------------------------------------------------------------- control 2

/** One per-side violation on a SETTLED edge — the shape control 2 counts. */
export interface LaneSideAttributionViolation {
  edge: LaneControlEdge;
  side: "tail" | "head";
  /** `undeclared` = the side's tag is not in that endpoint's own segment's registry; `not-on-endpoint` = the tag is not on that endpoint turn itself (spec D2 rule 3, the same invariant error class E4 checks). */
  kind: "undeclared" | "not-on-endpoint";
}

/**
 * C2's raw list. Domain: SETTLED edges only (both sides non-`''`) — a
 * half-settled or fully unsettled row is control 1's finding, and judging its
 * absent tag against a registry would double-count one defect as two.
 *
 * Both kinds can fire on ONE side, and then both are listed: "the word was
 * never declared here" and "the word is not on the turn" have different
 * repairs (declare/rename vs. retag the turn), and folding them would hide one.
 *
 * An endpoint whose stored `tags` are UNPARSEABLE yields no `not-on-endpoint`
 * verdict for its side — `parseTurnTags`' own "ignorance never manufactures an
 * error" rule, which error class E4 already applies and which a control must
 * not quietly contradict.
 */
export function computeSideAttributionViolations(
  edges: readonly LaneControlEdge[],
  registry: ReadonlyMap<string, ReadonlySet<string>>,
): LaneSideAttributionViolation[] {
  const violations: LaneSideAttributionViolation[] = [];
  for (const edge of edges) {
    if (edge.tailTag === UNSETTLED_LANE_TAG || edge.headTag === UNSETTLED_LANE_TAG) {
      continue; // control 1's domain, not this one's
    }
    const sides = [
      {
        side: "tail" as const,
        tag: edge.tailTag,
        segment: edge.citingSegment,
        endpointTags: edge.citingTags,
      },
      {
        side: "head" as const,
        tag: edge.headTag,
        segment: edge.citedSegment,
        endpointTags: edge.citedTags,
      },
    ];
    for (const side of sides) {
      if (!(registry.get(side.segment)?.has(side.tag) ?? false)) {
        violations.push({ edge, side: side.side, kind: "undeclared" });
      }
      if (side.endpointTags !== undefined && !side.endpointTags.includes(side.tag)) {
        violations.push({ edge, side: side.side, kind: "not-on-endpoint" });
      }
    }
  }
  return violations;
}

export function controlSideAttribution(
  edges: readonly LaneControlEdge[],
  registry: ReadonlyMap<string, ReadonlySet<string>>,
  capability: LaneControlCapability,
  findingLimit: number,
): LaneControl {
  const title = "per-side declaration/subset violations on SETTLED edges";
  const target = "0";
  const unit = "violation(s)";
  const reason = missingCapabilityReason(capability, ["edgeSideTagColumns", "laneRegistry"]);
  if (reason !== null) {
    return unmeasurable("C2", title, target, unit, reason);
  }
  const violations = computeSideAttributionViolations(edges, registry);
  const addressOf = addressLookupForEdges(edges);
  const settled = edges.filter(
    (edge) => edge.tailTag !== UNSETTLED_LANE_TAG && edge.headTag !== UNSETTLED_LANE_TAG,
  ).length;
  const undeclared = violations.filter((violation) => violation.kind === "undeclared").length;
  const findings = violations.map((violation) => ({
    address: edgeAddress(violation.edge, addressOf),
    tailLane: tailLaneOf(violation.edge),
    headLane: headLaneOf(violation.edge),
    note:
      violation.kind === "undeclared"
        ? 'the ' +
          violation.side +
          ' side\'s tag "' +
          (violation.side === "tail" ? violation.edge.tailTag : violation.edge.headTag) +
          '" is not DECLARED in that endpoint\'s own segment'
        : 'the ' +
          violation.side +
          ' side\'s tag "' +
          (violation.side === "tail" ? violation.edge.tailTag : violation.edge.headTag) +
          '" is not on that endpoint turn itself (subset, spec D2 rule 3 = error class E4)',
  }));
  return {
    id: "C2",
    title,
    target,
    measured: violations.length,
    unit,
    unmeasurableReason: null,
    context: [
      undeclared + " undeclared-lane, " + (violations.length - undeclared) + " subset (E4)",
      "over " + settled + " settled edge(s) (both sides naming a lane)",
      "an endpoint whose stored tags are unparseable yields no subset verdict for its side",
    ],
    ...cap(findings, findingLimit),
  };
}

// -------------------------------------------------------------- control 3

/** One node that has edges but claims no declared lane. */
export interface LaneLanelessNode {
  id: number;
  /** `LaneKey.segment` form of the node's owning segment. */
  segment: string;
  /** The incident edge that anchors the finding — the lowest `(citingId, citedId, relation)`, so the choice is a pure function of the graph. */
  anchorEdge: LaneControlEdge;
  /** How many live edges touch this node. */
  edgeCount: number;
  /** Every incident edge's OTHER endpoint is ALSO laneless — the ticket's literal "两端都无" shape, reported as a named subset rather than silently substituted for the count. */
  bothEndsLaneless: boolean;
}

/**
 * C3's raw list: every turn that is an endpoint of at least one live edge and
 * whose RESOLVED membership (`loadLaneTagsForTurns` — the turn's stored `tags`
 * intersected with its OWNING segment's declared lanes, the one membership rule
 * ticket 10 established) is empty.
 *
 * THE TICKET'S PHRASE IS AMBIGUOUS AND THIS RESOLVES IT ONE WAY, NAMING THE
 * OTHER. "有边但两端都无任何已声明 lane 的节点数" reads either as "a node with
 * edges that carries no declared lane" (spec solution 5's own "有边就必须有
 * lane") or, literally, as "a node on an edge NEITHER of whose ends carries
 * one". The second set is a SUBSET of the first — both-ends-laneless requires
 * the node itself to be laneless — so this counts the first and carries the
 * second as `bothEndsLaneless`, which reports both readings without letting
 * either hide the other.
 */
export function computeLanelessNodes(
  edges: readonly LaneControlEdge[],
  laneTagsByTurn: ReadonlyMap<number, readonly string[]>,
): LaneLanelessNode[] {
  const incident = new Map<number, LaneControlEdge[]>();
  const segmentOf = new Map<number, string>();
  for (const edge of edges) {
    for (const endpoint of [
      { id: edge.citingId, segment: edge.citingSegment },
      { id: edge.citedId, segment: edge.citedSegment },
    ]) {
      segmentOf.set(endpoint.id, endpoint.segment);
      const bucket = incident.get(endpoint.id);
      if (bucket === undefined) {
        incident.set(endpoint.id, [edge]);
      } else {
        bucket.push(edge);
      }
    }
  }
  const laneless = (id: number): boolean => (laneTagsByTurn.get(id) ?? []).length === 0;
  const nodes: LaneLanelessNode[] = [];
  for (const [id, incidentEdges] of [...incident.entries()].sort((a, b) => a[0] - b[0])) {
    if (!laneless(id)) continue;
    const anchorEdge = [...incidentEdges].sort(
      (a, b) =>
        a.citingId - b.citingId || a.citedId - b.citedId || a.relation.localeCompare(b.relation),
    )[0]!;
    nodes.push({
      id,
      segment: segmentOf.get(id)!,
      anchorEdge,
      edgeCount: incidentEdges.length,
      bothEndsLaneless: incidentEdges.every((edge) =>
        laneless(edge.citingId === id ? edge.citedId : edge.citingId),
      ),
    });
  }
  return nodes;
}

export function controlLanelessNodes(
  edges: readonly LaneControlEdge[],
  laneTagsByTurn: ReadonlyMap<number, readonly string[]>,
  capability: LaneControlCapability,
  findingLimit: number,
): LaneControl {
  const title = "nodes that have edges but carry no declared lane";
  const target = "0";
  const unit = "node(s)";
  const reason = missingCapabilityReason(capability, ["edgeSideTagColumns", "laneRegistry"]);
  if (reason !== null) {
    return unmeasurable("C3", title, target, unit, reason);
  }
  const nodes = computeLanelessNodes(edges, laneTagsByTurn);
  const addressOf = addressLookupForEdges(edges);
  const endpointCount = new Set(edges.flatMap((edge) => [edge.citingId, edge.citedId])).size;
  const bothEnds = nodes.filter((node) => node.bothEndsLaneless).length;
  const findings = nodes.map((node) => ({
    address:
      addressOf(node.id) + " (via " + edgeAddress(node.anchorEdge, addressOf) + ")",
    tailLane: tailLaneOf(node.anchorEdge),
    headLane: headLaneOf(node.anchorEdge),
    note:
      "carries no declared lane of its own across " +
      node.edgeCount +
      " edge(s)" +
      (node.bothEndsLaneless ? "; every one of them has a laneless far end too" : ""),
  }));
  return {
    id: "C3",
    title,
    target,
    measured: nodes.length,
    unit,
    unmeasurableReason: null,
    context: [
      "out of " + endpointCount + " turn(s) with at least one live edge",
      bothEnds +
        ' of them are the ticket\'s literal reading ("both ends of every incident edge are laneless")',
      "membership is the node's own tags INTERSECTED with its owning segment's declared lanes",
    ],
    ...cap(findings, findingLimit),
  };
}

// ------------------------------------------------------- control 4 (gold)

/** FNV-1a, 32-bit. A stable spread over the edge identities so a stratum's draw is neither "the oldest N" nor dependent on an RNG seed a re-run would have to be told. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The storage identity (spec D1) as one comparable string — the gold sample's row key AND the staleness probe. */
export function goldEdgeIdentity(edge: LaneGoldSampleEdgeId): string {
  return JSON.stringify([edge.citingId, edge.citedId, edge.relation, edge.tailTag, edge.headTag]);
}

/**
 * The stratified draw (ticket 13: "按关系词与段分层"). One stratum per
 * `(relation, segment)` pair, the segment being the CITING side's — the anchor
 * convention every error class in the checker already uses, and the only one of
 * the two that is defined for a cross-lane edge without picking a side twice.
 *
 * SETTLED edges only: the sample measures whether the tags settlement ASSIGNED
 * are right, and an unsettled edge has no assignment to grade — its absence is
 * control 1's number, not a wrong answer here.
 *
 * The draw is a pure function of the database: within a stratum, rows are
 * ordered by `fnv1a(identity)` and then by the identity itself, so the same
 * database yields the same sample on every run and two runs' accuracies are
 * comparable.
 */
export function drawGoldSample(
  edges: readonly LaneControlEdge[],
  perStratum: number,
  addressOf: (id: number) => string,
): LaneGoldSample {
  const strata = new Map<string, LaneControlEdge[]>();
  for (const edge of edges) {
    if (edge.tailTag === UNSETTLED_LANE_TAG || edge.headTag === UNSETTLED_LANE_TAG) continue;
    const stratum = edge.relation + " @ " + formatLaneSide(edge.citingSegment, edge.tailTag);
    const bucket = strata.get(stratum);
    if (bucket === undefined) {
      strata.set(stratum, [edge]);
    } else {
      bucket.push(edge);
    }
  }
  const rows: LaneGoldSampleRow[] = [];
  for (const stratum of [...strata.keys()].sort()) {
    const drawn = [...strata.get(stratum)!]
      .map((edge) => {
        const id: LaneGoldSampleEdgeId = {
          citingId: edge.citingId,
          citedId: edge.citedId,
          relation: edge.relation,
          tailTag: edge.tailTag,
          headTag: edge.headTag,
        };
        return { edge, identity: goldEdgeIdentity(id), id };
      })
      .sort((a, b) => fnv1a(a.identity) - fnv1a(b.identity) || a.identity.localeCompare(b.identity))
      .slice(0, Math.max(0, perStratum));
    for (const entry of drawn) {
      rows.push({
        edge: entry.id,
        stratum,
        address: edgeAddress(entry.edge, addressOf),
        tailLane: tailLaneOf(entry.edge),
        headLane: headLaneOf(entry.edge),
        citingTurnTags: entry.edge.citingTags ?? null,
        citedTurnTags: entry.edge.citedTags ?? null,
        verdict: { tail: "", head: "" },
      });
    }
  }
  return {
    kind: "lane-model-v12 gold sample",
    stratifiedBy: "relation word x the CITING side's lane (segment + tag)",
    perStratum,
    strata: strata.size,
    rows,
  };
}

function isDecided(verdict: LaneGoldVerdict): boolean {
  return verdict === "correct" || verdict === "wrong";
}

/**
 * Score a HAND-GRADED sample. Four dispositions, in this precedence, because
 * each excludes a row for a different reason and collapsing them would let a
 * denominator lie:
 *
 *   STALE   the graded row's exact stored identity is gone (retracted, or
 *           re-tagged since the draw — the live database is under a background
 *           worker, so an inherited figure is a measurement with an expiry
 *           date). Excluded whatever it says.
 *   UNGRADED at least one side still `""`. Excluded — an ungraded row is not a
 *           wrong one, and counting it as one would manufacture the accuracy
 *           this control refuses to invent.
 *   UNSURE  the grader declined. Excluded and NAMED, so a low denominator is
 *           visible rather than silently flattering.
 *   GRADED  both sides decided. The denominator.
 *
 * `accuracy` is `null` when nothing is gradable — never 0.
 */
export function scoreGoldSample(
  rows: readonly LaneGoldSampleRow[],
  liveIdentities: ReadonlySet<string> | null,
): LaneGoldScore {
  let graded = 0;
  let bothSidesCorrect = 0;
  let ungraded = 0;
  let unsure = 0;
  let stale = 0;
  let tailCorrect = 0;
  let headCorrect = 0;
  const perStratum = new Map<string, LaneGoldStratumScore>();
  for (const row of rows) {
    if (liveIdentities !== null && !liveIdentities.has(goldEdgeIdentity(row.edge))) {
      stale += 1;
      continue;
    }
    if (row.verdict.tail === "" || row.verdict.head === "") {
      ungraded += 1;
      continue;
    }
    if (!isDecided(row.verdict.tail) || !isDecided(row.verdict.head)) {
      unsure += 1;
      continue;
    }
    graded += 1;
    if (row.verdict.tail === "correct") tailCorrect += 1;
    if (row.verdict.head === "correct") headCorrect += 1;
    const correct = row.verdict.tail === "correct" && row.verdict.head === "correct";
    if (correct) bothSidesCorrect += 1;
    const bucket = perStratum.get(row.stratum);
    if (bucket === undefined) {
      perStratum.set(row.stratum, {
        stratum: row.stratum,
        graded: 1,
        bothSidesCorrect: correct ? 1 : 0,
      });
    } else {
      bucket.graded += 1;
      bucket.bothSidesCorrect += correct ? 1 : 0;
    }
  }
  return {
    graded,
    bothSidesCorrect,
    accuracy: graded === 0 ? null : (bothSidesCorrect / graded) * 100,
    ungraded,
    unsure,
    stale,
    tailCorrect,
    headCorrect,
    perStratum: [...perStratum.values()].sort((a, b) => a.stratum.localeCompare(b.stratum)),
  };
}

export function controlGoldSample(
  sample: LaneGoldSample | null,
  gradedRows: readonly LaneGoldSampleRow[] | null,
  liveIdentities: ReadonlySet<string> | null,
  capability: LaneControlCapability,
  findingLimit: number,
): LaneControl {
  const title = "two-sided-tag accuracy on a hand-graded, stratified sample";
  const target = "REPORTED, NO THRESHOLD -- the spec forbids inventing a bar with no denominator";
  const unit = "% of graded rows with BOTH sides correct";
  const reason = missingCapabilityReason(capability, ["edgeSideTagColumns"]);
  if (reason !== null) {
    return unmeasurable("C4", title, target, unit, reason);
  }
  if (gradedRows === null) {
    return unmeasurable(
      "C4",
      title,
      target,
      unit,
      "no graded sample was supplied (--graded). A sample can be DRAWN and exported without a human, but its accuracy cannot be computed without one" +
        (sample === null
          ? ""
          : " -- " + sample.rows.length + " row(s) across " + sample.strata + " stratum/strata are ready to grade"),
    );
  }
  const score = scoreGoldSample(gradedRows, liveIdentities);
  if (score.accuracy === null) {
    return unmeasurable(
      "C4",
      title,
      target,
      unit,
      "the graded file has no gradable row: " +
        score.ungraded +
        " ungraded, " +
        score.unsure +
        " unsure, " +
        score.stale +
        " stale (the edge was retracted or re-tagged since the draw)",
    );
  }
  const findings = gradedRows
    .filter((row) => row.verdict.tail === "wrong" || row.verdict.head === "wrong")
    .map((row) => ({
      address: row.address,
      tailLane: row.tailLane,
      headLane: row.headLane,
      note:
        "graded WRONG on " +
        [
          row.verdict.tail === "wrong" ? "the tail" : null,
          row.verdict.head === "wrong" ? "the head" : null,
        ]
          .filter((side) => side !== null)
          .join(" and ") +
        " (" +
        row.stratum +
        ")",
    }));
  return {
    id: "C4",
    title,
    target,
    measured: Math.round(score.accuracy * 10) / 10,
    unit,
    unmeasurableReason: null,
    context: [
      score.bothSidesCorrect + " of " + score.graded + " graded row(s) correct on BOTH sides",
      "per side: tail " + score.tailCorrect + "/" + score.graded + ", head " + score.headCorrect + "/" + score.graded,
      "excluded: " + score.ungraded + " ungraded, " + score.unsure + " unsure, " + score.stale + " stale",
      ...score.perStratum.map(
        (stratum) =>
          "  " + stratum.stratum + ": " + stratum.bothSidesCorrect + "/" + stratum.graded,
      ),
      "NO THRESHOLD is applied to this number, here or anywhere downstream",
    ],
    ...cap(findings, findingLimit),
  };
}

// ------------------------------------------------------- terminus sample

/**
 * Requirement 4's sample: every CLOSED lane whose terminus nobody outside
 * cites, with the DOWNSTREAM turns' addresses attached.
 *
 * It reuses the checker itself — `loadLaneCheckScope` + `checkLanes` per
 * segment, reading `LaneComponentReport.terminusCitedness` — rather than
 * re-deriving closed/open or citedness here. A control that re-derived the very
 * verdict it exists to make readable could disagree with the report it is
 * supposed to be checking, which would leave a reader with three stories
 * instead of two.
 *
 * ONE ENTRY PER LANE, NOT PER SCAN. A segment scan does not stop at its own
 * segment: a cross-segment edge makes the FOREIGN lane an involved lane of this
 * scope too, so scanning A and then B reports a lane they both touch twice.
 * Deduplicating by the lane's own `(segment, tag)` identity is safe rather than
 * arbitrary because the loader's WIDEN pass loads an involved lane's FULL
 * membership and FULL edge set whichever scope reached it — the two scans agree
 * on the verdict by construction, so keeping the first is keeping the same
 * answer.
 *
 * The downstream turns come from the LANE'S OWN segment, never from the segment
 * being scanned. For a foreign lane those are two different segments, and
 * "which turns could have cited this terminus and did not" is a question about
 * where the lane lives.
 */
export function collectTerminusSample(
  db: Database,
  segmentIds: readonly number[],
  downstreamLimit: number,
): { entries: LaneTerminusSampleEntry[]; closedLanesScanned: number } {
  const entries: LaneTerminusSampleEntry[] = [];
  const seenLanes = new Set<string>();
  let closedLanesScanned = 0;
  for (const segmentId of segmentIds) {
    const projection = loadLaneCheckScope(db, { kind: "segment", segmentId });
    const result = checkLanes(
      projection.turns,
      projection.edges,
      projection.outOfVocabularyEdges,
      projection.segmentFacts,
    );
    const addressOf = addressLookup(
      projection.turns
        .filter((turn) => turn.order !== undefined)
        .map((turn) => ({ id: turn.id, order: turn.order! })),
    );
    const epochOf = new Map(projection.turns.map((turn) => [turn.id, turn.createdAtEpoch]));
    for (const component of result.components) {
      const citedness = component.terminusCitedness;
      if (citedness === null) continue;
      const laneIdentity = laneToken(component.key.segment, component.key.tag);
      if (seenLanes.has(laneIdentity)) continue;
      seenLanes.add(laneIdentity);
      closedLanesScanned += 1;
      if (citedness.citedBy.length > 0) continue;
      const epoch = epochOf.get(citedness.terminus);
      const laneSegment = component.key.segment;
      const downstream =
        epoch === undefined || laneSegment === DEFAULT_SEGMENT
          ? []
          : loadDownstreamTurns(db, Number(laneSegment), epoch, downstreamLimit);
      const downstreamAddress = addressLookup(downstream);
      entries.push({
        lane: formatLaneKey(component.key),
        terminus: addressOf(citedness.terminus),
        terminusId: citedness.terminus,
        downstream: downstream.map((turn) => downstreamAddress(turn.id)),
      });
    }
  }
  return { entries, closedLanesScanned };
}

// ------------------------------------------------------------------ render

/**
 * THE CAUSAL MATRIX (ticket 13's third checkbox) — in the tool's OWN output,
 * not only in the ticket, because the ticket is not what a reader has open when
 * a report reads as noise six months from now.
 */
const CAUSAL_MATRIX: readonly string[] = [
  "## Read this first -- the judging order these controls exist to enforce",
  "",
  "A checker report that reads as noise has TWO possible causes and, without the",
  "controls below, no way to tell them apart: the DEFINITION is wrong, or the",
  "ATTRIBUTION is simply not done yet. Judge in this order:",
  "",
  "  1. C1-C3 are not all 0",
  "       -> the attribution is UNFINISHED, and no checker report is yet evidence",
  "          about anything. An unsettled edge takes part in NO lane computation,",
  "          so \"the model is wrong\" and \"nobody has settled these rows\" print the",
  "          same page. Settle, then re-run.",
  "  2. C1-C3 are 0, and a finding's ATTRIBUTION is wrong",
  "       -> fix the labels -- the turn's own tags, the edge's two side tags -- and",
  "          re-run. The definition was never in question. (Each finding below",
  "          carries the source address and BOTH side LaneKeys precisely so this",
  "          judgement can be made without opening the database.)",
  "  3. C1-C3 are 0, the attribution is RIGHT, and coupling/connectivity still",
  "     misreport it",
  "       -> the DEFINITION is wrong. This is the ONLY branch that is evidence",
  "          against the model, and it is what this batch is looking for.",
  "",
  "C4 sets no threshold, deliberately: an accuracy is a description of how far the",
  "attribution has got, never a bar it must clear.",
];

/**
 * The third-cause warning requirement 4 exists for. It is printed with the
 * sample, every time, because the failure mode it guards against is a reader
 * taking an empty `citedBy` list as a verdict on the connectivity rule.
 */
const TERMINUS_CAVEAT: readonly string[] = [
  '## Terminus sample -- "a closed lane\'s terminus is cited by nobody" has THREE causes',
  "",
  "  (a) the convergence really did go unused;",
  "  (b) the attribution is wrong -- the citing turn belongs to this lane after all,",
  "      or an edge's head tag names the wrong one;",
  "  (c) THE CITING EDGE WAS NEVER WRITTEN. The outside DID refer to the terminus,",
  "      in prose, and no edge records it.",
  "",
  "(c) is invisible to every graph, so the downstream turns' addresses are listed",
  "below (and exported by --export) for a human to READ. Until that reading is done,",
  "THIS REPORT ALONE MUST NOT BE USED TO REJECT THE CONNECTIVITY RULE.",
];

function renderControl(control: LaneControl): string[] {
  const lines: string[] = [];
  lines.push("## " + control.id + " -- " + control.title + "   [target: " + control.target + "]");
  if (control.measured === null) {
    lines.push("CANNOT MEASURE, because " + control.unmeasurableReason + ".");
    lines.push("(This is NOT zero. Nothing was counted.)");
    return lines;
  }
  lines.push("measured: " + control.measured + " " + control.unit);
  for (const line of control.context) {
    lines.push("  " + line);
  }
  if (control.findingCount === 0) {
    lines.push("  (no findings)");
    return lines;
  }
  lines.push(
    "  " +
      control.findingCount +
      " finding(s)" +
      (control.findingCount > control.findings.length
        ? " (showing first " + control.findings.length + ")"
        : "") +
      ":",
  );
  for (const finding of control.findings) {
    lines.push("    " + finding.address);
    lines.push(
      "      tail " + finding.tailLane + "  head " + finding.headLane + " -- " + finding.note,
    );
  }
  return lines;
}

export function renderLaneControlsReport(report: LaneControlsReport): string {
  const lines: string[] = [];
  lines.push("# Lane attribution controls -- lane-model-v12 ticket 13");
  lines.push("database: " + report.databasePath + " (opened READ-ONLY)");
  if (report.edgeCount === null) {
    lines.push("domain: NOT LOADED -- see the reasons under each control");
  } else {
    const provenance = Object.entries(report.provenanceCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => name + " " + count)
      .join(", ");
    lines.push(
      "domain: " +
        report.edgeCount +
        " live relation-carrying turn->turn edge(s)" +
        (provenance === "" ? "" : " (" + provenance + ")"),
    );
  }
  lines.push("");
  lines.push(...CAUSAL_MATRIX);
  for (const control of report.controls) {
    lines.push("");
    lines.push(...renderControl(control));
  }
  lines.push("");
  lines.push(...TERMINUS_CAVEAT);
  lines.push("");
  if (report.terminus.unmeasurableReason !== null) {
    lines.push("CANNOT MEASURE, because " + report.terminus.unmeasurableReason + ".");
    lines.push("(This is NOT zero. Nothing was scanned.)");
  } else if (report.terminus.entryCount === 0) {
    lines.push(
      "0 of " + report.terminus.closedLanesScanned + " closed lane(s) have an uncited terminus.",
    );
  } else {
    lines.push(
      report.terminus.entryCount +
        " of " +
        report.terminus.closedLanesScanned +
        " closed lane(s) have a terminus nobody outside cites" +
        (report.terminus.entryCount > report.terminus.entries.length
          ? " (showing first " + report.terminus.entries.length + ")"
          : "") +
        ":",
    );
    for (const entry of report.terminus.entries) {
      lines.push("  Lane " + entry.lane + " -- terminus " + entry.terminus);
      lines.push(
        "    downstream turns to read: " +
          (entry.downstream.length === 0 ? "(none in this segment)" : entry.downstream.join(", ")),
      );
    }
  }
  lines.push("");
  lines.push("## Sample artifacts");
  if (report.sample === null) {
    lines.push("gold sample: NOT DRAWN -- see C4's reason above");
  } else {
    lines.push(
      "gold sample: " +
        report.sample.rows.length +
        " row(s) across " +
        report.sample.strata +
        " stratum/strata, stratified by " +
        report.sample.stratifiedBy +
        ", " +
        report.sample.perStratum +
        " per stratum",
    );
  }
  lines.push(
    report.exportPath === null
      ? "export: none (pass --export <file> to write the gold sample and the downstream addresses)"
      : "export: " + report.exportPath,
  );
  if (report.gradedPath !== null) {
    lines.push("graded input: " + report.gradedPath);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------- CLI

const USAGE = `lane-controls -- read-only attribution controls (lane-model-v12 ticket 13)

Answers "is the attribution finished?" BEFORE anyone judges the checker's
reports. Opens the database READ-ONLY; it never writes to the database, and the
only file it writes at all is the one --export names.

Usage:
  bun scripts/lane-controls.ts [--db <path>] [--segment <id>]...
                               [--sample <n>] [--export <file>] [--graded <file>]
                               [--downstream <n>] [--findings <n>]

Options:
  --db <path>       database file (default: the configured production DB)
  --segment <id>    restrict every control to this segment (repeatable;
                    default: the whole database)
  --sample <n>      gold-sample rows drawn per (relation x lane) stratum (default 2)
  --export <file>   write the drawn gold sample AND the terminus sample's
                    downstream addresses to this JSON file
  --graded <file>   an exported sample with its verdicts filled in
                    ("correct"/"wrong"/"unsure"). WITHOUT it, control 4 reports
                    "cannot measure" -- never an accuracy of 0
  --downstream <n>  downstream turns exported per uncited terminus (default 10)
  --findings <n>    findings printed per control (default 20; the count line
                    always states the true total)
  --help            show this message`;

export interface LaneControlsCliOptions {
  dbPath?: string;
  segmentIds: number[];
  perStratum: number;
  exportPath?: string;
  gradedPath?: string;
  downstreamLimit: number;
  findingLimit: number;
  help: boolean;
}

export interface LaneControlsCliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_IO: LaneControlsCliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

/**
 * The opener `runLaneControlsCli` uses when a caller supplies none — the lane
 * checker CLI's own hard-`readonly` opener, IMPORTED rather than re-declared.
 *
 * It is a named export purely so a test can pin the BINDING (`expect(
 * DEFAULT_LANE_CONTROLS_OPENER).toBe(openReadOnlyLaneCheckDatabase)`): a
 * default parameter cannot be inspected, so without this, swapping the default
 * for a writable `new Database(path)` would redden no test — every other
 * read-only proof here would keep passing, since this tool issues no writes
 * whatever handle it is given.
 */
export const DEFAULT_LANE_CONTROLS_OPENER: OpenLaneCheckDatabase = openReadOnlyLaneCheckDatabase;

function positiveInteger(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/** Throws on any malformed argument; never returns a half-filled option set. */
export function parseLaneControlsArguments(argv: readonly string[]): LaneControlsCliOptions {
  const options: LaneControlsCliOptions = {
    segmentIds: [],
    perStratum: 2,
    downstreamLimit: 10,
    findingLimit: 20,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const next = argv[index + 1];
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--db":
        if (next === undefined) throw new Error("--db requires a value");
        options.dbPath = next;
        index += 1;
        break;
      case "--segment": {
        if (next === undefined) throw new Error("--segment requires a value");
        const segmentId = Number(next);
        if (!Number.isInteger(segmentId)) {
          throw new Error(`--segment must be a segment id, got "${next}"`);
        }
        options.segmentIds.push(segmentId);
        index += 1;
        break;
      }
      case "--sample":
        if (next === undefined) throw new Error("--sample requires a value");
        options.perStratum = positiveInteger("--sample", next);
        index += 1;
        break;
      case "--export":
        if (next === undefined) throw new Error("--export requires a value");
        options.exportPath = next;
        index += 1;
        break;
      case "--graded":
        if (next === undefined) throw new Error("--graded requires a value");
        options.gradedPath = next;
        index += 1;
        break;
      case "--downstream":
        if (next === undefined) throw new Error("--downstream requires a value");
        options.downstreamLimit = positiveInteger("--downstream", next);
        index += 1;
        break;
      case "--findings":
        if (next === undefined) throw new Error("--findings requires a value");
        options.findingLimit = positiveInteger("--findings", next);
        index += 1;
        break;
      default:
        throw new Error(`unrecognized argument "${flag}"`);
    }
  }
  return options;
}

/**
 * Read a `--graded` file. Accepts BOTH shapes this tool can produce — the
 * `--export` bundle (`{ goldSample: { rows } }`) and a bare `LaneGoldSample`
 * (`{ rows }`) — because a grader who splits the bundle by hand has done
 * nothing wrong and should not lose their work to a shape check.
 */
export function readGradedSample(text: string): LaneGoldSampleRow[] {
  const parsed = JSON.parse(text) as unknown;
  const container =
    parsed !== null && typeof parsed === "object" && "goldSample" in parsed
      ? (parsed as { goldSample: unknown }).goldSample
      : parsed;
  if (
    container === null ||
    typeof container !== "object" ||
    !Array.isArray((container as { rows?: unknown }).rows)
  ) {
    throw new Error(
      "a graded sample must be the exported bundle or a bare gold sample -- neither has a `rows` array here",
    );
  }
  return (container as { rows: LaneGoldSampleRow[] }).rows;
}

export function runLaneControlsCli(
  argv: readonly string[],
  io: LaneControlsCliIo = DEFAULT_IO,
  openDb: OpenLaneCheckDatabase = DEFAULT_LANE_CONTROLS_OPENER,
): number {
  let options: LaneControlsCliOptions;
  try {
    options = parseLaneControlsArguments(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("");
    io.stderr(USAGE);
    return 1;
  }
  if (options.help) {
    io.stdout(USAGE);
    return 0;
  }

  let gradedRows: LaneGoldSampleRow[] | null = null;
  if (options.gradedPath !== undefined) {
    try {
      gradedRows = readGradedSample(readFileSync(options.gradedPath, "utf8"));
    } catch (error) {
      io.stderr(
        "could not read --graded " +
          options.gradedPath +
          ": " +
          (error instanceof Error ? error.message : String(error)),
      );
      return 1;
    }
  }

  const databasePath = resolveDatabasePath(options.dbPath);
  const db = openDb(databasePath);
  try {
    const report = buildLaneControlsReport(db, databasePath, options, gradedRows);
    if (options.exportPath !== undefined) {
      writeFileSync(
        options.exportPath,
        JSON.stringify(
          {
            kind: "lane-model-v12 attribution controls export",
            database: databasePath,
            goldSample: report.sample,
            terminusSample: report.terminus.entries,
          },
          null,
          2,
        ) + "\n",
      );
    }
    io.stdout(renderLaneControlsReport(report));
    return 0;
  } finally {
    db.close();
  }
}

/**
 * The whole measurement, as data. Separated from `runLaneControlsCli` so a test
 * can assert the numbers and the finding shapes without going through argv,
 * stdout or the filesystem.
 */
export function buildLaneControlsReport(
  db: Database,
  databasePath: string,
  options: LaneControlsCliOptions,
  gradedRows: readonly LaneGoldSampleRow[] | null,
): LaneControlsReport {
  const capability = loadLaneControlCapability(db);
  const segmentFilter = new Set(options.segmentIds.map((id) => String(id)));
  const inScope = (edge: LaneControlEdge): boolean =>
    segmentFilter.size === 0 ||
    segmentFilter.has(edge.citingSegment) ||
    segmentFilter.has(edge.citedSegment);

  // The capability probe gates the LOAD, not just the verdicts: every control
  // query names `tail_tag`, so on an unmigrated database there is nothing to
  // read and every control reports its reason instead of a number.
  const edges = capability.edgeSideTagColumns ? loadLaneControlEdges(db).filter(inScope) : [];
  const provenanceCounts: Record<string, number> = {};
  for (const edge of edges) {
    provenanceCounts[edge.provenance] = (provenanceCounts[edge.provenance] ?? 0) + 1;
  }
  const registry = capability.laneRegistry ? loadDeclaredLaneRegistry(db) : new Map<string, Set<string>>();
  const endpointIds = [...new Set(edges.flatMap((edge) => [edge.citingId, edge.citedId]))];
  const laneTagsByTurn = capability.edgeSideTagColumns
    ? loadLaneTagsForTurns(db, endpointIds)
    : new Map<number, string[]>();
  const addressOf = addressLookupForEdges(edges);

  const sample = capability.edgeSideTagColumns
    ? drawGoldSample(edges, options.perStratum, addressOf)
    : null;
  const liveIdentities = capability.edgeSideTagColumns
    ? new Set(edges.map((edge) => goldEdgeIdentity(edge)))
    : null;

  const controls: LaneControl[] = [
    controlUnsettledSides(edges, capability, options.findingLimit),
    controlSideAttribution(edges, registry, capability, options.findingLimit),
    controlLanelessNodes(edges, laneTagsByTurn, capability, options.findingLimit),
    controlGoldSample(sample, gradedRows, liveIdentities, capability, options.findingLimit),
  ];

  const terminusReason = missingCapabilityReason(capability, [
    "edgeSideTagColumns",
    "edgeSideTagIndex",
    "laneRegistry",
  ]);
  let terminusEntries: LaneTerminusSampleEntry[] = [];
  let closedLanesScanned = 0;
  if (terminusReason === null) {
    const segmentIds =
      options.segmentIds.length > 0 ? options.segmentIds : loadSegmentsWithDeclaredLanes(db);
    const collected = collectTerminusSample(db, segmentIds, options.downstreamLimit);
    terminusEntries = collected.entries;
    closedLanesScanned = collected.closedLanesScanned;
  }

  return {
    databasePath,
    capability,
    edgeCount: capability.edgeSideTagColumns ? edges.length : null,
    provenanceCounts,
    controls,
    terminus: {
      entries: terminusEntries.slice(0, options.findingLimit),
      entryCount: terminusEntries.length,
      closedLanesScanned,
      unmeasurableReason: terminusReason,
    },
    sample,
    exportPath: options.exportPath ?? null,
    gradedPath: options.gradedPath ?? null,
  };
}
