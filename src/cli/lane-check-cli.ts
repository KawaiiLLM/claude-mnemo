import { Database } from "bun:sqlite";

import { loadLaneCheckScope, type LaneCheckScope } from "../db/lane-checker-load";
import { checkLanes } from "../shared/lane-checker";
import { canonicalTagSet, DEFAULT_SEGMENT, type LaneKey } from "../shared/lane-interpretation";
import {
  buildLaneAnchorAddresses,
  renderLaneCheckerReports,
  renderLaneDigraph,
} from "../shared/lane-checker-render";
import { resolveDatabasePath } from "../shared/paths";

/**
 * The lane checker CLI's testable half (rubric-v10 ticket 06). `scripts/
 * lane-check.ts` is a two-line wrapper (`process.exit(runLaneCheckCli(...))`
 * — the `p1-judge.ts`/`p1-metrics.ts` split's own pattern), so this module
 * can be imported and exercised directly instead of spawned as a
 * subprocess.
 *
 * Both renderers this module calls (`shared/lane-checker-render.ts`) consume
 * ONLY the core's own typed `LaneCheckerResult` — this file's own job is
 * argument parsing, scope resolution (`db/lane-checker-load.ts`) and the DB
 * handle's own lifecycle; it derives no lane semantics of its own.
 *
 * READ-ONLY (hard constraint): `openReadOnlyLaneCheckDatabase` is the
 * production opener and is what `runLaneCheckCli` uses by default —
 * `readonly: true` is passed to `bun:sqlite`'s own `Database` constructor,
 * never a config flag this CLI exposes a way to disable. The only reason an
 * override parameter exists at all is so a test can point the SAME opener
 * at a seeded temp-file database and assert the readonly contract holds
 * (a write through the resulting handle throws) — a test never gets a
 * *different*, writable code path, only a different target file.
 */

const USAGE = `lane-check -- read-only lane checker CLI (rubric-v10 ticket 06)

Prints the four-report lane checker output for a scope, plus a text digraph.
Opens the database READ-ONLY; this tool never writes.

Usage:
  bun scripts/lane-check.ts --session <id> --range <start>-<end>
  bun scripts/lane-check.ts --segment <id>
  bun scripts/lane-check.ts --lane <segment>:<tag1>,<tag2>[,...] [--lane ...]

Options:
  --db <path>      database file (default: the configured production DB)
  --no-digraph     print the four reports only, skip the text digraph
  --help           show this message

--lane's <segment> is either a segment id or the literal word "default"
(the sentinel scope every turn with no segment shares). A lane is one tag
(segment, ONE tag) — each comma-separated tag names its own independent
lane in that segment. Several --lane flags, and several comma-separated
tags within one --lane, may be given; every named lane is widened and
reported together.`;

export interface LaneCheckCliOptions {
  scope: LaneCheckScope | null;
  dbPath?: string;
  digraph: boolean;
  help: boolean;
}

export interface LaneCheckCliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_IO: LaneCheckCliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

/**
 * D5, v11: a lane is `(segment, ONE tag)`, not `(segment, tag SET)` — a
 * `--lane <segment>:<tag1>,<tag2>` still names several lanes at once (the
 * merge, applied at this interface too), but each COMMA-SEPARATED tag now
 * names its OWN independent lane in that segment, so this returns one
 * `LaneKey` per tag rather than one `LaneKey` carrying the whole set.
 */
function parseLaneArgument(raw: string): LaneKey[] {
  const colon = raw.indexOf(":");
  if (colon === -1) {
    throw new Error(`--lane must be "<segment>:<tag1>,<tag2>,...", got "${raw}"`);
  }
  const segmentToken = raw.slice(0, colon);
  const tags = raw
    .slice(colon + 1)
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (segmentToken.length === 0) {
    throw new Error(`--lane "${raw}" names no segment`);
  }
  if (tags.length === 0) {
    throw new Error(`--lane "${raw}" names no tags`);
  }
  const segment = segmentToken === "default" ? DEFAULT_SEGMENT : segmentToken;
  return canonicalTagSet(tags).map((tag) => ({ segment, tag }));
}

