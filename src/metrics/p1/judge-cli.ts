import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { BlindPair } from "./blind-pairs";
import { toJsonl } from "./blind-pairs";
import type { CliIo } from "./cli";
import {
  buildJudgePrompt,
  createHttpJudgeInvoke,
  readJudgeConfigFromEnv,
  runJudge,
  type JudgeInvoke,
} from "./judge-runner";

const DEFAULT_IO: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

const USAGE = `p1-judge — run a blind judge over exported pairs (ticket 04b).

Usage:
  bun scripts/p1-judge.ts --pairs <pairs.jsonl> --out <verdicts.jsonl> [options]

Options:
  --pairs <path>   pairs file written by \`p1-metrics blind-eval\`
  --out <path>     verdicts JSONL to write
  --limit <n>      judge only the first n pairs
  --dry-run        print the first prompt and exit; calls nothing

Environment:
  P1_JUDGE_MODEL              required; no default, the judge is a choice
  P1_JUDGE_API_KEY            required (falls back to ANTHROPIC_API_KEY)
  P1_JUDGE_API_URL            default https://api.anthropic.com/v1/messages
  P1_JUDGE_MAX_TOKENS         default 512
  P1_JUDGE_ANTHROPIC_VERSION  default 2023-06-01

The key file is never read here: the judge process cannot see which side is
which even if it wanted to.`;

export interface JudgeCliOptions {
  pairs?: string;
  out?: string;
  limit?: number;
  dryRun: boolean;
  help: boolean;
}

export function parseJudgeArguments(argv: string[]): JudgeCliOptions {
  const options: JudgeCliOptions = { dryRun: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const next = argv[index + 1];

    switch (flag) {
      case "--pairs":
        if (next === undefined) throw new Error("--pairs requires a value");
        options.pairs = next;
        index += 1;
        break;
      case "--out":
        if (next === undefined) throw new Error("--out requires a value");
        options.out = next;
        index += 1;
        break;
      case "--limit": {
        const parsed = Number(next);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("--limit must be a positive integer");
        }
        options.limit = parsed;
        index += 1;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return options;
}

/**
 * Read the pairs file, skipping its declaration header and rejecting anything
 * that is neither. A silently dropped malformed line would show up later as a
 * missing verdict with no cause attached.
 */
export function readPairs(path: string): BlindPair[] {
  const pairs: BlindPair[] = [];

  readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .forEach((line, index) => {
      const parsed = JSON.parse(line) as Partial<BlindPair> & {
        kind?: unknown;
      };
      if (parsed.kind === "blind-pairs-header") {
        return;
      }
      if (typeof parsed.pairId !== "string" || !parsed.a || !parsed.b) {
        throw new Error(
          `${path}: line ${index + 1} is neither a pair nor the header.`,
        );
      }
      pairs.push(parsed as BlindPair);
    });

  return pairs;
}

export interface JudgeMainDependencies {
  io?: CliIo;
  env?: Record<string, string | undefined>;
  invoke?: JudgeInvoke;
}

export async function judgeMain(
  argv: string[],
  dependencies: JudgeMainDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? DEFAULT_IO;
  const env = dependencies.env ?? (process.env as Record<string, string | undefined>);

  let options: JudgeCliOptions;
  try {
    options = parseJudgeArguments(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(USAGE);
    return 1;
  }

  if (options.help || argv.length === 0) {
    io.stdout(USAGE);
    return options.help ? 0 : 1;
  }

  if (!options.pairs) {
    io.stderr("--pairs is required.");
    return 1;
  }

  let pairs: BlindPair[];
  try {
    pairs = readPairs(options.pairs);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (options.dryRun) {
    const first = pairs[0];
    if (!first) {
      io.stderr("No pairs to judge.");
      return 1;
    }
    const { system, user } = buildJudgePrompt(first);
    io.stdout(`--- system ---\n${system}\n--- user ---\n${user}`);
    return 0;
  }

  if (!options.out) {
    io.stderr("--out is required.");
    return 1;
  }

  let config;
  try {
    config = readJudgeConfigFromEnv(env);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const invoke = dependencies.invoke ?? createHttpJudgeInvoke();
  const attempted =
    options.limit === undefined ? pairs : pairs.slice(0, options.limit);

  // Zero pairs is not a vacuous success: with --limit now rejecting anything
  // below 1, the only way here is an empty (or header-only) pairs file, and a
  // "0/0 judged" run must not exit 0 — the whole point of this CLI's exit code
  // is to say whether the trial was measured, not whether it was attempted.
  if (attempted.length === 0) {
    io.stderr("No pairs to judge.");
    return 1;
  }

  const result = await runJudge({
    pairs,
    config,
    invoke,
    limit: options.limit,
    onFailure: (failure) => io.stderr(`${failure.pairId}: ${failure.error}`),
  });

  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(options.out, toJsonl(result.verdicts), "utf8");

  io.stdout(
    `judged ${result.verdicts.length}/${attempted.length} pairs with ${config.model} ` +
      `(${result.failures.length} failed) -> ${options.out}`,
  );

  // A run that answered most of the pairs is not a partial success, it is a
  // failed measurement with a plausible-looking output file: the pairs a judge
  // cannot answer are not a random sample of the pairs. So every gap — a
  // failure, a pair with no verdict, a pairId answered twice — is listed and
  // the exit code is non-zero, and the operator decides whether to re-run or to
  // score a deliberately reduced set with an explicit --limit.
  const verdictIds = result.verdicts.map((verdict) => verdict.pairId);
  const counts = new Map<string, number>();
  for (const pairId of verdictIds) {
    counts.set(pairId, (counts.get(pairId) ?? 0) + 1);
  }
  const duplicated = [...counts]
    .filter(([, count]) => count > 1)
    .map(([pairId]) => pairId);
  const unanswered = attempted
    .map((pair) => pair.pairId)
    .filter((pairId) => !counts.has(pairId));

  const gaps: string[] = [];
  if (result.failures.length > 0) {
    gaps.push(
      `failed: ${result.failures.map((failure) => failure.pairId).join(", ")}`,
    );
  }
  if (unanswered.length > 0) {
    gaps.push(`no verdict: ${unanswered.join(", ")}`);
  }
  if (duplicated.length > 0) {
    gaps.push(`judged twice: ${duplicated.join(", ")}`);
  }

  if (gaps.length > 0) {
    io.stderr(
      `incomplete judging — ${verdictIds.length}/${attempted.length} pairs have exactly one verdict:`,
    );
    for (const gap of gaps) {
      io.stderr(`  ${gap}`);
    }
    return 1;
  }

  return 0;
}
