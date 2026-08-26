import type {
  LaneBypassCandidate,
  LaneCheckerError,
  LaneCheckerResult,
  LaneComponentReport,
  LaneCouplingReport,
  LaneCrossSegmentWarning,
  LaneErrorClass,
  LaneMember,
  LaneOutOfVocabularyEdge,
  LaneProliferationWarning,
  LaneState,
  LaneStatsReport,
  LaneTimeOrderViolation,
  LaneUnattributedCluster,
} from "./lane-checker";
import {
  DEFAULT_SEGMENT,
  laneToken,
  UNSETTLED_LANE_TAG,
  type LaneKey,
  type LaneTurnInput,
} from "./lane-interpretation";

/**
 * The lane checker's two renderers (rubric-v10 ticket 06). Both consume
 * ONLY `LaneCheckerResult` (the pure core's own typed output,
 * `shared/lane-checker.ts`) - neither derives, filters, or re-interprets a
 * single fact. A semantic change in the core (a new report field, a
 * different pinned number) needs no edit here beyond, at most, printing a
 * field that already exists on the typed result; nothing in this file
 * re-runs `deriveLaneInterpretation` or touches `LaneEdgeInput`/
 * `LaneTurnInput` directly. That is what requirement 4 ("a semantic change
 * in the core must propagate with zero renderer edits") is asking for, and
 * what the settlement-tool/CLI split below both honour: they differ only in
 * WHICH of these two functions they call, never in what data reaches them.
 *
 *   - `renderLaneCheckerReports` - the compact numeric prose. Both surfaces
 *     use it: the settlement tool returns exactly this (requirement 3: "NO
 *     digraph"), and the CLI prints it ahead of the digraph.
 *   - `renderLaneDigraph` - the git-log-graph-style text digraph
 *     (requirement 2). CLI-only, per the spec's own "digraph rendering is
 *     human/CLI-only; agents receive the numeric reports."
 *
 * ## The error/warning split (tag-mandate tickets 03/04, narrowed by v12 ticket 11)
 *
 * Both surfaces lead with an ERRORS block — states the grammar forbids, E3-E4,
 * each naming its ANCHOR turn — visually separated from everything below it,
 * which is the WARNING side (connectivity, coupling, bypass candidates,
 * time-order, attribution, and the stock facts no report admits).
 *
 * There is no standalone "## Vocabulary conformance" section: the TYPE half of
 * that fact block is error class E3 and prints in the ERRORS block, and the
 * EDGE half (an out-of-vocabulary relation word) prints as one line in the
 * trailing stock-warnings section — ticket 11 deleted error class E2 while
 * keeping the fact, because the only database that can still hold such a row is
 * one no writer has migrated (`shared/lane-checker.ts`'s own header).
 *
 * The two surfaces differ on ONE thing beyond the anchor spelling — whether
 * the error list is capped (peer round T1466, finding P2-8):
 *
 *   - `renderLaneCheckerReports` prints EVERY instance. This is the render
 *     the settlement `lane_check` tool returns, and the commit gate judges
 *     the same uncapped `result.errors` list — a cap here would break the
 *     "the tool shows you exactly what the gate will refuse on" contract the
 *     moment a window carries more errors than the cap, leaving an agent
 *     repairing an invisible remainder it was never shown.
 *   - `renderLaneDigraph` (CLI-only, human-read, column-truncated anyway)
 *     keeps `MAX_ERROR_RENDER_ENTRIES` with its true-total count line: its
 *     reader can re-run the check, and its output is a picture rather than a
 *     work list.
 *
 * ## Address form (floor-and-render-fidelity ticket 03, user ruling
 * S15069/T1482)
 *
 * EVERY turn id this file prints — anchors, edge endpoints, error subjects,
 * declaration/terminus/coverage facts, digraph member labels — routes
 * through `formatTurnRef`, the ONE id -> `S<session>/T<prompt>` formatter.
 * Internal DB ids never reach a reader as bare `T<dbid>` text; the CLI's own
 * digraph labels are no exception (its own node IDENTITIES — the numeric
 * comparisons `errorClassesByAnchor`/`findingTurnIds`/the crossing-lane scan
 * use internally — may and do stay internal, since none of that is ever
 * printed). A caller with no addresses map (a hand-built fixture with no
 * `order`) falls back to the bare `T<dbid>` form — a marked last resort, not
 * a silently-accepted default: `lane_check`'s own settlement caller and the
 * CLI both always build one from the SAME projection they just loaded
 * (`buildLaneAnchorAddresses`), so the fallback is unreachable on any real
 * scope and exists only for a turn genuinely outside the projection (a
 * loader bug post-widening) or a test fixture that never populated `order`.
 */

