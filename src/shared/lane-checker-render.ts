import type {
  LaneBypassReport,
  LaneCheckerError,
  LaneCheckerResult,
  LaneComponentReport,
  LaneCrossSegmentWarning,
  LaneErrorClass,
  LaneFoldedPaths,
  LaneInterfacePair,
  LaneMember,
  LanePathReport,
  LaneState,
  LaneStatsReport,
  LaneTimeOrderViolation,
} from "./lane-checker";
import { DEFAULT_SEGMENT, laneToken, type LaneKey } from "./lane-interpretation";

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
 * ## The error/warning split (tag-mandate tickets 03/04)
 *
 * Both surfaces lead with an ERRORS block — states the grammar forbids,
 * E1-E5, each naming its ANCHOR turn — visually separated from everything
 * below it, which is the WARNING side (the three principles' aspirational
 * facts, reports 1-4 and the cross-segment warnings, unchanged).
 *
 * The old trailing "## Vocabulary conformance" section is GONE, not merely
 * moved: its two fact lists ARE error classes E2 and E3 now, and its own
 * header sentence ("reported, never enforced") stopped being true the
 * moment the commit gate started refusing on them. `LaneCheckerResult` still
 * carries the capped `vocabularyConformance` field as the raw source those
 * classes are read from — this file simply no longer prints it twice.
 *
 * The errors block is the one place a DISPLAY cap is applied that the data
 * does not have (`MAX_ERROR_RENDER_ENTRIES`): `result.errors` is uncapped
 * precisely so the commit gate can trust it, while a settlement window with
 * hundreds of stock violations must not blow the text budget. The count line
 * always states the TRUE total, and the next `lane_check` after a repair
 * round surfaces the remainder.
 */

function formatTagSet(key: LaneKey): string {
  const scope = key.segment === DEFAULT_SEGMENT ? "default" : "E" + key.segment;
  return scope + ":{" + key.tagSet.join(",") + "}";
}

function formatMembers(members: readonly LaneMember[]): string {
  return members
    .map((member) => (member.dead ? member.id + "(dead)" : String(member.id)))
    .join(", ");
}

/**
 * The three-state reading (milestone-election spec, ticket 04) — replaces
 * the raw `declaration.state` word (declared/reopened/undeclared) that used
 * to render here, which `lane-interpretation.ts`'s `deriveLaneStates` doc
 * names as the wrong axis to show: a lane that kept living past its own
 * declaration still reports `declaration.state === "declared"` even though
 * it is actually open. `state` (`LaneStatsReport.state`, consumed straight
 * from that helper) is the corrected reading. An open lane names its last
 * declarer only when one exists — a truly never-declared lane (`{write-gate}`
 * in the golden fixture) has none, and this prints exactly "open" for it, no
 * invented "last stable milestone".
 */
function formatLaneState(state: LaneState): string {
  if (state.closure === "closed") {
    return "closed-" + state.validity;
  }
  return state.lastDeclarer !== null ? "open (last declarer T" + state.lastDeclarer + ")" : "open";
}

function renderStatsReport(lane: LaneStatsReport): string[] {
  const lines: string[] = [];
  lines.push("Lane " + formatTagSet(lane.key) + " - phases: " + (lane.phases.join(",") || "(none)"));
  lines.push("  members: " + formatMembers(lane.members));
  const edgeCounts = Object.entries(lane.edgeCountsByRelation)
    .map(([relation, count]) => relation + "=" + count)
    .join(" ");
  lines.push("  edges: " + (edgeCounts || "(none)"));
  lines.push(
    "  declaration: " +
      formatLaneState(lane.state) +
      (lane.declaration.terminus !== null ? " (terminus " + lane.declaration.terminus + ")" : "") +
      (lane.declaration.latestEventTurn !== null
        ? " [last event T" + lane.declaration.latestEventTurn + "]"
        : ""),
  );
  const grounds = lane.citedness.groundsFromNonMembers.map(
    (fact) => "T" + fact.citingId + "->T" + fact.citedId,
  );
  const used = lane.citedness.usedFromNonMembers.map(
    (fact) => "T" + fact.citingId + "->T" + fact.citedId,
  );
  const testimony = lane.citedness.testimonyFromNonMembers.map(
    (fact) => "T" + fact.citingId + " " + fact.relation + " T" + fact.citedId,
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
        ? " (missing: " + lane.coverage.missingTurnIds.join(",") + ")"
        : ""),
  );
  return lines;
}

