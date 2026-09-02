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
import { estimateTokens } from "../utils/token-estimate";

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
 * Both surfaces lead with an ERRORS block — states the grammar forbids,
 * E3/E4/E6, each naming its ANCHOR turn — visually separated from everything
 * below it, which is the WARNING side (connectivity, coupling, bypass
 * candidates, time-order, attribution, and the stock facts no report admits).
 *
 * E6 (a DRAFT edge, ticket 20) prints in BOTH blocks' subjects and that is
 * deliberate: the ERRORS block lists it per row, and D9's unattributed-cluster
 * warning below counts the both-sides-empty subset of the same rows as a
 * cluster. The attribution section says so in its own heading, so a reader
 * meeting one edge twice is told why rather than left to suspect a double
 * count. See `shared/lane-checker.ts`'s header for the split.
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
 * coverage facts, digraph member labels — routes
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

function renderStatsReport(lane: LaneStatsReport, addresses?: LaneAnchorAddresses): string[] {
  const lines: string[] = [];
  lines.push("Lane " + formatLaneKey(lane.key) + " - phases: " + (lane.phases.join(",") || "(none)"));
  lines.push("  members: " + formatMembers(lane.members));
  const edgeCounts = Object.entries(lane.edgeCountsByRelation)
    .map(([relation, count]) => relation + "=" + count)
    .join(" ");
  lines.push("  edges: " + (edgeCounts || "(none)"));
  // THE DECLARATION LINE IS GONE (lane-state-retirement ticket 01), not
  // narrowed to one of its two words. It printed a closure verdict and the
  // single terminus that verdict was computed from; both concepts left the
  // model, and a line that kept either half would keep teaching it. A reader
  // who wants to know what this lane converged reads its out-edges —
  // `edges:` above already counts them.
  // THE `cited from outside:` LINE IS GONE (main-agent-edges spec D2). It
  // split incoming citations into `depends[]` / `used[]` / `testimony[]`, one
  // bucket per retired relation word, and the three classes have no such
  // split: `grounds` and `consume` are ONE class now, so two of the three
  // brackets would hold the same edges and the line would be answering a
  // question the vocabulary no longer asks.
  // TICKET 04: the coverage line names BOTH halves of the verdict. `members:`
  // above prints a NUMBER, and after ticket 02's judgment narrowing that number
  // is routinely a slice of the lane — 195 where the lane has 295 — while the
  // old line said `whole` because every claiming edge's endpoint happened to be
  // loaded. The slice is now said out loud, in the same line the reader already
  // consults for completeness, rather than left to be inferred from a count
  // nothing else states.
  const membership = lane.coverage.membership;
  lines.push(
    "  coverage: " +
      lane.coverage.status +
      (lane.coverage.missingTurnIds.length > 0
        ? " (missing: " + formatTurnRefList(lane.coverage.missingTurnIds, addresses) + ")"
        : "") +
      (membership === undefined
        ? ""
        : " -- " +
          membership.loaded +
          " of " +
          membership.declared +
          " declared member(s) loaded" +
          (membership.declared > membership.loaded
            ? "; the members above are a SLICE of this lane, not all of it"
            : "")),
  );
  return lines;
}

