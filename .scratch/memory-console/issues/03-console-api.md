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

**Status:** ready-for-agent

- [ ] Schema tests per route incl. nullable semantics (`terminus: null`,
      empty lists `[]`), 400/404 matrix, clamp reporting, partial labeling
- [ ] Single-source pin: the T900-1001 fixture's graph payload is asserted to
      be a projection of the SAME checkLanes result that produced its
      laneCheckText (one call, one object)
- [ ] Focus-domain payload: each lane carries membershipComponentId computed
      server-side (lane-membership connectivity, documented as distinct from
      report-2 components)
- [ ] Console requests never reset the worker's hard-exit timer (pinned)
