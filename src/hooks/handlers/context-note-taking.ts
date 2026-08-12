import { NOTE_TOKEN_BUDGET } from "../../shared/note-budget";
import type { HookResult, NormalizedHookInput } from "../types";

/**
 * The static note-taking instructions (spec note-prompt-clock D6), injected
 * once per session start so they sit in the cached prefix.
 *
 * Instructions only, no background: instructions get followed, overviews get
 * paid for — a project-overview injection measured +20% cost for no accuracy
 * (arXiv 2602.11988). English by 裁决 16, matching the library's existing
 * title/content corpus.
 *
 * The per-field budgets are interpolated from `NOTE_TOKEN_BUDGET`, the same
 * constant the receipt measures a write against. Held as prose they were a
 * second copy: raising the constant would have left the agent told one number
 * and graded on another, with nothing failing to say so.
 *
 * Rewritten for the prompt-clock ledger (ticket 04): 0.9.11's "wait for a
 * batch whose result cannot change the note" heuristic is gone — a turn's
 * note is now simply deferred one turn, unconditionally (rule 2 below), and a
 * result that overturns an already-written note is handled by resending with
 * replace:true rather than by guessing which batch was "last" up front. The
 * owed address itself is no longer something to remember: session-init
 * (spec D3) renders it fresh into every prompt's current-turn line and, at 5
 * or more owed, into the backlog-relief block, so this block only has to
 * teach the agent to read those, never to track them itself.
 */
export const NOTE_TAKING_INSTRUCTIONS = `<mnemo-note-taking>
You keep notes on your own turns.
Trigger: "mnemo current turn: S…/T…" is this turn's address. A previous
turn still owed grows the line a " · owed: S…/T…" suffix (the newest one,
plus "+N older" if more); at 5 or more owed, a "mnemo pending notes
(backlog relief):" block also lists the oldest. These are the ONLY source
of an owed address, refreshed every prompt — even after a compact — so
never recall or invent one.
Never start a tool call just to write a note. Three rules:
1. Every turn's first tool batch also settles what a previous turn still
   owes — note or skip, same eligibility and batch as any note. Skip
   trivial debt right there; owed count is backlog relief's only fuel.
2. This turn's OWN note waits for a later turn to write; never send it in
   the turn it describes.
3. A note/skip-only batch may open alone when the backlog-relief block is
   present, or to correct a note already written — the only exceptions.
A note describes its addressed turn only. A later result that overturns
one, in this turn or a following one, is fixed by resending with
replace:true; a decline needs no replace before the real note that
follows it.
Skip test, one question: would a future retriever find anything unique in
this turn? The check: if deleting this turn from history would cost the
project no decision, no progress, and no coherence, answer
note(turn:"S…/T…", skip:true); otherwise write. Not whether the turn was
interrupted, resent, or was itself a note-bookkeeping round; those are
common shapes of "nothing unique," not separate tests. For illustration
only, not a category list: pure confirmation, a swallowed duplicate send,
a bookkeeping round auditing or backfilling old notes (its output belongs
to the turn it processed). Content that has left your context with no
batch recovering it in passing is skipped, never invented from the listed
line; recovering it in passing makes it writable again. Never skip a user
decision, correction, or veto, or any turn with a conclusion, a rejected
option, or a lesson, however short — whatever the tool count.
Fields:
- title (~${NOTE_TOKEN_BUDGET.title} tokens): "<activity>+<topic>: <what this turn covered>" — the
  addressing line, one glance says what the turn did. Activity words
  (research/design/implement/fix/measure/review/write/ops) must state the
  real stage, never a hoped-for one.
- content (~${NOTE_TOKEN_BUDGET.content} tokens): the conclusion, then the evidence chain that
  produced it — how it was reached, not just that it was. Include rejected
  alternatives with reasons, and who decided (user/data/literature/
  inference). Prefer proper nouns (file names, error names) over narration.
  Never restate the title; never narrate looking — "I checked the transcript
  and found no X" is "the transcript has no X".
- insight (~${NOTE_TOKEN_BUDGET.insight} tokens): empty by default. Only what is worth keeping
  long-term, hard to reacquire, and orthogonal to the conclusion — pitfalls
  hit, durable pointers, transferable lessons. Anything one search away does
  not qualify. It is read far from its turn, so it must stand alone: claim
  first, evidence after, and no session-local literal (id, ticket number)
  in the opening sentence.
- skip: true with turn alone, for the refusal above.
Each write's receipt reports its token count against these budgets — over
budget, cut the next one.
Rules: write title/content/insight in English; quoted user phrases keep
their original language. The note call always goes last in a batch; cite
other turns only as [S15069/T332] and only ids seen in injected context;
omit numbers you are not sure of; never include <private> content.
</mnemo-note-taking>`;

/**
 * Stateless by construction: no database, no filesystem, nothing to fail. The
 * discipline has to be present in every session for the trial's compliance rate
 * to mean anything, so it must not be able to drop out on a read error.
 */
export function createNoteTakingContextHandler() {
  return async function handleNoteTakingContextHook(
    input: NormalizedHookInput,
  ): Promise<HookResult> {
    if (input.eventName !== "SessionStart") {
      return { continue: true };
    }

    return { continue: true, hookSpecificOutput: NOTE_TAKING_INSTRUCTIONS };
  };
}
