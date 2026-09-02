# 03b — Ticket 03's public route gets end-to-end coverage (peer review escapes)

**What to build:** the peer's implementation review of ticket 03 (S15069/T2438) found the storage mechanics sound and six escapes; this ticket closes the four that are tests/glue and records the other two where they belong.

**Blocked by:** None (03 landed at 16dc1087).

**Status:** LANDED

- [x] **F2 — `declare` end to end.** Drive the settlement `note` with a `declare` entry through the real route: `settlementNoteInputShape` zod parse → the turn facade loop → the direct-write rollback wrapper. Cases: matching class CAS declares; stale class refuses naming the current class and rolls back the whole call; `tailTag: null` CLEARS a stored declaration (an explicit null must not collapse into `''`-means-unchanged anywhere in the glue); `headTag` omitted stays unchanged; the `declared` counter, the `laneTouches` push (old and new lane) and the receipt line appear. `grep -rn "declare:" tests/` must stop returning zero.
- [x] **F3 — dead test via duplicate key.** `tests/worker/note-settlement-turn-facade.test.ts` ~1331–1332 has two `use:` keys in one object literal (JS keeps the last), so the TAGGED self-edge case is never sent and the closing assertion has drifted. Fix the fixture so the tagged self-edge entry is actually sent and assert what it proves. Add a repo-wide `typecheck:tests` script (a tsconfig extending the project's that includes `tests/**`) so TS1117 and friends surface; wire it into `npm run typecheck` or document why not; fix or explicitly allowlist what it turns up (pre-existing test type errors are known to exist — list them, do not paper over them).
- [x] **F4 — one call at the cap.** A single real `note` / settlement call carrying BOTH a retraction and a new attach on a citer at exactly 20 succeeds (retractions resolve before relations); swapping the two resolution sites in `note.ts` and the facade must go red.
- [x] **F5 — same lane word under two tasks against `declareEdgeSides`.** Give `declareEdgeSides` a two-segment fixture where the same lane word exists in both tasks; a declaration naming the other task's lane refuses as `invalid-declaration`. Then either route `endpointLaneTags` through `collectEdgeSideFacts` (`lane-edge-gate.ts`) or state why two readers must stay.
- [x] **F6 — pin the non-stamping restatement.** A live attach that only materialises `relation_class` on a legacy row reports `restated` and does NOT advance the relations stamp.
- [x] Recorded elsewhere, not here: **F1** (the settlement prompt still teaches "the bare citation comes back" — false since 03 deleted the restoration; pinned by a shallow `toContain`) → ticket 06, marked as a ticket-03 escape; the tie-break/fold agreement → ticket 01 acceptance.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- ≥3 mutation probes of your own, RED, md5-restored, mutation verified applied.
- [x] `npx tsc --noEmit` clean; the new tests-typecheck script clean or its findings listed; full `bun test` once with every delta accounted; `npm run build`; guards green; `git diff --check` clean. No version bump, no push.

## Report (2026-09-03)

Baseline on this worktree after `git merge --ff-only main` (23c9f579): `bun test` = **4794 pass / 0 fail / 267 files** (ticket's stated baseline said 4793; off by one at HEAD, unrelated to this ticket — noted, not investigated further).

**F2** (`tests/worker/settlement-declare-route.test.ts`, new file): 4 tests driving `declare` through `settlementTurnWriteInputSchema.parse()` → `evaluateSettlementTurnWrite` → `createSettlementDirectWriteEngine.writeNote` — matching-class CAS declare (+ `declared`/receipt/laneTouches), stale-class whole-call rollback (a legal `use` attach riding beside the failing `declare` also vanishes), `tailTag: null` clears while an omitted `headTag` in the same call survives, and a true no-op declare. `grep -rn "declare:" tests/` now finds it.

**F3**: fixed the duplicate `use:` key (JS silently drops the first) so the tagged entry to T2 is actually sent alongside the self-referential one — the test now genuinely proves the legal entry gets taken down by the illegal one, not just a bare self-edge refusal. Added `tsconfig.tests.json` (extends `tsconfig.json`, `include: ["src/**/*","tests/**/*"]`, `rootDir: "."`, `noEmit: true`) and `npm run typecheck:tests`. It surfaces **365 pre-existing test type errors** (full list in the agent's final report) — none in files this ticket touches. In `tests/worker/note-settlement-turn-facade.test.ts` (a file this ticket already touches) fixed 13 cheap, behavior-preserving ones: two retired-option-object call sites (`evaluateSettlementTurnWrite`/`renderSettlementTurnWriteReceipt` dropped their `apply`/`staged` params under ticket 11), one retired-mode-literal cast (`as never`, deliberately off-schema by design), four dead `tags:` properties on relation-target entries (an unknown key the schema never reads — proven equivalent to the bare-address form already used two lines below each site, so replaced with it), and five `updateTurnById(..., NOW - 10)` calls carrying a 4th arg the function no longer accepts (dropped; the function has no explicit-epoch parameter at all). The remaining 365 are left listed, not touched, per the ticket's instruction.

**F4** (same new file): one real `note` call at exactly 20 outgoing atoms carrying both `retractUse` and `use` succeeds, proving retraction-before-attach at the facade (not just the storage primitive, which `tests/db/relation-degree-caps.test.ts` already pinned via two direct calls).

**F5** (`tests/db/logical-edge-writes.test.ts`, extended the existing `declareEdgeSides` describe block): a second segment declaring the SAME lane word (`#alpha`) as the first proves `endpointLaneTags` resolves each endpoint to its OWN task before intersecting with declared lanes — positive (endpoint declares the shared word under its own task) and negative (naming the word as it exists in the OTHER task refuses `invalid-declaration`, and the endpoint's own real lane still declares fine right after). Kept `endpointLaneTags` as a second reader rather than routing through `collectEdgeSideFacts` — documented why in a comment on the function (different calling convention: one endpoint at a time vs. both sides at once; no caller-supplied in-flight tag correction to thread; the `derivable` cardinality check `collectEdgeSideFacts` has no concept of) — and pinned that the one part that must not drift (segment resolution) doesn't, via the two-segment fixture.

**F6** (`tests/worker/note-settlement-direct-write.test.ts`, new describe block, same full-route pattern as F2): a legacy `extends` row with no `relation_class` yet, re-asserted as `use` through a real call — the receipt reads "1 relation(s) already present, nothing added." (never "Landed"), the stored row's class is genuinely filled in, and the turn's `relations` write-gate stamp sequence is provably unchanged (captured before/after via `getFieldStamp`).

**Mutation probes** (4, ≥3 required), each: single-file edit → targeted `bun test` → confirmed RED → restored from the pre-probe `cp` backup → md5 verified equal to the backup:

| # | Target | Mutation | Result |
|---|---|---|---|
| A | `note-settlement-turn-facade.ts` declare glue (~2170) | `tailTag: entry.tailTag` → `entry.tailTag ?? ""` (same for headTag) | F2's omit-vs-null test went RED (omitted `headTag` was wrongly cleared) |
| B | `note-settlement-turn-facade.ts` (~1893-2129) | moved the retraction block to run AFTER the attach instead of before | F4's cap test went RED (`outgoing-degree-cap` refusal); pre-existing suite (130 tests in the two files) stayed green — confirms this really was an escape |
| C | `note-settlement-turn-facade.ts` (~2188) | `relations.written > 0 \|\| relations.retracted > 0` → added `\|\| relations.restated > 0` | F6's stamp-unchanged test went RED (`write_sequence` moved from `null` to `1`) |
| D | `citations.ts` `endpointLaneTags` (~1362) | segment resolution forced to `Math.min(...segmentTags.values())` (always the lowest segment id, ignoring the endpoint's own task) | Both new F5 tests went RED; all 29 pre-existing tests in the file stayed green — the two-segment fixture is what makes this escape visible |

md5 before/after every restore: `note-settlement-turn-facade.ts` = `78e6c9f0bbfdf3513a96b497ee3ca13c` (probes A/B/C), `citations.ts` = `e3a7ef0b6d4d24eea645002142eee0e3` (probe D) — matched in every case.

**Final verification**: `npx tsc --noEmit` clean (0 errors). `npm run typecheck:tests` → 365 pre-existing errors, 0 new. `bun test` → **4802 pass / 0 fail / 268 files** (delta from baseline: +8 tests / +1 file = the 4 F2 tests + 1 F4 test in the new file + 2 F5 tests + 1 F6 test). `npm run build` clean. `bun test tests/shared/release-artifacts.test.ts` → 11 pass. `grep -c anthropic-ai plugin/scripts/worker.cjs` → `0`. `git diff --check` clean on every touched file. No control bytes in any touched/new file.

**Shared-file note**: `src/db/citations.ts` gets ONE hunk from this ticket — a doc comment added above `endpointLaneTags` (no code change). Ticket 02 (`tests/db/citations.test.ts` etc.) edits this same file elsewhere; this hunk is additive-only and named so it should not conflict.

**UNVERIFIED / left as found**: the 365 pre-existing `typecheck:tests` errors outside files this ticket touches (full list in the implementing agent's final report to the caller) — left exactly as instructed, not investigated for runtime impact.
