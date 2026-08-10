import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";

import type { Database } from "bun:sqlite";

import {
  exportBlindPairs,
  toJsonl,
  unblindVerdicts,
  type PairExportStats,
  type PairKeyRow,
  type UnblindedTally,
} from "./blind-pairs";
import {
  computeCompliance,
  type BucketRow,
  type ComplianceReport,
} from "./compliance";
import {
  listMissingTables,
  openReadOnlyDatabase,
  resolveSessionSelector,
  P1_TABLES,
} from "./database";
import {
  detectMisattribution,
  detectShiftCandidates,
  type MisattributionReport,
  type ShiftCandidateReport,
} from "./misattribution";
import { renderTable } from "./render";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

const COMMANDS = [
  "all",
  "compliance",
  "blind-eval",
  "misattribution",
  "help",
] as const;

type Command = (typeof COMMANDS)[number];

export interface CliOptions {
  command: Command;
  db?: string;
  session?: string;
  json: boolean;
  out: string;
  seed: number;
  minCharacters?: number;
  prefixRatio?: number;
  limit: number;
  agingTurns?: number;
  verdicts?: string;
  key?: string;
}

const USAGE = `p1-metrics — P1 trial measurement (spec D12, ticket 04). Read only.

Usage:
  bun scripts/p1-metrics.ts [command] --db <path> [options]

Commands:
  all             all three metrics (default)
  compliance      note-debt outcomes: written / defaulted / never shown / open
  blind-eval      export anonymised A/B pairs, or score verdicts with --verdicts
  misattribution  duplicate-text signature across response / legacy / shadow
  help            this text

Options:
  --db <path>            database to read. Opened read-only (file:...?mode=ro)
                         and with PRAGMA query_only. No default — pass
                         ~/.claude-mnemo/memory.db explicitly.
  --session <id>         restrict to one session: 15069, S15069 or the uuid
  --json                 emit JSON instead of tables
  --out <prefix>         blind-eval output prefix (default ./p1-blind-eval).
                         Must stay inside the working directory: one of the two
                         files it writes is the un-blinding key
  --seed <n>             blind-eval A/B randomisation seed (default 1)
  --verdicts <path>      score this verdicts JSONL against the key; makes
                         metric (b) the judged win rate instead of a pair count
  --key <path>           key path for --verdicts (default <out>.key.jsonl)
  --aging-turns <n>      compliance: aging bound (default 50)
  --min-chars <n>        misattribution: shortest text considered (default 80)
  --prefix-ratio <r>     misattribution: shorter/longer length floor (default 0.5)
  --limit <n>            misattribution: instances printed (default 20)

The judge itself lives in scripts/p1-judge.ts (model and endpoint from
P1_JUDGE_MODEL / P1_JUDGE_API_URL / P1_JUDGE_API_KEY).`;

