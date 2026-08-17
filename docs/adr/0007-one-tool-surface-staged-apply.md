# ADR-0007 — One tool surface; the subagent's writes apply on commit

**Status:** accepted · 2026-08-17 · source: S15069 T830

The settlement subagent uses the same injection and the same tool quartet as the
main agent — note, remember, timeline, recall — not a dedicated facade set. The
difference is application semantics: the main agent's writes apply immediately;
the subagent's stage and apply only on `commit` (which replaces the retired
`check` as the closing act). The staged-commit machinery already exists from the
0.11.x settlement rebuild; this decision widens it from a settlement-only facade
into the general subagent write contract. Rejected alternative: parallel
settlement-specific tools, which drift from the main surface and double every
contract change.
