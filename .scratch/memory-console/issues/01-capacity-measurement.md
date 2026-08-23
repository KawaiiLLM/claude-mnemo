# 01 — Capacity measurement: the numbers that set every console budget

**What to build:** a measurement report (numbers, not code) that lets the
console spec's named bounds be set from data instead of guesses. On a /tmp
COPY of the production database (never the live file):

- `loadLaneCheckScope → checkLanes → renderLaneCheckerReports` wall time for
  the S15069 whole-session scope (~1370 turns), for T900-1001, and for a
  50-turn window — plus widened node/edge counts per scope.
- Serialized payload bytes for the graph shape the spec defines (turns with
  capped excerpts + edges + lanes) at each scope.
- `/flush`-style latency impact: measure a synchronous check of the largest
  scope and state the serve-thread stall it would impose.
- Segment scope: E60 (785+ members) through the same chain.

**Deliverable:** a table in this ticket file + recommended values for
`SESSIONS_PAGE_MAX`, `GRAPH_WINDOW_DEFAULT`, `GRAPH_WINDOW_MAX`,
`EXCERPT_*_CP`, `GRAPH_EDGE_MAX`, `WIDEN_NODE_MAX`,
`RESPONSE_BYTE_SOFT_MAX`, and a stated verdict: which scopes get
`stateCoverage: "full"` synchronously, which need refusal-or-partial.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] All measurements from a production COPY, live DB opened read-only or
      not at all; methodology (commands) recorded verbatim
- [x] Recommended constants named with one-line rationales
- [x] The full-vs-partial boundary stated as a rule the API ticket can encode

## Methodology (verbatim)

Production DB never opened for write, never opened at all in this pass —
only a `/tmp` copy, opened `{ readonly: true }`:

```
cp ~/.claude-mnemo/claude-mnemo.db /tmp/console-measure.db
cp ~/.claude-mnemo/claude-mnemo.db-wal /tmp/console-measure.db-wal   # if present
cp ~/.claude-mnemo/claude-mnemo.db-shm /tmp/console-measure.db-shm   # if present
```

