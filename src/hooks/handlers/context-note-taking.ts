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
You keep notes on your own turns (episodic memory across sessions).
Trigger: after a tool result you may see a "pending notes" reminder. When it
appears, append a note call for the listed turns at the end of the current
batch. No reminder — do nothing. Never start a tool call just to write a note.
Skip when the main task is critical; the system will remind you again.
Fields:
- title (~20 tokens): "<activity>+<topic>: <what this turn covered>". Activity
  words (research/design/implement/fix/measure/review/write/ops) must state
  the real stage — never claim "finalized" for work still in design.
- content (~100 tokens): conclusion first, then the key steps. Include
  rejected alternatives with reasons, and who decided (user/data/literature/
  inference). Prefer proper nouns (file names, error names) over narration.
  Do not repeat the title.
- insight: study notes; empty by default. Only knowledge gained this turn
  that is worth keeping long-term and hard to reacquire — pitfalls hit,
  durable pointers, transferable lessons — and orthogonal to this turn's
  conclusion. Already-known facts, perishable state, and anything one search
  away do not qualify.
Rules: write title/content/insight in English; quoted user phrases keep
their original language. The note call always goes last in a batch; cite
other turns only as [S15069/T332] and only ids seen in reminders or injected
context; omit numbers you are not sure of; never include <private> content.
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
