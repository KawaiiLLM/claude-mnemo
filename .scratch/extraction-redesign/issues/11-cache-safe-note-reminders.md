# 11 — Cache-safe note reminders (retire the floating-attachment channel)

**What to build:** the pending-notes reminder stops killing the prompt cache. Claude Code renders Pre/PostToolUse hook `additionalContext` as floating `attachment` entries (48/59 reminder hits in the S15069 transcript are attachment-type, not message content) and re-renders them at request assembly; when the bytes at an old position change — which the per-turn-varying pending list guarantees — the tail cache breakpoint dies and the whole prefix re-ingests at cache-write price (~12× input cost per turn boundary, verified by an instrumented session showing the index-diff on the previous turn's last tool_result). UserPromptSubmit context is structurally safe: it fires once per prompt, and persists inside the user message bytes (15 in-message hits in the same transcript).

**User rulings (2026-08-09, S15069):**

- **裁决 22** — the ordinary reminder moves to UserPromptSubmit (`prompt-dispatch`), overriding D2's placement ruling. Each debt is reminded **at most once** by the ordinary path: only never-before-reminded debts are listed. The "不为笔记单开工具批" rule is retained via wording — append notes to a tool batch you were opening anyway; a turn that needs no tools skips.
- **裁决 23** (confirms 21) — the relief valve is unchanged: pending ≥5 writable debts + 5 dry turns → re-remind the oldest ≤5 **regardless of the reminded marker**, with the dedicated note-only batch authorized.
- **Unified principle** — mnemo emits **zero** `additionalContext` on tool-adjacent events (PreToolUse/PostToolUse); those land on the floating channel. Prompt/session events carry everything. Audit `pre-tool-dispatch` emissions under the same principle.
- **裁决 24** (2026-08-09 追加) — skip criterion in the framework text: a reminded turn that carries nothing worth noting, or whose details are no longer retrievable from the agent's context (e.g. it predates a compact), is **skipped** — never fabricate a note from the reminder line alone.
- **裁决 24 补** (2026-08-09, user-approved) — a skip is an **explicit, cheap call**: the `note` tool gains an optional `skip` boolean (title/content not required when set); it closes the debt into the **existing** skipped/aged terminal state (no new status vocabulary — if the close-reason enum must grow a value, follow the `ensureNoteDebtClosedReason` rebuild precedent). Rationale: compacts are routine and strand the oldest debts as permanently unwritable; under silent skipping those clog the relief window (relief re-reminds oldest ≤5) and pollute the dry-turn counter, so refusal must be distinguishable from neglect. Skip calls obey the batch rule — appended to an existing batch or the relief batch, never standalone. Edge semantics: a real note after a skip is accepted and replaces it (late good note beats aging, existing precedent); a skip for an already-noted turn is a no-op.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Implementation notes

- `note_debt` gains a reminded marker column (via `addColumnIfMissing`, joining the guarded-migration set). Ordinary selection filters to unmarked debts; marking happens in the same immediate transaction as the per-prompt claim (mirror the CAS discipline `note-relief.ts` already uses on this event). Mark only on actual emission — if relief precedence suppresses the ordinary section, nothing is marked.
- Precedence: if relief fires this prompt, the ordinary reminder is suppressed; its unlisted new debts stay unmarked and surface next prompt.
- `result-dispatch` stops emitting the reminder. Decide the entry's fate under the unified principle: PostToolUse rule tips must not emit `additionalContext` either, and the prompt-side rule dispatcher already exists — if nothing is left, retire the hooks.json entry and the dead wiring in `hook-command.ts`.
- Framework text (`context-note-taking.ts`): trigger becomes "with the user's prompt"; notes go at the end of the current/first tool batch; a debt is reminded once — no repeat until relief; "never start a tool call just to write a note" stays, relief as sole exception. Update the stale D2-era comments in `note-reminder.ts` (the relief path is no longer "the one reminder at turn start").
- Rolled-back notices and the escalation wording ladder (driven by `writableTotal`) carry over unchanged; the 50-turn aging rule is untouched.
- Accepted risk (record, don't solve): a marked-but-dropped reminder (hook timeout) never re-reminds until relief — relief is the recovery, same as today.

## Acceptance criteria

- [ ] No mnemo handler returns `additionalContext` for PreToolUse/PostToolUse events (grep-verifiable; hooks.json reflects it)
- [ ] prompt-dispatch lists only never-reminded writable debts, marks them transactionally on emission, and yields to relief when both would fire
- [ ] Relief behavior byte-for-byte unchanged except coexistence rules
- [ ] Framework text updated; all D2-era placement comments corrected
- [ ] Full suite + typecheck green; bundles rebuilt cleanly (local node_modules via `cp -Rc`, no realpath noise)
