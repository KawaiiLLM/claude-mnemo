# 03 — The dream is the worker's last in-process model call, and the SDK's bare-promise crash still reaches it

**What to build:** the nightly dream run gets the same containment the settlement run got in ticket 02 — an abort (or any control-request rejection inside the vendored SDK) kills at most that night's dream, never the worker process.

**Why this exists (peer round 3 adjudication, 2026-08-31):** ticket 02 removed every settlement model call from worker core, but its stated end-state — "worker.cjs sheds the SDK entirely" — is unreachable: the nightly dream runs IN the worker (`server.ts → diary-runtime.ts → diary-sdk-query.ts`), so worker.cjs still bundles `sdk.mjs` once. The vendored SDK's pinned mechanism (ticket 01 Status: every inbound `control_request` dispatched as a bare unawaited promise; under abort the reply write throws, the catch's second write throws again, the unobserved rejection exits Bun in ~10ms) is therefore still reachable through the dream path. Same crash family that killed the worker three-for-three on settlement runs — different subsystem, lower frequency (nightly, aborts rare), same blast radius: silent worker death plus collateral on every in-flight settlement child's parent side.

**In-process SDK abort sites, enumerated (2026-08-31, the peer asked for this list):**

- `src/worker/diary-sdk-query.ts` — `createDiarySdkQuery`: owns an `AbortController` (~:198), forwards the request's outer signal into it (~:200-206), hands it to the SDK query (~:346). This is the one place a live SDK session and an abort signal meet in-process.
- `src/worker/diary-runtime.ts` — `abortDream(reason)` (~:264): the lifecycle abort that pulls that trigger (idle watchdog, shutdown, stall escalation).
- Settlement paths: NONE remain (ticket 02, guard-enforced — `MODEL_SUBPROCESS_ENTRY_POINTS` is down to `diary-runtime.ts` alone, which is precisely this ticket's target).

**Route:** the same shape as ticket 02 — the dream's SDK wrapper moves into a child process (a `mode` on the existing settlement-child wire, or a sibling entry sharing `runSettlementChildProcess`'s runner; the runner was deliberately written as THE one place the spawn/kill/liveness/envelope discipline lives, reuse it rather than growing a second). After the move, worker.cjs really does shed the SDK, and the no-model guard's last entry-point exemption goes to zero. An interim mitigation (scoped unhandledRejection shield) is NOT acceptable — that exact shape was withdrawn in ticket 01 with three structural P1s.

**Blocked by:** ticket 02 (its runner and wire are the reuse target). Does NOT block ticket 02's release: peer adjudicated the dream exposure as pre-existing, neither introduced nor widened by b49d6bac, and holding a reproduced production settlement crash hostage to a rarer pre-existing one would be backwards. This ticket must exist ON FILE before that release — it does now.

**Status:** DISSOLVED — not implemented (dream-retirement ticket 01, 2026-09-01)

- [ ] The dream run executes in a child process through the ticket-02 runner discipline (real resolver, group kill, liveness pipe, strict success conjunction, bounded envelope).
- [ ] A control-request rejection during a dream abort kills at most the dream child; the worker survives; the night's failure is logged with the child's stderr tail (subprocess-level test, the abort-survival harness is the template).
- [ ] worker.cjs contains zero SDK bytes; `MODEL_SUBPROCESS_ENTRY_POINTS` shrinks to `[]`; the release-artifacts guard pins both.
- [ ] Dream retry/backoff semantics (cap=3, retry_disposition, event-driven triggers — the 0.6.6 family) survive unchanged; their suites stay green unmodified.
- [ ] `npx tsc --noEmit` clean; full `bun test` once at the end; bundles rebuilt.

---

## DISSOLVED — not implemented

This ticket's entire reason for existing was CONTAINING the in-process SDK path
that the nightly dream kept alive. dream-retirement ticket 01 deleted that path
instead, and deletion is the stronger fix: containment would have moved the
dream's model client into a child process, so a control-request rejection would
have killed at most that child — but the client, the abort seam, the vendored
SDK's bare-promise mechanism and a whole second child wire would all still ship.
There is now nothing to contain.

What was accepted here was met, by removal rather than by construction:

- **Line 21 — "worker.cjs contains zero SDK bytes; `MODEL_SUBPROCESS_ENTRY_POINTS`
  shrinks to `[]`; the release-artifacts guard pins both."** DONE, exactly as
  written. `grep -c anthropic-ai plugin/scripts/worker.cjs` is 0 (was 1);
  `MODEL_SUBPROCESS_ENTRY_POINTS` is `[]`, which makes the source walk
  exemption-free; and a new release-artifacts test, "no model client ships in
  the worker, hook or mcp bundles", pins the byte-level half — with
  `settlement-child.cjs` asserted to still CONTAIN the string, so the detector
  is proven to fire.
- **Lines 19/20 — the dream runs in a child, an abort kills at most the child.**
  MOOT. There is no dream run, no abort seam (`abortDream`/`abortDreamImpl` are
  deleted along with the stale-build shutdown carve-out that existed only for
  them), and therefore no in-process SDK session that an abort can reach.
- **Line 22 — "Dream retry/backoff semantics (cap=3, `retry_disposition`,
  event-driven triggers — the 0.6.6 family) survive unchanged; their suites stay
  green unmodified."** DELIBERATELY NOT MET, and this is the one place this
  ticket and its successor genuinely disagree. Those semantics existed to make a
  failing dream recover; with no dream to recover they are dead machinery, so
  `db/diary-state.ts` and its suite are deleted and the `diary_state` /
  `diary_day_state` tables go INERT (no reads, no writes; `CREATE TABLE` stays
  in schema.ts, because dropping is irreversible and buys nothing).

The evidence that settled it: every dream output had been frozen since
2026-08-08 12:13 — 24 days of zero output while `reconcileDreamBacklog` and
`dreamAgentHour` stayed wired — and nobody noticed. Containment work on a
subsystem producing nothing is cost without a return.
