# 10 — SessionStart injection composition

**What to build:** A session with bindings opens with one 2000-token block per attached segment — literally recall's collapsed card (1000) + timeline's milestone view (1000), composed, not re-rendered. Roster follows: title + derived facets with counts, coarse project tag as group header, recency-ordered, budget-truncated, legacy arc-segments frozen out. Proposals last (≤3). RecentSessions and the diary index leave SessionStart. The hook red line stands: nothing floats on tool-adjacent channels.

**Blocked by:** 03, 05 (the two renderers); 08 (proposals to render); 09 (RecentSessions retirement).

**Status:** ready-for-agent

- [ ] The block is byte-composed from the two readers' outputs (wiring test — no dedicated renderer)
- [ ] Roster excludes frozen legacy segments and truncates on budget with a recall pointer
- [ ] RecentSessions and diary index no longer render at SessionStart
- [ ] Total injection scales linearly with attachment count and nothing else
