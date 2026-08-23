# Memory console — the worker serves the live frontend (Rev 2)

Ruled/iterated S15069/T1344–T1375 (template through six review rounds); Rev 2
closes the peer round of T1377 (11 findings, all verified). Label:
ready-for-agent AFTER the capacity-measurement ticket reports (see Budgets).

## Problem Statement

The memory graph is only inspectable through ad-hoc exports: the approved
console template embeds a hand-exported snapshot of one window, other
sessions/segments are dead rows, and every refresh is a manual export +
rebuild. The user wants to open a page while the worker runs and browse ALL
sessions, segments and turns, with the turn graph rendered from the
database's directed edges — always current, no export step.

## Solution

The resident worker's loopback HTTP server gains a read-only console route
group: `GET /console` serves the approved shell, `GET /api/console/*` serves
JSON. Clicking a session or segment loads its graph live; lane structure,
states and election tiers are computed server-side through the shared
interpretation core — ONE projection per request feeding both the graph and
the lane-check text. The shell renders; it derives nothing.

## User Stories

(Stories 1–15 of Rev 1 stand unchanged; additions:)

16. As the user, I want every DB-sourced string (titles, prompts, content,
    tags, lane tokens) rendered inertly, so that a malicious tag written into
    memory can never execute in the console's origin.
17. As the user, I want the page to survive the worker's idle exit gracefully
    (last snapshot retained, a "worker stopped" state, manual retry), so that
    a dead loopback server is diagnosable, and I do NOT want the browser to
    keep the worker alive.
18. As the user, I want partial results labeled as partial
    (`stateCoverage: "partial"`, no completeness claims), so that a clamped
    scope never silently masquerades as the full truth.
19. As the user, I want the approved prototype's every interaction preserved
    per an explicit acceptance matrix, so that "behaves as approved" is
    checkable rather than aspirational.

## API Contract (peer #1 — normative)

All routes GET, all responses `application/json; charset=utf-8` +
`X-Content-Type-Options: nosniff` + `Cache-Control: no-store` (the shell
too). Error envelope: `{ error: { code, message } }` with status 400
(malformed parameter), 404 (unknown session/segment id or unknown route
under /api/console/), 200 otherwise — an oversized-but-valid scope is 200 +
clamp metadata, never an error.

| Route | Params | Returns |
|---|---|---|
| `/console` | — | the shell (text/html, no-store) |
| `/api/console/sessions` | `cursor?` (opaque), `limit?` (≤ SESSIONS_PAGE_MAX) | `{ sessions: [{id, title, project, turnCount, date}], nextCursor?, meta }` |
| `/api/console/segments` | — (roster-sized, unpaginated) | `{ segments: [{id, title, status, tags, type, memberCount}], meta }` |
| `/api/console/graph` | `session` + `from?`/`to?` (prompt numbers, inclusive; `from>to` → 400) OR `segment` (mutually exclusive, both → 400) | `{ turns, edges, lanes, laneCheckText, meta }` |
| `/api/console/segment` | `id` | `{ card: {…all Working State + summary fields…}, members: [address…], meta }` |

Defaults: graph without `from/to` = the latest `GRAPH_WINDOW_DEFAULT` turns.
Named bounds (constants, values from the measurement ticket):
`SESSIONS_PAGE_MAX`, `GRAPH_WINDOW_DEFAULT`, `GRAPH_WINDOW_MAX`,
`EXCERPT_PROMPT_CP` / `EXCERPT_CONTENT_CP` (code points), `GRAPH_EDGE_MAX`,
`WIDEN_NODE_MAX`, `RESPONSE_BYTE_SOFT_MAX`. Every applied clamp is reported
in `meta.appliedBounds: [{bound, requested, applied}]`.

`meta` (every response): `{ scope, counts, asOf, workerBuildId,
stateCoverage: "full" | "partial", appliedBounds }`. Nullable field semantics
fixed in the schema: absent lane terminus = `null`, never omitted; empty
lists = `[]`, never `null`.

## Read-only, structurally (peer #2)

- Console handlers receive a narrow `ConsoleReader` capability — a closed set
  of query methods — never the raw `Database`.
- The capability is backed by a SEPARATE `{ readonly: true, create: false }`
  SQLite connection opened by the worker for the console alone.
- Tests: a write through that connection MUST fail (asserted); a source guard
  pins the console module free of DML/exec/queue imports.
- Scope statement: "read-only" is a guarantee about the CONSOLE REQUEST PATH
  against the persistent memory DB. The worker process at large keeps
  writing (queues, settlement, migrations) — browsing does not freeze it.

## Budgets and coverage (peer #3)

- A MEASUREMENT TICKET precedes implementation: on a production-copy DB,
  measure the 1300-turn session's load→check→render wall time, widened node/
  edge counts, payload bytes; measure `/flush` latency while a console graph
  request runs. Budget values are set FROM those numbers, as named constants.
- Clamp semantics are two-valued, never silent: a scope the budgets can hold
  returns `stateCoverage: "full"`; a scope they cannot returns EITHER a
  refusal-with-summary (413-style 200 envelope naming the bound) OR a
  partial graph with `stateCoverage: "partial"` — and a partial response
  carries NO claim of equality with lane_check; the shell renders a partial
  banner and drops the "REAL states" framing for that view.
- Console work runs on the serve thread; the measurement ticket decides
  whether chunked/deferred loading is needed to keep `/flush` under its
  latency bound.

## One projection (peer #4)

