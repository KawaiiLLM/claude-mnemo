# 02 — The write gate refuses a bare extends/narrows assertion, and every teaching surface says so

**What to build:** a tagless extends/narrows ASSERTION is refused at the
shared edge-legality layer both write paths (main note tool, settlement
facade) inherit, with a teaching rejection; retraction mirrors
(`retractExtends`/`retractNarrows`) KEEP accepting bare addresses (legacy
untagged rows must stay deletable). Spec: `.scratch/tag-mandate/spec.md`
sections "Write gate" and "The mandate reaches every teaching surface".

Details ruled:
- Word-level check only — no graph-state gates at the write path.
- The rejection message names the mandate and the subset requirement, and
  NEVER reproduces angle-bracket markup (the write-gate-hardening red
  line; the message must pass `containsToolCallSyntax`).
- The extends/narrows assertion `.describe()` lines say tagged-form-only
  (shared zod objects — both surfaces inherit); retraction describes stay
  untouched.
- A stale-example guard (test or source grep) proves no teaching surface
  still shows a bare extends/narrows assertion example.

**Blocked by:** edge-read-surface ticket 01's acceptance commit (territory
overlap on the tool definitions file) — the delegator dispatches this
ticket when that lands.

**Status:** ready-for-agent (dispatch gated by the delegator)

- [ ] Bare extends/narrows assertion refused on both write paths with the
      teaching message; tagged form passes; all other words' bare forms
      unaffected; retraction mirrors accept bare addresses (pinned)
- [ ] Rejection message passes containsToolCallSyntax (pinned)
- [ ] Describe lines updated; stale-example guard green
- [ ] Load-bearing properties declared for mutation acceptance
