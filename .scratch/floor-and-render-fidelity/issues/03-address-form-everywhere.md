# 03 — Every rendered turn reference speaks S<n>/T<m>: lane_check, console, citation surfaces

**What to build:** internal DB ids disappear from every rendered address
(user ruling S15069/T1482): one shared formatter maps turnId →
`S<session>/T<prompt>`, and all three leaking surfaces route through it.
Internal ids may survive as DATA KEYS (DOM datasets, graph node keys, DOT
identifiers) — never as reader-facing text.

1. **lane_check text render** (`lane-checker-render.ts`): the loader-built
   address map today feeds ONLY `formatAnchor` (line ~294); every other
   position hardcodes `"T"+id` — the WARNINGS fact lines
   (`T<citing>->T<cited>`, ~119-125), `renderEdgeArrow` (~257), E3's subject
   (~325), E5's `nodeId`/`canonicalId`, and the anchor fallback. All of them
   consume the map, widened from anchors-only to the whole projection (the
   loader already holds every projection turn's row). A reference outside
   the projection is a loader bug post-RA: the `T<dbid>` fallback stays as a
   marked last resort and a test asserts it is unreachable on the fixtures.
   The DOT digraph's node LABELS switch to addresses; its node identifiers
   may stay internal.
2. **Console frontend** (`console-api.ts` payload + `console-shell.html`):
   turn node labels, the info card, and edge listings render `S<n>/T<m>`
   (session prefix per node — a graph scope can span sessions; the user's
   earlier "T12375" gray-edge report was in fact a global id on screen).
   The API payload carries promptNumber+sessionId alongside the internal
   key; the shell renders only the address form.
3. **Citation surfaces**: recall's internal `includeDbTurnIds` flag and its
   `dbid:T<n>` appendix retire — their whole purpose was correlating with a
   lane_check that spoke db ids, which (1) ends. Any teaching text that
   taught the correlation updates with it.
4. **Ticket-02 hand-offs** (its worker's findings): `src/mcp/segment-card.ts`
   (~line 544) carries a THIRD copy of the retired prompt fallback
   (`turn?.title ?? turn?.userPrompt ?? "untitled"` on the member index
   line) — sweep it under the same rule (title or bare address; a raw
   prompt never leaks). And the main-agent recall description
   (`src/mcp/definitions.ts` `filter.fields` text) gains one line teaching
   that a note-less turn renders as a bare address unless `prompt` is
   selected.

Byte-baseline report tests and console fixture expectations churn by
construction — regenerate them under the new form, and keep one pin per
surface asserting NO `T<dbid>`-shaped reference appears for in-projection
turns.

**Blocked by:** 02 (shares `formatTurnLabel`/format.ts territory — the
`dbid:` segment lives inside the function 02 rewrites). 01 and
session-id-burn/01 are unrelated.

**Status:** ready-for-agent (dispatch after 02 lands)

- [ ] lane_check fixtures: every rendered turn reference in ERRORS, WARNINGS
      and lane listings is `S<n>/T<m>`; the dbid fallback is asserted
      unreachable on in-projection references
- [ ] Console graph + info card render addresses; internal ids only as data
      keys (grep the served HTML/payload for reader-facing `T<dbid>`)
- [ ] `includeDbTurnIds`/`dbid:` retired from recall's render and its
      call sites; no caller regression
- [ ] Settlement teaching surfaces that mentioned db-id correlation updated
- [ ] Segment-card member lines never leak a raw prompt; definitions.ts
      teaches the bare-address behavior
- [ ] Territory: src/shared/lane-checker-render.ts (+ loader map widening in
      src/db/lane-checker-load.ts), src/worker/console-api.ts,
      src/worker/console-shell.html (+ regenerated console-shell.ts),
      src/mcp/recall.ts + src/mcp/format.ts (dbid retirement only),
      src/mcp/segment-card.ts (fallback sweep only), src/mcp/definitions.ts
      (teaching line only), their tests. NOT src/db/turn-completion.ts (01)
      or src/db/sessions.ts (session-id-burn/01)
- [ ] Load-bearing properties declared for mutation acceptance
