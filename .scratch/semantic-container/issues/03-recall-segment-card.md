# 03 — recall segment card + view/budget reform

**What to build:** `recall(id="E<n>")` renders the segment card: metadata header (tag counts, type glyph counts, per-session member stats with last-active, consulted-only attachments, maintenance distance; election never shown), then fields — collapsed shows per-field counts plus newest rows with the ellipsis at the TOP (storage uncapped; render elides the largest field's oldest rows first), expanded shows all rows plus the member index. `view` becomes a pure field-set switch for turns too (collapsed: prompt/title/content; expanded: + insight, response, observations with in/out). Two budget params: `page` (default 1000, overflow → pagination — the index is lossless) and a per-turn budget. Bare `recall()` lists segments before sessions. `remember(attach)` output switches to this renderer. Spec §Tools; ADR-0006.

**Blocked by:** 02 — remember tool + segment state schema.

**Status:** ready-for-agent

- [ ] Segment card collapsed/expanded render per contract, top-elision demonstrated on an over-budget field
- [ ] Turn collapsed shows exactly prompt/title/content; expanded adds the detail fields
- [ ] Page overflow paginates with a stable page 2; per-turn budget caps each rendered turn
- [ ] Bare recall() leads with segments; attach returns the canonical card
- [ ] Election/tier data appears nowhere in any recall render
