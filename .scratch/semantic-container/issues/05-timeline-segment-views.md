# 05 — timeline segment views + milestone admission

**What to build:** `timeline(id="E<n>")` in both views. Turn view: every member in event order, one line per turn — segment ordinal, type glyphs, prompt excerpt → title; no session group headers; ordinals are navigation handles (rendered rows still expose their S/T home). Milestone view: rows admitted only if the segment's state cites them or they hold an A tier (read tiers if present — cited-only until election lands), B-tier rows fill remaining budget in election order; inherits nested rows, collapse counters, overflow pointers and the corrector flag; drops shape signals and orphan anchors. Page overflow filters low-tier rows (the narrative selects, never paginates). Tier labels never print.

**Blocked by:** 02 (members, ordinals); 04 (filter surface).

**Status:** ready-for-agent

- [ ] E turn view renders one line per member in event order with ordinals and glyphs
- [ ] Milestone admission: state-cited rows appear without any tier; A rows appear when tiers exist; B fills only leftover budget
- [ ] Overflow drops lowest-value rows rather than paginating; tier labels absent from output
- [ ] Session (S) views unchanged except tier labels and phases removal