/** A segment in the reader's own vocabulary — `E<n>`, or the word "default" for the homeless scope. The one spelling both `formatLaneKey` and D9's per-segment proliferation line use. */
function formatSegment(segment: string): string {
  return segment === DEFAULT_SEGMENT ? "default" : "E" + segment;
}

/**
 * `{tag}` (D5, v11: a lane is one tag, not a set) — the braces stay as the
 * reader's visual cue "this is a lane identifier", even though there is never
 * more than one tag inside them now.
 *
 * EXPORTED for the attribution controls (`src/cli/lane-controls-cli.ts`, ticket
 * 13), whose every finding must name both side LaneKeys: a second spelling of
 * the same identifier would let a reader compare a control's finding against a
 * checker report and see two different-looking names for one lane.
 */
export function formatLaneKey(key: LaneKey): string {
  return formatSegment(key.segment) + ":{" + key.tag + "}";
}

/**
 * ONE SIDE of an edge as a lane identifier (ticket 13). The `''` sentinel
 * prints as `<unsettled>` rather than an empty brace pair: spec D1 makes `''`
 * the ABSENCE of a lane, and `E60:{}` reads like a lane whose tag is the empty
 * word — which is exactly the confusion the sentinel convention already costs
 * every reader once.
 */
export function formatLaneSide(segment: string, tag: string): string {
  if (tag === UNSETTLED_LANE_TAG) {
    return formatSegment(segment) + ":<unsettled>";
  }
  return formatLaneKey({ segment, tag });
}

function formatMembers(members: readonly LaneMember[]): string {
  return members.map((member) => String(member.id)).join(", ");
}

/**
 * Turn id -> `S<session>/T<prompt>`, built from the SAME projection turns the
 * checker was run over (tag-mandate ticket 06).
 *
 * `LaneTurnInput.order` is the `[session_id, prompt_number]` tuple
 * `db/lane-checker-load.ts` fills for every turn it loads, so the address is
 * read straight off the input the checker already consumed — this module
 * derives nothing and queries nothing, exactly as its header requires. A turn
 * without an `order` (a hand-built fixture) contributes no entry and its
 * references keep printing the bare row id.
 */
export type LaneAnchorAddresses = ReadonlyMap<number, string>;

export function buildLaneAnchorAddresses(
  turns: readonly LaneTurnInput[],
): LaneAnchorAddresses {
  const addresses = new Map<number, string>();
  for (const turn of turns) {
    if (turn.order) {
      addresses.set(turn.id, "S" + turn.order[0] + "/T" + turn.order[1]);
    }
  }
  return addresses;
}

/**
 * The ONE id -> reader-vocabulary formatter every position in this file
 * routes through (floor-and-render-fidelity ticket 03): an agent repairs
 * through `S<session>/T<prompt>` addresses and cannot type a `turns.id` into
 * any tool, so a settlement-facing report that printed the row id would name
 * a row the reader has no way to act on. Falls back to the bare id when the
 * caller supplied no addresses (the CLI/console did not build one — a hand
 * fixture, say) or when this particular turn was not in the projection the
 * map was built from.
 */
function formatTurnRef(turnId: number, addresses: LaneAnchorAddresses | undefined): string {
  return addresses?.get(turnId) ?? "T" + turnId;
}

/** Comma-joined turn-id list, each element through `formatTurnRef` — `renderStatsReport`'s coverage line, an island's members, a path's starts/fork/join nodes, a folded path's citing turns. */
function formatTurnRefList(
  turnIds: readonly number[],
  addresses: LaneAnchorAddresses | undefined,
): string {
  return turnIds.map((id) => formatTurnRef(id, addresses)).join(",");
}

/**
 * The TWO-state reading (milestone-election spec, ticket 04) — replaces the
 * raw `declaration.state` word that used to render here, which
 * `lane-interpretation.ts`'s `deriveLaneStates` doc names as the wrong axis to
 * show: a lane that kept living past its own declaration still reports
 * `declaration.state === "declared"` even though it is actually open. `state`
 * (`LaneStatsReport.state`, consumed straight from that helper) is the
 * corrected reading.
 *
 * lane-model-v12 ticket 04: the two REFINEMENTS this line used to print are
 * deleted with the concepts behind them. A closed lane no longer prints a
 * second qualifying word (that verdict read a per-node status the model no
 * longer has), and an open lane no longer names a most-recent declaring turn
 * (that seat does not exist). Closed prints "closed"; open prints "open".
 */