/**
 * Report 2, retargeted by v12 ticket 11: the lane's own members partitioned by
 * the lane's OWN claiming edges.
 *
 * The closed-terminus line ticket 11 added below the islands is DELETED with
 * lane state itself (lane-state-retirement ticket 01) — it asked whether a
 * CLOSED lane's single terminus was cited from outside, and neither "closed"
 * nor "the terminus" is a fact this model has any more.
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
 * exactly the lanes a reader can `delete` to get back under the line.
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
    " of them have no live member (delete removes them): " +
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
    case "E6":
      // The SIDE is the whole finding (ticket 20), so it is spelled in words
      // rather than as a tag list: "which end is missing" is the difference
      // between settling a row and settling the other half of one. The settled
      // half's lane is printed when there is one, because the repair for a
      // half-settled edge usually IS that same lane on the other end.
      return (
        head +
        renderEdgeArrow(error.citingId, error.relation, error.citedId, addresses) +
        ": DRAFT edge -- " +
        (error.unsettledSides.length === 2
          ? "neither side names a lane"
          : "the " +
            error.unsettledSides[0]! +
            " side names no lane (the " +
            (error.unsettledSides[0] === "tail" ? "head" : "tail") +
            " side is {" +
            error.tags.join(",") +
            "})")
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

  sections.push(ERRORS_SECTION_HEADER);
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
  sections.push(WARNINGS_SECTION_HEADER);
  sections.push(LANE_CHECK_WARNING_NOTICE);

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
    "## Attribution -- unattributed clusters + lane proliferation (warnings; settlement's own debt, never enforced -- a cluster's edges are ALSO listed one by one as E6 above, which is the half that blocks commit)",
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
    sections.push("(no task over its lane budget)");
  } else {
    sections.push(result.laneProliferation.length + " task(s) over the lane budget:");
    for (const warning of result.laneProliferation) {
      sections.push(renderLaneProliferation(warning));
    }
  }

  sections.push("");
  sections.push("## Stock warnings -- rows that take part in no report");
  if (result.warnings.length === 0) {
    sections.push("(no cross-task tagged edges)");
  } else {
    sections.push(result.warnings.length + " cross-task tagged edge(s):");
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

// ------------------------------------------------------- settlement paging --

/**
 * `lane_check` PAGING (settlement-ergonomics ticket 05, spec D3 items 1/2/4)
 * AND SCOPE (ticket 06, spec D3 item 3). ADDITIVE ONLY: `renderLaneCheckerReports`
 * above is untouched and stays the CLI's/console's own uncapped, unaggregated,
 * unscoped render — this is a SEPARATE entry point the settlement `lane_check`
 * tool alone calls, because only that caller is bound by
 * `WORKER_TOOL_RESULT_MAX_CHARS` (the worker's tool-result cap,
 * `mcp/handlers.ts`) and only that caller's default (zero-argument) call blew
 * past it on a real run — 128,100 characters / 1,773 lines, one call, no error
 * recovery, so that run effectively had no checker at all.
 *
 * THREE mechanisms, applied in the spec's own order — project by scope FIRST,
 * THEN aggregate, THEN page. Any other order lets the budget cut a page out of
 * a set the scope was about to remove, or lets a fold mix an in-scope instance
 * with one scope was about to drop:
 *
 *   0. SCOPE (`projectLaneCheckerResultByScope`) — NO LONGER RUN HERE.
 *      Settlement-gate-taxonomy ticket 03 moved the call to the evaluator seam
 *      (`note-settlement-sdk-query.ts`'s `evaluateWindowLanes`), because the
 *      `lane_check` tool result has a SECOND half — the LANE DISPOSITION block
 *      — which is not rendered by this function and was therefore reading the
 *      UNPROJECTED result while this render read the projected one. One call
 *      printed "this lane is fine" above "this lane owes a disposition". The
 *      projection is one question, so it is answered once, upstream of both
 *      halves; what arrives here is already projected and this function
 *      renders it verbatim.
 *   1. AGGREGATION folds the two report families that are BOTH unbounded AND
 *      literally repetitive — report 4c (time-order violations) and the stock
 *      cross-segment-warning list — from one line per instance down to ONE
 *      line: a count plus the first few instance addresses
 *      (`MAX_AGGREGATE_ADDRESS_SAMPLES`). Every OTHER report family (lane
 *      statistics, connectivity, coupling, bypass candidates, attribution)
 *      keeps one block per entry: each entry there is a STRUCTURED fact
 *      (members, per-relation counts, a closure state), not a repeated shape,
 *      so folding it into one line would delete information a reader needs
 *      rather than compress noise. The ERRORS block is exempt from folding
 *      altogether — `renderLaneCheckerReports`'s own header explains why it
 *      must stay uncapped and per-instance (the commit gate reads the
 *      identical list); paging, never folding, is how its bulk is handled
 *      here.
 *   2. PAGINATION packs the render into fixed-token pages
 *      (`estimateTokens`-measured, the SAME measure and the SAME parameter
 *      name/meaning `recall`'s own `pageBudget` uses) at the granularity of
 *      an INDIVISIBLE render block — one lane's whole stats paragraph, one
 *      error instance, one folded summary line — so a page break never lands
 *      inside one. Every page beyond the first states, at its own end, how
 *      many pages remain and the exact call that reaches the next one.
 */

/**
 * THE WARNING WORDING, verbatim from the settlement-gate-taxonomy spec
 * ("Warning wording"). One string, two surfaces: it heads the `## WARNINGS`
 * section of the `lane_check` render below, and `commit`'s own receipt carries
 * it beside the same findings (`note-settlement-sdk-query.ts`).
 *
 * A warning that READS like an obligation buys a round trip, which is the cost
 * this batch exists to remove — job 166 spent 21 refused commits and ~54M
 * cache-read tokens on a demand it could not satisfy. So the text states three
 * things a reader would otherwise have to infer: that nothing here blocks,
 * that delaying `commit` to work on this line is not wanted, and that a stitch
 * is legitimate only when the material the run is already holding supports it
 * — never as a way to silence the line.
 *
 * Ticket 06 review: the notice used to name `justify` as one of the two
 * round-trip-buying moves. That verb is retired, and a warning that forbids a
 * call the tool no longer offers is stale text sitting in the model's context —
 * the exact class of thing this batch exists to remove. The ticket-04 freeze
 * protected the no-action INSTRUCTION, not a reference to a deleted action.
 *
 * It lives in this SHARED module rather than beside the gate because both
 * printers must emit the identical bytes; a second copy in the worker is how
 * the two would come to word it differently.
 */
