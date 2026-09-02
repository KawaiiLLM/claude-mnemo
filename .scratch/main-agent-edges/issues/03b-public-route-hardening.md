# 03b — Ticket 03's public route gets end-to-end coverage (peer review escapes)

**What to build:** the peer's implementation review of ticket 03 (S15069/T2438) found the storage mechanics sound and six escapes; this ticket closes the four that are tests/glue and records the other two where they belong.

**Blocked by:** None (03 landed at 16dc1087).

**Status:** ready-for-agent

- [ ] **F2 — `declare` end to end.** Drive the settlement `note` with a `declare` entry through the real route: `settlementNoteInputShape` zod parse → the turn facade loop → the direct-write rollback wrapper. Cases: matching class CAS declares; stale class refuses naming the current class and rolls back the whole call; `tailTag: null` CLEARS a stored declaration (an explicit null must not collapse into `''`-means-unchanged anywhere in the glue); `headTag` omitted stays unchanged; the `declared` counter, the `laneTouches` push (old and new lane) and the receipt line appear. `grep -rn "declare:" tests/` must stop returning zero.
- [ ] **F3 — dead test via duplicate key.** `tests/worker/note-settlement-turn-facade.test.ts` ~1331–1332 has two `use:` keys in one object literal (JS keeps the last), so the TAGGED self-edge case is never sent and the closing assertion has drifted. Fix the fixture so the tagged self-edge entry is actually sent and assert what it proves. Add a repo-wide `typecheck:tests` script (a tsconfig extending the project's that includes `tests/**`) so TS1117 and friends surface; wire it into `npm run typecheck` or document why not; fix or explicitly allowlist what it turns up (pre-existing test type errors are known to exist — list them, do not paper over them).
- [ ] **F4 — one call at the cap.** A single real `note` / settlement call carrying BOTH a retraction and a new attach on a citer at exactly 20 succeeds (retractions resolve before relations); swapping the two resolution sites in `note.ts` and the facade must go red.
- [ ] **F5 — same lane word under two tasks against `declareEdgeSides`.** Give `declareEdgeSides` a two-segment fixture where the same lane word exists in both tasks; a declaration naming the other task's lane refuses as `invalid-declaration`. Then either route `endpointLaneTags` through `collectEdgeSideFacts` (`lane-edge-gate.ts`) or state why two readers must stay.
- [ ] **F6 — pin the non-stamping restatement.** A live attach that only materialises `relation_class` on a legacy row reports `restated` and does NOT advance the relations stamp.
- [ ] Recorded elsewhere, not here: **F1** (the settlement prompt still teaches "the bare citation comes back" — false since 03 deleted the restoration; pinned by a shallow `toContain`) → ticket 06, marked as a ticket-03 escape; the tie-break/fold agreement → ticket 01 acceptance.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- ≥3 mutation probes of your own, RED, md5-restored, mutation verified applied.
- [ ] `npx tsc --noEmit` clean; the new tests-typecheck script clean or its findings listed; full `bun test` once with every delta accounted; `npm run build`; guards green; `git diff --check` clean. No version bump, no push.