function formatLaneState(state: LaneState): string {
  return state.closure === "closed" ? "closed" : "open";
}

function renderStatsReport(lane: LaneStatsReport, addresses?: LaneAnchorAddresses): string[] {
  const lines: string[] = [];
  lines.push("Lane " + formatLaneKey(lane.key) + " - phases: " + (lane.phases.join(",") || "(none)"));
  lines.push("  members: " + formatMembers(lane.members));
  const edgeCounts = Object.entries(lane.edgeCountsByRelation)
    .map(([relation, count]) => relation + "=" + count)
    .join(" ");
  lines.push("  edges: " + (edgeCounts || "(none)"));
  // Closure, and the terminus when one exists. The `[last event T<n>]` clause
  // that used to trail this line is DELETED with `declaration.latestEventTurn`
  // itself: it was v11's "freshest EDGE activity", a quantity only the
  // override-reopening reducer ever needed, and printing it beside a closure
  // that reads MEMBERSHIP taught two different notions of "latest" on one
  // line. `lane.members`/`state` carry what a reader of this report needs; a
  // latest-internal-edge display, if ever wanted, is a presentational
  // derivation of its own and does not belong in declaration state.
  lines.push(
    "  declaration: " +
      formatLaneState(lane.state) +
      (lane.declaration.terminus !== null
        ? " (terminus " + formatTurnRef(lane.declaration.terminus, addresses) + ")"
        : ""),
  );
  const grounds = lane.citedness.groundsFromNonMembers.map(
    (fact) => formatTurnRef(fact.citingId, addresses) + "->" + formatTurnRef(fact.citedId, addresses),
  );
  const used = lane.citedness.usedFromNonMembers.map(
    (fact) => formatTurnRef(fact.citingId, addresses) + "->" + formatTurnRef(fact.citedId, addresses),
  );
  const testimony = lane.citedness.testimonyFromNonMembers.map(
    (fact) =>
      formatTurnRef(fact.citingId, addresses) +
      " " +
      fact.relation +
      " " +
      formatTurnRef(fact.citedId, addresses),
  );
  lines.push(
    "  cited from outside: grounds[" +
      (grounds.join(", ") || "-") +
      "] used[" +
      (used.join(", ") || "-") +
      "] testimony[" +
      (testimony.join(", ") || "-") +
      "]",
  );
  lines.push(
    "  coverage: " +
      lane.coverage.status +
      (lane.coverage.missingTurnIds.length > 0
        ? " (missing: " + formatTurnRefList(lane.coverage.missingTurnIds, addresses) + ")"
        : ""),
  );
  return lines;
}

/**
 * Report 2, retargeted by v12 ticket 11: the lane's own members partitioned by
 * the lane's OWN claiming edges, plus the closed-terminus line.
 *
 * The terminus line prints for a CLOSED lane only (`terminusCitedness` is
 * `null` otherwise) and states the negative case in words rather than as an
 * empty list — "nobody outside cites the convergence" is the finding, and a
 * bare `[]` reads as an absent measurement.
 */
function renderComponentReport(
  component: LaneComponentReport,
  addresses?: LaneAnchorAddresses,
): string[] {
  const lines: string[] = [];
  const health = component.componentCount === 1 ? "healthy" : "SEVERED";
  lines.push(
    "Lane " + formatLaneKey(component.key) + " - components: " + component.componentCount + " (" + health + ")",
  );
  for (const island of component.islands) {
    lines.push(
      "  island@" +
        formatTurnRef(island.representative, addresses) +
        ": " +
        formatTurnRefList(island.memberIds, addresses),
    );
  }
  const citedness = component.terminusCitedness;
  if (citedness) {
    lines.push(
      "  terminus " +
        formatTurnRef(citedness.terminus, addresses) +
        (citedness.citedBy.length > 0
          ? " cited from outside: " + formatTurnRefList(citedness.citedBy, addresses)
          : " is NOT cited from outside the lane"),
    );
  }
  return lines;
}

