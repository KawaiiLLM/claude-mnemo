# R3 — Shell and gate hardening (peer findings #8 #9 #10 #13 #14b)

**#8 (P2) Console requests extend the generic idle lease.** The fetch
handler updates lastHttpRequestAt before the gate, so any /console request
defers the 30-minute generic idle shutdown even though the 70s hard-exit is
untouched. The ruled intent is "browsing never keeps the worker alive":
exempt `/console` and `/api/console/*` from the idle-lease touch entirely,
and pin it (a console request leaves the lease timestamp unchanged).

**#9 (P2) The DOM guard is a sink-counter, not an invariant.** Removing
`esc()` from a currently-safe field (e.g. `${esc(t.contentExcerpt)}` →
`${t.contentExcerpt}`) keeps sinkCount at 11 and the suite green; the
payload string `</div><img src=x onerror=...>` executes under
script-src 'unsafe-inline'. Replace the counting test with per-field pins:
enumerate every payload-sourced field the shell renders; for each, assert
the escaped form IS present and the unescaped interpolation is ABSENT
(absence assertions are the teeth), or route all rendering through one safe
primitive and pin that. Verify by esc-removal mutations per field class.

**#10 (P2) Sessions sidebar shows only page one.** The shell fetches
/api/console/sessions once and ignores nextCursor (page max 50) — older
sessions are unreachable. Implement load-more using nextCursor (keep the
approved visual language; a plain "更多…" row is fine).

**#13 (P3) Two standards gaps**: Host/Origin comparison must ASCII
case-fold before the exact match (`LOCALHOST:37778` currently 403s; fold,
do NOT widen the allowlist); parseSessionsCursor accepts numbers beyond
Number.MAX_SAFE_INTEGER and passes them to SQLite — malformed → 400 per the
contract.

**#14b (P3) Non-BMP titles**: the shell truncates titles with UTF-16
`.slice`, splitting surrogate pairs — use code-point slicing like the
excerpt caps.

**Territory**: src/worker/console-shell.html + regenerated
src/worker/console-shell.ts (via the generator), src/worker/server.ts (the
idle-lease exemption + host fold), src/worker/console-reader.ts (cursor
parse), their test files. NOT console-api.ts (a sibling repair owns it), NOT
lane-checker*/note-settlement* (sibling workers). Regenerate the shell
constant and keep the byte guard green.

**Status:** done (mutation-verified: lease exemption → 1 red, safe-integer cursor → 1 red; worker demonstrated 3 esc-removal reds)

- [ ] Idle-lease exemption pinned; hard-exit pin unchanged
- [ ] Per-field DOM pins with absence assertions; an esc-removal mutation on
      each field class goes red (demonstrate at least three in the report)
- [ ] Load-more pagination wired and smoke-tested; gate case-fold + cursor
      400 pinned
- [ ] Byte-equality guard green after regeneration; typecheck + targeted
      suites green; control-byte scan clean
