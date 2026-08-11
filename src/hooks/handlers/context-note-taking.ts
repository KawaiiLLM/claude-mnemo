import type { HookResult, NormalizedHookInput } from "../types";

/**
 * The static note-taking instructions (spec D2 附), injected once per session
 * start so they sit in the cached prefix.
 *
 * Instructions only, no background: instructions get followed, overviews get
 * paid for — a project-overview injection measured +20% cost for no accuracy
 * (arXiv 2602.11988). English by 裁决 16, matching the library's existing
 * title/content corpus.
 */
export const NOTE_TAKING_INSTRUCTIONS = `<mnemo-note-taking>
You keep notes on your own turns.
Trigger: "mnemo current turn: S…/T…" with the user's message is this turn's
own address. Write its note in the batch you expect to be this turn's last:
while another tool call is still likely, let it wait rather than seal the
turn early — its address stays writable later. The note describes this turn
only; when a later result changes it, in this turn or a following one,
resend with replace:true.
Never start a tool call just to write a note: a turn that opens no batch
writes none — missed turns accumulate for a "backlog relief" list, the only
authorization for a batch of ONLY note calls.
Answer note(turn:"S…/T…", skip:true) for a relief-listed turn holding
nothing worth keeping, or whose details left your context with no open
batch recovering them in passing — never invent a note from the listed
line, never open a lookup just to rescue one.
Fields:
- title (~20 tokens): "<activity>+<topic>: <what this turn covered>" — the
  addressing line, one glance says what the turn did. Activity words
  (research/design/implement/fix/measure/review/write/ops) must state the
  real stage, never a hoped-for one.
- content (~100 tokens): the conclusion, then the evidence chain that
  produced it — how it was reached, not just that it was. Include rejected
  alternatives with reasons, and who decided (user/data/literature/
  inference). Prefer proper nouns (file names, error names) over narration.
  Never restate the title; never narrate looking — "I checked the transcript
  and found no X" is "the transcript has no X".
- insight (~60 tokens): empty by default. Only what is worth keeping
  long-term, hard to reacquire, and orthogonal to the conclusion — pitfalls
  hit, durable pointers, transferable lessons. Anything one search away does
  not qualify.
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