/**
 * Report 3 (v12 ticket 11), in the deleted shared-components report's own
 * section: one line per lane, three group counts, no verdict word anywhere on
 * it. The group's relation words are printed rather than a coined group name,
 * so the reader never has to look up what a bucket contains.
 */
function renderCouplingReport(report: LaneCouplingReport): string {
  return (
    "Lane " +
    formatLaneKey(report.key) +
    " - cross-lane edges: " +
    report.groups
      .map((group) => group.relations.join("/") + "=" + group.count)
      .join("  ")
  );
}

/**
 * Report 4b (v12 ticket 11): a direct edge and the longer route that also joins
 * its two ends. Both are printed and NEITHER is marked for deletion — the
 * section heading carries that reasoning once, so each line stays a fact.
 */
function renderBypassCandidate(
  candidate: LaneBypassCandidate,
  addresses?: LaneAnchorAddresses,
): string {
  return (
    "  " +
    formatTurnRef(candidate.citingId, addresses) +
    " -> " +
    formatTurnRef(candidate.citedId, addresses) +
    " (" +
    candidate.relations.join(",") +
    ") -- also joined by " +
    candidate.alternativePath.map((id) => formatTurnRef(id, addresses)).join(" -> ")
  );
}

/** One pre-migration stock row whose relation word is outside the seven — a WARNING since v12 ticket 11 deleted error class E2 (the checker's own header carries the reasoning). */
function renderOutOfVocabularyEdge(
  edge: LaneOutOfVocabularyEdge,
  addresses?: LaneAnchorAddresses,
): string {
  return "  " + renderEdgeArrow(edge.citingId, edge.relation, edge.citedId, addresses);
}

function renderTimeOrderViolation(
  violation: LaneTimeOrderViolation,
  addresses?: LaneAnchorAddresses,
): string {
  const tags = violation.tags.length > 0 ? " {" + violation.tags.join(",") + "}" : "";
  return (
    "  " +
    formatTurnRef(violation.citingId, addresses) +
    " -> " +
    formatTurnRef(violation.citedId, addresses) +
    " (" +
    violation.relation +
    tags +
    ")"
  );
}

/**
 * D9 warning 1, retargeted by v12 ticket 11: one cluster of turns joined by
 * edges with NO lane on either side. `turnCount` is the TRUE size — the number
 * the 4+ boundary was judged on — while `turnIds` is the core's own capped
 * list, so a large cluster prints its head and says so rather than dumping a
 * segment.
 *
 * The teaching half of the line is deliberate: an agent reading this must know
 * it is being shown settlement DEBT (rows nobody has attributed yet), not a
 * defect of the turns themselves, and that the repair is a two-sided tag on the
 * edges, never a rewrite of the turns.
 */
function renderUnattributedCluster(
  cluster: LaneUnattributedCluster,
  addresses?: LaneAnchorAddresses,
): string {
  return (
    "  " +
    cluster.turnCount +
    " turns joined by edges with no lane on either side: " +
    formatTurnRefList(cluster.turnIds, addresses) +
    cappedCountSuffix(cluster.turnCount, cluster.turnIds.length)
  );
}

/** A whole number prints bare; a fractional allowance prints to two places (the ratio line is read, not parsed). */
function formatAllowance(allowance: number): string {
  return Number.isInteger(allowance) ? String(allowance) : allowance.toFixed(2);
}

/**
 * D9 warning 2: one over-the-line segment, naming BOTH counts (the ticket's
 * own requirement) plus the line they were judged against, so a reader can
 * see how far over it is without recomputing `max(1, 0.05 × members)`.
 *
 * Ticket 14: when the count includes lanes with NO live member, they are
 * NAMED on a second line. They are counted in the numerator like any other
 * declared lane (`LaneSegmentFacts.emptyLaneTags` carries that rule) — this
 * line is what keeps that from being a silent inflation, since these are
 * exactly the lanes a reader can `undeclare` to get back under the line.
 */
function renderLaneProliferation(warning: LaneProliferationWarning): string {
  const head =
    "  " +
    formatSegment(warning.segment) +
    ": " +
    warning.declaredLaneCount +
    " declared lanes over " +
    warning.memberTurnCount +
    " member turns -- above max(1, 0.05 x " +
    warning.memberTurnCount +
    ") = " +
    formatAllowance(warning.allowance);
  const emptyLaneTags = warning.emptyLaneTags ?? [];
  if (emptyLaneTags.length === 0) {
    return head;
  }
  return (
    head +
    "\n    " +
    emptyLaneTags.length +
    " of them have no live member (undeclare removes them): " +
    emptyLaneTags.map((tag) => "#" + tag).join(", ")
  );
}

