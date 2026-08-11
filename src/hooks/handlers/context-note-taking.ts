import { NOTE_TOKEN_BUDGET } from "../../shared/note-budget";
import type { HookResult, NormalizedHookInput } from "../types";

/**
 * The static note-taking instructions (spec D2 附), injected once per session
 * start so they sit in the cached prefix.
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
 */
export const NOTE_TAKING_INSTRUCTIONS = `<mnemo-note-taking>
You keep notes on your own turns.
Trigger: "mnemo current turn: S…/T…" with the user's message is this turn's
own address. Write its note in a batch whose result cannot change what the
note says — a commit, a push, a check you expect to pass. Which batch is
last is not knowable before its results return, so do not wait for it: a
turn that ends still owing its note is written from ANY batch of a later
turn, results in hand, and that is the ordinary path. The note describes
its own turn only; when a later result changes it, in this turn or a
following one, resend with replace:true.
Never start a tool call just to write a note. Exactly two things authorize
a batch of only note calls: a "backlog relief" list, and correcting a note
already written — a written note owes nothing, so no reminder returns to it.
Answer note(turn:"S…/T…", skip:true) for a turn you owe that holds
nothing worth keeping, or whose details left your context with no open
batch recovering them in passing — never invent a note from the listed
line, never open a lookup just to rescue one.
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
