import { query } from "@anthropic-ai/claude-agent-sdk";

import { buildIsolatedEnv } from "./env";

export interface ForkMnemosyneInput {
  sessionId: string;
  prompt: string;
  cwd?: string;
}

export interface ForkMnemosyneResult {
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  durationMs: number;
}

export async function forkMnemosyne(
  input: ForkMnemosyneInput,
): Promise<ForkMnemosyneResult | null> {
  const execution = query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      resume: input.sessionId,
      forkSession: true,
      maxTurns: 15,
      env: buildIsolatedEnv(),
    },
  });

  let result: ForkMnemosyneResult | null = null;

  for await (const message of execution) {
    if (message.type === "result") {
      result = {
        numTurns: message.num_turns,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
        durationMs: message.duration_ms,
      };
    }
  }

  return result;
}
