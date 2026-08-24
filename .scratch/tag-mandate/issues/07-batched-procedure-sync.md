# 07 — The batched settlement procedure syncs into production verbatim

**What to build:** `src/worker/note-settlement-prompt.ts` integrates
revision 7 of the authored text at
`.scratch/tag-mandate/issues/06-prompt-text.md` word-for-word, per that
file's own integration notes:

- Block A replaces the Procedure section's scope/STEP-0 framing AND the
  "Reconcile what is stored ..." paragraph (three-moves text + its
  trailing lane_check sentence retire).
- Block B replaces the Duties edges bullet whole.
- Block C replaces the commit-paragraph appendix (the "Call `lane_check`
  early" sentence retires).
- Block D: D1 appends to the session-narrative duty; D2 replaces the
  output tail's "(or if you are certain there is nothing to do)" clause.
- The Duties preamble's "exactly one `commit`" becomes "one SUCCESSFUL
  `commit`; a refusal is not that commit".

The durable verbatim guard (`tests/worker/note-settlement-prompt.test.ts`
reads the authored file directly) must pass green; line-pin fixtures
update to the new text without weakening. Add absence pins for the three
retired teachings: the "Reconcile what is stored" opener, "Call
`lane_check` early", and the no-op commit exemption clause — each pinned
ABSENT so a future merge cannot resurrect them.

Nothing else in the prompt changes: proposals duty, membership call
shapes, lease semantics, markup/English rules, `{WRITABLE_SET}` plumbing
all stay byte-identical.

**Blocked by:** None (console ticket 04 runs concurrently on disjoint
files).

**Status:** ready-for-agent

- [ ] Verbatim guard green against the revision-7 authored file
- [ ] Three retired sentences pinned absent
- [ ] Duties preamble phrase updated and pinned
- [ ] No behavioral code change outside the prompt strings (diff shows
      prompt text + tests only)
- [ ] Territory: src/worker/note-settlement-prompt.ts,
      tests/worker/note-settlement-prompt.test.ts (and any test file
      whose pins quote the retired sentences). NOT console files (04's),
      NOT the authored .md (already final — never reword it)
- [ ] Load-bearing properties declared for mutation acceptance
