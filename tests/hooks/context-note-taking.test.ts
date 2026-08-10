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
    // Asserted against a whitespace-collapsed copy: the block is hard-wrapped
    // to keep the injected paragraph narrow, so a sentence that reads as one
    // phrase can be split by a newline at any time.
    const flat = NOTE_TAKING_INSTRUCTIONS.replace(/\s+/gu, " ");
    // 裁决 25: the injection is the current turn's own address, and the note is
    // written during the turn it describes — the reminder protocol whose
    // one-turn lag manufactured pure-shift mis-attributions is gone.
    expect(flat).toContain("mnemo current turn: S…/T…");
    expect(flat).toContain("with the user's message");
    expect(flat).toContain("The note describes this turn only");
    expect(flat).toContain("the newer note replaces");
    // 裁决 26: sealing at the first batch was 0.9.4's rule and it survived the
    // protocol change — S18993/T93 filed its note two seconds after dispatching
    // a worker, so the report that arrived next never entered it. The note now
    // waits for the batch that looks final, and any later result reopens it.
    expect(flat).toContain("the batch you expect to be this turn's last");
    expect(flat).toContain("let it wait rather than seal the turn early");
    expect(flat).toContain("in this turn or a following one");
    expect(flat).toContain("Never start a tool call just to write a note");
    expect(flat).toContain('"backlog relief" list');
    // 裁决 24: the refusal is explicit, and a note invented from a listed line
    // — the only thing left when the turn predates a compact — would poison
    // the corpus with confident fiction. Ticket 12: "left your context" is not
    // "unrecoverable"; a skip is correct only when recovery would need a tool
    // batch of its own.
    expect(flat).toContain('note(turn:"S…/T…", skip:true)');
    expect(flat).toContain("never invent a note from the listed line");
    expect(flat).toContain("no open batch recovering them in passing");
    expect(flat).toContain("never open a lookup just to rescue one");
    expect(NOTE_TAKING_INSTRUCTIONS).toContain("[S15069/T332]");
    // The note-language rule (裁决 16): without it, agents follow the
    // conversation's language — the S15440 Chinese-notes regression.
    expect(NOTE_TAKING_INSTRUCTIONS).toContain(
      "write title/content/insight in English",
    );
    expect(NOTE_TAKING_INSTRUCTIONS).toContain("never include <private> content");
    // Budgeted as a cached prefix block (~280 tokens in the spec, ~380 as
    // shipped). Re-baselined to 500 for 裁决 22/24, which added the skip
    // protocol and the once-per-turn rule: the block is injected at
    // SessionStart and therefore paid once, into the same cached prefix whose
    // repeated re-ingestion this release exists to stop. Estimated with the
    // 4-chars-per-token rule, not the diary's CJK-weighted one, which reads
    // ~3x high on English prose.
    expect(estimateTokens(NOTE_TAKING_INSTRUCTIONS)).toBeLessThanOrEqual(500);
  });

  test("it stays out of other events", async () => {
    const result = await createNoteTakingContextHandler()(
      createInput({ eventName: "PostToolUse" }),
    );

    expect(result).toEqual({ continue: true });
  });
});
