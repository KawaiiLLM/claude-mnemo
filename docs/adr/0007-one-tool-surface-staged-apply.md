# ADR-0007 — One tool surface; the subagent's writes apply on commit

**Status:** staged-apply half superseded 2026-08-19 by ADR-0008 (was accepted ·
2026-08-17) · source: S15069 T830

> The **staged-apply half** of this decision (the subagent's writes accumulate
> and apply only on a closing `commit`) is **superseded** by
> [ADR-0008](0008-read-write-contract.md): settlement now gates, writes, and
> stamps each `note`/`remember` call directly, in its own transaction,
> immediately — the same admission rule the main agent's writes go through.
> `commit` is reduced to a claim-validity check, a per-run write count, and a
> terminal-status mark; there is no staged buffer left to apply. The
> **one-tool-surface half** (the settlement subagent uses the same
> note/remember/timeline/recall quartet as the main agent, not a dedicated
> facade set) is untouched and stands.

The settlement subagent uses the same injection and the same tool quartet as the
main agent — note, remember, timeline, recall — not a dedicated facade set. The
difference is application semantics: the main agent's writes apply immediately;
the subagent's stage and apply only on `commit` (which replaces the retired
`check` as the closing act). The staged-commit machinery already exists from the
0.11.x settlement rebuild; this decision widens it from a settlement-only facade
into the general subagent write contract. Rejected alternative: parallel
settlement-specific tools, which drift from the main surface and double every
contract change.
