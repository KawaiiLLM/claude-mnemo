import { query } from "@anthropic-ai/claude-agent-sdk";

import { buildIsolatedEnv } from "./env";

export interface ForkMnemosyneInput {
  sessionId: string;
  prompt: string;
  cwd?: string;
}

export async function forkMnemosyne(
  input: ForkMnemosyneInput,
): Promise<void> {
  const execution = query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      resume: input.sessionId,
      forkSession: true,
      env: buildIsolatedEnv(),
    },
  });

  for await (const _message of execution) {
    // Consume the stream to completion; Mnemosyne communicates via tool calls.
  }
}
