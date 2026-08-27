# 01 — Edge width means "incident to the clicked node"

**What to build:** in the console graph, clicking a node makes exactly the edges
touching that node (in-edges and out-edges alike) thick; every other edge is
thin. With no node focused, EVERY edge is thin — including under lane-only
focus. Width answers one question only: does this edge touch the node I clicked.

**Blocked by:** None — can start immediately.

**Status:** resolved — landed as `7bc17fb`; every criterion re-checked per-item from the worker's report and spot-verified (`.inc` rule + `touchesSel` present, console test file 104/0, tree clean). Selection model confirmed single-select, so decision 4's multi-node case was reported not built, as instructed.

## Why

User ruling 2026-08-28 [S15069/T1859], revising console-focus-encoding ticket 01
(cf32918). That ticket gave width to the focused SUBGRAPH — inside coloured and
thick, outside grey and thin — so under any focus a whole component reads thick,
and with no focus everything is thick (base 2.2). The revision splits the
channels: colour keeps marking the focused subgraph, width narrows to the
clicked node's own neighbourhood.

## Decisions (settled — implement as given)

1. **Thick iff incident.** An edge is thick exactly when one of its endpoints is
   the clicked/focused node. Direction does not matter — 出边或入边都算.
2. **No node focus → all thin.** The resting graph is uniformly thin. A
   lane-multi-select focus with no clicked node colours and greys as today but
   thickens NOTHING — thickness is the node's channel, not the lane's.
3. **Colour is untouched.** The focused subgraph keeps its per-relation colour,
   outside stays grey (`path.edge.gray`), the unfocused default stays coloured —
   the existing "not uniformly grey with no focus" pin STAYS. Dash untouched.
4. **If the selection model supports more than one focused node**, thick =
   incident to ANY of them; if it is single-select, say so in the report rather
   than building multi-select.
5. **Comments follow the code.** The cf32318-era comments saying "colour and
   width both belong to focus" / "every edge shares the same base width until a
   focus greys one out" now describe the wrong rule — rewrite them to state the
   incidence rule. A comment contradicting the code is a defect in this repo.

## Acceptance criteria

- [x] With a node clicked: every edge incident to it is thick; a same-component
      edge NOT touching it is thin. Both halves asserted — the second is the
      one the old rule would get wrong.
- [x] With no node focused: all edges thin, asserted; and the graph is still not
      uniformly grey (the colour pin survives).
- [x] Lane-only focus: colour/grey behave as before, width uniformly thin —
      asserted.
- [x] In-edge and out-edge of the clicked node are both thick — asserted
      separately, since "相关的边" means both directions.
- [x] Existing tests pinning the cf32918 width rule are UPDATED together with
      the code, not deleted; any test archiving the old comment text follows it.
- [x] `src/worker/console-shell.ts` regenerated with
      `bun scripts/generate-console-shell.ts` (stale-shell guard pins them
      byte-identical) and the inline scripts still compile.
- [x] Every new test mutation-verified: name the observable, backup AFTER the
      implementation lands, assert the needle matched and PRINT that it applied,
      red, restore, green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test`
      green; report the number and account for the change.

## Out of scope

Any change to colour or dash semantics, the focus domain computation, the graph
API, or which edges render.

## Notes

Production database read-only. No version bump, no push.
