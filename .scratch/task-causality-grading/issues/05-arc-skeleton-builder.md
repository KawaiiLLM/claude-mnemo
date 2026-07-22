# 05 — Arc-grouped task skeleton builder

**What to build:** A pure rendering module that builds the re-prime task skeleton for a session. Source: the session's full turn set filtered by stored grade directly — it must NOT pass through the milestone daily-budget, selection, or tail-pagination machinery (an early G4 or over-budget G3 must never be silently dropped).

Arc assignment (computable from grades, order, and existing `[T<n>]` citations only):
- every G4 opens a new arc by default;
- a G4 citing an earlier G4 is a re-foundation, grouped into that arc and marked as re-foundation (no rollback implied);
- a G3 attaches to the nearest preceding trusted G4 unless it explicitly cites an earlier arc's G4;
- legacy-era (pre-cutoff) G4/G3 render in a separate trailing `legacy` block, never as trusted backbone; a G3 with no trusted G4 (straddling session before a bridge G4 exists) renders under the legacy block's arc context.

Anchor line format: DB id + grade + title + one compressed semantic clause (~120 chars) from the turn's stored insight (fallback: content excerpt). Casualty rows keep their casualty marker.

Budget: hard cap 4,000 estimated tokens (existing diary token estimator). Class order: session state → live G4 → live G3 → legacy/casualty block → recent-turn bare index → overflow pointer. Intra-class truncation: (1) overflow-pointer space reserved up front; (2) all live G4 lines unconditionally kept; (3) under pressure each arc keeps at least its earliest and latest live G3, remaining space fills newest-first; (4) any omission at any level emits the timeline pointer.

**Blocked by:** 01 — Era cutoff constant and era predicate.

**Status:** ready-for-agent

- [x] Grouping tests: uncited G4 opens a new arc; cited G4 groups as re-foundation into the cited arc with a re-foundation marker; G3 attaches to nearest preceding trusted G4; an explicit citation overrides recency.
- [x] Legacy anchors render only under the `legacy` marker; a straddling session's pre-bridge G3s appear there, not as trusted backbone.
- [x] Anchor lines carry correct DB ids and a semantic clause sourced from insight with content fallback; casualty rows keep their marker.
- [x] Skeleton includes an early G4 that the milestone daily-budget path would have dropped (proves the full-turn-set source).
- [x] Budget tests: 4,000-token cap holds; live G4 always survives pressure; earliest+latest live G3 per arc survive; pointer space is reserved and the pointer is emitted whenever anything is omitted.
