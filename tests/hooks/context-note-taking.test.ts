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

  test("the block is the timing digest and defers the contract (T586 split)", () => {
    // Single-home split (user ruling, S15069 T586): this block carries ONLY
    // what must fire while composing a batch of OTHER tools — the address
    // norm and the three timing rules — and points at the note tool's
    // description for everything else. The contract clauses themselves are
    // pinned in tests/mcp/definitions.test.ts; the two pin sets are disjoint
    // on purpose, because a clause stated on both surfaces is how they
    // diverged before.
    expect(NOTE_TAKING_INSTRUCTIONS).toStartWith("<mnemo-note-taking>");
    expect(NOTE_TAKING_INSTRUCTIONS).toEndWith("</mnemo-note-taking>");
    // Asserted against a whitespace-collapsed copy: the block is hard-wrapped
    // to keep the injected paragraph narrow, so a sentence that reads as one
    // phrase can be split by a newline at any time.
    const flat = NOTE_TAKING_INSTRUCTIONS.replace(/\s+/gu, " ");

    // The address norm — the one thing the injected formats cannot teach on
    // sight. The formats themselves (owed suffix shape, relief threshold) are
    // deliberately NOT documented: they explain themselves when they appear,
    // and the relief block carries its own authorization text.
    expect(flat).toContain('The injected "mnemo current turn" line');
    expect(flat).toContain("the ONLY sources of a note address");
    expect(flat).toContain("never recall one from memory, never invent one");

    // The three timing rules, each independently locatable.
    expect(flat).toContain(
      "Each turn's first tool batch also settles owed turns — a note or a skip per address",
    );
    expect(flat).toContain(
      "A turn's own note is written by a later turn, never by itself",
    );
    expect(flat).toContain("Never open a batch just for notes");
    expect(flat).toContain(
      "except while the relief block is present or to correct a note already written",
    );

    // The pointer at the single home.
    expect(flat).toContain(
      "Fields, budgets, the skip test, and replace live in the note tool's description",
    );

    // The 0.9.11 heuristic and the pre-T586 duplicated contract must both be
    // gone: no batch-picking advice, no field or skip prose here.
    expect(flat).not.toContain("a batch whose result cannot change");
    expect(flat).not.toContain("title (~");
    expect(flat).not.toContain("skip:true");

    // 908 → 152 measured after the T586 split: the block stopped restating
    // the contract and stopped documenting injection formats that teach
    // themselves. Capped with headroom; the description's own 500-token cap
    // (user decree) lives in tests/mcp/definitions.test.ts.
    expect(estimateTokens(NOTE_TAKING_INSTRUCTIONS)).toBeLessThanOrEqual(170);
  });

  test("it stays out of other events", async () => {
    const result = await createNoteTakingContextHandler()(
      createInput({ eventName: "PostToolUse" }),
    );

    expect(result).toEqual({ continue: true });
  });
});
