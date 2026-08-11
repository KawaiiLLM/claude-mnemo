# 01 — One truncator, applied everywhere a field is cut

**What to build:** every truncated field in every read surface ends the same
way — on a word boundary, with the same ellipsis — and a multi-line prompt is
one line wherever it is rendered. Today the word-boundary fix reaches only half
the renderer, which is worse than not having it: the same session reads
differently depending on which view you asked for.

Found by a Codex review of `7d9fb4d`. Each item below was independently
confirmed against the code before this ticket was written.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `timeline` output and the SessionStart milestone injection cut on a word
      boundary like `recall` does. `src/mcp/timeline.ts` currently exports its
      own `truncateText(text, maxChars, signal)` — a second function of the
      same name, hard-slicing, and ending in `…` where the other ends in `...`.
      One implementation survives; the duplicate is deleted, not wrapped.
- [ ] The two suffixes are reconciled deliberately. State which one wins and
      why in the code; do not leave a renderer whose ellipsis depends on which
      view produced the line.
- [ ] The expanded turn detail's `- prompt:` and `- response:` lines collapse a
      multi-line value to one line, as the collapsed title slot already does.
      Leaving one of the two fixed is what made the renderer inconsistent.
- [ ] A test covers the expanded view specifically — the existing multi-line
      test only exercises the collapsed title slot, which is why this escaped.
- [ ] The note budget's numbers are interpolated into the prose that states
      them, so `NOTE_TOKEN_BUDGET` is the only place `20`/`100`/`60` appear.
      They are currently hardcoded as literal text in the injected note-taking
      instructions and in the `note` tool description; changing the constant
      would leave three surfaces disagreeing.
- [ ] The budget estimate stops under-reporting quoted CJK. Note fields are
      English by rule, but the same instructions explicitly allow quoted user
      phrases in their original language, and four-characters-per-token reports
      80 Chinese characters as 20 tokens. Whatever the fix, there must be ONE
      estimator per audience, co-located — the diary's CJK-weighted estimator
      and `src/utils/token-estimate`'s plain one already exist and must not
      become three.
- [ ] The ratio no longer prints `(0.0×)` for a small write. A one-decimal
      ratio is fine for the over-budget case it exists to expose; decide what a
      well-under write should read as and make it read that way.
- [ ] Existing timeline tests that assert the old hard-cut behaviour are
      updated deliberately, with the reason recorded — not deleted.
- [ ] Full suite green; `bun run typecheck` and `bun run build` clean.

## Comments

The word-boundary rule itself is settled and must not be re-litigated: retreat
to the last space when the window ends mid-word, keep the whole window when it
already stopped before whitespace, hard-cut when the last space is earlier than
80% of the limit (a URL, a base64 blob, an unbroken CJK run). An earlier
revision also retreated to the last full sentence; that was removed because a
note written conclusion-first ends its first sentence around 45% in, so
honouring it threw away the evidence the rest of the window exists to show.
