import { describe, expect, test } from "bun:test";

import {
  createNoteTakingContextHandler,
  NOTE_TAKING_INSTRUCTIONS,
} from "../../src/hooks/handlers/context-note-taking";
import { MNEMO_TOOL_DESCRIPTIONS } from "../../src/mcp/definitions";
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

  test("the block is the address norm and nothing else (T781: single home completed)", () => {
    // The T586 split left timing HERE and the contract in the note tool's
    // description. T781 moved timing across too, because the split is what
    // broke: this block said "first tool batch" while the description ended
    // with "goes last in its batch", and read together at a glance they are
    // opposites — the agent repeatedly settled owed turns in a batch of their
    // own, after answering, which rule 3 forbids. A tool description is in
    // context whenever the tool is, so timing never needed a second home.
    //
    // What cannot move is the address NORM: the injected formats (the
    // current-turn line, the relief block) teach themselves on sight, but
    // "these lines are the only legitimate source" cannot be read off a
    // format, and it belongs where the formats appear. The contract clauses
    // are pinned in tests/mcp/definitions.test.ts; the two pin sets stay
    // disjoint, because a clause stated on both surfaces is how they
    // diverged before. Ticket 03 retired the owed SUFFIX itself (see the
    // "timing contract has exactly one home" test below) — this comment no
    // longer names it as a format this block documents.
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

    // The pointer at the single home, timing now included.
    expect(flat).toContain(
      "Timing, fields, budgets, the skip test and replace live in the note tool's description",
    );

    // Timing must NOT be restated here. These are the exact phrases that
    // contradicted the description; a re-added copy of either fails.
    expect(flat).not.toContain("first tool batch");
    expect(flat).not.toContain("goes last");
    expect(flat).not.toContain("Never open a batch just for notes");

    // The 0.9.11 heuristic and the pre-T586 duplicated contract must both be
    // gone: no batch-picking advice, no field or skip prose here.
    expect(flat).not.toContain("a batch whose result cannot change");
    expect(flat).not.toContain("title (~");
    expect(flat).not.toContain("skip:true");

    // 908 → 152 (T586) → measured again here after timing moved out. Capped
    // with headroom; the description's own token cap lives in
    // tests/mcp/definitions.test.ts.
    expect(estimateTokens(NOTE_TAKING_INSTRUCTIONS)).toBeLessThanOrEqual(110);
  });

  // Ticket 03 (note-cadence-backlog): "the note timing wording exists in
  // exactly ONE home" as a cross-file assertion, not a trust exercise between
  // two doc comments that both claim it — the 0.11.1 incident was exactly two
  // files each stating a timing rule, disagreeing with each other. Every
  // distinguishing phrase of the CURRENT timing contract (spec's rule 1
  // unchanged, rule 2 rewritten to the backlog-relief trigger) must appear on
  // the note tool's own description and must NOT appear on the SessionStart
  // block.
  test("timing contract has exactly one home: the note tool's description, never the SessionStart block", () => {
    const note = MNEMO_TOOL_DESCRIPTIONS.note;
    const flat = NOTE_TAKING_INSTRUCTIONS.replace(/\s+/gu, " ");

    const timingSignatures = [
      "note only FINISHED turns",
      "never the one in progress",
      "backlog relief appears",
      "never just to write one turn's note early",
    ];

    for (const signature of timingSignatures) {
      expect(note, `note description should state: ${signature}`).toContain(signature);
      expect(
        flat,
        `SessionStart block must not restate: ${signature}`,
      ).not.toContain(signature);
    }

    // The SessionStart block's own text: a pointer at the single home, not a
    // second copy of what the home says.
    expect(flat).toContain("Timing, fields, budgets, the skip test and replace live in the note tool's description");
  });

  test("it stays out of other events", async () => {
    const result = await createNoteTakingContextHandler()(
      createInput({ eventName: "PostToolUse" }),
    );

    expect(result).toEqual({ continue: true });
  });
});
