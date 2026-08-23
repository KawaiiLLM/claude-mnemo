# 02 — The request gate and the ConsoleReader capability

**What to build:** the two structural guarantees the console rests on,
landable before any console route exists:

1. **Request gate** (worker server, before ALL route dispatch, existing POST
   routes included): `Host` must be exactly the loopback host:port; `Origin`,
   when present, must be exactly the loopback origin; `Sec-Fetch-Site`, when
   present, must be `same-origin` or `none`; violations → 403; no
   `Access-Control-Allow-Origin` anywhere. Covers the DNS-rebinding class.
2. **ConsoleReader capability**: a narrow read-only query surface backed by a
   SEPARATE `{ readonly: true, create: false }` database connection the
   worker opens for the console alone. Console handlers (ticket 03) will
   receive only this object, never the raw Database.

**Blocked by:** None — can start immediately (parallel with 01).

**Status:** done

- [x] Gate matrix tests: good/bad Host, absent/exact/foreign Origin,
      absent/same-origin/cross-site Sec-Fetch-Site — against an existing
      route (e.g. /health) and a POST route
- [x] A write attempted through the ConsoleReader's connection FAILS, pinned
      by test; a source guard pins the reader module free of DML/exec and of
      queue/settlement imports
- [x] Existing route behavior otherwise byte-stable (health/flush contract
      tests still green)

**Implementation notes:**

- Gate: `evaluateRequestGate(headers, port)` in `src/worker/server.ts`,
  applied as the first statement inside the fetch handler's `try` block —
  before `new URL(req.url)` and every route check. `port` is a new
  `WorkerServerDeps.port` field, defaulting to the existing `WORKER_PORT`
  constant (37778) — there is no `config.port`; the worker's bound port is
  presently a hardcoded module constant, not a config field, so the gate
  reads that same constant by default and accepts an override for tests.
  Rejections return `{ error: { code: "forbidden", message } }` at 403 via
  `Response.json`; no route anywhere sets `Access-Control-Allow-Origin`.
  Tests: `tests/worker/server.request-gate.test.ts` (pure-function matrix +
  through the real handler for GET /health and POST /flush).
- Reader: `src/worker/console-reader.ts` — `ConsoleReader.listRecentSessions`
  delegates to the existing `db/sessions.ts` reader (`getRecentSessions`)
  rather than new SQL, so the module's own query surface is zero lines of
  SQL. `openConsoleReaderDatabase` = `new Database(path, { readonly: true,
  create: false })`. Tests: `tests/worker/console-reader.test.ts` (readonly
  write-throws proof on a real temp-file DB, missing-file-fails proof,
  static source guard, `listRecentSessions` behavior).
- Three PRE-EXISTING tests construct a synthetic in-process `Request`
  without a `Host` header (a real network `fetch()` always carries one; a
  bare `new Request(url)` does not) and needed one line each to stay green
  under the new gate: `tests/worker/server.settle-backfill.test.ts`,
  `tests/worker/diary-runtime.test.ts`, `tests/e2e/async-tool-turn-liveness.test.ts`.
- NOT done in this ticket: `main()` does not open a live ConsoleReader
  connection at boot. The spec text ("the worker opens it beside its main
  handle") reads as a boot-time requirement, but there is no consumer until
  ticket 03's routes exist, and the only test-suite caller of `main()`
  (`diary-runtime.test.ts`) injects `deps.db` as `:memory:` with no real
  file to reopen — wiring an unconsumed, unclosed second handle into boot
  would be both untested and a real (if minor) resource leak. Flagging this
  reading for ticket 03 to confirm: either ticket 03 opens the connection
  itself when it wires the first console route, or this ticket's scope
  needs the boot wiring added explicitly with its own test.
- The full-suite run surfaces exactly one unrelated failure:
  `tests/shared/release-artifacts.test.ts > built bundles embed current
  worker + timeline logic (stale-bundle guard)`. It rebuilds
  `plugin/scripts/*.cjs` via `node scripts/build.js` and diffs against the
  checked-in bundles — expected, since source changed and bundles were not
  rebuilt (explicitly out of this ticket's territory: "Never run node
  scripts/build.js"). Needs a rebuild before release, same as any other
  src/worker/ change in this batch.