export function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "all",
    json: false,
    out: "./p1-blind-eval",
    seed: 1,
    limit: 20,
  };

  let index = 0;
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-")) {
    if (!(COMMANDS as readonly string[]).includes(first)) {
      throw new Error(`Unknown command: ${first}`);
    }
    options.command = first as Command;
    index = 1;
  }

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  const requireNumber = (flag: string, value: string | undefined): number => {
    const parsed = Number(requireValue(flag, value));
    if (!Number.isFinite(parsed)) {
      throw new Error(`${flag} requires a number`);
    }
    return parsed;
  };

  for (; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const next = argv[index + 1];

    switch (flag) {
      case "--db":
        options.db = requireValue(flag, next);
        index += 1;
        break;
      case "--session":
        options.session = requireValue(flag, next);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--out":
        options.out = requireValue(flag, next);
        index += 1;
        break;
      case "--seed":
        options.seed = requireNumber(flag, next);
        index += 1;
        break;
      case "--verdicts":
        options.verdicts = requireValue(flag, next);
        index += 1;
        break;
      case "--key":
        options.key = requireValue(flag, next);
        index += 1;
        break;
      case "--aging-turns":
        options.agingTurns = requireNumber(flag, next);
        index += 1;
        break;
      case "--min-chars":
        options.minCharacters = requireNumber(flag, next);
        index += 1;
        break;
      case "--prefix-ratio":
        options.prefixRatio = requireNumber(flag, next);
        index += 1;
        break;
      case "--limit":
        options.limit = requireNumber(flag, next);
        index += 1;
        break;
      case "-h":
      case "--help":
        options.command = "help";
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return options;
}

function percent(value: number | null): string | null {
  return value === null ? null : `${(value * 100).toFixed(1)}%`;
}

function bucketRows(rows: BucketRow[]): (string | number | null)[][] {
  return rows.map((row) => [
    row.label,
    row.counts.total,
    row.counts.noted,
    row.counts.defaulted,
    row.counts.unreached,
    row.counts.open,
    row.counts.waived,
    percent(row.complianceRate),
    percent(row.reachRate),
  ]);
}

const COMPLIANCE_HEADERS = [
  "bucket",
  "debts",
  "written",
  "defaulted",
  "unreached",
  "open",
  "waived",
  "compliance",
  "reach",
];

export function renderCompliance(report: ComplianceReport): string {
  const lines: string[] = [];

  lines.push("(a) NOTE COMPLIANCE — note_debt ledger");
  lines.push(
    `sessions ${report.sessionsCovered} · aging bound ${report.agingTurns} turns · ` +
      `notes without a debt row ${report.notesWithoutDebt} · ` +
      `writer_model inferred from session for ${report.inferredWriterModels} debts`,
  );
  lines.push(
    "compliance = written / (written + defaulted); a debt that aged out without " +
      "ever being shown counts as unreached, not as a miss.",
  );
  lines.push("");
  lines.push(
    renderTable({
      headers: COMPLIANCE_HEADERS,
      rows: bucketRows([report.overall]),
    }),
  );

  for (const [title, rows] of [
    ["by session length", report.bySessionLength],
    ["by turn weight (substantive tool calls)", report.byTurnWeight],
    ["by writer model", report.byWriterModel],
  ] as [string, BucketRow[]][]) {
    lines.push("");
    lines.push(title);
    lines.push(renderTable({ headers: COMPLIANCE_HEADERS, rows: bucketRows(rows) }));
  }

  const { latency } = report;
  lines.push("");
  lines.push(
    `note latency (turns between the turn and the note): n=${latency.measured} · ` +
      `median ${latency.median ?? "—"} · p90 ${latency.p90 ?? "—"} · ` +
      `within 3 turns ${percent(latency.withinThreeTurns) ?? "—"}`,
  );

  return lines.join("\n");
}

export function renderPairStats(
  stats: PairExportStats,
  written?: { pairsPath: string; keyPath: string },
): string {
  const lines: string[] = [];
  lines.push("(b) BLIND EVAL — shadow note vs legacy extraction, same turn");
  lines.push(
    renderTable({
      headers: ["measure", "count"],
      rows: [
        ["shadow notes", stats.shadowNotes],
        ["turns with a legacy title", stats.legacyExtracted],
        ["pairs exportable", stats.candidates],
        ["dropped: no legacy summary", stats.droppedMissingLegacy],
        ["dropped: a field empty on one side", stats.droppedEmptyField],
        ["title prefixes stripped", stats.titlePrefixesStripped],
      ],
    }),
  );

  // Named here and nowhere near the pairs file: these are per-source and would
  // themselves be the tell if a judge ever saw them.
  lines.push("");
  lines.push(
    "residual length signal — median body characters after anonymisation: " +
      `shadow ${stats.shadowContentMedianCharacters ?? "—"} · ` +
      `legacy ${stats.legacyContentMedianCharacters ?? "—"}`,
  );

  if (written) {
    lines.push("");
    lines.push(`pairs -> ${written.pairsPath}`);
    lines.push(`key   -> ${written.keyPath}  (keep away from the judge)`);
  }

  return lines.join("\n");
}

function gapLine(label: string, ids: string[]): string {
  return `${label}: ${ids.length} — ${ids.slice(0, 10).join(", ")}${
    ids.length > 10 ? ", …" : ""
  }`;
}

export function renderTally(tally: UnblindedTally): string {
  const lines: string[] = [];
  lines.push(
    renderTable({
      headers: ["verdict", "count"],
      rows: [
        ["scored", tally.scored],
        ["shadow note wins", tally.shadowWins],
        ["legacy summary wins", tally.legacyWins],
        ["tie", tally.ties],
        ["shadow win rate (decided)", percent(tally.shadowWinRate)],
      ],
    }),
  );

  if (!tally.complete) {
    lines.push("");
    lines.push(
      "INCOMPLETE — no win rate is reported. A rate over a partial verdict set " +
        "measures the pairs the judge managed to answer, not the trial. Fill " +
        "the gaps below and re-score.",
    );
    if (tally.missing.length > 0) {
      lines.push(gapLine("  key pairs with no verdict", tally.missing));
    }
    if (tally.unmatched.length > 0) {
      lines.push(gapLine("  verdicts not in the key", tally.unmatched));
    }
    if (tally.duplicates.length > 0) {
      lines.push(gapLine("  pair ids judged twice", tally.duplicates));
    }
    if (tally.invalid.length > 0) {
      lines.push(gapLine("  malformed verdict rows", tally.invalid));
    }
    if (
      tally.missing.length === 0 &&
      tally.unmatched.length === 0 &&
      tally.duplicates.length === 0 &&
      tally.invalid.length === 0
    ) {
      lines.push("  the key file is empty — nothing to score against.");
    }
  }

  return lines.join("\n");
}

export function renderMisattribution(
  report: MisattributionReport,
  limit: number,
  shifts?: ShiftCandidateReport,
): string {
  const lines: string[] = [];
  lines.push("(c) MIS-ATTRIBUTION — same text on two turns of one session");
  lines.push(
    `min ${report.minCharacters} chars · prefix ratio ${report.prefixRatio} · ` +
      "victims = cluster members after the earliest; a pure shift (each text " +
      "on exactly one wrong turn) leaves no duplicate — see the shift " +
      "candidates below for the shadow channel's approximation.",
  );
  lines.push("");
  lines.push(
    renderTable({
      headers: [
        "channel",
        "texts",
        "clusters",
        "victims",
        "rate",
        "victims ex-retry",
        "rate ex-retry",
      ],
      rows: report.channels.map((channel) => [
        channel.channel,
        channel.eligible,
        channel.clusters,
        channel.victims,
        percent(channel.rate),
        channel.victimsExcludingRetries,
        percent(channel.rateExcludingRetries),
      ]),
    }),
  );

  if (report.missingChannels.length > 0) {
    lines.push("");
    lines.push(
      `channels skipped (P1 not enabled): ${report.missingChannels.join(", ")}`,
    );
  }

  if (report.clusters.length > 0) {
    lines.push("");
    lines.push(`instances (top ${Math.min(limit, report.clusters.length)}):`);
    for (const cluster of report.clusters.slice(0, limit)) {
      const members = cluster.members
        .map(
          (member) =>
            `${member.turnRef}${member.wasRolledBack ? "(rolled-back)" : ""}${
              member.wasInterrupted ? "(interrupted)" : ""
            }`,
        )
        .join(" = ");
      lines.push(
        `  [${cluster.channel}/${cluster.kind}] ${members} :: ${cluster.sample}`,
      );
    }
  }

  if (shifts) {
    lines.push("");
    lines.push(
      `shift candidates (shadow notes matching a neighbour turn better · ` +
        `margin ${shifts.margin} · floor ${shifts.floor} · ±${shifts.neighborDistance} turns):`,
    );
    lines.push(
      "  candidates for adjudication, not victims — a dispatch turn's note " +
        "legitimately shares vocabulary with the turn where its work lands.",
    );
    if (shifts.candidates.length === 0) {
      lines.push(`  none of ${shifts.notesConsidered} notes flagged.`);
    } else {
      lines.push(
        `  ${shifts.candidates.length} of ${shifts.notesConsidered} notes flagged:`,
      );
      for (const candidate of shifts.candidates.slice(0, limit)) {
        lines.push(
          `  ${candidate.turnRef} reads like ${candidate.bestNeighborRef} ` +
            `(own ${candidate.ownOverlap.toFixed(2)} vs ` +
            `${candidate.neighborOverlap.toFixed(2)}) :: ${candidate.title.slice(0, 60)}`,
        );
      }
    }
  }

  return lines.join("\n");
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Walk up from `path` to the nearest ancestor that exists on disk. */
function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

/**
 * blind-eval writes two files derived from one `--out` prefix, and one of them
 * is the key that de-anonymises the whole trial. Confining the prefix to the
 * working directory keeps a mistyped or pasted `--out` from dropping that key
 * into a shared location — and since this is the only writing path in an
 * otherwise read-only tool, the confinement costs nothing else.
 *
 * The lexical check alone trusts `path.resolve`, which never looks at the
 * filesystem: a symlinked directory sitting lexically inside `cwd` (e.g.
 * `./out -> /elsewhere`) passes it and still writes outside `cwd` for real. So
 * once the string check passes, the nearest ancestor of the target that
 * actually exists is realpath'd — the target file itself usually does not
 * exist yet, this call is about to create it — and the same containment check
 * runs again against the realpath'd root.
 */
export function resolveOutputPath(path: string, cwd = process.cwd()): string {
  const root = resolve(cwd);
  const resolved = resolve(root, path);
  const inside = relative(root, resolved);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(
      `--out must stay inside the working directory; ${path} resolves to ${resolved}.`,
    );
  }

  const realRoot = realpathSync(root);
  const ancestor = nearestExistingAncestor(dirname(resolved));
  const realAncestor = realpathSync(ancestor);
  const realInside = relative(realRoot, realAncestor);
  if (realInside.startsWith("..") || isAbsolute(realInside)) {
    throw new Error(
      `--out must stay inside the working directory; ${path} resolves to ${resolved}, ` +
        `whose existing parent ${ancestor} is a symlink escaping ${realRoot}.`,
    );
  }

  return resolved;
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function p1NotEnabledMessage(db: Database): string | null {
  const missing = listMissingTables(db, P1_TABLES);
  if (missing.length === 0) {
    return null;
  }
  return `P1 not enabled in this database (missing ${missing.join(", ")}).`;
}

export interface MainOptions {
  /** The directory `--out` is confined to. Injected so tests need no chdir. */
  cwd?: string;
}

export async function main(
  argv: string[],
  io: CliIo = DEFAULT_IO,
  mainOptions: MainOptions = {},
): Promise<number> {
  const cwd = mainOptions.cwd ?? process.cwd();
  let options: CliOptions;

  try {
    options = parseArguments(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(USAGE);
    return 1;
  }

  if (options.command === "help") {
    io.stdout(USAGE);
    return 0;
  }

  // With verdicts in hand, metric (b) is the judged win rate rather than a
  // count of what could be paired — and scoring is pure file work, so
  // `blind-eval --verdicts` alone needs no database at all.
  const scoring = options.verdicts !== undefined;

  if (!options.db && !(scoring && options.command === "blind-eval")) {
    io.stderr("--db is required (no default: this tool never guesses a path).");
    io.stderr(USAGE);
    return 1;
  }

  let db: Database | null = null;

  try {
    if (options.db) {
      db = openReadOnlyDatabase(options.db);
    }

    let sessionId: number | undefined;
    if (options.session !== undefined) {
      if (!db) {
        io.stderr("--session needs --db.");
        return 1;
      }
      const resolved = resolveSessionSelector(db, options.session);
      if (resolved === null) {
        io.stderr(`No session matches ${options.session}.`);
        return 1;
      }
      sessionId = resolved;
    }

    const sections: string[] = [];
    const jsonPayload: Record<string, unknown> = {};
    // A gap in the verdict set is a failed measurement, not a footnote: the exit
    // code has to say so, or a scripted run reports a win rate it never had.
    let incompleteScoring = false;
    const wants = (command: Command): boolean =>
      options.command === "all" || options.command === command;

    if (wants("compliance") && db) {
      const notEnabled = p1NotEnabledMessage(db);
      if (notEnabled) {
        sections.push(`(a) NOTE COMPLIANCE — ${notEnabled}`);
      } else {
        const report = computeCompliance(db, {
          sessionId,
          agingTurns: options.agingTurns,
        });
        jsonPayload.compliance = report;
        sections.push(renderCompliance(report));
      }
    }

    if (wants("blind-eval")) {
      if (scoring) {
        const keyPath = options.key ?? `${options.out}.key.jsonl`;
        const verdicts = readJsonl<unknown>(options.verdicts!);
        const key = readJsonl<PairKeyRow>(keyPath);
        const tally = unblindVerdicts(verdicts, key);
        incompleteScoring = !tally.complete;
        jsonPayload.blindEval = tally;
        sections.push(
          "(b) BLIND EVAL — verdicts scored against the key\n" +
            renderTally(tally),
        );
      } else if (db) {
        const notEnabled = p1NotEnabledMessage(db);
        if (notEnabled) {
          sections.push(`(b) BLIND EVAL — ${notEnabled}`);
        } else {
          const exported = exportBlindPairs(db, {
            sessionId,
            seed: options.seed,
          });
          jsonPayload.blindEval = {
            stats: exported.stats,
            pairs: exported.pairs.length,
          };

          // `all` reports what is pairable; only the explicit subcommand writes.
          if (options.command === "blind-eval") {
            const pairsPath = resolveOutputPath(
              `${options.out}.pairs.jsonl`,
              cwd,
            );
            const keyPath = resolveOutputPath(`${options.out}.key.jsonl`, cwd);
            // The header rides the pairs file so the file itself states what was
            // normalised and what was left; it is not a pair and the judge
            // runner skips it.
            writeFile(pairsPath, toJsonl([exported.header, ...exported.pairs]));
            writeFile(keyPath, toJsonl(exported.key));
            sections.push(
              renderPairStats(exported.stats, { pairsPath, keyPath }),
            );
          } else {
            sections.push(renderPairStats(exported.stats));
          }
        }
      }
    }

    if (wants("misattribution") && db) {
      const report = detectMisattribution(db, {
        sessionId,
        minCharacters: options.minCharacters,
        prefixRatio: options.prefixRatio,
      });
      const shifts = detectShiftCandidates(db, { sessionId });
      jsonPayload.misattribution = report;
      jsonPayload.shiftCandidates = shifts;
      sections.push(renderMisattribution(report, options.limit, shifts));
    }

    if (options.json) {
      io.stdout(JSON.stringify(jsonPayload, null, 2));
    } else {
      io.stdout(sections.join("\n\n"));
    }

    if (incompleteScoring) {
      io.stderr(
        "blind-eval scoring is incomplete — see the gap list above; no win rate was computed.",
      );
      return 1;
    }

    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    db?.close();
  }
}