function renderComponentReport(component: LaneComponentReport): string[] {
  const lines: string[] = [];
  const health = component.componentCount === 1 ? "healthy" : "SEVERED";
  lines.push(
    "Lane " + formatTagSet(component.key) + " - components: " + component.componentCount + " (" + health + ")",
  );
  for (const island of component.islands) {
    lines.push("  island@" + island.representative + ": " + island.memberIds.join(","));
  }
  return lines;
}

function renderFoldedPaths(folded: LaneFoldedPaths): string {
  const folding = folded.citingTurnsFolded.length > 0 ? folded.citingTurnsFolded.join(",") : "-";
  return "folded pathCount=" + folded.pathCount + " (citing turns folded: " + folding + ")";
}

function renderForkJoin(path: LanePathReport): string | null {
  if (path.forkNodes.length === 0 && path.joinNodes.length === 0) {
    return null;
  }
  return (
    "fork: " +
    (path.forkNodes.join(",") || "-") +
    " join: " +
    (path.joinNodes.join(",") || "-")
  );
}

function renderPathReport(path: LanePathReport): string[] {
  const lines: string[] = [];
  if (path.status === "skipped") {
    lines.push(
      "Lane " +
        formatTagSet(path.key) +
        " - paths: skipped (" +
        path.skipReason +
        "); starts: " +
        (path.starts.join(",") || "-"),
    );
    const skippedForkJoin = renderForkJoin(path);
    if (skippedForkJoin) {
      lines.push("  " + skippedForkJoin);
    }
    return lines;
  }
  lines.push(
    "Lane " +
      formatTagSet(path.key) +
      " - paths: " +
      path.pathCount +
      " (terminus T" +
      path.terminus +
      "; starts: " +
      (path.starts.join(",") || "-") +
      ")",
  );
  if (path.folded) {
    lines.push("  " + renderFoldedPaths(path.folded));
  }
  const forkJoin = renderForkJoin(path);
  if (forkJoin) {
    lines.push("  " + forkJoin);
  }
  return lines;
}

function renderInterfacePair(pair: LaneInterfacePair): string {
  return "  " + formatTagSet(pair.laneA) + " <-> " + formatTagSet(pair.laneB) + ": " + pair.count;
}

function renderBypassReport(report: LaneBypassReport): string[] {
  const lines: string[] = [];
  lines.push("  Lane " + formatTagSet(report.key) + " - bypass: " + report.count);
  for (const edge of report.edges) {
    const tags = edge.tags.length > 0 ? " {" + edge.tags.join(",") + "}" : "";
    lines.push("    T" + edge.citingId + " -> T" + edge.citedId + " (" + edge.relation + tags + ")");
  }
  return lines;
}

function renderTimeOrderViolation(violation: LaneTimeOrderViolation): string {
  const tags = violation.tags.length > 0 ? " {" + violation.tags.join(",") + "}" : "";
  return "  T" + violation.citingId + " -> T" + violation.citedId + " (" + violation.relation + tags + ")";
}

function renderSharedNodes(shared: LaneCheckerResult["multiLaneComponents"][number]): string[] {
  return shared.sharedNodes.map(
    (node) =>
      "  shared T" +
      node.id +
      (node.designedShape ? " (designed fork/merge)" : " (judgment)") +
      ": " +
      node.citingLanesByStance.map(formatTagSet).join(", "),
  );
}

/**
 * How many error instances either surface prints. `LaneCheckerResult.errors`
 * itself is UNCAPPED (the commit gate filters it by anchor and must see
 * every instance) — this bound exists only so a window over badly
 * non-conforming stock cannot blow the settlement text budget. Higher than
 * the fact lists' own cap: an error is work the reader must actually do, so
 * a longer list earns its bytes.
 */
const MAX_ERROR_RENDER_ENTRIES = 50;

/** `count` vs a possibly-capped printed list — the "(showing first N of count)" suffix. */
function cappedCountSuffix(count: number, shown: number): string {
  return count > shown ? " (showing first " + shown + ")" : "";
}

function renderEdgeArrow(citingId: number, relation: string, citedId: number): string {
  return "T" + citingId + " --" + relation + "--> T" + citedId;
}

/**
 * One line per error instance, ALWAYS leading with its class and its ANCHOR
 * turn — the anchor is what the commit gate scopes by, so a reader deciding
 * "is this mine to fix" must not have to infer it from the endpoints.
 */
