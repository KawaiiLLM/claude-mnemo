import { renderReplayQuery } from "./commands/query";
import { renderReplaySchema } from "./commands/schema";
import { renderReplayShow } from "./commands/show";
import { parseReplayFile } from "./parser";

function parseNumber(value: string | undefined, flag: string): number {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}

function parseRange(value: string | undefined): { start: number; end: number } {
  if (!value) {
    throw new Error("Missing value for --range");
  }
  const match = /^T(\d+)\.\.T(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid range: ${value}`);
  }
  return {
    start: Number.parseInt(match[1]!, 10),
    end: Number.parseInt(match[2]!, 10),
  };
}

export function runReplayParseCommand(argv: string[]): string {
  const [subcommand, transcriptPath, ...rest] = argv;

  if (!subcommand || !transcriptPath) {
    throw new Error("Usage: replay-parse <schema|query|show> <jsonl-path> ...");
  }

  const result = parseReplayFile(transcriptPath);

  if (subcommand === "schema") {
    return renderReplaySchema(result);
  }

  if (subcommand === "query") {
    const options: Record<string, unknown> = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (token === "-f") {
        options.fields = rest[++index];
      } else if (token === "--all") {
        options.all = true;
      } else if (token === "--last") {
        options.last = parseNumber(rest[++index], "--last");
      } else if (token === "--first") {
        options.first = parseNumber(rest[++index], "--first");
      } else if (token === "--range") {
        options.range = parseRange(rest[++index]);
      } else if (token === "--grep") {
        options.grep = rest[++index];
      } else if (token === "-i") {
        options.ignoreCase = true;
      }
    }
    return renderReplayQuery(result, options);
  }

  if (subcommand === "show") {
    const turnToken = rest.shift();
    const match = /^T(\d+)$/.exec(turnToken ?? "");
    if (!match) {
      throw new Error("Usage: replay-parse show <jsonl> T<n> [options]");
    }
    const options: Record<string, unknown> = {};
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (token === "--no-tool-result") {
        options.noToolResult = true;
      } else if (token === "--thinking") {
        options.thinking = true;
      } else if (token === "--raw") {
        options.raw = true;
      } else if (token === "--preview") {
        options.preview = parseNumber(rest[++index], "--preview");
      }
    }
    return renderReplayShow(result, Number.parseInt(match[1]!, 10), options);
  }

  throw new Error(`Unknown subcommand: ${subcommand}`);
}

function isDirectExecution(): boolean {
  const argv1 = process.argv[1] ?? "";
  return argv1.endsWith("/replay-parse.cjs") || argv1.endsWith("/cli.ts");
}

if (isDirectExecution()) {
  const output = runReplayParseCommand(process.argv.slice(2));
  process.stdout.write(`${output}\n`);
}