export const LANE_CHECK_WARNING_NOTICE =
  "WARNING — informational; does not block commit. Do not delay commit to act on it. " +
  "Add a stitch only if a truthful relation is already supported by the material you are processing.";

/**
 * The `## WARNINGS` header, and the criterion it now satisfies
 * (settlement-gate-taxonomy ticket 04). It used to read "aspirations, never
 * enforced" while `commit` refused over one of the findings printed beneath it
 * — the first of the two written contradictions the spec's problem statement
 * names. Nothing under this header blocks anything now, so the header says so
 * plainly instead of claiming a posture the code contradicted.
 */
const WARNINGS_SECTION_HEADER = "## WARNINGS -- informational; nothing below this line blocks commit";

/**
 * The `## ERRORS` header, shared by both renders so the two never describe one
 * class two ways. "that THIS run can repair" is the part ticket 04 added: the
 * list under it is exactly the one `commit` refuses over, because the same rule
 * built both — a finding whose repair this run's authority cannot reach is
 * printed under the warnings header instead of here and then silently carved
 * out of the gate.
 */
const ERRORS_SECTION_HEADER =
  "## ERRORS -- states the grammar forbids that THIS run can repair; commit refuses while one remains";

/** Samples per folded warning line — the "first several instance addresses" the ticket asks for. */
const MAX_AGGREGATE_ADDRESS_SAMPLES = 5;

/** One line: a `count`, then up to `MAX_AGGREGATE_ADDRESS_SAMPLES` of `addresses`, then a "(+N more)" remainder marker when any are left unshown. */
function aggregateAddressLine(addresses: readonly string[]): string {
  const shown = addresses.slice(0, MAX_AGGREGATE_ADDRESS_SAMPLES);
  const omitted = addresses.length - shown.length;
  return "  " + shown.join(", ") + (omitted > 0 ? ` (+${omitted} more)` : "");
}

// ------------------------------------------------------- settlement scope --

/**
 * `lane_check`'s THIRD layer was once a MODEL-FACING CHOICE — `"actionable"`
 * (the default) or `"all"` (settlement-ergonomics ticket 06, spec D3 item 3).
 * Settlement-gate-taxonomy ticket 03 REMOVED the widening: the spec's own
 * "Consequences" clause ("the agent-facing `scope: \"all\"` widening is
 * removed"). A run that could ask for a second, wider view of the same lanes
 * could be shown findings its own commit gate would never judge — and, worse,
 * one of the two halves of the `lane_check` result (the LANE DISPOSITION
 * block) never had a scope argument at all, so the widening it could not
 * follow was a divergence the agent had a tool parameter for. There is one
 * projection now, and no way to ask for another.
 */

/** `laneToken(segment, tag)` -> that reported lane's own member ids, from report 1 (`result.lanes`) — the borrowed anchor `coupling` below needs, since `LaneCouplingReport` carries no turn id of its own. */
function laneMemberIdsByToken(lanes: readonly LaneStatsReport[]): Map<string, ReadonlySet<number>> {
  const byToken = new Map<string, ReadonlySet<number>>();
  for (const lane of lanes) {
    byToken.set(
      laneToken(lane.key.segment, lane.key.tag),
      new Set(lane.members.map((member) => member.id)),
    );
  }
  return byToken;
}

/** `LaneKey.segment` -> the UNION of every reported lane's own member ids in that segment — the borrowed anchor `laneProliferation` below needs, since `LaneProliferationWarning` carries no turn id at all (module doc on `projectLaneCheckerResultByScope`). */
function laneMemberIdsBySegment(lanes: readonly LaneStatsReport[]): Map<string, Set<number>> {
  const bySegment = new Map<string, Set<number>>();
  for (const lane of lanes) {
    let bucket = bySegment.get(lane.key.segment);
    if (bucket === undefined) {
      bucket = new Set();
      bySegment.set(lane.key.segment, bucket);
    }
    for (const member of lane.members) {
      bucket.add(member.id);
    }
  }
  return bySegment;
}

/** `true` iff any of `ids` is a member of `window`. */
function intersectsWindow(ids: Iterable<number>, window: ReadonlySet<number>): boolean {
  for (const id of ids) {
    if (window.has(id)) {
      return true;
    }
  }
  return false;
}

