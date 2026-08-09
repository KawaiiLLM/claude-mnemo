# 12 — Reclaim the word "skip", and price the skip criterion

**What to build:** the reminder text stops contradicting 裁决 24. Two wording defects found live on 2026-08-09, the first day 0.9.3's prompt-side reminder ran:

1. **"skip" means two things.** The escalation ladder closes with `skipping is no longer authorized`, and the routine line closes with `skip if this turn needs no tools`. In both, "skip" means *defer this reminder* — the pre-0.9.3 sense. Since 裁决 24, `note(turn, skip:true)` means *close this debt as `declined`*, an honest terminal answer. The escalated line therefore reads as forbidding the one response the ticket-11 design added, and the routine line reads as recommending it for a turn that simply opened no batch. The word must belong to exactly one of the two meanings: the tool call keeps it, every deferral is named a deferral.

2. **The skip criterion prices nothing.** The framework text says to skip when a turn's "details have left your context (e.g. it predates a compact)". Observed in practice: two task-notification turns looked unwritable from context, but a `turns` row already in front of me carried their titles and responses, so a real note was cheap and a skip would have thrown away recoverable material. "Not in context" is not the same as "not recoverable" — what makes a skip correct is that recovering the turn would cost a tool batch of its own, which the standing rule forbids opening for a note. The criterion must say so: details recovered in passing make the turn writable again; a lookup opened solely to rescue a note is never justified.

**Blocked by:** None — can start immediately.

**Status:** done

## Implementation notes

- Both reminder closing lines live in `note-reminder.ts`'s renderer, with the wording ladder's rationale in the escalation constant's doc comment; the same "told to skip" phrasing has leaked into two handler doc comments and must move with it.
- The skip criterion is stated twice — in the session-start framework text and in the `note` tool description — and the two are read together by the agent, so they change together or they disagree.
- The framework text sits under a token cap; adding the recovery clause must stay inside it, trimming elsewhere if needed rather than raising the cap.
- No schema, no behavior, no new state: `declined` semantics, the escalation threshold, and the relief valve are unchanged. This ticket changes only what the agent is told.

## Acceptance criteria

- [x] No injected text uses "skip"/"skipping" for deferring a reminder; the word appears only for the `skip:true` tool call
- [x] The escalated closing line forbids deferral while explicitly preserving the honest `skip:true` answer
- [x] The routine closing line tells a batch-less turn to leave the debt for backlog relief, not to "skip" it
- [x] Both statements of the skip criterion carry the recovery clause: recovered-in-passing means write it, and no lookup may be opened just to rescue a note
- [x] Framework text stays within its token cap (508 → 499 by tightening the added clause, cap left at 500)
- [x] Full suite + typecheck green; bundles rebuilt
