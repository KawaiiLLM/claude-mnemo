# 01 — Edges become readable: a relations field on recall, and the ↳ rows name their word

**Ruling (S15069/T1447-T1448):** the MCP read surface renders neither the
relation word nor edge tags anywhere, so a writer cannot self-verify an
edge it just wrote (topology visible, semantics invisible — found during
the T1-100 real annotation). Two approved additions:

**What to build:**

1. **`relations` joins the recall field vocabulary** (`filter.fields`),
   OFF by default. When requested, a turn's block renders BOTH directions
   with word and tag set, e.g.:
   `→ override T38 {rule-ledger-tickets+watchdog-liveness}` and
   `← narrows from T48 {…}`. Untagged edges render with no brace suffix.
   Live-endpoint filtering follows the existing Law-8 discipline
   (deleted/dormant endpoints never render). Works at every recall level
   that renders turn blocks; costs nothing when not requested.
2. **Timeline ↳ rows carry the word in parentheses**: `↳ T123(extends),
   T99(consume)` — both the turns views and the milestone views' ↳ lines,
   ruled format exactly `T<n>(<word>)`. Tags stay OFF these rows (they are
   an index, not the microscope; the relations field is the microscope).

**Blocked by:** None — can start immediately.

**Status:** done (mutation-verified: Law-8 strip → 1 red, address-word strip → 11 red; peer completeness bar checked — legacy relations visible (no vocabulary filter in the reader), settlement allowlist carries recall; accepted gap: the costs-nothing-when-unrequested gate is structural, not mutation-pinned)

- [ ] `relations` accepted in `filter.fields`; unrequested output
      byte-identical to today (absence pinned); requested output renders
      both directions with word + tag set, Law-8 filtered
- [ ] ↳ rows in turns and milestone views render `T<n>(<word>)`; a pair
      carrying several relations renders each word once; goldens updated
      deliberately (the format change is the point, not drift)
- [ ] Read-grant semantics unchanged (relations rendering grants nothing
      new — it is a read convenience, not a licensing surface); doc text
      in the tool descriptions updated within their token-budget pins
- [ ] Skill docs (mnemo-recall / mnemo-timeline) updated in the same
      release (stale-teacher constraint)
- [ ] Typecheck + targeted suites green; control-byte scan clean
