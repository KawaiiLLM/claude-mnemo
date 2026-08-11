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
    // "its own turn", not "this turn": a note is now routinely written for an
    // earlier turn from a later turn's batch, so the possessive has to point at
    // the address rather than at the turn doing the writing. The rule 裁决 25
    // pinned — one note describes exactly one turn — is unchanged.
    expect(flat).toContain("The note describes its own turn only");
    // Note guardrails ticket (spec D3): a repeat write used to replace
    // silently; it now demands an explicit declaration, and the instructions
    // must say so or every agent's first rewrite attempt bounces.
    expect(flat).toContain("resend with replace:true");
    // 2026-08-12: 裁决 26's "wait for the batch that looks final" sent 95 of
    // 272 measured notes into a batch of their own — 93 of them with a
    // rideable batch earlier in the same turn — re-reading 22.6M context
    // tokens for the extra requests. The batch you can be confident is last
    // is precisely the one whose results you have not seen, so lastness is
    // undecidable when the note is composed and result-independence is what
    // the rule now tests. Deferral is the ordinary path, not a failure: a
    // turn that ends still owing its note is written from any batch of a
    // LATER turn, which is what 裁决 26's S18993/T93 case needed all along —
    // the worker's report arrived after the note was filed.
    expect(flat).toContain(
      "a batch whose result cannot change what the note says",
    );
    expect(flat).toContain("ANY batch of a later turn");
    expect(flat).toContain("in this turn or a following one");
    expect(flat).toContain("Never start a tool call just to write a note");
    // The authorisation list is exhaustive by construction — a third case was
    // proposed and rejected, since a rule that already decides the case does
    // not need a special case bolted on. A correction is on it because a
    // written note closes its debt: no channel will ever list that turn again,
    // so a deferred correction is a permanently lost one.
    expect(flat).toContain("Exactly two things authorize");
    expect(flat).toContain('"backlog relief" list');
    expect(flat).toContain("correcting a note already written");
    // 裁决 24: the refusal is explicit, and a note invented from a listed line
    // — the only thing left when the turn predates a compact — would poison
    // the corpus with confident fiction. Ticket 12: "left your context" is not
    // "unrecoverable"; a skip is correct only when recovery would need a tool
    // batch of its own.
    expect(flat).toContain('note(turn:"S…/T…", skip:true)');
    expect(flat).toContain("never invent a note from the listed line");
    expect(flat).toContain("no open batch recovering them in passing");
    expect(flat).toContain("never open a lookup just to rescue one");
    // The writing rules (2026-08-11): sixteen consecutive notes ran 1.5x-2.5x
    // over a budget the block stated but never explained the purpose of. Each
    // field now says what it is FOR, which is what the terser version could
    // not convey — and the receipt reports the cost back, so the budget is
    // measured rather than merely declared.
    expect(flat).toContain("the addressing line, one glance says what the turn did");
    expect(flat).toContain("the evidence chain that produced it");
    expect(flat).toContain("Never restate the title; never narrate looking");
    expect(flat).toContain("insight (~60 tokens)");
    // An insight is retrieved far from the turn that produced it — it is FTS
    // indexed but renders only at expanded depth, so a search hit shows the
    // title beside it and nothing else. Of 15 written under the era, 4 opened
    // on a pointer into their own turn ("the brief", "this trap") or on a
    // session-local literal, and those are the ones that do not survive the
    // trip.
    expect(flat).toContain("it must stand alone: claim first, evidence after");
    expect(flat).toContain("reports its token count against these budgets");
    expect(NOTE_TAKING_INSTRUCTIONS).toContain("[S15069/T332]");
    // The note-language rule (裁决 16): without it, agents follow the
    // conversation's language — the S15440 Chinese-notes regression.
    expect(NOTE_TAKING_INSTRUCTIONS).toContain(
      "write title/content/insight in English",
    );
    expect(NOTE_TAKING_INSTRUCTIONS).toContain("never include <private> content");
    // Budgeted as a cached prefix block (~280 tokens in the spec, ~380 as
    // shipped, 500 after 裁决 22/24 added the skip protocol and the
    // once-per-turn rule). Re-baselined to 580 for the writing rules: the
    // field descriptions now carry what a title and a content are FOR, which
    // is what sixteen consecutive 1.5×–2.5× over-budget notes on S15069 showed
    // the terser version could not convey. The block is injected at
    // SessionStart and therefore paid once, into the same cached prefix whose
    // repeated re-ingestion this release exists to stop — 80 tokens once per
    // session against every note the session writes. Estimated with the
    // 4-chars-per-token rule, not the diary's CJK-weighted one, which reads
    // ~3x high on English prose. Re-baselined again to 680 (measured 656) for
    // the batching rule and the insight's standalone requirement: the block is
    // injected once at SessionStart into the cached prefix, so the ~76 added
    // tokens are paid once per session, against the 22.6M context tokens the
    // old rule spent on extra requests in the measured corpus alone. A budget
    // is the softer constraint when it collides with a rule that has to be
    // stated — the alternative here is a shorter block that does not say when
    // to write.
    expect(estimateTokens(NOTE_TAKING_INSTRUCTIONS)).toBeLessThanOrEqual(680);
  });

  test("it stays out of other events", async () => {
    const result = await createNoteTakingContextHandler()(
      createInput({ eventName: "PostToolUse" }),
    );

    expect(result).toEqual({ continue: true });
  });
});