/**
 * How many error instances the CLI DIGRAPH prints (peer round T1466, finding
 * P2-8 — the settlement prose render above it is uncapped). Higher than the
 * fact lists' own cap: an error is work the reader must actually do, so a
 * longer list earns its bytes.
 */
const MAX_ERROR_RENDER_ENTRIES = 50;

/**
 * How many report-4b bypass candidates either surface prints. A candidate is a
 * QUESTION for a human ("do these two routes say the same thing?"), not work
 * the gate refuses on, so both surfaces cap it and both state the true total —
 * unlike the error list, where the settlement render must stay uncapped.
 */
const MAX_BYPASS_RENDER_ENTRIES = 20;

/** `count` vs a possibly-capped printed list — the "(showing first N of count)" suffix. */
function cappedCountSuffix(count: number, shown: number): string {
  return count > shown ? " (showing first " + shown + ")" : "";
}

function renderEdgeArrow(
  citingId: number,
  relation: string,
  citedId: number,
  addresses?: LaneAnchorAddresses,
): string {
  return formatTurnRef(citingId, addresses) + " --" + relation + "--> " + formatTurnRef(citedId, addresses);
}

/**
 * One line per error instance, ALWAYS leading with its class and its ANCHOR
 * turn — the anchor is what the commit gate scopes by, so a reader deciding
 * "is this mine to fix" must not have to infer it from the endpoints.
 */
function renderLaneError(
  error: LaneCheckerError,
  addresses?: LaneAnchorAddresses,
): string {
  const head = "  [" + error.class + "] anchor " + formatTurnRef(error.anchorId, addresses) + " -- ";
  switch (error.class) {
    // E1 (an untagged extends/narrows) is RETIRED with the tag mandate
    // (lane-declaration ticket 02); E2 (an out-of-vocabulary relation word) was
    // deleted as a CLASS by v12 ticket 11 and prints as a stock warning
    // instead. Neither has a case here, and neither is in the class union this
    // switch is exhaustive over.
    case "E3":
      return (
        head +
        (error.types.length === 0
          ? formatTurnRef(error.id, addresses) + " type: [] (empty)"
          : formatTurnRef(error.id, addresses) +
            " type: [" +
            error.types.join(",") +
            "] (outside vocabulary: " +
            error.outsideVocabulary.join(",") +
            ")")
      );
    case "E4":
      return (
        head +
        renderEdgeArrow(error.citingId, error.relation, error.citedId, addresses) +
        " {" +
        error.tags.join(",") +
        "}: " +
        error.missing
          .map((miss) => '"' + miss.tag + "\" missing from the " + miss.endpoint + " turn's tags")
          .join("; ")
      );
  }
}

/**
 * The instance lines both surfaces print, identically formatted so the CLI's
 * digraph and the settlement text never describe one error two ways. The
 * COUNT line is each surface's own (the digraph folds it into its heading),
 * which is why this returns instances only.
 *
 * `limit` is the ONLY difference between the two callers (finding P2-8): the
 * settlement prose passes none and prints every instance the commit gate
 * judges; the CLI digraph passes `MAX_ERROR_RENDER_ENTRIES`.
 */
function errorInstanceLines(
  errors: readonly LaneCheckerError[],
  addresses?: LaneAnchorAddresses,
  limit?: number,
): string[] {
  const shown = limit === undefined ? errors : errors.slice(0, limit);
  return shown.map((error) => renderLaneError(error, addresses));
}

function renderCrossSegmentWarning(
  warning: LaneCrossSegmentWarning,
  addresses?: LaneAnchorAddresses,
): string {
  return (
    "⚠ " +
    formatTurnRef(warning.citingId, addresses) +
    "(" +
    warning.citingSegment +
    ") -> " +
    formatTurnRef(warning.citedId, addresses) +
    "(" +
    warning.citedSegment +
    ") {" +
    warning.tagSet.join(",") +
    "}"
  );
}

