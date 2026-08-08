import type { BlindPair, VerdictRow } from "./blind-pairs";

/**
 * The pluggable judge for metric (b).
 *
 * Three separations are deliberate:
 *
 *   - the runner never reads the key file, so no judge process — however it is
 *     configured — can see which side is which;
 *   - the model and endpoint come from the environment, never from a literal in
 *     this file, so swapping judges is a config change and re-running with a
 *     second model costs nothing in code;
 *   - the transport is an injected `JudgeInvoke`. Tests pass a stub and assert
 *     the call shape; nothing in the test suite can reach the network.
 */

export interface JudgeConfig {
  model: string;
  apiUrl: string;
  apiKey: string;
  maxTokens: number;
  anthropicVersion: string;
}

export interface JudgeInvocation {
  config: JudgeConfig;
  system: string;
  user: string;
}

export type JudgeInvoke = (invocation: JudgeInvocation) => Promise<string>;

export const DEFAULT_JUDGE_API_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 512;

export function readJudgeConfigFromEnv(
  env: Record<string, string | undefined>,
): JudgeConfig {
  const model = env.P1_JUDGE_MODEL?.trim();
  if (!model) {
    throw new Error(
      "P1_JUDGE_MODEL is required (the judge model is deliberately not defaulted).",
    );
  }

  const apiKey = (env.P1_JUDGE_API_KEY ?? env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("P1_JUDGE_API_KEY (or ANTHROPIC_API_KEY) is required.");
  }

  const rawMaxTokens = env.P1_JUDGE_MAX_TOKENS?.trim();
  const maxTokens =
    rawMaxTokens && /^\d+$/u.test(rawMaxTokens)
      ? Number.parseInt(rawMaxTokens, 10)
      : DEFAULT_MAX_TOKENS;

  return {
    model,
    apiUrl: env.P1_JUDGE_API_URL?.trim() || DEFAULT_JUDGE_API_URL,
    apiKey,
    maxTokens,
    anthropicVersion:
      env.P1_JUDGE_ANTHROPIC_VERSION?.trim() || DEFAULT_ANTHROPIC_VERSION,
  };
}

const JUDGE_SYSTEM_PROMPT = `You compare two summaries of the same recorded work turn.

You are given the turn's user prompt and the tools it used, then two candidate
summaries labelled A and B. Each has a title and a body. Decide which summary a
future reader would rather find in a memory index.

Judge on, in order:
1. Faithfulness — nothing asserted that the prompt and tool list do not support.
2. Decision content — the conclusion, the rejected alternatives and who decided,
   rather than a narration of activity.
3. Addressability — concrete proper nouns (files, identifiers, error names) a
   later search could hit.
4. Economy — no filler, no restatement of the title.

The two summaries were produced by two different systems. Do not speculate about
which system wrote which; any guess you make is noise, and formatting has been
normalised so it carries no signal.

Answer with one JSON object and nothing else:
{"winner": "A" | "B" | "tie", "reason": "<= 25 words"}`;

export function buildJudgePrompt(pair: BlindPair): {
  system: string;
  user: string;
} {
  const tools = pair.tools.length > 0 ? pair.tools.join(", ") : "(none recorded)";

  return {
    system: JUDGE_SYSTEM_PROMPT,
    user: [
      `TURN PROMPT: ${pair.prompt}`,
      `TOOLS USED: ${tools}`,
      "",
      `SUMMARY A title: ${pair.a.title}`,
      `SUMMARY A body: ${pair.a.content}`,
      "",
      `SUMMARY B title: ${pair.b.title}`,
      `SUMMARY B body: ${pair.b.content}`,
    ].join("\n"),
  };
}

/** Tolerant parse: models wrap JSON in prose more often than they should. */
export function parseVerdict(pairId: string, text: string): VerdictRow | null {
  const match = /\{[\s\S]*\}/u.exec(text);
  if (!match) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const winner = (parsed as { winner?: unknown }).winner;
  if (winner !== "A" && winner !== "B" && winner !== "tie") {
    return null;
  }

  const reason = (parsed as { reason?: unknown }).reason;

  return {
    pairId,
    winner,
    reason: typeof reason === "string" ? reason : undefined,
  };
}

/**
 * The Anthropic Messages transport. Everything variable — url, model, key,
 * version — arrives through the config, so an OpenAI-compatible gateway that
 * speaks the same shape works by changing P1_JUDGE_API_URL alone.
 */
export function createHttpJudgeInvoke(
  fetchImpl: typeof fetch = fetch,
): JudgeInvoke {
  return async ({ config, system, user }) => {
    const response = await fetchImpl(config.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": config.anthropicVersion,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `judge request failed: ${response.status} ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as {
      content?: { type?: string; text?: string }[];
    };

    return (payload.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  };
}

export interface JudgeFailure {
  pairId: string;
  error: string;
}

export interface JudgeRunResult {
  verdicts: VerdictRow[];
  failures: JudgeFailure[];
}

export interface RunJudgeOptions {
  pairs: BlindPair[];
  config: JudgeConfig;
  invoke: JudgeInvoke;
  limit?: number;
  onVerdict?: (verdict: VerdictRow) => void;
  onFailure?: (failure: JudgeFailure) => void;
}

export async function runJudge(
  options: RunJudgeOptions,
): Promise<JudgeRunResult> {
  const pairs =
    options.limit === undefined
      ? options.pairs
      : options.pairs.slice(0, options.limit);

  const verdicts: VerdictRow[] = [];
  const failures: JudgeFailure[] = [];

  for (const pair of pairs) {
    const { system, user } = buildJudgePrompt(pair);

    try {
      const text = await options.invoke({ config: options.config, system, user });
      const verdict = parseVerdict(pair.pairId, text);

      if (!verdict) {
        const failure = {
          pairId: pair.pairId,
          error: `unparseable verdict: ${text.slice(0, 120)}`,
        };
        failures.push(failure);
        options.onFailure?.(failure);
        continue;
      }

      verdicts.push(verdict);
      options.onVerdict?.(verdict);
    } catch (error) {
      const failure = {
        pairId: pair.pairId,
        error: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
      options.onFailure?.(failure);
    }
  }

  return { verdicts, failures };
}
