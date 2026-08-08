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
        if (!Number.isFinite(parsed)) throw new Error("--limit requires a number");
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

export function readPairs(path: string): BlindPair[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as BlindPair);
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
    `judged ${result.verdicts.length}/${pairs.length} pairs with ${config.model} ` +
      `(${result.failures.length} failed) -> ${options.out}`,
  );

  return result.failures.length > 0 && result.verdicts.length === 0 ? 1 : 0;
}