/**
 * The compact numeric reports, one section per report domain. No digraph -
 * this is exactly what `note-settlement-sdk-query.ts`'s `lane_check` tool
 * hands back to the settlement model (requirement 3), and what the CLI
 * prints ahead of its own digraph.
 *
 * `anchorAddresses` (tag-mandate ticket 06) is OPTIONAL by TYPE only, not by
 * an intended "some surfaces skip it" split any more (floor-and-render-
 * fidelity ticket 03 retired that split — the CLI and the console now build
 * and pass one too, from the same projection they just loaded, exactly like
 * the settlement tool always has). It changes how EVERY turn id in this
 * render is spelled: the settlement tool, the CLI, and the console all pass
 * the projection's own turns so every reference — anchors, edge endpoints,
 * declaration/coverage facts — prints as an address the agent can type into
 * `note`. Only a caller with no projection at all (a hand-built fixture)
 * legitimately omits it, and the bare-id fallback that produces is a marked
 * last resort, never the steady state on a real scope.
 */
export function renderLaneCheckerReports(
  result: LaneCheckerResult,
  anchorAddresses?: LaneAnchorAddresses,
): string {
  const sections: string[] = [];

  sections.push(
    "## ERRORS -- states the grammar forbids; commit refuses while one anchored in your writable scope remains",
  );
  // UNCAPPED (finding P2-8): this is the render the settlement `lane_check`
  // returns, and the commit gate judges the same list — every instance the
  // gate can refuse on must be visible here. `cappedCountSuffix` therefore
  // always yields "" on this surface; it is kept so the two renders share
  // one count-line shape.
  const shownErrors = errorInstanceLines(result.errors, anchorAddresses);
  if (result.errors.length === 0) {
    sections.push("(none)");
  } else {
    sections.push(
      result.errors.length + " error(s)" + cappedCountSuffix(result.errors.length, shownErrors.length),
    );
    sections.push(...shownErrors);
  }

  sections.push("");
  sections.push("## WARNINGS -- the three principles' facts below; aspirations, never enforced");

  sections.push("");
  sections.push("## Report 1 -- lane statistics");
  if (result.lanes.length === 0) {
    sections.push("(no lanes in scope)");
  } else {
    for (const lane of result.lanes) {
      sections.push(...renderStatsReport(lane, anchorAddresses));
    }
  }

  sections.push("");
  sections.push(
    "## Report 2 -- connectivity over each lane's OWN edges (provisional lanes, 0-1 members, are not judged)",
  );
  if (result.components.length === 0) {
    sections.push("(no lanes in scope)");
  } else {
    for (const component of result.components) {
      sections.push(...renderComponentReport(component, anchorAddresses));
    }
  }

  sections.push("");
  sections.push("## Report 3 -- cross-lane coupling (counts only; no threshold and no verdict)");
  if (result.coupling.length === 0) {
    sections.push("(no lanes in scope)");
  } else {
    for (const report of result.coupling) {
      sections.push(renderCouplingReport(report));
    }
  }

  sections.push("");
  sections.push(
    "## Report 4b -- structural bypass candidates (a direct edge and a longer route between the same two turns; which to keep depends on what each contributes, so nothing here is marked for deletion)",
  );
  if (result.bypassCandidates.length === 0) {
    sections.push("(none)");
  } else {
    const shownCandidates = result.bypassCandidates.slice(0, MAX_BYPASS_RENDER_ENTRIES);
    sections.push(
      result.bypassCandidates.length +
        " candidate(s)" +
        cappedCountSuffix(result.bypassCandidates.length, shownCandidates.length) +
        ":",
    );
    for (const candidate of shownCandidates) {
      sections.push(renderBypassCandidate(candidate, anchorAddresses));
    }
  }

  sections.push("");
  sections.push("## Report 4c -- time-order violations (the DAG guarantee)");
  if (result.timeOrderViolations.length === 0) {
    sections.push("(none)");
  } else {
    for (const violation of result.timeOrderViolations) {
      sections.push(renderTimeOrderViolation(violation, anchorAddresses));
    }
  }

  sections.push("");
  sections.push(
    "## Attribution -- unattributed clusters + lane proliferation (warnings; settlement's own debt, never enforced)",
  );
  if (result.unattributedClusters.count === 0) {
    sections.push("(no unattributed clusters)");
  } else {
    sections.push(
      result.unattributedClusters.count +
        " unattributed cluster(s) of 4+ turns" +
        cappedCountSuffix(result.unattributedClusters.count, result.unattributedClusters.entries.length) +
        ":",
    );
    for (const cluster of result.unattributedClusters.entries) {
      sections.push(renderUnattributedCluster(cluster, anchorAddresses));
    }
  }
  if (result.laneProliferation.length === 0) {
    sections.push("(no segment over its lane budget)");
  } else {
    sections.push(result.laneProliferation.length + " segment(s) over the lane budget:");
    for (const warning of result.laneProliferation) {
      sections.push(renderLaneProliferation(warning));
    }
  }

  sections.push("");
  sections.push("## Stock warnings -- rows that take part in no report");
  if (result.warnings.length === 0) {
    sections.push("(no cross-segment tagged edges)");
  } else {
    sections.push(result.warnings.length + " cross-segment tagged edge(s):");
    for (const warning of result.warnings) {
      sections.push(renderCrossSegmentWarning(warning, anchorAddresses));
    }
  }
  // The EDGE half of `vocabularyConformance` (v12 ticket 11): a relation word
  // outside the seven. No write path can create one, so this is pre-migration
  // stock and a WARNING, not error class E2 — but it must be SAID, because
  // `partitionEdgesByVocabulary` excludes these rows from every graph above and
  // a reader who was not told would see a silently under-reported scope.
  const outOfVocabulary = result.vocabularyConformance.outOfVocabularyEdges;
  if (outOfVocabulary.count === 0) {
    sections.push("(no out-of-vocabulary relations)");
  } else {
    sections.push(
      outOfVocabulary.count +
        " edge(s) whose relation is outside the seven-word vocabulary -- pre-migration stock, admitted to no graph" +
        cappedCountSuffix(outOfVocabulary.count, outOfVocabulary.entries.length) +
        ":",
    );
    for (const edge of outOfVocabulary.entries) {
      sections.push(renderOutOfVocabularyEdge(edge, anchorAddresses));
    }
  }

  return sections.join("\n");
}