function renderLaneError(error: LaneCheckerError): string {
  const head = "  [" + error.class + "] anchor T" + error.anchorId + " -- ";
  switch (error.class) {
    case "E1":
      return (
        head +
        renderEdgeArrow(error.citingId, error.relation, error.citedId) +
        " carries no lane tags; extends/narrows must name their line" +
        " (tag the edge; both endpoints carry the tag)"
      );
    case "E2":
      return (
        head +
        renderEdgeArrow(error.citingId, error.relation, error.citedId) +
        ": relation is outside the eight-word vocabulary"
      );
    case "E3":
      return (
        head +
        (error.types.length === 0
          ? "T" + error.id + " type: [] (empty)"
          : "T" +
            error.id +
            " type: [" +
            error.types.join(",") +
            "] (outside vocabulary: " +
            error.outsideVocabulary.join(",") +
            ")")
      );
    case "E4":
      return (
        head +
        renderEdgeArrow(error.citingId, error.relation, error.citedId) +
        " {" +
        error.tags.join(",") +
        "}: " +
        error.missing
          .map((miss) => '"' + miss.tag + "\" missing from the " + miss.endpoint + " turn's tags")
          .join("; ")
      );
    case "E5":
      // Names the CANONICAL node too, because the repair is a choice between
      // two shapes ("retag this chain into its own lane" vs "bridge it to the
      // lane's real start/end") and neither is decidable without knowing
      // which node the lane already runs from/to.
      return (
        head +
        "lane " +
        formatTagSet(error.key) +
        " has a second " +
        error.role +
        ": T" +
        error.nodeId +
        " dangles beside T" +
        error.canonicalId +
        "; a lane has exactly one start and one end" +
        " (retag one chain, or bridge them)"
      );
  }
}

/**
 * The capped instance lines both surfaces print, identically formatted so
 * the CLI's digraph and the settlement text never describe one error two
 * ways. The COUNT line is each surface's own (the digraph folds it into its
 * heading), which is why this returns instances only.
 */
function errorInstanceLines(errors: readonly LaneCheckerError[]): string[] {
  return errors.slice(0, MAX_ERROR_RENDER_ENTRIES).map(renderLaneError);
}

function renderCrossSegmentWarning(warning: LaneCrossSegmentWarning): string {
  return (
    "⚠ T" +
    warning.citingId +
    "(" +
    warning.citingSegment +
    ") -> T" +
    warning.citedId +
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
 */
export function renderLaneCheckerReports(result: LaneCheckerResult): string {
  const sections: string[] = [];

  sections.push(
    "## ERRORS -- states the grammar forbids; commit refuses while one anchored in your writable scope remains",
  );
  const shownErrors = errorInstanceLines(result.errors);
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
      sections.push(...renderStatsReport(lane));
    }
  }

  sections.push("");
  sections.push("## Report 2 -- component integrity");
  if (result.components.length === 0) {
    sections.push("(no lanes in scope)");
  } else {
    for (const component of result.components) {
      sections.push(...renderComponentReport(component));
    }
  }

  sections.push("");
  sections.push("## Report 3 -- shared components (multi-lane entanglement)");
  if (result.multiLaneComponents.length === 0) {
    sections.push("(none)");
  } else {
    for (const shared of result.multiLaneComponents) {
      sections.push("component@" + shared.representative + ": " + shared.lanes.map(formatTagSet).join(", "));
      sections.push(...renderSharedNodes(shared));
    }
  }

  sections.push("");
  sections.push("## Report 4a -- inter-lane interfaces + per-lane bypass (fewer/zero is the aspiration; nothing enforced)");
  if (result.interfaces.length === 0) {
    sections.push("(no inter-lane interfaces)");
  } else {
    for (const pair of result.interfaces) {
      sections.push(renderInterfacePair(pair));
    }
  }
  if (result.bypass.length === 0) {
    sections.push("(no declared lanes)");
  } else {
    for (const report of result.bypass) {
      sections.push(...renderBypassReport(report));
    }
  }

  sections.push("");
  sections.push("## Report 4b -- start-to-terminus path counts (fact, no target)");
  if (result.paths.length === 0) {
    sections.push("(no lanes in scope)");
  } else {
    for (const path of result.paths) {
      sections.push(...renderPathReport(path));
    }
  }

  sections.push("");
  sections.push("## Report 4c -- time-order violations (the DAG guarantee)");
  if (result.timeOrderViolations.length === 0) {
    sections.push("(none)");
  } else {
    for (const violation of result.timeOrderViolations) {
      sections.push(renderTimeOrderViolation(violation));
    }
  }

  sections.push("");
  sections.push("## Cross-segment warnings");
  if (result.warnings.length === 0) {
    sections.push("(none)");
  } else {
    sections.push(result.warnings.length + " cross-segment tagged edge(s):");
    for (const warning of result.warnings) {
      sections.push(renderCrossSegmentWarning(warning));
    }
  }

  // No trailing "## Vocabulary conformance" section: those two fact lists
  // are error classes E2/E3 now and print in the ERRORS block above (this
  // module's own header, "The error/warning split").
  return sections.join("\n");
}

