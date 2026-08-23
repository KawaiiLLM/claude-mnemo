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
