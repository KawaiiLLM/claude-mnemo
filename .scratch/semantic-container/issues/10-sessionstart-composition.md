# 10 — SessionStart injection composition

**What to build:** A session with bindings opens with **two independent blocks per
attached segment**: recall's collapsed card and timeline's milestone view, each
invoked with an explicit `pageBudget: 2000` (both tools' interactive defaults stay
1000 — the injection parameterizes, never re-renders). Both blocks self-identify
(`[E31] #topic · fields` / `[E31] #topic · milestones`). Roster follows: title +
derived facets with counts, coarse project tag as group header, recency-ordered,
budget-truncated, legacy arc-segments frozen out. Proposals last (≤3).
RecentSessions and the diary index leave SessionStart. The hook red line stands:
nothing floats on tool-adjacent channels.

Transport constraint (ADR-0006 amended): Claude Code persists an oversized hook
output to a file with a 2KB preview at roughly 10K characters — the mechanism
that already swallows today's milestones block (a known live defect this ticket
replaces). Every emitted block therefore asserts its rendered size below ~9.5K
characters and demotes further on breach. Whether blocks ride separate hook
registrations (fixed pool) or one command's `additionalContexts` array is decided
by an empirical test of the persist granularity — array if per-element, pool if
per-command.

**Blocked by:** 03, 05 (the two renderers); 08 (proposals to render); 09
(RecentSessions retirement).

**Status:** ready-for-agent

- [ ] Each attached segment yields two blocks, byte-composed from the readers' outputs at pageBudget 2000 (wiring test — no dedicated renderer; tool defaults unchanged)
- [ ] The persist-granularity experiment is run and recorded; the chosen emission keeps every hook output under the persist line, verified by constructing an overflow
- [ ] Every block carries a post-render character assertion (<9.5K) that demotes on breach
- [ ] Roster excludes frozen legacy segments and truncates on budget with a recall pointer
- [ ] RecentSessions and diary index no longer render at SessionStart
- [ ] Total injection scales linearly with attachment count and nothing else
