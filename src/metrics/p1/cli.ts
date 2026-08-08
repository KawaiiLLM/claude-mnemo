import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Database } from "bun:sqlite";

import {
  exportBlindPairs,
  toJsonl,
  unblindVerdicts,
  type PairExportStats,
  type PairKeyRow,
  type UnblindedTally,
  type VerdictRow,
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
  type MisattributionReport,
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
  --out <prefix>         blind-eval output prefix (default ./p1-blind-eval)
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
      ],
    }),
  );

  if (written) {
    lines.push("");
    lines.push(`pairs -> ${written.pairsPath}`);
    lines.push(`key   -> ${written.keyPath}  (keep away from the judge)`);
  }

  return lines.join("\n");
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

  if (tally.unmatched.length > 0) {
    lines.push(
      `unmatched pair ids (not in the key): ${tally.unmatched.length} — ` +
        `${tally.unmatched.slice(0, 5).join(", ")}`,
    );
  }

  return lines.join("\n");
}

export function renderMisattribution(
  report: MisattributionReport,
  limit: number,
): string {
  const lines: string[] = [];
  lines.push("(c) MIS-ATTRIBUTION — same text on two turns of one session");
  lines.push(
    `min ${report.minCharacters} chars · prefix ratio ${report.prefixRatio} · ` +
      "victims = cluster members after the earliest; a pure shift (each text " +
      "on exactly one wrong turn) leaves no duplicate and is not visible here.",
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

  return lines.join("\n");
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
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

export async function main(
  argv: string[],
  io: CliIo = DEFAULT_IO,
): Promise<number> {
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
        const verdicts = readJsonl<VerdictRow>(options.verdicts!);
        const key = readJsonl<PairKeyRow>(keyPath);
        const tally = unblindVerdicts(verdicts, key);
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
            const pairsPath = `${options.out}.pairs.jsonl`;
            const keyPath = `${options.out}.key.jsonl`;
            writeFile(pairsPath, toJsonl(exported.pairs));
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
      jsonPayload.misattribution = report;
      sections.push(renderMisattribution(report, options.limit));
    }

    if (options.json) {
      io.stdout(JSON.stringify(jsonPayload, null, 2));
    } else {
      io.stdout(sections.join("\n\n"));
    }

    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    db?.close();
  }
}