// --------------------------------------------------------------- digraph --

const MAX_DIGRAPH_COLUMNS = 100;

/** lane-model-v12 ticket 04 deleted the third glyph (the overridden-node cross) along with node death itself — a member is a member. */
type DigraphGlyph = "member" | "terminus";

function glyphFor(kind: DigraphGlyph): string {
  if (kind === "terminus") return "◎"; // terminus
  return "●"; // member
}

const FINDING_GLYPH = "⚠"; // warning-side finding
const CROSSING_ARROW = "⇐"; // reference-line crossing
/** Error mark, ALWAYS followed by its bracketed class list — the bracket is what keeps the mark unmistakable in terminal fonts where the two cross glyphs are near-identical. */
const ERROR_GLYPH = "✗";

/** Anchor turn id -> the distinct error classes anchored there, ascending — the digraph's per-member mark, and the reason an anchor is DATA and not prose. */
function errorClassesByAnchor(errors: readonly LaneCheckerError[]): Map<number, LaneErrorClass[]> {
  const byAnchor = new Map<number, Set<LaneErrorClass>>();
  for (const error of errors) {
    let bucket = byAnchor.get(error.anchorId);
    if (bucket === undefined) {
      bucket = new Set();
      byAnchor.set(error.anchorId, bucket);
    }
    bucket.add(error.class);
  }
  return new Map([...byAnchor.entries()].map(([id, set]) => [id, [...set].sort()]));
}

/**
 * True when a lane member has a report-2 finding worth flagging: its lane is
 * SEVERED (more than one island), or it is the terminus of a closed lane
 * nothing outside cites.
 *
 * The report-4b half is gone with the path counts (v12 ticket 11): a bypass
 * candidate is a fact about an EDGE pair, and there is no member-level glyph
 * that could carry it honestly — marking the citing turn would read as "this
 * turn is defective" when the finding is that two routes exist.
 */
function findingTurnIds(result: LaneCheckerResult): Set<number> {
  const ids = new Set<number>();
  for (const component of result.components) {
    if (component.componentCount > 1) {
      for (const island of component.islands) {
        for (const id of island.memberIds) {
          ids.add(id);
        }
      }
    }
    const citedness = component.terminusCitedness;
    if (citedness && citedness.citedBy.length === 0) {
      ids.add(citedness.terminus);
    }
  }
  return ids;
}

function truncateToColumns(line: string): string {
  if (line.length <= MAX_DIGRAPH_COLUMNS) {
    return line;
  }
  return line.slice(0, MAX_DIGRAPH_COLUMNS - 3) + "...";
}

