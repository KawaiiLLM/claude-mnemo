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
 * Single-home split (user ruling, S15069 T586): this block carries ONLY the
 * batch-timing rules — the ones that must fire while composing a batch of
 * OTHER tools, before the note tool is even in mind. Everything an agent
 * needs at note-composition time (fields, budgets, the skip test, replace)
 * lives in the note tool's description, stated exactly once. The injection
 * formats themselves (owed suffix, relief block) are not documented anywhere:
 * they explain themselves on sight, and the relief block carries its own
 * authorization text. What cannot be read off the format is the norm — the
 * injected lines are the only legitimate address source — so that is the one
 * sentence spent on them here.
 */
export const NOTE_TAKING_INSTRUCTIONS = `<mnemo-note-taking>
You keep notes on your own turns. The injected "mnemo current turn" line,
its owed suffix, and the backlog-relief block are the ONLY sources of a
note address — never recall one from memory, never invent one.
1. Each turn's first tool batch also settles owed turns — a note or a
   skip per address.
2. A turn's own note is written by a later turn, never by itself.
3. Never open a batch just for notes, except while the relief block is
   present or to correct a note already written.
Fields, budgets, the skip test, and replace live in the note tool's
description.
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