// --------------------------------------------------------------- digraph --

const MAX_DIGRAPH_COLUMNS = 100;

type DigraphGlyph = "member" | "terminus" | "dead";

function glyphFor(kind: DigraphGlyph): string {
  if (kind === "dead") return "✕"; // dead node
  if (kind === "terminus") return "◎"; // terminus
  return "●"; // member
}

const FINDING_GLYPH = "⚠"; // warning-side finding
const CROSSING_ARROW = "⇐"; // reference-line crossing
/** Error mark, ALWAYS followed by its bracketed class list — the bracket is what keeps it unmistakable for the dead-node `✕`, whose glyph is near-identical in many terminal fonts. */
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

/** True when a lane member or terminus has a report-2/4 finding worth flagging. */
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
  for (const path of result.paths) {
    if (path.status === "ok" && path.pathCount !== null && path.pathCount > 1 && path.terminus !== null) {
      ids.add(path.terminus);
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

/** Segment + exact canonical tag set equality — via `laneToken`'s own escaped join (round-4 review #6: a plain `tagSet.join("")` collides `{"a","bc"}` with `{"ab","c"}`). */
function sameLaneKey(a: LaneKey, b: LaneKey): boolean {
  return laneToken(a.segment, a.tagSet) === laneToken(b.segment, b.tagSet);
}

/**
 * The git-log-graph-style text digraph (requirement 2): turn order
 * top-down, one member per line, glyphed member (dot) / terminus (target) /
 * dead-overridden (x) as the ticket's own vocabulary requires, plus a
 * warning glyph for a report-2/4 finding. Deeper cross-lane crossings (a
 * member shared with another lane) render as a reference line ("see T... in
 * another lane") rather than a second branch column - this derives NOTHING:
 * every fact printed here already exists on `result`, read off report 1
 * (membership/dead) and report 4 (terminus).
 *
 * CLI-only, per the spec's own "digraph rendering is human/CLI-only" -
 * `note-settlement-sdk-query.ts`'s `lane_check` tool never calls this.
 *
 * Tag-mandate ticket 03: an ERRORS block leads, listing every instance with
 * its anchor, and each anchored LANE MEMBER additionally carries an inline
 * `✗[E1,...]` mark. The block is what makes the listing complete — an error
 * can anchor at a turn that is no lane's member at all (an untagged
 * extends/narrows forms no lane by construction, and a type error needs no
 * edge whatsoever), so the inline marks alone would silently hide exactly
 * the class of error this ticket exists to surface.
 */
export function renderLaneDigraph(result: LaneCheckerResult): string {
  const flagged = findingTurnIds(result);
  const errorClasses = errorClassesByAnchor(result.errors);
  const lines: string[] = [];

  const shownErrors = errorInstanceLines(result.errors);
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
    const path = result.paths.find((entry) => sameLaneKey(entry.key, lane.key));
    const terminus = path && path.status === "ok" ? path.terminus : null;

    lines.push(truncateToColumns("Lane " + formatTagSet(lane.key)));

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
      const kind: DigraphGlyph = member.dead ? "dead" : member.id === terminus ? "terminus" : "member";
      const glyph = glyphFor(kind);
      const anchored = errorClasses.get(member.id);
      // Errors precede warnings on the line for the same reason they precede
      // them in the report: must-fix before should-consider.
      const errorMark = anchored ? " " + ERROR_GLYPH + "[" + anchored.join(",") + "]" : "";
      const flag = flagged.has(member.id) ? " " + FINDING_GLYPH : "";
      const crossing = seenElsewhere.has(member.id)
        ? " " + CROSSING_ARROW + " see T" + member.id + " in another lane"
        : "";
      lines.push(truncateToColumns("  " + glyph + " T" + member.id + errorMark + flag + crossing));
    }
  }

  if (result.lanes.length === 0) {
    lines.push("(no lanes in scope)");
  }

  return lines.join("\n");
}
