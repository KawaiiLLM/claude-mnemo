# 11 — Verify on real data + baseline re-measurement

**What to build:** The pieces meet on production-shaped data. A real settlement window runs election + membership + staged commit; a segment is created, attached, maintained and injected across a session boundary. The five baselines re-measure against S15069's 2026-08-17 numbers: narrative-opening rate (3/4), note budget overage (95%), title-only cold read (~70%), milestone candidate collapse (77%), insight standalone-teachability (~85%). The election-vs-citation A/B runs its first leakage-aware comparison. Findings only; every fix is a new ticket.

**Blocked by:** 01–10.

**Status:** ready-for-agent

- [ ] Each baseline re-measured on a fresh window with method matching the original
- [ ] One full segment lifecycle demonstrated end to end on real data
- [ ] A/B agreement rate + eyeballed disagreement set reported
- [ ] A written finding lands; no code changes under this ticket