/** Segment + tag equality (D5, v11 — a lane's identity is one tag, not a set) — via `laneToken`'s own escaped join (round-4 review #6's collision-avoidance reasoning, still load-bearing). */
function sameLaneKey(a: LaneKey, b: LaneKey): boolean {
  return laneToken(a.segment, a.tag) === laneToken(b.segment, b.tag);
}

/**
 * The git-log-graph-style text digraph (requirement 2): turn order
 * top-down, one member per line, glyphed member (dot) / terminus (target),
 * plus a warning glyph for a report-2/4 finding. Deeper cross-lane crossings (a
 * member shared with another lane) render as a reference line ("see T... in
 * another lane") rather than a second branch column - this derives NOTHING:
 * every fact printed here already exists on `result`, read off report 1
 * (membership) and report 4 (terminus).
 *
 * CLI-only, per the spec's own "digraph rendering is human/CLI-only" -
 * `note-settlement-sdk-query.ts`'s `lane_check` tool never calls this.
 *
 * `addresses` (floor-and-render-fidelity ticket 03): every printed member
 * LABEL and the ERRORS block above the lane listing route through it, same
 * as `renderLaneCheckerReports`. What stays internal is the graph's own node
 * IDENTITY — `errorClassesByAnchor`/`findingTurnIds`/the same-lane/crossing
 * scan below all key their maps and sets by the bare numeric id, since none
 * of that keying is ever itself printed; only the text a member's line ends
 * up showing goes through `formatTurnRef`. The CLI is this function's one
 * caller and always builds `addresses` from the same projection it loaded —
 * omitting it (the bare-id fallback) is a test-fixture path only.
 *
 * Tag-mandate ticket 03: an ERRORS block leads, listing every instance with
 * its anchor, and each anchored LANE MEMBER additionally carries an inline
 * `✗[E2,...]` mark. The block is what makes the listing complete — an error
 * can anchor at a turn that is no lane's member at all (an untagged
 * extends/narrows forms no lane by construction, and a type error needs no
 * edge whatsoever), so the inline marks alone would silently hide exactly
 * the class of error this ticket exists to surface.
 */
export function renderLaneDigraph(result: LaneCheckerResult, addresses?: LaneAnchorAddresses): string {
  const flagged = findingTurnIds(result);
  const errorClasses = errorClassesByAnchor(result.errors);
  const lines: string[] = [];

  // CLI-only surface: the cap stays here (finding P2-8) — the count line
  // states the true total and this reader can re-run the check.
  const shownErrors = errorInstanceLines(result.errors, addresses, MAX_ERROR_RENDER_ENTRIES);
  lines.push(
    truncateToColumns(
      "ERRORS (" + result.errors.length + ")" + cappedCountSuffix(result.errors.length, shownErrors.length),
    ),
  );
  for (const line of shownErrors) {
    lines.push(truncateToColumns(line));
  }
  lines.push("");

  for (const lane of result.lanes) {
    // v12 ticket 11: the terminus comes off report 1's own state, which
    // `deriveLaneStates` already resolved — report 4b no longer carries one
    // (it is a per-segment edge report now, with no lane column at all).
    const terminus = lane.state.terminus;

    lines.push(truncateToColumns("Lane " + formatLaneKey(lane.key)));

    const seenElsewhere = new Set<number>();
    for (const otherLane of result.lanes) {
      if (sameLaneKey(otherLane.key, lane.key)) {
        continue;
      }
      for (const member of otherLane.members) {
        if (lane.members.some((own) => own.id === member.id)) {
          seenElsewhere.add(member.id);
        }
      }
    }

    for (const member of lane.members) {
      const kind: DigraphGlyph = member.id === terminus ? "terminus" : "member";
      const glyph = glyphFor(kind);
      const anchored = errorClasses.get(member.id);
      // Errors precede warnings on the line for the same reason they precede
      // them in the report: must-fix before should-consider.
      const errorMark = anchored ? " " + ERROR_GLYPH + "[" + anchored.join(",") + "]" : "";
      const flag = flagged.has(member.id) ? " " + FINDING_GLYPH : "";
      const crossing = seenElsewhere.has(member.id)
        ? " " + CROSSING_ARROW + " see " + formatTurnRef(member.id, addresses) + " in another lane"
        : "";
      lines.push(
        truncateToColumns("  " + glyph + " " + formatTurnRef(member.id, addresses) + errorMark + flag + crossing),
      );
    }
  }

  if (result.lanes.length === 0) {
    lines.push("(no lanes in scope)");
  }

  return lines.join("\n");
}
