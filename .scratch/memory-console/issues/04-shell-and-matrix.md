# 04 — The shell ships: packaging, /console route, and the behavior matrix

**What to build:** the approved prototype becomes the served page:

- The canonical shell is `src/worker/console-shell.html` (snapshotted from
  the approved prototype at T1387 — the user's "实现可以用目前的模板"
  ruling; the /tmp copies stop being canonical). Its client-side lane math
  is deleted (server payloads carry lanes/states/components/tiers); fetch
  wiring + the "worker stopped" snapshot state + manual retry land per the
  spec's lifecycle section.
- A generator emits the version-controlled TS constant via `JSON.stringify`
  (never a backtick template — 448 backticks in the shell); a test
  regenerates and asserts byte equality (the stale-shell guard).
- `GET /console` serves it (no-store); CSP + the DOM rule (all DB strings
  escaped/`textContent`, closed-set mapping for relation/type names) are
  acceptance criteria.
- The behavior acceptance matrix from the spec is instantiated in the ticket
  and walked manually at acceptance, per the FINAL focus model
  (T1370-T1386): relation-word filters; lane chips grouped open-first with
  closed-valid / closed-invalid(strike+✝) / open styling; SINGLE-COMPONENT
  focus — clicking a node or chip switches focus to its whole membership
  component (every connected lane auto-lights), replacing the previous one;
  two-stage clicks inside the focused component (panel first, undo only on
  the panel's own node); laneless nodes focus solo (direct edges color);
  blank click (arc rail, background) and Esc both clear; chip-select
  scroll-to-anchor; edge tooltips with tags; under-layer row hover band
  (node+text width only — the rail stays blank); search jump; edge-row
  jump; line weight strictly semantic (thick=tagged), dash=cross-phase,
  gray only in focus state.

**Blocked by:** 03 — the console API.

**Status:** implemented (this pass) — pending the live browser walk + release

- [x] Generator + byte-equality guard green; route smoke test serves the
      shell with the required headers
- [x] DOM-rule sweep: no unescaped DB-sourced interpolation into innerHTML
      (grep + targeted review recorded in the report)
- [x] The behavior matrix walked and checked row by row, deviations listed
      explicitly
- [x] Atomic release note: console route, shell, API and buildId ship in one
      worker bundle; pre-console workers 404 — symptom named in the release
      notes

## Implementation summary

- `src/worker/console-shell.html` rewritten: the embedded `const DATA =
  __DATA__` snapshot is gone. On load the shell fetches
  `/api/console/sessions` + `/api/console/segments` for the sidebar, then
  loads the most recent session's default-window graph
  (`/api/console/graph?session=<id>`). Clicking any sidebar session row
  calls `loadGraph({session})`; clicking any segment row calls
  `loadGraph({segment})` (`/api/console/graph?segment=<id>`). The header's
  `#scopeTitle`/`#meta` spans are rebuilt from each response's `meta.scope`/
  `meta.counts`/`meta.asOf` on every load (`renderHeader`, console-shell.html
  around the `applyGraph`/`renderHeader` functions).
- Client-side lane derivation is deleted: no BFS over tagged edges, no
  `laneComponentOf`. Focus components are grouped by
  `membershipComponentId`, which the server already computes
  (`lanesTouchingComponentForLane`/`lanesTouchingComponentForTurn` are pure
  lookups/filters over the payload, not graph traversals).
- `meta.stateCoverage: "partial"` renders a visible `#partialBanner`
  ("部分结果(已按预算截断，不等价于完整 lane_check)") naming every
  `meta.appliedBounds` entry compactly — no completeness claim, no "REAL
  states" framing for that view.
- A fetch failure (network error, not a valid HTTP response) keeps the last
  rendered snapshot on screen, shows `#stoppedBanner`
  ("worker 无响应 — 当前展示的是最后一次成功加载的快照") with a single
  manual "重试" button wired to the failed request's own retry closure. No
  `setInterval` anywhere in the file (checked by
  `tests/worker/console-shell.test.ts`) — no heartbeat, no auto-retry loop,
  matching the spec's "Worker lifecycle" ruling. A well-formed 4xx/5xx JSON
  error envelope (the worker IS up, it just refused the request) is instead
  surfaced as a transient `toast()`, reusing the approved toast mechanism
  for the error class it actually fits, rather than flipping the persistent
  "worker stopped" banner for a request that would fail identically on
  retry.
- CSP meta tag added verbatim per spec: `default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'`.
  `GET /console` (src/worker/server.ts) serves the shell with
  `content-type: text/html; charset=utf-8`, `cache-control: no-store`,
  `x-content-type-options: nosniff` — the same three-header discipline the
  `/api/console/*` routes already carry.
- Packaging: `scripts/generate-console-shell.ts` exports a pure
  `renderConsoleShellModule(html)` plus a CLI entry
  (`bun scripts/generate-console-shell.ts`) that writes
  `src/worker/console-shell.ts` — `export const CONSOLE_SHELL_HTML: string
  = JSON.stringify(...)`, never a backtick template (the shell's own inline
  `<script>` contains backticks and `${`). `tests/worker/console-shell.test.ts`
  regenerates in-process and asserts byte equality against the committed
  file (no `spawnSync`/build.js — pure function comparison).

## Additive console-api.ts payload fields (ticket 04)

The shell needs four per-turn/per-edge/per-lane facts the ticket-03 payload
did not carry. Each was computed ENTIRELY from data `handleGraphRoute`
already holds (`run.result.lanes`, `run.turns`) — no new `ConsoleReader`
method, no new SQL:

| Field | Type | Source | Why |
|---|---|---|---|
| `ConsoleGraphTurn.type` | `string[]` | `run.turns[i].type` (`LaneTurnInput.type`, already loaded) | node pie-slice coloring + panel type chips |
| `ConsoleGraphTurn.lanes` | `string[]` (lane tokens) | `computePerTurnLaneFacts` over `run.result.lanes[].members` | panel "所属 lane" + focus/highlight lookups; `[]` never omitted |
| `ConsoleGraphTurn.isTerminus` | `boolean` | `run.result.lanes[].state.terminus` union | node terminus ring + panel "◎ 已宣告终点" |
| `ConsoleGraphTurn.isDead` | `boolean` | `run.result.lanes[].members[].dead` union | node dead-X + panel "✕ 被 override" |
| `ConsoleGraphEdge.laneToken` | `string \| null` | `laneToken(citingTurn.segment, edge.tags)`, `null` if untagged | restores the prototype's own `e.laneToken` used for edge/lane highlight matching |
| `ConsoleGraphLane.token` | `string` | `tokenFor(lane)` (already computed internally for `membershipComponentId`) | the shell's own `laneByToken` map key |

Tests: `tests/worker/console-api.test.ts`, new describe block "ticket 04
additive fields" (5 deterministic fake-reader tests) + one new assertion
block inside the T900-1001 single-source-pin fixture test (real declared
terminus, real dead member, edge `laneToken` null-iff-untagged, distinct
lane tokens, over real `checkLanes` output).

## One territory-bounded deviation: turn free-tag chips

The approved prototype's turn panel rendered a chip row for the turn's own
free-form tags (`t.tags.map(x => ...#${x})`, alongside the type chips). This
ticket's assigned territory is `console-api.ts` (additive fields only) and
does NOT include `console-reader.ts` — but `turns.tags` is not available on
`run.turns` (`LaneTurnInput` carries no `tags` field; it only exists via
`ConsoleReader.loadTurnDisplayFields`, which does not currently select it).
Adding it would require widening `console-reader.ts`'s
`ConsoleTurnDisplayFields`/`loadTurnDisplayFields`, which is out of this
ticket's stated territory.

**Deviation, explicit:** the turn-tags chip row is omitted from the live
panel (the type chips still render). This is a real, visible gap from the
approved template, not a silent one — flagged here for a fast-follow ticket
that widens `console-reader.ts`'s existing, designed-to-grow
`loadTurnDisplayFields` (its own doc comment already anticipates further
widening) to also select `turns.tags`.

## Bug found and fixed during the DOM-rule sweep

The edge tooltip (`tip()`, fed from the SVG edge's `mousemove` handler)
interpolated `e.relation` and `e.tags.join(",")` directly into an
`innerHTML`-bound string with NO `esc()` wrapping — a twin code path to the
turn panel's `erow` renderer, which DID escape the same two fields. The
spec's own "Further Notes" states the T1377 review round already found and
patched every "tag/token/edge-tag sink"; this specific twin (the tooltip,
as opposed to the panel row) was still unescaped in the T1387-pinned
canonical file this ticket started from. Fixed: both fields are now wrapped
in `esc()` in the tooltip handler (console-shell.html, the
`addEventListener("mousemove", ...)` block). Also hardened while sweeping
(same DOM-rule "closed-set lookup before class/style" clause, previously
unenforced in the template):
- `style="color:var(--${e.relation})"` (erow) -> `relationVar(rel)`, a
  closed-set lookup over `WORDS` before the value ever reaches a `style`
  attribute (falls back to `"inherit"` for anything outside the known
  relation vocabulary).
- `class="sdot ${g.status}"` (segment sidebar row) -> `SEGMENT_STATUS_DOT`,
  a closed-set lookup (`open`/`closed` -> the two dot CSS classes the
  template's own CSS actually defines — real `SegmentStatus` values are
  `"open"`/`"closed"` per `db/segments.ts`'s `SEGMENT_STATUSES`, not the
  prototype's invented `"delivered"` demo value; `"closed"` maps onto the
  existing grey `.sdot.delivered` bucket rather than inventing a third dot
  color).

## Two intentional deletions (recorded per spec's own instruction)

1. **The session-row placeholder toast** ("模板为静态内嵌数据 — live 版由
   worker HTTP 接口按会话供数") is gone. It existed ONLY because the
   prototype could not actually load a different session; now every session
   row genuinely loads its own graph, so the toast's own premise is false.
   Explicitly authorized by this ticket's own Work section ("The
   static-data toasts retire").
2. **`showSegment()`'s standalone info-panel click behavior** is gone. In
   the static prototype, clicking a segment row opened an info panel
   without changing the main graph (a stand-in — "live 版" text in the
   panel body literally said the live version would supply real data
   instead). Now that live loading works, a segment row behaves exactly
   like a session row: it loads its own graph
   (`/api/console/graph?segment=<id>`). This is a **deviation from the
   spec's OLDER peer #10 matrix line "toast on dead rows"** (spec Rev 2 was
   written before live fetch wiring existed) — reconciled in this ticket's
   own favor because this ticket's explicit Work-section instruction
   ("clicking a segment loads ?segment=<id>", "the static-data toasts
   retire") is the more specific, more recent instruction for exactly this
   file. Flagged here rather than silently resolved.

## Behavior acceptance matrix — walked by CODE INSPECTION

Every row below was verified by reading the wired shell's own handlers/
classes/CSS — NOT by running a browser. `mnemo`'s worker was never started
against a real (let alone production) database for this ticket; a live
browser walk is explicitly deferred to the humans post-release, per this
ticket's own instruction not to claim a run that did not happen.

| # | Trigger | Observable result | Code (console-shell.html) |
|---|---|---|---|
| 1 | Uncheck a relation-word checkbox in `#bar` | Every edge of that relation gets `.off` (opacity .04) | `bar.addEventListener("change", ...)` -> `paintFilters()` L298, L513 |
| 2 | Lane strip render | Open lanes group first, closed group after; closed+valid lanes plain, closed+invalid struck-through with a trailing "✝", open lanes dashed-border | `renderLanes()`/`laneChip(l)` L381 |
| 3 | Click a node with lane membership | Focus SWITCHES to that node's whole membership component (every lane sharing `membershipComponentId` lights); the PREVIOUS component clears | `select(id)` L558 -> `lanesTouchingComponentForTurn` |
| 4 | Click a lane chip | Same switch-to-component behavior, keyed by the chip's own lane token | `laneChip(l).onclick` L381 -> `lanesTouchingComponentForLane` |
| 5 | Click a node inside the ALREADY-focused component | Two-stage: opens/updates the panel first; a SECOND click on the SAME node (the one the panel already shows) clears focus | `select(id)`: `if (sameFocus(toks)) { if (sel === id) clearFocus(); }` L558-566 |
| 6 | Click a laneless node | Solo focus: only that node's own direct edges color (`soloDirect` in `paintFilters`), no lane chips light | `select(id)` else-branch L562-566; `paintFilters()` L513 `soloDirect` check |
| 7 | Click the SVG background or the baseline rail line | All focus clears (`clearFocus()`) | `svg.addEventListener("click", ...)` L415 |
| 8 | Press Esc | Same full clear as a blank click | `addEventListener("keydown", ...)` L547 |
| 9 | Click a lane chip that becomes focused | Smooth-scrolls `#wrap` to the lane's anchor (`state.terminus` or its highest-id loaded member) | `laneChip(l).onclick` -> `anchorOf(tok)` L506, `wrap.scrollTo({...,behavior:"smooth"})` |
| 10 | Hover an edge | Tooltip shows `T<citing> —word→ T<cited>` plus `{tags}` when tagged, both `esc()`-escaped | `mousemove` listener + `tip()` L442-444, L606 |
| 11 | Hover a turn row | The full-width `rect.rowhit` (node+text width only, NOT the arc rail) highlights via `:hover` CSS | `.rowhit` CSS L75-76; hit-rect built at `x:NODE_X-10 ... width:W-(NODE_X-10)` — starts AT the node column, the rail (x < NODE_X-10) is excluded |
| 12 | Type `T<n>` or a title substring in `#search`, press Enter | Jumps to and selects the matching turn | `getElementById("search")` keydown handler L598-605 |
| 13 | Click an edge row in the turn panel (`出边`/`入边`) | Jumps to the cited/citing turn | `erow` `data-j` + `pbody.querySelectorAll(".erow")...addEventListener("click", ()=>jump(...))` L576, L590 |
| 14 | Click the panel's `✕` | Panel closes, selection clears | `getElementById("close").onclick` L597 |
| 15 | Line weight (thick=tagged / thin=untagged) | `path.edge.laned` (2.2px) vs `path.edge.plain` (1.2px), assigned once at build time from `e.tags.length`, never touched by any focus/filter code path | CSS L72-74; class assignment at edge-build time, `renderGraphSvg()` |
| 16 | Dash = cross-phase | `DASH.has(e.relation)` sets `stroke-dasharray` at build time, independent of focus | `renderGraphSvg()`, `DASH` closed set |
| 17 | Gray only in focus state | `.gray` class is only ever added inside the `anyFocus` branch of `paintFilters()`; with no focus active every edge keeps its natural relation color | `paintFilters()` L513-524 |
| 18 | (spec's older matrix line) "toast on dead rows" | **Retired** — see "Two intentional deletions" above | n/a |

**Not walked live**: a real browser session (mouse hover precision, actual
scroll-into-view timing, real SVG pie-slice rendering for multi-type nodes)
was NOT exercised — this ticket's own instruction forbids starting the
worker against the production DB, and no other live target existed. The
release note below states this plainly.

## Release note (atomic — ticket 04)

This release ships the `/console` route, the shell constant
(`console-shell.ts`), the `/api/console/*` handlers (ticket 03) and a
matching `BUILD_ID` together, in one worker bundle — there is no
intermediate state where only some of these exist in a running worker.

**Symptom for a pre-console worker:** `GET /console` returns 404 (the
generic "Not found" fallback — this route simply does not exist in an older
build). Restart/update the worker to the release that includes this ticket
to make the console available; there is no partial-availability mode.

The behavior matrix above was verified by code inspection only. A human
browser walk against a real (non-production) database, covering hover
precision and the live SVG interactions no static test can exercise, is the
remaining step before this is fully signed off.
