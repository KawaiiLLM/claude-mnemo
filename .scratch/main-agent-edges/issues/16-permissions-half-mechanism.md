# 16 — The write-permission split has no input left: delete it

**What to build:** follow-up subtraction from ticket 14's report. After the ruling that ambiguity is a warning (S15069/T2465–T2466), every surviving writable provenance (`window`, `lookback`, `closure`) carries BOTH field and relation authority, so `settlementWritePermissions` / `settlementTurnPermissions` and the facade's field gate (`note-settlement-turn-facade.ts` ~1370) can never answer `fields: false` — the refusal branch is unreachable by construction. Delete the split: one authority per writable turn; the facade, `write-gate.ts`'s consumer of it, condition 3 of the finding-class rule, and their tests lose the relations-only arm.

**Blocked by:** None (14 landed, 29e18985).

**Status:** ready-for-agent — LOW priority; not a release blocker (unreachable code, no wrong behaviour).

- [ ] `grep -rn "relationsOnly\|fields: false\|RELATIONS_ONLY" src tests` → 0 live hits after the deletion (absence comments allowed).
- [ ] The finding-class rule and the facade's gate read one authority; tests of the deleted arm replaced by their opposite where a subject remains.
- [ ] Revert probe: the split partially re-added → the "every surviving provenance carries BOTH authorities" pin red.

## Constraints

- NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from `cp` copies, md5-verified. Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No subagents. No version bump, no push. Full `bun test` once, every delta accounted.
