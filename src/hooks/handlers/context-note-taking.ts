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
 * Single home, completed (user ruling, S15069 T781; the split began at T586).
 * The timing rules used to live HERE and everything else in the note tool's
 * description, on the reasoning that timing must fire while composing a batch
 * of OTHER tools, before the note tool is in mind. That split is what broke:
 * this block said "first tool batch" while the description ended with "goes
 * last in its batch", and the two read as opposites at a glance — the agent
 * repeatedly settled owed turns in a batch of their own, after answering,
 * which is the one thing rule 3 forbids. A tool description is in context
 * whenever the tool is, so the premise that timing needed a second home was
 * wrong; timing now lives with the fields, stated once.
 *
 * What stays is the only thing the description cannot carry: the address
 * NORM. The injection formats (the current-turn line, the relief block) are
 * documented nowhere on purpose — they explain themselves on sight — but
 * "these lines are the only legitimate source" cannot be read off a format,
 * so it is stated here, where the formats appear.
 *
 * Ticket 03 (note-cadence-backlog): the current-turn line's owed SUFFIX
 * retired (structurally always present, so zero information — see
 * `hooks/note-reminder.ts`'s doc comment) — this text no longer names it as
 * a source. The single-home rule this ticket exists to enforce is the SAME
 * one the paragraph above already states: timing lives ONLY in the note
 * tool's description, never restated here — see
 * `tests/hooks/context-note-taking.test.ts`'s "timing contract has exactly
 * one home" test, which cross-checks this string against
 * `MNEMO_TOOL_DESCRIPTIONS.note` directly rather than trusting either file's
 * own comment.
 */
export const NOTE_TAKING_INSTRUCTIONS = `<mnemo-note-taking>
You keep notes on your own turns. The injected "mnemo current turn" line
and the backlog-relief block are the ONLY sources of a note address —
never recall one from memory, never invent one.
Timing, fields, budgets, the skip test and the write modes live in the
note tool's description.
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