/**
 * D3 item 3's projection: a pure function of `LaneCheckerResult` plus the set
 * of turn ids this run may act on. Run ONCE, at the evaluator seam
 * (`note-settlement-sdk-query.ts`'s `evaluateWindowLanes`), BEFORE either half
 * of the `lane_check` result is built and before the commit gate reads a
 * finding — never inside the render, which is only one of its two consumers.
 *
 * SETTLEMENT-GATE-TAXONOMY TICKET 03 CLOSED BOTH ESCAPE HATCHES that used to
 * live in this signature:
 *
 *   - `scope: "all"`, which let the agent ask for a view its own gate would
 *     not judge (see `LaneCheckerScope`'s deleted declaration above);
 *   - `actionableTurnIds === undefined`, which returned the WHOLE projection.
 *     That was the spec's "missing production provenance … falling open to
 *     whole history". The set is required now; a caller that cannot supply one
 *     has an unconstructible projection and must say so on the system-failure
 *     channel instead of being handed a report — see `judgeSettlementWindow`
 *     at the tool path, and `worker/note-settlement-system-failure.ts` for the
 *     channel's own type and its four cases.
 *
 * ## Per-family predicate (spec D3 item 3's own requirement: "define the
 * predicate PER REPORT FAMILY and list every family with its rule")
 *
 * ANCHORED — tested by its own anchor, against the WINDOW set:
 *   - `errors` (E3/E4/E6) — `window.has(error.anchorId)`. This is the ONE
 *     family the whole projection exists to keep faithful to: an error the
 *     window can fix must never disappear under the default scope.
 *
 * AGGREGATE — tested by whether the members the entry COVERS intersect the
 * window set (the ticket's own wording for report 1/2/3/4b/4c/attribution):
 *   - `lanes` (report 1) — the lane's OWN `members`.
 *   - `components` (report 2) — the union of every island's `memberIds`.
 *   - `bypassCandidates` (report 4b) — `citingId`, `citedId`, and every node
 *     on `alternativePath` (a bypass is a fact about the WHOLE route).
 *   - `timeOrderViolations` (report 4c) — `citingId`/`citedId`, filtered
 *     PER INSTANCE before the fold below ever runs (order matters: folding
 *     first would merge a droppable instance into a count nothing could then
 *     subtract from).
 *   - `warnings` (stock cross-segment) and `vocabularyConformance
 *     .outOfVocabularyEdges` — not named in the ticket's own enumerated list,
 *     but structurally identical to `bypassCandidates`/`timeOrderViolations`
 *     (an edge with two real endpoints and no other identity) — extended here
 *     under the SAME rule, per-instance on `citingId`/`citedId`. Each SHOWN
 *     entry is a COMPLETE fact (both ids, no per-entry truncation), so this
 *     is fully decidable even though the list itself may already be
 *     `cappedFactList`-truncated upstream; `count` is left UNTOUCHED on both
 *     — it always names the list's own TRUE total, independent of how many
 *     entries are shown, exactly like the pre-existing display cap already
 *     behaves. Scope filtering only narrows WHICH examples earn a slot.
 *   - `tooFineIndexes.entries` — per-instance on `citingId`/`citedId`, the
 *     same complete-fact rule as the edge lists above.
 *   - `unattributedClusters.entries` — UNLIKE the edge lists above, one
 *     cluster's own `turnIds` sample can ITSELF be truncated
 *     (`MAX_CLUSTER_TURN_ENTRIES`) below its true `turnCount`. A HIT among the
 *     shown ids is trustworthy regardless (more unseen members cannot
 *     invalidate a positive match); a MISS is trustworthy only when the shown
 *     list IS the cluster's full membership (`turnIds.length === turnCount`)
 *     — otherwise this is the "cannot decide honestly" case and the cluster
 *     is KEPT rather than dropped on a display cap it never asked for.
 *     `count` (the true CLUSTER total) is likewise untouched.
 *
 * NO UNIFORM ANCHOR — a borrowed one, or an honest "cannot decide":
 *   - `coupling` (report 3, `LaneCouplingReport`) carries no turn id of its
 *     own at all (counts only). Borrowed anchor: the SAME lane's own member
 *     set report 1 already resolved for this identical `key`
 *     (`checkLanes`'s `computeCoupling` iterates the SAME `lanes` list report
 *     1's stats are built from, so the lookup always hits on real checker
 *     output). A hand-built fixture whose coupling entry names no matching
 *     lane at all is the one case this cannot decide — kept, not dropped.
 *   - `laneProliferation` (`LaneProliferationWarning`) carries a SEGMENT and
 *     no turn id at all — the hardest case, and not named in the ticket's own
 *     enumerated list either. Borrowed anchor: the UNION of every reported
 *     lane's own members in that segment (report 1 again). A segment with no
 *     reported lane at all (every one of its declared lanes carries zero live
 *     members) has nothing to borrow from — kept, not guessed at.
 *   - `vocabularyConformance.typeViolations` is never rendered by ANY
 *     function in this file (it is E3's own raw source, module header of
 *     `shared/lane-checker.ts`: "the raw source E3 is classed from") — left
 *     completely untouched, since filtering a field nothing prints changes no
 *     observable behaviour.
 */
