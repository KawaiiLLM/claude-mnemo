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

  test("the block states the prompt-clock protocol (ticket 04)", () => {
    // Instructions, not background: the reminder's trigger, the field contract,
    // the citation form the ledger's addresses use, and the privacy rule.
    expect(NOTE_TAKING_INSTRUCTIONS).toStartWith("<mnemo-note-taking>");
    expect(NOTE_TAKING_INSTRUCTIONS).toEndWith("</mnemo-note-taking>");
    // Asserted against a whitespace-collapsed copy: the block is hard-wrapped
    // to keep the injected paragraph narrow, so a sentence that reads as one
    // phrase can be split by a newline at any time.
    const flat = NOTE_TAKING_INSTRUCTIONS.replace(/\s+/gu, " ");

    // --- Trigger line and the new injection shape (spec D3) ---
    // 裁決 25's own-address line is unchanged, but it now grows an owed
    // suffix and, at 5+ owed, a backlog-relief block — both rendered by
    // session-init every prompt (ticket 03). The block must say these ARE
    // the owed-address channel, or the agent goes hunting from memory.
    expect(flat).toContain('mnemo current turn: S…/T…" is this turn\'s address');
    expect(flat).toContain('· owed: S…/T…" suffix');
    expect(flat).toContain('"+N older" if more');
    expect(flat).toContain('"mnemo pending notes (backlog relief):" block');
    expect(flat).toContain("the ONLY source of an owed address");
    expect(flat).toContain("even after a compact");
    expect(flat).toContain("never recall or invent one");

    // --- 0.9.11 heuristic must be fully gone (ticket 04 AC) ---
    // The batch-result-independence rule this ticket supersedes: no batch is
    // "the right one" to wait for any more, since the note is unconditionally
    // deferred (rule 2) and a wrong write is fixed with replace:true instead.
    expect(flat).not.toContain(
      "a batch whose result cannot change what the note says",
    );
    expect(flat).not.toContain("Exactly two things authorize");

    // --- Three rules + 3′ (spec D6), each independently locatable ---
    expect(flat).toContain("Never start a tool call just to write a note");
    expect(flat).toContain(
      "Every turn's first tool batch also settles what a previous turn still",
    );
    expect(flat).toContain("owes — note or skip, same eligibility and batch as any note");
    // Operational discipline folded into rule 1 rather than stated
    // separately (issue 04 revision): timely skipping is what keeps backlog
    // relief's threshold from being the only thing that empties the queue.
    expect(flat).toContain("owed count is backlog relief's only fuel");
    // Rule 2: the note describes a turn that has already ended by the time
    // it is written — never composed inside the turn it is about.
    expect(flat).toContain(
      "This turn's OWN note waits for a later turn to write",
    );
    expect(flat).toContain("never send it in the turn it describes");
    // Rule 3 + 3′: the two things that still authorize a note-only batch —
    // unchanged in substance from 0.9.11's "exactly two things", restated as
    // the exception to the opening prohibition instead of a standalone list.
    expect(flat).toContain(
      "A note/skip-only batch may open alone when the backlog-relief block is",
    );
    expect(flat).toContain("to correct a note already written — the only exceptions");

    // --- replace:true absorbs the old result-independence heuristic ---
    expect(flat).toContain("A later result that overturns");
    expect(flat).toContain("is fixed by resending with replace:true");
    expect(flat).toContain(
      "a decline needs no replace before the real note that follows it",
    );

    // --- Skip criterion (issue 04, revised S15069 T577/T579/T580/T581) ---
    // A single dimension — does the turn hold anything unique — not a
    // taxonomy. The user explicitly rejected enumerating interrupted/resent/
    // bookkeeping as separate tests ("打不打断也不重要"): they are examples
    // of the one question's answer, never a checklist to sort a turn into.
    expect(flat).toContain(
      "would a future retriever find anything unique in this turn",
    );
    // The operational form of the same question (T581): would deleting the
    // turn cost the project anything real.
    expect(flat).toContain(
      "if deleting this turn from history would cost the project no decision, no progress, and no coherence",
    );
    expect(flat).toContain('note(turn:"S…/T…", skip:true)');
    expect(flat).toContain(
      'those are common shapes of "nothing unique," not separate tests',
    );
    expect(flat).toContain("For illustration only, not a category list");
    // The red line (unchanged in substance across every prior revision):
    // never invent from a reminder line, and incidental recovery undoes the
    // skip.
    expect(flat).toContain(
      "Content that has left your context with no batch recovering it in passing is skipped, never invented from the listed line",
    );
    expect(flat).toContain("recovering it in passing makes it writable again");
    // The hard line: a user decision/correction/veto or any turn with a
    // conclusion, rejected option, or lesson is never skippable, whatever the
    // tool count — this is the one place tool-call count is explicitly
    // disclaimed as irrelevant to the skip decision.
    expect(flat).toContain(
      "Never skip a user decision, correction, or veto, or any turn with a",
    );
    expect(flat).toContain("however short — whatever the tool count");

    // --- Retained checklist (issue 04's "保留清单") ---
    expect(flat).toContain("the addressing line, one glance says what the turn did");
    expect(flat).toContain("the evidence chain that produced it");
    expect(flat).toContain("Never restate the title; never narrate looking");
    expect(flat).toContain("insight (~60 tokens)");
    // An insight is retrieved far from the turn that produced it — it is FTS
    // indexed but renders only at expanded depth, so a search hit shows the
    // title beside it and nothing else.
    expect(flat).toContain("it must stand alone: claim first, evidence after");
    expect(flat).toContain("reports its token count against these budgets");
    expect(NOTE_TAKING_INSTRUCTIONS).toContain("[S15069/T332]");
    // The note-language rule (裁决 16): without it, agents follow the
    // conversation's language — the S15440 Chinese-notes regression.
    expect(NOTE_TAKING_INSTRUCTIONS).toContain(
      "write title/content/insight in English",
    );
    expect(NOTE_TAKING_INSTRUCTIONS).toContain("never include <private> content");
    expect(flat).toContain("The note call always goes last in a batch");

    // Re-baselined for ticket 04 (note-prompt-clock): the previous 680-token
    // cap covered the 0.9.11 batch-result-independence protocol, which this
    // release deletes outright. In its place the block now has to teach the
    // owed-suffix/backlog-relief injection shape (new in ticket 03, previously
    // undocumented here) AND the full skip criterion the old block only
    // gestured at in one sentence — a single test, its operational
    // (deletion-cost) form, the red line, and the hard line. Measured 908
    // tokens as shipped; capped at 950 for headroom. A budget is the softer
    // constraint when it collides with a rule that has to be stated — the
    // alternative here is a shorter block that does not say when to write or
    // where an owed address comes from.
    expect(estimateTokens(NOTE_TAKING_INSTRUCTIONS)).toBeLessThanOrEqual(950);
  });

  test("it stays out of other events", async () => {
    const result = await createNoteTakingContextHandler()(
      createInput({ eventName: "PostToolUse" }),
    );

    expect(result).toEqual({ continue: true });
  });
});
