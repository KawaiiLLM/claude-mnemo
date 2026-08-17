# 05 — timeline segment views + milestone admission

**What to build:** `timeline(id="E<n>")` in both views, under the two one-line view
contracts ruled at S15069 T838–T839:

> **milestones** — the lossy skeleton: every row matters, overflow demotes, never paginates.
> **turns** — the lossless ledger: every member present, overflow paginates, never filters.

Milestone rows use the minimal format — `id time type-glyphs title` — no prompt
excerpt (the ticket-01 title contract absorbed the decider's voice), no tier
labels, no antecedent (`↳ +N`) counters; the corrector flag (⚑) and the overflow
pointer stay. Admission: state-cited ∪ A-tier (read tiers if present — cited-only
until election data exists), B-tier rows fill remaining budget in election order.
Turn view: every member, one line per turn in event order with segment ordinals
(navigation handles; rows expose their S/T home), prompt excerpt retained as
narrative raw material; overflow paginates exactly like recall. This corrects the
earlier tool-level rule "timeline filters on overflow" — lossiness belongs to the
skeleton view, not to the tool. Session (S) views: same minimal milestone row,
same per-view overflow; shape signals stay session-side only.

**Blocked by:** 02 (members, ordinals); 04 (filter surface).

**Status:** ready-for-agent

- [ ] Milestone rows render as `id time glyphs title`; no excerpt, no tier labels, no antecedent counters; ⚑ and the overflow pointer survive
- [ ] Milestone admission: state-cited rows appear without any tier; A rows appear when tiers exist; B fills only leftover budget; overflow demotes, never paginates
- [ ] Turn view renders every member one-per-line in event order with ordinals and glyphs; overflow paginates, never filters
- [ ] Session (S) views adopt the same minimal milestone row and per-view overflow; phases stays retired
