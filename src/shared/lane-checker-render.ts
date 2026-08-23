import type {
  LaneBypassReport,
  LaneCheckerResult,
  LaneComponentReport,
  LaneCrossSegmentWarning,
  LaneFoldedPaths,
  LaneInterfacePair,
  LaneMember,
  LaneOutOfVocabularyEdge,
  LanePathReport,
  LaneState,
  LaneStatsReport,
  LaneTimeOrderViolation,
  LaneTypeConformanceViolation,
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
 *     digraph"), and the CLI prints it ahead of the digraph. Also carries
 *     the vocabulary-conformance fact block (semantic-conformance ticket 02)
 *     as its own trailing section, past "Cross-segment warnings" — a numeric
 *     fact like every report above it, so it belongs on the same compact
 *     surface, never the digraph.
 *   - `renderLaneDigraph` - the git-log-graph-style text digraph
 *     (requirement 2). CLI-only, per the spec's own "digraph rendering is
 *     human/CLI-only; agents receive the numeric reports."
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

/** One line per `LaneTypeConformanceViolation` (semantic-conformance ticket 02) — the empty case and the outside-vocabulary case read distinctly, never the same string with an empty word list. */
function renderTypeViolation(violation: LaneTypeConformanceViolation): string {
  if (violation.types.length === 0) {
    return "  T" + violation.id + " - type: [] (empty)";
  }
  return (
    "  T" +
    violation.id +
    " - type: [" +
    violation.types.join(",") +
    "] (outside vocabulary: " +
    violation.outsideVocabulary.join(",") +
    ")"
  );
}

function renderOutOfVocabularyEdge(edge: LaneOutOfVocabularyEdge): string {
  return "  T" + edge.citingId + " -> T" + edge.citedId + " (" + edge.relation + ")";
}

/** `count` vs a possibly-capped `entries` list — the same "(showing first N of count)" suffix both `vocabularyConformance` sub-blocks use. */
function cappedCountSuffix(count: number, shown: number): string {
  return count > shown ? " (showing first " + shown + ")" : "";
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

  sections.push("");
  sections.push("## Vocabulary conformance -- MEMORY_TYPES/EDGE_RELATIONS closed-set check (reported, never enforced)");
  const typeViolations = result.vocabularyConformance.typeViolations;
  sections.push(
    "types: " + typeViolations.count + cappedCountSuffix(typeViolations.count, typeViolations.entries.length),
  );
  if (typeViolations.entries.length === 0) {
    sections.push("(none)");
  } else {
    for (const violation of typeViolations.entries) {
      sections.push(renderTypeViolation(violation));
    }
  }
  const outOfVocabularyEdges = result.vocabularyConformance.outOfVocabularyEdges;
  sections.push(
    "edges: " +
      outOfVocabularyEdges.count +
      cappedCountSuffix(outOfVocabularyEdges.count, outOfVocabularyEdges.entries.length),
  );
  if (outOfVocabularyEdges.entries.length === 0) {
    sections.push("(none)");
  } else {
    for (const edge of outOfVocabularyEdges.entries) {
      sections.push(renderOutOfVocabularyEdge(edge));
    }
  }

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

const FINDING_GLYPH = "⚠"; // finding
const CROSSING_ARROW = "⇐"; // reference-line crossing

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
 */
export function renderLaneDigraph(result: LaneCheckerResult): string {
  const flagged = findingTurnIds(result);
  const lines: string[] = [];

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
      const flag = flagged.has(member.id) ? " " + FINDING_GLYPH : "";
      const crossing = seenElsewhere.has(member.id)
        ? " " + CROSSING_ARROW + " see T" + member.id + " in another lane"
        : "";
      lines.push(truncateToColumns("  " + glyph + " T" + member.id + flag + crossing));
    }
  }

  if (result.lanes.length === 0) {
    lines.push("(no lanes in scope)");
  }

  return lines.join("\n");
}
