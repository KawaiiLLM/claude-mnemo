import { Database } from "bun:sqlite";

import {
  loadDeclaredLaneRegistry,
  loadDownstreamTurns,
  loadLaneCheckScope,
  loadLaneControlCapability,
  loadLaneControlEdges,
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
 * THE ATTRIBUTION CONTROL (lane-model-v12 spec "验证", ticket 13; C1/C3/C4
 * retired by main-agent-edges spec D10, ticket 8).
 *
 * ## What this tool is for, and why it is not a checker report
 *
 * C2 answers "is the per-side attribution right" -- whether a SETTLED edge's
 * stored side tag is both a lane its own segment ever declared and a tag the
 * endpoint turn itself carries. It is deliberately NOT a new checker report
 * (spec D6's "不重新设计报表结构"): it lives in its own CLI, reads the
 * database directly, and no gate, prompt or renderer of the checker's
 * consumes it.
 *
 *   C2  per-side declaration/subset violations on SETTLED edges      target 0
 *
 * C1 (blank sides), C3 (lane-less endpoints) and C4 (sampled side audit)
 * were diagnostics over the STORED-side model and are retired without
 * replacement (main-agent-edges D10): E6 accounting now lives in
 * `lane_check`, a lane-less edge is legal, and a declaration is validated at
 * write rather than audited after the fact.
 *
 * ## Every finding carries an address and BOTH side LaneKeys
 *
 * `LaneControlFinding` has no shape in which either can be missing. That is
 * the ticket's own requirement: a reader judges "is THIS attribution right"
 * from the address (which turn) and the two side LaneKeys (which lane each
 * end claims), and only then judges the definition. A finding that named a
 * count without an address would force the reader back to step 2 with
 * nothing to look at.
 *
 * ## NEVER A ZERO STANDING IN FOR AN UNMEASURABLE
 *
 * `LaneControl.measured` is `number | null`. `null` means COULD NOT MEASURE
 * and always arrives with `unmeasurableReason`; the control never reports
 * `0` unless it actually counted zero. This is not defensive decoration --
 * the production database has NOT run the v12 edge migration (verified
 * read-only: `tail_tag`/`head_tag` absent, `memory_edge_side_tags` and
 * `lanes` absent), so the FIRST live run of this tool is exactly the case
 * where a fabricated zero would read as "the attribution is finished".
 *
 * ## READ-ONLY, and how that is established
 *
 *   1. the opener is `openReadOnlyLaneCheckDatabase` — IMPORTED from
 *      `lane-check-cli.ts`, not re-declared, so there is one `readonly: true`
 *      in the lane tooling and no second place to get it wrong;
 *   2. every statement this tool reaches (`db/lane-checker-load.ts`'s control
 *      loaders and the projection loader they share) is a `SELECT`;
 *   3. this tool writes no file at all.
 *
 * `tests/cli/lane-controls-cli.test.ts` pins all three, the third by hashing
 * the database file before and after a full run.
 */

// ------------------------------------------------------------------ shapes

export type LaneControlId = "C2";

/**
 * ONE control finding. The three identity fields are mandatory BY TYPE: the
 * ticket's requirement is that a reader can judge the attribution before the
 * definition, and that judgement needs the source address and the lane each
 * SIDE claims. `tailLane`/`headLane` are always both present — an unsettled
 * side prints `<unsettled>` (`formatLaneSide`), never an empty string.
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

export interface LaneControlsReport {
  databasePath: string;
  capability: LaneControlCapability;
  /** `null` when the capability probe stopped the load. */
  edgeCount: number | null;
  /** Provenance breakdown of the domain — a denominator fact, never a filter. */
  provenanceCounts: Record<string, number>;
  controls: LaneControl[];
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

// -------------------------------------------------------------- control 2

/** One per-side violation on a SETTLED edge — the shape control 2 counts. */
export interface LaneSideAttributionViolation {
  edge: LaneControlEdge;
  side: "tail" | "head";
  /** `undeclared` = the side's tag is not in that endpoint's own segment's registry; `not-on-endpoint` = the tag is not on that endpoint turn itself (spec D2 rule 3, the same invariant error class E4 checks). */
  kind: "undeclared" | "not-on-endpoint";
}

/**
 * C2's raw list. Domain: SETTLED edges only (both sides non-`''`) — an
 * unsettled row (either side `''`) is out of scope, and judging its absent
 * tag against a registry would manufacture a defect that is not this
 * control's to report.
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
      continue; // an unsettled side has no assignment to judge
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
      "every endpoint's tags are a JSON array of strings, so every side gets a verdict",
    ],
    ...cap(findings, findingLimit),
  };
}

// ------------------------------------------------------------------ render

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
  for (const control of report.controls) {
    lines.push("");
    lines.push(...renderControl(control));
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------- CLI

const USAGE = `lane-controls -- read-only attribution control (lane-model-v12 ticket 13)

Answers "is the per-side attribution right?" Opens the database READ-ONLY; it
never writes to the database, and it writes no file at all.

Usage:
  bun scripts/lane-controls.ts [--db <path>] [--segment <id>]... [--findings <n>]

Options:
  --db <path>       database file (default: the configured production DB)
  --segment <id>    restrict the control to this segment (repeatable;
                    default: the whole database)
  --findings <n>    findings printed (default 20; the count line always
                    states the true total)
  --help            show this message`;

export interface LaneControlsCliOptions {
  dbPath?: string;
  segmentIds: number[];
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

  const databasePath = resolveDatabasePath(options.dbPath);
  const db = openDb(databasePath);
  try {
    const report = buildLaneControlsReport(db, databasePath, options);
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

  const controls: LaneControl[] = [
    controlSideAttribution(edges, registry, capability, options.findingLimit),
  ];

  return {
    databasePath,
    capability,
    edgeCount: capability.edgeSideTagColumns ? edges.length : null,
    provenanceCounts,
    controls,
  };
}