export function projectLaneCheckerResultByScope(
  result: LaneCheckerResult,
  actionableTurnIds: ReadonlySet<number>,
): LaneCheckerResult {
  const window = actionableTurnIds;

  const byToken = laneMemberIdsByToken(result.lanes);
  const bySegment = laneMemberIdsBySegment(result.lanes);

  const lanes = result.lanes.filter((lane) =>
    intersectsWindow(lane.members.map((member) => member.id), window),
  );

  const components = result.components.filter((component) =>
    component.islands.some((island) => intersectsWindow(island.memberIds, window)),
  );

  const coupling = result.coupling.filter((report) => {
    const members = byToken.get(laneToken(report.key.segment, report.key.tag));
    return members === undefined || intersectsWindow(members, window);
  });

  const bypassCandidates = result.bypassCandidates.filter(
    (candidate) =>
      window.has(candidate.citingId) ||
      window.has(candidate.citedId) ||
      intersectsWindow(candidate.alternativePath, window),
  );

  const timeOrderViolations = result.timeOrderViolations.filter(
    (violation) => window.has(violation.citingId) || window.has(violation.citedId),
  );

  const warnings = result.warnings.filter(
    (warning) => window.has(warning.citingId) || window.has(warning.citedId),
  );

  // THE COUNT FOLLOWS THE FILTER (peer round three finding 05). Keeping the
  // unfiltered total beside filtered entries rendered as "2 edge(s) … showing
  // first 1", which reads as an actionable item withheld by the page budget
  // when it is really an edge outside the scope entirely. `scopedCount`
  // rescales the total only when the sample it is computed from is COMPLETE;
  // a truncated sample cannot say how many of the unseen instances are in
  // scope, so the total stands and the render says the sample was capped —
  // the same "cannot decide, keep" rule the cluster filter below already uses.
  const rescope = <T>(
    family: { count: number; entries: readonly T[] },
    keep: (entry: T) => boolean,
  ): { count: number; entries: T[] } => {
    const entries = family.entries.filter(keep);
    const sampleComplete = family.entries.length === family.count;
    return { count: sampleComplete ? entries.length : family.count, entries };
  };

  const outOfVocabularyEdges = rescope(
    result.vocabularyConformance.outOfVocabularyEdges,
    (edge) => window.has(edge.citingId) || window.has(edge.citedId),
  );

  const unattributedClusters = rescope(result.unattributedClusters, (cluster) => {
    if (intersectsWindow(cluster.turnIds, window)) {
      return true;
    }
    return cluster.turnIds.length < cluster.turnCount; // truncated sample -> cannot decide, keep
  });

  const laneProliferation = result.laneProliferation.filter((warning) => {
    const members = bySegment.get(warning.segment);
    return members === undefined || intersectsWindow(members, window);
  });

  const errors = result.errors.filter((error) => window.has(error.anchorId));

  return {
    lanes,
    components,
    coupling,
    bypassCandidates,
    timeOrderViolations,
    warnings,
    vocabularyConformance: {
      typeViolations: result.vocabularyConformance.typeViolations,
      outOfVocabularyEdges,
    },
    unattributedClusters,
    laneProliferation,
    errors,
  };
}

/** One INDIVISIBLE render unit — the pager below never splits the lines inside one across a page boundary. */
interface LaneCheckerRenderBlock {
  lines: readonly string[];
}

function renderBlock(...lines: string[]): LaneCheckerRenderBlock {
  return { lines };
}

/**
 * The full report as ordered, indivisible blocks — the SAME section order,
 * the SAME section headings, and (for every family except the two folded
 * ones) the SAME per-entry render helpers `renderLaneCheckerReports` itself
 * calls, so the two functions never describe one fact two different ways.
 * Time-order violations and stock cross-segment warnings are the two
 * exceptions (module doc above).
 */
