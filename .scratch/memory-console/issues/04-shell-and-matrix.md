# 04 — The shell ships: packaging, /console route, and the behavior matrix

**What to build:** the approved prototype becomes the served page:

- The canonical shell `.html` moves into the repo (from
  /private/tmp/turn-graph/console-template-v2.html, XSS patches included);
  its client-side lane math is deleted (server payloads carry
  lanes/states/components/tiers); fetch wiring + the "worker stopped"
  snapshot state + manual retry land per the spec's lifecycle section.
- A generator emits the version-controlled TS constant via `JSON.stringify`
  (never a backtick template — 448 backticks in the shell); a test
  regenerates and asserts byte equality (the stale-shell guard).
- `GET /console` serves it (no-store); CSP + the DOM rule (all DB strings
  escaped/`textContent`, closed-set mapping for relation/type names) are
  acceptance criteria.
- The behavior acceptance matrix from the spec is instantiated in the ticket
  and walked manually at acceptance: filters, lane-chip grouping and
  unified multi-select focus, scroll-to-anchor, tooltips, row hover layer,
  search jump, edge-row jump, badge/Esc reset, semantic-only line weight.

**Blocked by:** 03 — the console API.

**Status:** ready-for-agent

- [ ] Generator + byte-equality guard green; route smoke test serves the
      shell with the required headers
- [ ] DOM-rule sweep: no unescaped DB-sourced interpolation into innerHTML
      (grep + targeted review recorded in the report)
- [ ] The behavior matrix walked and checked row by row, deviations listed
      explicitly
- [ ] Atomic release note: console route, shell, API and buildId ship in one
      worker bundle; pre-console workers 404 — symptom named in the release
      notes
