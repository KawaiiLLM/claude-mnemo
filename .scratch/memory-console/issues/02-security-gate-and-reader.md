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

**Status:** ready-for-agent

- [ ] Gate matrix tests: good/bad Host, absent/exact/foreign Origin,
      absent/same-origin/cross-site Sec-Fetch-Site — against an existing
      route (e.g. /health) and a POST route
- [ ] A write attempted through the ConsoleReader's connection FAILS, pinned
      by test; a source guard pins the reader module free of DML/exec and of
      queue/settlement imports
- [ ] Existing route behavior otherwise byte-stable (health/flush contract
      tests still green)
