# 13 — The prompt injection carries the current turn's address, not a reminder

**What to build:** 裁决 25. The per-prompt pending-notes reminder is abolished.
Each user prompt instead carries one data-only line — `mnemo current turn:
S…/T…` — and the agent writes THAT turn's note at the end of the batch where
the turn's work concludes. The note protocol lives only in the session-start
framework text; the only list-bearing channel left is the backlog relief
(pending ≥5 + 5 dry turns), which is also where missed turns now drain.

**Why:** the trial's first mis-attribution case (S19773 T19→T21) showed the
per-debt reminder MANUFACTURES pure-shift errors: a note for turn N is written
while riding turn N+1, and when N+1 continues the same investigation the agent
writes its present working state under the past turn's address — two
consecutive notes each described the NEXT turn's work, invisible to the
duplicate-based mis-attribution detector. The control case in the same session
(a note written three turns late, across a topic change) was accurate: forced
recall works, same-topic adjacency does not. Writing the note during the turn
itself makes address and content structurally the same thing — there is no
recall step left to get wrong.

**Blocked by:** None — can start immediately.

**Status:** done

## Design decisions

- The line is emitted by `session-init`, not `prompt-dispatch`: the process
  that CREATES the turn row is the only one that knows its prompt number
  without racing the parallel UserPromptSubmit hook. Subagent prompts get no
  line (they have no authority over the root session's ledger).
- The note tool admits the addressed session's LATEST turn without a debt row
  (debts only open at classification, after the turn ends). `skip:true` on the
  current turn inserts the declined row directly, so classification later
  respects the refusal. `classifyCompletedTurn` already absorbs a
  note-before-debt turn without opening anything.
- The reminder machinery retires: handler, routine/escalated renderers, the
  escalation ladder, and the reminded-at claim. The `reminded_at_epoch` column
  stays for the trial's historical reach metric.
- Rolled-back debts close silently at reconcile. Their courtesy line rode the
  reminder; with the channel gone, the timeline's rollback fold is the notice
  (amends user story 5).
- Relief is untouched in mechanism; its wording stays the sole authorisation
  for a dedicated note batch. The skip criterion now speaks of relief-listed
  turns, since the current turn is by definition in context.
- Trial metrics: note latency collapses to 0 and compliance/reach change
  meaning at the deploy epoch — the P1 read must segment there; the ticket
  changes no metric code.

## Acceptance criteria

- [x] Every non-subagent user prompt injects exactly one `mnemo current turn`
  line whose address is the turn row session-init just created
- [x] `note(turn: current)` succeeds with no debt row; the turn's later
  classification opens nothing; `skip:true` on the current turn records
  `declined`
- [x] No per-debt reminder text can render from any path; relief still fires
  under its unchanged gates
- [x] A rolled-back pending debt closes at reconcile without requiring an
  exposure
- [x] Framework text and note-tool description both describe the current-turn
  protocol; framework text stays within its 500-token cap
- [x] Full suite + typecheck green; bundles rebuilt
