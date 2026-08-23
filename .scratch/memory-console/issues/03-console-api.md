# 03 — The console API: four routes, one projection, bounded and labeled

**What to build:** the `/api/console/*` routes per the spec's normative
contract table (sessions, segments, graph, segment card): handlers shaped
`(reader, url) → payload` consuming the ConsoleReader; every response
carrying the meta block (`scope, counts, asOf, workerBuildId, stateCoverage,
appliedBounds`), the error envelope with 400/404 semantics, and JSON headers
(`nosniff`, `no-store`).

- A graph request runs `loadLaneCheckScope → checkLanes` EXACTLY ONCE and
  projects from that single result: lanes/states/`membershipComponentId`,
  the `laneCheckText`, `asOf` and the scope descriptor. No second derivation
  anywhere.
- Bounds from ticket 01's constants; every clamp reported in
  `meta.appliedBounds`; over-budget scopes follow the ruled two-option
  semantics (refusal-with-summary or `stateCoverage: "partial"` with no
  completeness claims).
- Election preview: per-turn tier from the pure election module.

**Blocked by:** 01 (constants), 02 (gate + reader). Election ticket 03 is
landed.

**Status:** done

- [x] Schema tests per route incl. nullable semantics (`terminus: null`,
      empty lists `[]`), 400/404 matrix, clamp reporting, partial labeling
- [x] Single-source pin: the T900-1001 fixture's graph payload is asserted to
      be a projection of the SAME checkLanes result that produced its
      laneCheckText (one call, one object)
- [x] Focus-domain payload: each lane carries membershipComponentId computed
      server-side (lane-membership connectivity, documented as distinct from
      report-2 components)
- [x] Console requests never reset the worker's hard-exit timer (pinned)

## Implementation notes

- **Files:** `src/worker/console-reader.ts` (grown), `src/worker/console-api.ts`
  (new — the four handlers), `src/worker/server.ts` (route wiring + boot
  wiring only). Tests: `tests/worker/console-reader.test.ts` (updated),
  `tests/worker/console-api.test.ts` (new), `tests/worker/server.console-routes.test.ts`
  (new — route wiring through the real fetch handler + the hard-exit pin).