function buildLaneCheckerBlocks(
  result: LaneCheckerResult,
  addresses: LaneAnchorAddresses | undefined,
  classifyError: LaneCheckerErrorClassifier,
): LaneCheckerRenderBlock[] {
  const blocks: LaneCheckerRenderBlock[] = [];

  // ONE CLASS PER FINDING, DECIDED ELSEWHERE (ticket 04). This render prints
  // the two lists in their two sections; it does not decide which list an
  // instance belongs to, and there is no per-class rule here to drift from the
  // gate's. `classifyError` is the settlement evaluator's own predicate,
  // handed in — see `LaneCheckerPageOptions.classifyError`.
  const blocking: LaneCheckerError[] = [];
  const informational: LaneCheckerError[] = [];
  for (const error of result.errors) {
    (classifyError(error) === "blocking" ? blocking : informational).push(error);
  }

  blocks.push(renderBlock(ERRORS_SECTION_HEADER));
  if (blocking.length === 0) {
    blocks.push(renderBlock("(none)"));
  } else {
    // UNCAPPED, same as `renderLaneCheckerReports` (module doc): the commit
    // gate judges this identical list, so every instance must stay reachable
    // — across pages if it must, never dropped.
    blocks.push(renderBlock(blocking.length + " error(s)"));
    for (const error of blocking) {
      blocks.push(renderBlock(renderLaneError(error, addresses)));
    }
  }

  blocks.push(renderBlock("", WARNINGS_SECTION_HEADER, LANE_CHECK_WARNING_NOTICE));

  // The DEMOTED grammar findings (ticket 04, spec's classification table: E3 is
  // a WARNING at stage 2). They are still SHOWN — narrowing what blocks is not
  // hiding the fact — but they are shown UNDER the warnings header, paged like
  // everything else, so a run cannot read them as a repair queue. Before this
  // ticket they printed in the ERRORS block above while the gate silently
  // carved them out, which is the second of the spec's two written
  // contradictions.
  if (informational.length > 0) {
    blocks.push(
      renderBlock(
        "",
        "## Grammar findings this run cannot repair -- " +
          informational.length +
          " finding(s); shown, never blocking",
      ),
    );
    for (const error of informational) {
      blocks.push(renderBlock(renderLaneError(error, addresses)));
    }
  }

  blocks.push(renderBlock("", "## Report 1 -- lane statistics"));
  if (result.lanes.length === 0) {
    blocks.push(renderBlock("(no lanes in scope)"));
  } else {
    for (const lane of result.lanes) {
      blocks.push(renderBlock(...renderStatsReport(lane, addresses)));
    }
  }

  blocks.push(
    renderBlock(
      "",
      "## Report 2 -- connectivity over each lane's OWN edges (provisional lanes, 0-1 members, are not judged)",
    ),
  );
  if (result.components.length === 0) {
    blocks.push(renderBlock("(no lanes in scope)"));
  } else {
    for (const component of result.components) {
      blocks.push(renderBlock(...renderComponentReport(component, addresses)));
    }
  }

  blocks.push(renderBlock("", "## Report 3 -- cross-lane coupling (counts only; no threshold and no verdict)"));
  if (result.coupling.length === 0) {
    blocks.push(renderBlock("(no lanes in scope)"));
  } else {
    for (const report of result.coupling) {
      blocks.push(renderBlock(renderCouplingReport(report)));
    }
  }

  blocks.push(
    renderBlock(
      "",
      "## Report 4b -- structural bypass candidates (a direct edge and a longer route between the same two turns; which to keep depends on what each contributes, so nothing here is marked for deletion)",
    ),
  );
  if (result.bypassCandidates.length === 0) {
    blocks.push(renderBlock("(none)"));
  } else {
    const shownCandidates = result.bypassCandidates.slice(0, MAX_BYPASS_RENDER_ENTRIES);
    blocks.push(
      renderBlock(
        result.bypassCandidates.length +
          " candidate(s)" +
          cappedCountSuffix(result.bypassCandidates.length, shownCandidates.length) +
          ":",
      ),
    );
    for (const candidate of shownCandidates) {
      blocks.push(renderBlock(renderBypassCandidate(candidate, addresses)));
    }
  }

  blocks.push(renderBlock("", "## Report 4c -- time-order violations (the DAG guarantee)"));
  if (result.timeOrderViolations.length === 0) {
    blocks.push(renderBlock("(none)"));
  } else {
    // FOLDED (module doc, mechanism 1): every instance is the SAME shape
    // repeated, so it collapses to one count line plus a sample of addresses
    // rather than one line per instance.
    const violationAddresses = result.timeOrderViolations.map(
      (violation) =>
        formatTurnRef(violation.citingId, addresses) + "->" + formatTurnRef(violation.citedId, addresses),
    );
    blocks.push(
      renderBlock(
        result.timeOrderViolations.length + " time-order violation(s), folded:",
        aggregateAddressLine(violationAddresses),
      ),
    );
  }

  blocks.push(
    renderBlock(
      "",
      "## Attribution -- unattributed clusters + lane proliferation (warnings; settlement's own debt, never enforced -- a cluster's edges are ALSO listed one by one as E6 above, which is the half that blocks commit)",
    ),
  );
  if (result.unattributedClusters.count === 0) {
    blocks.push(renderBlock("(no unattributed clusters)"));
  } else {
    blocks.push(
      renderBlock(
        result.unattributedClusters.count +
          " unattributed cluster(s) of 4+ turns" +
          cappedCountSuffix(result.unattributedClusters.count, result.unattributedClusters.entries.length) +
          ":",
      ),
    );
    for (const cluster of result.unattributedClusters.entries) {
      blocks.push(renderBlock(renderUnattributedCluster(cluster, addresses)));
    }
  }
  if (result.laneProliferation.length === 0) {
    blocks.push(renderBlock("(no task over its lane budget)"));
  } else {
    blocks.push(renderBlock(result.laneProliferation.length + " task(s) over the lane budget:"));
    for (const warning of result.laneProliferation) {
      blocks.push(renderBlock(renderLaneProliferation(warning)));
    }
  }

  blocks.push(renderBlock("", "## Stock warnings -- rows that take part in no report"));
  if (result.warnings.length === 0) {
    blocks.push(renderBlock("(no cross-task tagged edges)"));
  } else {
    // FOLDED, same reasoning as report 4c above.
    const warningAddresses = result.warnings.map(
      (warning) =>
        formatTurnRef(warning.citingId, addresses) +
        "(" + warning.citingSegment + ")->" +
        formatTurnRef(warning.citedId, addresses) +
        "(" + warning.citedSegment + ")",
    );
    blocks.push(
      renderBlock(
        result.warnings.length + " cross-task tagged edge(s), folded:",
        aggregateAddressLine(warningAddresses),
      ),
    );
  }
  const outOfVocabulary = result.vocabularyConformance.outOfVocabularyEdges;
  if (outOfVocabulary.count === 0) {
    blocks.push(renderBlock("(no out-of-vocabulary relations)"));
  } else {
    blocks.push(
      renderBlock(
        outOfVocabulary.count +
          " edge(s) whose relation is outside the seven-word vocabulary -- pre-migration stock, admitted to no graph" +
          cappedCountSuffix(outOfVocabulary.count, outOfVocabulary.entries.length) +
          ":",
      ),
    );
    for (const edge of outOfVocabulary.entries) {
      blocks.push(renderBlock(renderOutOfVocabularyEdge(edge, addresses)));
    }
  }

  return blocks;
}