/** Throws on any malformed or ambiguous argument set; never partially fills `options.scope`. */
export function parseLaneCheckArguments(argv: readonly string[]): LaneCheckCliOptions {
  const options: LaneCheckCliOptions = { scope: null, digraph: true, help: false };
  let sessionId: number | undefined;
  let range: { start: number; end: number } | undefined;
  let segmentId: number | undefined;
  const laneKeys: LaneKey[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const next = argv[index + 1];

    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--no-digraph":
        options.digraph = false;
        break;
      case "--db":
        if (next === undefined) throw new Error("--db requires a value");
        options.dbPath = next;
        index += 1;
        break;
      case "--session":
        if (next === undefined) throw new Error("--session requires a value");
        sessionId = Number(next);
        index += 1;
        break;
      case "--range": {
        if (next === undefined) throw new Error("--range requires a value");
        const match = /^(\d+)-(\d+)$/.exec(next);
        if (!match) throw new Error(`--range must be "<start>-<end>", got "${next}"`);
        range = { start: Number(match[1]), end: Number(match[2]) };
        index += 1;
        break;
      }
      case "--segment":
        if (next === undefined) throw new Error("--segment requires a value");
        segmentId = Number(next);
        index += 1;
        break;
      case "--lane":
        if (next === undefined) throw new Error("--lane requires a value");
        laneKeys.push(...parseLaneArgument(next));
        index += 1;
        break;
      default:
        throw new Error(`unrecognized argument "${flag}"`);
    }
  }

  if (options.help) {
    return options;
  }

  const scopeKindsGiven = [
    sessionId !== undefined || range !== undefined,
    segmentId !== undefined,
    laneKeys.length > 0,
  ].filter(Boolean).length;
  if (scopeKindsGiven !== 1) {
    throw new Error(
      "exactly one scope is required: --session/--range together, --segment, or one or more --lane",
    );
  }

  if (laneKeys.length > 0) {
    options.scope = { kind: "lanes", laneKeys };
  } else if (segmentId !== undefined) {
    options.scope = { kind: "segment", segmentId };
  } else {
    if (sessionId === undefined || range === undefined) {
      throw new Error("--range requires --session (and vice versa)");
    }
    options.scope = {
      kind: "range",
      sessionId,
      promptStart: range.start,
      promptEnd: range.end,
    };
  }

  return options;
}

export type OpenLaneCheckDatabase = (path: string) => Database;

/** The production opener: `readonly: true` passed straight to `bun:sqlite`'s own constructor — hardcoded, never a flag this CLI exposes a way to turn off. */
export const openReadOnlyLaneCheckDatabase: OpenLaneCheckDatabase = (path) =>
  new Database(path, { readonly: true });

export function runLaneCheckCli(
  argv: readonly string[],
  io: LaneCheckCliIo = DEFAULT_IO,
  openDb: OpenLaneCheckDatabase = openReadOnlyLaneCheckDatabase,
): number {
  let options: LaneCheckCliOptions;
  try {
    options = parseLaneCheckArguments(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("");
    io.stderr(USAGE);
    return 1;
  }

  if (options.help || !options.scope) {
    io.stdout(USAGE);
    return options.help ? 0 : 1;
  }

  const databasePath = resolveDatabasePath(options.dbPath);
  const db = openDb(databasePath);
  try {
    const projection = loadLaneCheckScope(db, options.scope);
    // Ticket 09 (D9): the loader's per-SEGMENT registry/membership counts feed
    // the proliferation warning — the same fourth argument the settlement
    // `lane_check` tool passes, so both surfaces read one verdict.
    const result = checkLanes(
      projection.turns,
      projection.edges,
      projection.outOfVocabularyEdges,
      projection.segmentFacts,
    );
    // floor-and-render-fidelity ticket 03: every rendered turn reference
    // speaks `S<session>/T<prompt>`, the CLI's own digraph included — built
    // from the SAME projection just loaded, exactly like the settlement
    // `lane_check` tool already does.
    const addresses = buildLaneAnchorAddresses(projection.turns);

    io.stdout(renderLaneCheckerReports(result, addresses));
    if (options.digraph) {
      io.stdout("");
      io.stdout("## Digraph");
      io.stdout("");
      io.stdout(renderLaneDigraph(result, addresses));
    }
    return 0;
  } finally {
    db.close();
  }
}
