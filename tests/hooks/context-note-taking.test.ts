import { describe, expect, test } from "bun:test";

import {
  createNoteTakingContextHandler,
  NOTE_TAKING_INSTRUCTIONS,
} from "../../src/hooks/handlers/context-note-taking";
import { estimateTokens } from "../../src/utils/token-estimate";
import type { NormalizedHookInput } from "../../src/hooks/types";

function createInput(
  overrides: Partial<NormalizedHookInput> = {},
): NormalizedHookInput {
  return {
    eventName: "SessionStart",
    source: "startup",
    sessionId: "session-notes",
    cwd: "/tmp/project",
    stopHookActive: false,
    raw: {},
    ...overrides,
  };
}

describe("note-taking instructions injection", () => {
  test("every session start carries the static block", async () => {
    const handler = createNoteTakingContextHandler();

    for (const source of ["startup", "resume", "clear", "compact"] as const) {
      const result = await handler(createInput({ source }));

      expect(result.hookSpecificOutput).toBe(NOTE_TAKING_INSTRUCTIONS);
      // Injection-only: it must never claim the worker wake.
      expect(result.asyncWork).toBeUndefined();
    }
  });

  test("the block states the protocol the reminder relies on", () => {
    // Instructions, not background: the reminder's trigger, the field contract,
    // the citation form the ledger's addresses use, and the privacy rule.
    expect(NOTE_TAKING_INSTRUCTIONS).toStartWith("<mnemo-note-taking>");
    expect(NOTE_TAKING_INSTRUCTIONS).toEndWith("</mnemo-note-taking>");
    expect(NOTE_TAKING_INSTRUCTIONS).toContain('"pending notes" reminder');
    expect(NOTE_TAKING_INSTRUCTIONS).toContain(
      "Never start a tool call just to write a note",
    );
    expect(NOTE_TAKING_INSTRUCTIONS).toContain("[S15069/T332]");
    // The note-language rule (裁决 16): without it, agents follow the
    // conversation's language — the S15440 Chinese-notes regression.
    expect(NOTE_TAKING_INSTRUCTIONS).toContain(
      "write title/content/insight in English",
    );
    expect(NOTE_TAKING_INSTRUCTIONS).toContain("never include <private> content");
    // Budgeted as a cached prefix block (~280 tokens in the spec). Estimated
    // with the 4-chars-per-token rule, not the diary's CJK-weighted one, which
    // reads ~3x high on English prose.
    expect(estimateTokens(NOTE_TAKING_INSTRUCTIONS)).toBeLessThanOrEqual(400);
  });

  test("it stays out of other events", async () => {
    const result = await createNoteTakingContextHandler()(
      createInput({ eventName: "PostToolUse" }),
    );

    expect(result).toEqual({ continue: true });
  });
});