/**
 * Packs blocks into pages by TOKEN budget (`estimateTokens`, the same measure
 * `recall`'s own `pageBudget` uses) — a page always holds at least one block
 * (so one oversized block can never stall pagination), and a block is never
 * split across the boundary.
 */
function packLaneCheckerBlocks(
  blocks: readonly LaneCheckerRenderBlock[],
  pageBudget: number,
): LaneCheckerRenderBlock[][] {
  const pages: LaneCheckerRenderBlock[][] = [];
  let current: LaneCheckerRenderBlock[] = [];
  let currentTokens = 0;

  for (const blk of blocks) {
    const blockTokens = estimateTokens(blk.lines.join("\n"));
    if (current.length > 0 && currentTokens + blockTokens > pageBudget) {
      pages.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(blk);
    currentTokens += blockTokens;
  }
  if (current.length > 0 || pages.length === 0) {
    pages.push(current);
  }
  return pages;
}

function renderLaneCheckerPage(page: readonly LaneCheckerRenderBlock[]): string {
  const lines: string[] = [];
  for (const blk of page) {
    lines.push(...blk.lines);
  }
  return lines.join("\n");
}

/**
 * Every page beyond the first states how many remain and the exact call that
 * reaches the next one (D3's "每页末尾带续读提示"). A single-page render
 * carries no footer at all — nothing to continue.
 */
function continuationFooter(page: number, pageCount: number): string {
  if (pageCount <= 1) {
    return "";
  }
  const remaining = pageCount - page;
  const hint =
    remaining > 0
      ? remaining + " more page(s) -- call lane_check(page=" + (page + 1) + ") for the next"
      : "this was the last page";
  // Paging RE-RUNS the check (peer round three finding 01, user ruling
  // [S15069/T1778]: recomputation is the contract, the "not a re-run" promise
  // was the thing that was wrong). The page count is therefore a fact about
  // THIS call, and a write landed between two pages moves it — said out loud
  // on any page after the first, because a silently shifting denominator is
  // how a reader ends up never seeing a row.
  const freshness = page > 1 ? " (re-run; counts are as of this call)" : "";
  return "\n\n-- page " + page + "/" + pageCount + ": " + hint + freshness + " --";
}

/**
 * Default `pageBudget`, in `estimateTokens` tokens — sized so the DEFAULT
 * (zero-argument) call's first page stays comfortably under
 * `WORKER_TOOL_RESULT_MAX_CHARS` (100,000 characters, `mcp/handlers.ts`) even
 * though the two never share a unit: this render is effectively all-ASCII, so
 * `estimateTokens` costs one token per ~4 characters, and 20,000 tokens is
 * ~80,000 characters — a comfortable margin under the cap for the
 * continuation footer, inter-block newlines, and per-block rounding.
 */
export const LANE_CHECK_DEFAULT_PAGE_BUDGET = 20_000;

/**
 * "Does this error instance block a commit?" — asked, never answered, here
 * (settlement-gate-taxonomy ticket 04). The ONE rule that answers it lives at
 * the settlement evaluator (`worker/note-settlement-finding-class.ts`), because
 * two of its three conditions are facts about a RUN (which turns it may judge,
 * which repairs its authority reaches) that this pure render cannot see.
 *
 * A caller that supplies none — the CLI, a fixture — gets `"blocking"` for
 * every instance, which is the honest reading for a surface with no run and no
 * gate behind it: it can say what the grammar forbids, and it must not invent
 * a verdict about who could repair it.
 */
export type LaneCheckerErrorClassifier = (error: LaneCheckerError) => "blocking" | "informational";

export interface LaneCheckerPageOptions {
  /** 1-based. Out-of-range yields an empty page body with the true `pageCount` still reported — the same "no clamping" convention `mcp/recall.ts`'s own pageBudget pagination uses. */
  page?: number;
  /** Same name and meaning as `recall`'s own `pageBudget` — a token ceiling per page; overflow rolls to another page, a block is never truncated. */
  pageBudget?: number;
  /**
   * The settlement evaluator's own class predicate (ticket 04). The demoted
   * findings are rendered UNDER the warnings header and PAGED with everything
   * else — an unpaged tail block would be the "output that cannot be expressed
   * inside the protocol" failure the spec's third channel is about, and a real
   * window has carried 435 E3s.
   */
  classifyError?: LaneCheckerErrorClassifier;
  // NO `scope` AND NO `actionableTurnIds` (settlement-gate-taxonomy ticket 03).
  // The scope projection is the evaluator's, applied once to the result BOTH
  // halves of the `lane_check` tool result are built from; a render that
  // projected again would be a second answer to a question already answered.
}

export interface LaneCheckerPagedReport {
  /** This page's body, with the continuation footer already appended when more than one page exists. */
  text: string;
  page: number;
  pageCount: number;
}

/**
 * The settlement `lane_check` tool's OWN entry point (D3 items 1/2/4) — see
 * the module doc above `MAX_AGGREGATE_ADDRESS_SAMPLES`'s predecessor comment
 * for the two mechanisms left here (aggregate, THEN page) and for where the
 * third one went. `result` arrives ALREADY PROJECTED; this function renders
 * what it is given. `renderLaneCheckerReports` is untouched and remains the
 * CLI's/console's uncapped, unaggregated, unscoped render.
 */
export function renderLaneCheckerReportsPaged(
  result: LaneCheckerResult,
  anchorAddresses?: LaneAnchorAddresses,
  options?: LaneCheckerPageOptions,
): LaneCheckerPagedReport {
  const pageBudget = options?.pageBudget ?? LANE_CHECK_DEFAULT_PAGE_BUDGET;
  const requestedPage = options?.page ?? 1;

  const blocks = buildLaneCheckerBlocks(
    result,
    anchorAddresses,
    options?.classifyError ?? (() => "blocking"),
  );
  const pages = packLaneCheckerBlocks(blocks, pageBudget);
  const pageCount = pages.length;
  const index = requestedPage - 1;
  const inRange = index >= 0 && index < pages.length;
  const pageBlocks = inRange ? pages[index]! : [];
  // An out-of-range page is genuinely empty -- no footer either, since a
  // footer stating "this was the last page" (or naming a "next" page) about a
  // page that was never rendered would be its own kind of wrong answer.
  const footer = inRange ? continuationFooter(requestedPage, pageCount) : "";

  return {
    text: renderLaneCheckerPage(pageBlocks) + footer,
    page: requestedPage,
    pageCount,
  };
}

// --------------------------------------------------------------- digraph --

const MAX_DIGRAPH_COLUMNS = 100;

/**
 * ONE glyph. lane-model-v12 ticket 04 deleted the overridden-node cross along
 * with node death; lane-state-retirement ticket 01 deleted the TERMINUS target
 * along with the single per-lane terminus it marked. A member is a member, and
 * this digraph makes no claim about any of them beyond membership.
 */
const MEMBER_GLYPH = "●";

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
 * SEVERED (more than one island).
 *
 * The report-4b half is gone with the path counts (v12 ticket 11): a bypass
 * candidate is a fact about an EDGE pair, and there is no member-level glyph
 * that could carry it honestly — marking the citing turn would read as "this
 * turn is defective" when the finding is that two routes exist. The
 * uncited-terminus half is gone with lane state (ticket 01).
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
 * top-down, one member per line, one glyph (dot) per member,
 * plus a warning glyph for a report-2/4 finding. Deeper cross-lane crossings (a
 * member shared with another lane) render as a reference line ("see T... in
 * another lane") rather than a second branch column - this derives NOTHING:
 * every fact printed here already exists on `result`, read off report 1
 * (membership).
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
      const glyph = MEMBER_GLYPH;
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