Chain under test called directly (no HTTP, no worker process — the same
call shape `src/cli/lane-check-cli.ts`'s `runLaneCheckCli` uses):
`loadLaneCheckScope(db, scope)` → `checkLanes(projection.turns,
projection.edges)` → `renderLaneCheckerReports(result)`, `db = new
Database("/tmp/console-measure.db", { readonly: true })`. Verified by
`grep -n "await\|async " src/db/lane-checker-load.ts
src/shared/lane-checker.ts src/shared/lane-checker-render.ts` → **zero
matches**: the whole chain is synchronous, zero yield points, over
`bun:sqlite`'s synchronous query API. That makes the wall-time numbers
below not an *estimate* of the Bun.serve-thread stall a console request
would impose — they ARE that stall, exactly, because nothing else can run
on the thread between the first query and the last byte of
`renderLaneCheckerReports`'s return.

Measurement script: `/tmp/console-measure.ts` (full source left in place;
cleaned up per instruction: `/tmp/console-measure.db*` only). Each scope run
3× back-to-back on the same open `Database` handle; run 1 reported
separately (cold OS/page-cache effects), runs 2–3 medianed as steady state.
For each run the script also builds the graph-shaped JSON payload the
console's `/api/console/graph` would ship — `{ turns: [{id, sessionId,
promptNumber, title, promptExcerpt}], edges: [{citingId, citedId, relation,
tags}], lanes: [{segment, tagSet, state, memberCount, phases,
declarationState, declarationTerminus}] }`, `promptExcerpt` truncated to 280
CODE POINTS (`[...text].slice(0, 280).join("")`, not `.slice()`, which cuts
mid-surrogate-pair on CJK) — and reports both that payload's byte length and
the same payload with `laneCheckText` appended (the real API response also
carries `laneCheckText`; the ticket's instructed shape does not, so both are
reported: the first is what the delegator asked for, the second is what
actually goes over the wire and is what `RESPONSE_BYTE_SOFT_MAX` must
bound).

Run command: `bun /tmp/console-measure.ts`. Scopes exercised (session 15069
has 1378 turn rows / 1228 live, prompt numbers 1–1379; segment 60 has 1298
`segment_members` rows, the DB's largest segment by far — next is 86):

```ts
{ kind: "range", sessionId: 15069, promptStart: 0, promptEnd: 100000 }      // (a) whole session
{ kind: "range", sessionId: 15069, promptStart: 900, promptEnd: 1001 }      // (b) T900-1001
{ kind: "range", sessionId: 15069, promptStart: 1300, promptEnd: 1350 }     // (c) 50-turn window
{ kind: "segment", segmentId: 60 }                                          // (d) segment 60
```

## Results table

| Scope | requested width | widened turns | widened edges | lanes | load ms (1st / steady median) | check ms | render ms | total ms (steady median) | graph payload bytes | +laneCheckText bytes |
|---|---|---|---|---|---|---|---|---|---|---|
| (a) session 15069 whole | ~1370 prompts | 1251 | 457 | 12 | 411.1 / 226.9 | 1.4 | 0.1 | 228.4 | 445,872 | 453,750 |
| (b) session 15069, T900–1001 | 101 prompts | 391 | 348 | 12 | 231.3 / 223.8 | 0.9 | 0.1 | 224.7 | 156,528 | 164,406 |
| (c) session 15069, T1300–1350 | 50 prompts | 43 | 9 | 0 | 1.0 / 0.9 | 0.0 | 0.0 | 0.9 | 17,612 | 18,162 |
| (d) segment 60 | 1298 members | 1178 | 425 | 12 | 233.9 / 235.2 | 1.6 | 0.1 | 236.9 | 419,364 | 427,242 |

Raw per-run totals (ms), showing steady-state repeatability: (a) 416.1,
233.5, 223.4 · (b) 232.4, 227.3, 222.1 · (c) 1.1, 0.9, 0.9 · (d) 234.9,
233.0, 240.7. `check`+`render` are noise next to `load` at every scope
(≤5ms combined even on the 1251-turn case) — `loadLaneCheckScope`'s SQL
round-trips are the entire cost.

**laneCheckText is 7693 bytes identically for (a), (b), and (d).** Not a
coincidence — see finding below.

## Key finding: cost tracks WIDENED size, not requested scope size

Scope (b) asked for 101 prompt numbers and widened to **391 turns** (nearly
4×) at **224ms steady** — indistinguishable in cost from scope (a)'s entire
~1370-prompt session (1251 turns, 228ms). Scope (c) asked for a
same-order-of-magnitude 50-prompt window and stayed at **43 turns / 0.9ms**
— 250× faster than (b).

The reason: (b)'s range touches turns whose tagged edges belong to lanes
owned by **segment 60**, and the WIDEN pass then loads that lane's
segment-GLOBAL turn/edge set (`db/lane-checker-load.ts`'s SEGMENT-GLOBAL
pass) — every live turn segment 60 owns, from ANY session, not just
15069. Confirmed directly: of scope (a)'s 1251 widened turns, **23 belong
to session 21460**, not 15069, and all 12 involved lanes in (a) resolve to
`segment: "60"` — i.e. requesting "the whole of session 15069" and
requesting "segment 60" load almost the same underlying graph, because
15069's own lane structure IS mostly segment 60's. Scope (c)'s window
happens to touch zero tagged edges (`lanes: 0`), so WIDEN never fires and
it stays cheap.

**Implication: a request's `from`/`to` width cannot predict its cost.** Two
requests of comparable requested width differed 250× in wall time and node
count depending on which lane/segment they touched. `WIDEN_NODE_MAX` /
`GRAPH_EDGE_MAX` / `RESPONSE_BYTE_SOFT_MAX` must be evaluated on the
POST-widen result, not on the request shape — there is no cheap
pre-flight signal available (the widen has to actually run to know if a
touched lane belongs to a small or a segment-60-sized segment).

## Recommended constants

| Constant | Value | Rationale |
|---|---|---|
| `SESSIONS_PAGE_MAX` | 50 | Outside the measured chain (plain `SELECT` of title/project/turnCount/date, no widening) — sized for legibility against the DB's actual scale today (219 sessions total), cursor pagination absorbs growth. |
| `GRAPH_WINDOW_DEFAULT` | 50 | Matches the ticket's own 50-turn example window; window size doesn't predict cost (see finding above), so the default's job is UI legibility, not a safety bound — that's `WIDEN_NODE_MAX`'s job. |
| `GRAPH_WINDOW_MAX` | 2000 | Comfortably covers today's largest real session (~1370 prompts) with headroom for growth, and rejects a pathological `from=1&to=10000000` before the load step; paired with, not a substitute for, `WIDEN_NODE_MAX`. |
| `EXCERPT_PROMPT_CP` | 280 | As measured — keeps the 1200–1300-turn scopes' payload at 356–400 bytes/turn including JSON overhead, comfortably under the byte budget below. |
| `EXCERPT_CONTENT_CP` | 280 | **Not separately measured** — the ticket's instructed payload shape used prompt excerpts + full titles only (no content field). Recommending parity with `EXCERPT_PROMPT_CP` on the same order-of-magnitude reasoning; flagged for the API ticket to confirm once a content-bearing field actually enters the projection. |
| `GRAPH_EDGE_MAX` | 1000 | ~2.2× the largest observed edge count (457, whole session) — keeps a worst-case *admitted* scope's stall in the same sub-500ms order measured here. |
| `WIDEN_NODE_MAX` | 2000 | ~1.6× the largest observed widened node count (1251). Segment 60 is the DB's largest by a 15× margin over the next segment (1298 vs 86 members) — it IS today's real stress case, and it costs ~230ms; headroom buys room for the DB to grow before any real scope needs partial coverage. |
| `RESPONSE_BYTE_SOFT_MAX` | 1,000,000 (1 MB) | ~2.2× the largest observed real payload (453,750 bytes, whole session incl. `laneCheckText`) — a soft/advisory cap per the spec's 200-plus-clamp-metadata posture, not a hard error threshold. |

## Full-vs-partial boundary rule

A graph request gets `stateCoverage: "full"` **synchronously** iff, AFTER
running `loadLaneCheckScope` once (cost cannot be predicted before that —
see finding above), ALL THREE hold on the actual result:
widened-turn-count ≤ `WIDEN_NODE_MAX` AND widened-edge-count ≤
`GRAPH_EDGE_MAX` AND `JSON.stringify({turns, edges, lanes,
laneCheckText}).length` (byte length) ≤ `RESPONSE_BYTE_SOFT_MAX`. All four
scopes measured here (whole session, T900–1001, the 50-turn window,
segment 60) pass all three caps today and would all be `"full"`.

If any cap is exceeded post-load, the handler either (a) returns the
200-with-clamp-metadata refusal envelope naming the exceeded bound, or (b)
truncates `turns`/`edges` to the caps (both are already sorted
deterministically — `turns` by id, `edges` by `(citingId, citedId,
relation)` — before serialization, so truncation is a stable prefix, not an
arbitrary cut) and returns `stateCoverage: "partial"` with no
lane_check-equivalence claim, per the spec's peer #3 semantics. This ticket
does not adjudicate (a) vs (b) for a given caller — that is the API
ticket's call — but confirms the ordering: load → measure the actual
result → THEN decide full/partial/refuse. There is no valid way to make
that decision from `from`/`to` width, session id, or segment id alone.

## Cleanup

`/tmp/console-measure.db`, `/tmp/console-measure.db-wal`,
`/tmp/console-measure.db-shm` removed at the end of this ticket.
`/tmp/console-measure.ts` (the measurement script) and
`/tmp/console-measure.out` (raw run output) left in place for reference —
not instructed to remove them and no repo file was touched to produce them.
