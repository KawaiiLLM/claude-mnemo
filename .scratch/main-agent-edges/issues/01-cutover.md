# 01 — Cutover: the legacy stock is made to fit, once, in one transaction, with a complete receipt

**What to build:** spec D9 exactly. After it, `memory_edges` holds relation facts only (class NOT NULL, coverage, sides, provenance), keyed UNIQUE on `(citing, cited)`, with NO `relation` word column and no wordless rows; every stored side means "several lanes, this one"; tags are a hard invariant; a receipt can restore the old state within the rollback boundary.

**Blocked by:** 02, 03, 04, 07, 08 — the code must stop reading `relation` and stop producing wordless rows BEFORE the column and the rows go. Implemented last, released together with all of them.

**Status:** ready-for-agent (after blockers)

- [ ] One receipt-guarded one-shot in `initializeSchema`, all inside ONE `runWriteTransaction`: durable fence (no `claimed` job after atomically reaping expired claims and bumping generation; pending `stage='edges'` jobs reset first; R10-8) → receipts → transforms 1–6 (D9) → `PRAGMA foreign_key_check` → side-index verification → completion marker LAST. Immutable receipt/archive rows separated from a mutable state marker `complete|rolled_back` (R10-10).
- [ ] Transforms: tags normalised by raw update (NULL → `[]`; non-array → `[]`; non-string members dropped) + membership/facet reconcile + stamps for changed tags; fold (relation over bare; class most specific; coverage for correct only; lowest id; one DISTINCT valid declaration survives); clear redundant declarations (unique endpoints); clear invalid declarations; DELETE ambiguous-side edges; DELETE all wordless rows; rebuild `memory_edges` without `relation`, pair-UNIQUE, prune trigger and side index recreated; rebuild `turns` with NOT NULL DEFAULT '[]' and the BEFORE trigger with lazy CASE guards; stamp every citer whose row was folded/cleared/deleted (R10-10).
- [ ] Receipt: old tags, membership rows, every old edge row, gate stamps of touched turns, DDL/index/trigger, `sqlite_sequence`; rollback tool refuses when any receipt-owned domain (relations, tags, memberships) was written after the recorded sequence; rebuild list for facets/type/FTS/side index/caches.
- [ ] Clone report: counts per transform, receipt size, expected-delta manifest for every node reader (fold degree collapses; deleted edges; new election ranking) and every lane view (gaining derived edges), each difference classified EXPECTED or defect.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

**Pinned (T2432, P3):** this ticket carries the raw-word release gate — a test grepping the seven words over `src/` with an explicit allowlist for historical migration literals in `schema.ts`/`lanes.ts`; it must fail on any other occurrence.