- **Boot wiring resolved** (ticket 02's flag): the reader connection opens
  LAZILY on the first `/api/console/*` request
  (`console-reader.ts`'s `createLazyConsoleReaderResolver`), never eagerly at
  `main()` boot — there is no consumer before a route fires. `main()` derives
  `consoleDatabasePathImpl` from its own already-open primary connection's
  `db.filename`, never a second independent path resolution, so the two
  connections can never target different files. `WorkerServerDeps` gained
  `consoleReaderImpl` (direct injection — the only seam that works when the
  main db is `:memory:`, since two separate `:memory:` connections share no
  state), `openConsoleReaderDatabaseImpl`, `consoleDatabasePathImpl`. A
  resolution failure (missing/unreadable path) is cached and returns 503
  `{error:{code:"unavailable"}}` on every subsequent request until restart —
  never a create-empty fallback.
- **Handlers receive ONLY `ConsoleReader`, never `Database`** — enforced twice:
  `console-api.ts` imports no `bun:sqlite` and every `../db/` import is
  `import type` only (pinned by a source-guard test, same pattern as ticket
  02's reader guard). The whole `loadLaneCheckScope` → `checkLanes` chain
  therefore lives INSIDE `ConsoleReader.runLaneCheck` (one read transaction,
  `asOf` captured at its start) — `console-api.ts` only *projects* from the
  returned `LaneCheckerResult`/`turns`/`edges`, matching spec's "One
  projection" section literally: there is exactly one call site.
- **`membershipComponentId`** (Focus domain): a small local union-find over
  LANE TOKENS (not turn ids), unioning two lanes whenever they share a member
  turn id. Deliberately a different domain from report 2/3's structural-edge
  components — the T900-1001 fixture test asserts two lanes that share zero
  structural edges but DO share a member get the same id. The id itself is
  the lexicographically-smallest lane token in the component (stable,
  human-legible, and never confusable with report 2's numeric turn-id
  `representative` by shape).
- **Election preview budget = 30**, hardcoded as a local literal rather than
  importing `DEFAULT_TIMELINE_PAGE_SIZE` from `mcp/timeline.ts` — that would
  be a new `src/worker` → `src/mcp` coupling for one constant; the precedent
  is recorded in a comment instead of an import.
- **`EXCERPT_CONTENT_CP` confirmed at parity (280)**, not adjusted — see the
  doc comment on the constant in `console-api.ts` for the worst-case byte
  analysis (a fully-CJK-populated `content` field across 1251 turns adds
  ~1.05 MB on its own) and why that is still safe: `RESPONSE_BYTE_SOFT_MAX`'s
  own truncation loop degrades that case to a correctly-labeled `partial`
  response rather than an oversized one.
- **Bounds ordering, a design call this ticket had to make beyond what 01
  fixed:** count caps (`WIDEN_NODE_MAX`/`GRAPH_EDGE_MAX`) apply to the bare
  projection rows BEFORE `loadTurnDisplayFields` runs (so a turn beyond the
  cap never costs a display-field lookup it will not appear in the response
  to justify); the byte cap (`RESPONSE_BYTE_SOFT_MAX`) then measures the
  REAL, fully-built display payload (titles/excerpts resolved) and trims
  further if needed — measuring a cheaper stand-in shape here would have let
  an actually-oversized response through. `GRAPH_WINDOW_MAX` alone (a
  pre-load clamp with no post-load overage) still reports
  `stateCoverage: "full"` — only a POST-load truncation drops the
  lane-check-equivalence claim, per the boundary rule's own wording.
  Truncate-partial (not refuse) was the chosen v1 semantics per this
  ticket's own instruction.
- **`from`/`to` partial-specification** (spec pins only the "both absent"
  default): if only one of `from`/`to` is given, the other defaults
  symmetrically (`to` absent → session's max prompt number; `from` absent →
  `GRAPH_WINDOW_DEFAULT` turns ending at `to`). A turn-less session resolves
  to an empty, non-inverted range rather than 400ing — the from>to check only
  ever fires on an EXPLICIT user-supplied inversion.
- **`counts` on non-graph routes**: sessions/segments routes report
  `{turns:0, edges:0, lanes:0}` (neither domain applies); the segment-card
  route reports `counts.turns = members.length` (a card's members genuinely
  ARE turns) — recorded as the literal, non-fabricated reading for each
  route rather than a blanket zero-fill.
- **`nextCursor`** is OMITTED (not `null`) when there is no next page — the
  spec's own `nextCursor?` notation, distinct from the "absent lane
  terminus = null, never omitted" rule which is scoped to lane/declaration
  fields specifically.
- **Cursor format**: `${epoch}:${id}`, plain and unobfuscated — "opaque"
  (spec) means callers must not construct one, not that the bytes must hide
  anything on a same-OS-user loopback surface.
- **Hard-exit/session-registry isolation**: the console dispatch block in
  `server.ts` never references `sessionEnvRegistry` or `deps.hardExitTimerImpl`
  at all — pinned by a test that hits all four routes and asserts
  `arm`/`cancel` were never called and the registry is byte-identical
  before/after.
- **Not done in this ticket** (explicitly out of territory): the `/console`
  shell route itself (ticket 04) — a pre-console-shell worker still 404s on
  `GET /console`, matching the spec's own documented symptom. A literal
  `main()` boot invocation was not exercised end-to-end (binding a real port
  etc. is unrelated heavy scaffolding); the boot-wiring CONTRACT is instead
  proven via `createWorkerFetchHandler` directly with a real file-backed
  `consoleDatabasePathImpl` — see `server.console-routes.test.ts`.
- **Full suite**: 2766 pass / 1 fail (the same pre-existing, expected
  `tests/shared/release-artifacts.test.ts` stale-bundle guard ticket 02 also
  reported — needs `node scripts/build.js` before release, out of this
  ticket's territory).