A graph request executes `loadLaneCheckScope → checkLanes` EXACTLY ONCE,
inside one read transaction, and projects from that single result: the
graph's lanes/states/components, the lane-check text
(`renderLaneCheckerReports` over the same result, returned as
`laneCheckText`), and `meta.asOf` + the scope descriptor. There is no
separate lane-check endpoint and no second derivation path. The golden test
pins that the console payload is a PROJECTION of `LaneCheckerResult` (same
object, one call), not a second computation that happens to agree.

## Focus domain (peer #5 — ruled semantics recorded)

The approved focus behavior (five prototype rounds) is LANE-MEMBERSHIP
connectivity: lanes joined by sharing member turns (the prototype's
tagged-edge component). This is deliberately NOT report 2's component domain
(stance+consume+grounds). The server computes and ships it explicitly:
each lane carries `membershipComponentId`; the shell colors by grouping and
computes nothing. The payload documents the distinction; the checker's
report-2/3 components remain their own separate facts in `laneCheckText`.

## Security posture (peer #6/#7)

- Request gate before ANY route dispatch: `Host` must be exactly
  `127.0.0.1:<port>` (or `localhost:<port>`); when `Origin` is present it
  must be exactly `http://127.0.0.1:<port>` / `http://localhost:<port>`;
  when `Sec-Fetch-Site` is present it must be `same-origin` or `none`.
  Violations → 403. No `Access-Control-Allow-Origin` header, ever. This
  gate covers the DNS-rebinding class; it applies to the console routes AND
  the pre-existing POST routes (one shared gate).
- DOM rule (shell acceptance criterion): every DB-sourced string reaches the
  DOM escaped or via `textContent`; relation names and type words map
  through closed-set lookups before touching class/style; no unescaped
  interpolation into `innerHTML`. (The prototype's tag/token/edge-tag sinks
  were found and patched in the T1377 round — the acceptance test exists so
  they cannot return.) CSP (`default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; connect-src 'self'`) as the second layer, not a
  substitute.
- Threat model stated: same-OS-user local processes are TRUSTED (they can
  read the DB file directly already); other OS users and browser-mediated
  cross-origin access are in scope and covered by the gate. No auth token in
  v1; adding one is the named escalation if the trust line ever moves.

## Worker lifecycle (peer #8 — ruled: no keep-alive)

The console never extends the worker's life: no heartbeat, no Service
Worker, the hard-exit timer is untouched, and a test pins that an open
console does not block idle exit. The shell keeps its last successful
snapshot, flips to a "worker stopped" banner on fetch failure, and offers
manual retry. A pre-console worker returns 404 for `/console`; the release
note names that symptom.

## Shell packaging (peer #9)

The canonical shell is a repo `.html` file; a generator script emits the
version-controlled TS constant via `JSON.stringify` (byte-safe — never a
backtick template: the shell holds 448 backticks and 84 `${`), and a test
regenerates and asserts byte equality (the stale-shell guard, same posture
as the release-artifacts bundle guard). No runtime file reads.

## Behavior acceptance matrix (peer #10)

The approved prototype (hash pinned in the ticket at implementation time) 
defines: relation-word filter checkboxes (off ≈ hidden), lane chips
open-first grouping with closed-valid/closed-invalid(strike+✝)/open styling,
the unified focus system (node click adds its component's lanes to the
multi-select; chip deselect refocuses to the last still-on lane's anchor;
badge + Esc full reset), chip-select smooth-scroll to anchor, edge tooltips
(word/direction/tags), full-width under-layer row hover, `T<n>`-or-title
search jump, edge-row click jump, panel close, toast on dead rows, weight
strictly semantic (never changed by interaction). Each row: trigger →
observable result; intentional deletions must be listed as deletions.
Browser JS stays untested; the matrix + route smoke + generator byte-guard
are the gate.

## Dependencies and release (peer #11)

- Blocked by: the election core (landed), the turn-edge reader and timeline
  integration (milestone-election ticket 03, in flight), and the capacity
  measurement ticket above.
- Console route, shell constant, API handlers and buildId ship in ONE worker
  bundle release — no partial exposure; the election preview uses the pure
  module only and never reimplements timeline rendering.

## Testing Decisions

- Seam: `ConsoleReader`-backed handler functions, `:memory:`/fixture DBs;
  assert payload schemas, bounds behavior (clamp reporting, partial
  labeling), error envelope, and the security gate (Host/Origin/Sec-Fetch
  matrices).
- Read-only proof: the readonly connection rejects writes; DML-free source
  guard.
- Single-source pin: the T900-1001 fixture graph payload is asserted to be
  the projection of the SAME `checkLanes` result that produced its
  `laneCheckText`.
- Lifecycle: console requests do not reset the hard-exit timer; post-exit
  fetch behavior manual-verified per the matrix.

## Out of Scope

Writes, auth tokens (until the trust line moves), auto-refresh/push,
multi-session stitched graphs, timeline ↳/budget rendering, keep-alive of
any kind.

## Further Notes

- The prototype files under /private/tmp/turn-graph/ move into the repo with
  the implementation; the T1377-round XSS patches are already in the
  template.
- Rev 1 → Rev 2 delta implements peer findings #1–#11 verbatim where they
  proposed mechanisms (#1 contract, #2 capability, #3 budgets/coverage, #4
  single projection, #5 explicit focus domain, #6 request gate, #7 DOM rule,
  #8 lifecycle, #9 packaging, #10 matrix, #11 ordering).
