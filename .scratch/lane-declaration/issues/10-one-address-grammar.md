# 10 — One address grammar: `S<session>/T<prompt>` everywhere, the segment only as a scope

**What to build:** a turn has ONE address, `S<session>/T<prompt>`, on every surface that renders it and in every selector that accepts it. A segment appears as a SCOPE in front of that address (`E31/S123/T1..S234/T10`), never as an address namespace of its own.

**Blocked by:** 06, 07 (they render the addresses this ticket unifies).

**Status:** ready-for-agent

Ruling: [S15069/T1557] — "recall 和 timeline 的选择器直接用 SxxTxx 吧,例如 `E31/S123/T1..S234/T10`,返回渲染一直都是 Sxx/Txx". It supersedes the segment-ordinal experiment [S15069/T1524] and the segment-scoped global id [S15069/T1532] alike: both made `E<n>/T<m>` mean something, and it already meant a third thing in `recall`'s own selector (the segment's 1-based event-order position), so the same string resolved to different turns depending on where it was pasted.

- [ ] **Selectors:** `recall` and `timeline` accept `E<n>/S<a>/T<b>` for one turn and `E<n>/S<a>/T<b>..S<c>/T<d>` for a range within that segment. The endpoints are ordinary addresses; the range runs over the segment's own event order between them, so the two endpoints need not share a session.
- [ ] The ordinal form `E<n>/T<m>` retires. A caller who passes it gets a refusal naming the new grammar, never a silent reinterpretation — the two readings differ by hundreds of turns and a silent one lands the reader on the wrong row.
- [ ] **Renders:** every rendered turn reference is `S<session>/T<prompt>`. Inside one row (a lane chain, a member list) the full address is printed for the FIRST turn and again whenever the SESSION changes; the rest render bare `T<prompt>`, which is what keeps the row affordable.
- [ ] The segment card's lanes row and the timeline lane view both follow that rule; their existing `E<segment>/T<globalTurnId>` output is replaced.
- [ ] **The console follows too:** row labels, the detail panel, lane chips and the interval label all read `S<session>/T<prompt>`; the interval names its scope separately (`E60` in the header) rather than folding the segment into each address. The address-space switch shipped in 61f73a6 has nothing left to switch between and goes with it.
- [ ] Every teaching surface updates in the same ticket: the `recall` and `timeline` tool descriptions, the plugin skills docs (mnemo-recall / mnemo-timeline), and any prompt copy quoting a selector. A cached skill doc teaching the retired grammar is the exact failure this project has already been bitten by twice.
- [ ] Tests: the new selector forms (single, range, cross-session range); the refusal on the retired ordinal form; the leading-prefix rule including a session switch mid-row; console labels and interval; and the skills-doc sweep.
