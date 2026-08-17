# 06 — Settlement election

**What to build:** The settlement pass ranks a window's turns and elects at most floor(10%·N) A and floor(30%·N) B — seats are ceilings, never targets. New era-gated tier facet on turns (legacy 0–4 grades stay behind the old era, never mixed). A validator rejects over-quota submissions and the subagent re-ranks (mandatory re-rank, no mechanical demotion). The settlement prompt's grading duty rewrites to the one-line criterion: how much does this task's future depend on this turn. ADR-0003.

**Blocked by:** None — can start immediately.

**Status:** done — tier storage + ceiling validator + duty-1 rewrite landed. Two flagged deviations accepted at review: (1) election era is a NEW placeholder constant (inert in production until a release-time ticket pins the epoch — the segment-era rollback pattern, deliberate); (2) duty 3 still reads grades and is dead for new-era windows until tickets 07/08 land — known ADR-0003 consequence.

- [ ] Tier storage is era-gated; a legacy-era read never sees tiers and a new-era read never sees 0–4 grades
- [ ] Validator rejects over-ceiling submissions naming the ceiling; an empty or sparse election passes (ceilings are not targets)
- [ ] The settlement prompt carries the ranking criterion and ceilings; the old rubric text is gone from the duty
- [ ] Mutation checks: ceiling validator and era gate each demonstrated red
