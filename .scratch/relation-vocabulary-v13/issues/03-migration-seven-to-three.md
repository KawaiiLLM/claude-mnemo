# 03 — Migrate the graph, no re-judgement

**What to build:** every existing edge lands in the new vocabulary by pure mapping, with the full/partial bit derived from which old word it was.

**Blocked by:** 02.

**Status:** LANDED — VERIFIED S15069/T2405. The wordless population is RULED HERE: it stays `''` (see the report below). Previous status line: blocked by 02 — cleared to run after it (user ruling S15069/T2391). Previous status line: BLOCKED on ticket 06 (user ruling S15069/T2332: v13 does not advance until the shadow settlement comparison returns). The lane-placement question that used to block this is RULED — S15069/T2331, the empty side is legacy compatibility only, readable but never newly created; S15069/T2332, one row per pair at the honest placement. Earlier blocker follows: design-peer verdict 2026-09-01 (NOT READY). Do not dispatch until the semantic rulings listed at the end of the spec are made. See the spec's Status block for what changed and why. **VERIFIED S15069/T2401** (`ca5455cc`): tsc 0, full suite 4651/0/255 (+21/+1 file = the new test file), guards clean. Two probes of mine RED: sweep skipping `verifies` (4), sweep rewriting `relation` (5). Wordless rows staying `''` accepted on the three reasons given (pair-existence record, reader equivalence, retraction address) — and the receipt is what disambiguates `''` = bare from `''` = unswept. Corrections recorded: 3,799 worded + 1,883 wordless (696 judged + 1,187 text-ref) = 5,682 rows; the spec's 3,661 is stale by 138.

Spec: the mapping table in `.scratch/relation-vocabulary-v13/spec.md`. It has NO residue — every one of the 3,661 worded production edges has exactly one destination.

- [x] `override` → class 1, FULL. `narrows` → class 1, PARTIAL. `verifies` → class 2. `extends` / `consume` / `grounds` / `indexes` → class 3. Nothing is re-judged, nothing is dropped, no edge needs a model to look at it.
- [x] The 696 `judged` edges carrying NO relation word are a separate population — decide and state their destination (they are settlement's own output that never got a word).
- [x] The migration is additive and reversible until a later release retires the old column; existing rows keep their original word until that release, so a rollback is a read-side switch.
- [x] Fixtures: one per old word proving its destination and its bit; a legacy-shaped DB proving the migration runs additively; idempotence.
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.

---

## Implementation report — landed

### What runs

`classifyLegacyMemoryEdgeRelations` (`src/db/schema.ts`), called from
`initializeSchema` immediately after `ensureMemoryEdgesRelationClassColumns`
and strictly after every `memory_edges` rebuild. Receipt-guarded on
`MEMORY_EDGES_RELATION_CLASS_BACKFILL_RECEIPT`
(`relation-vocabulary-v13-relation-class-backfill`), double-checked outside and
inside the write transaction — the `retireUntenantedSegmentContentFromSearch`
idiom, for the same reason (two hook processes open the same database for one
Claude Code event).

Set-based: SEVEN UPDATEs, one per legacy word, each
`WHERE relation = ? AND relation_class = ''`. No row loop. Measured directly on
a clone of production: **7.31 ms** for 3,799 rows; a second run changes 0 rows
in 0.97 ms.

The mapping is IMPORTED (`LEGACY_RELATION_CLASS`), not restated as literals the
way `MEMORY_EDGES_LANE_MODEL_V12_RELATION_WORDS` restates its own target. That
literal exists because a migration TARGET must not move when a vocabulary
constant moves. This is the opposite case: the sweep materializes a LIVE
READER's fallback (`edgeRelationClass`), so it must use the reader's own table
or rows migrated on different days would answer differently.

`relation` is never touched. Rollback stays a read-side switch — stop reading
the two columns, or `UPDATE memory_edges SET relation_class = '',
relation_coverage = ''`; a test pins that clearing them restores the pre-sweep
row byte for byte.

### The wordless population — DECIDED: it stays `''`

The 696 `judged` bare rows STAY unclassified, and so do the 1,187 `text-ref`
bare rows beside them (the ticket names only the 696; there are two wordless
populations, not one). Three reasons, any one sufficient:

1. A bare row is not an unclassified relation, it is the PAIR'S EXISTENCE
   RECORD (`db/memory-edges.ts`: "records only that this pair exists"). `use` is
   a claim — the cited output was a direct input to this new output — and
   settlement never made it. Minting it in a migration is re-judgement, which
   this ticket's first bullet forbids.
2. It would break the equivalence the whole migration rests on:
   `edgeRelationClass` returns `null` for a bare row today and would return
   `use` after. The sweep would stop being a materialization.
3. It would corrupt the retraction address. `retractMemoryEdges` addresses the
   bare row as `relation: null` precisely because "never classified" and "this
   classification is wrong" are different retractions.

**How a reader tells "pre-v13, never classified" from "classified as nothing".**
Three states, all decidable from the row plus the receipt:

| state | test | meaning |
|---|---|---|
| never swept | no receipt for this database | every `''` is pre-v13 stock |
| classified as nothing | receipt present, `relation IS NULL` | bare row; permanent, by construction; `bareRowsLeftUnclassified` counts it |
| unknown word | receipt present, `relation IS NOT NULL`, class `''` | a stored word outside `EDGE_RELATIONS`; `unknownWordRowsLeftUnclassified` counts it (production: 0) |

The receipt payload is `{classifiedByRelation, classified,
bareRowsLeftUnclassified, unknownWordRowsLeftUnclassified}`, so every one of
those states is OBSERVABLE rather than inferred.

### Ticket 02's owed gap, closed

`writeMemoryEdges`' `ON CONFLICT` now assigns the class columns — but ONLY onto
a row that carries no class yet (`CASE WHEN memory_edges.relation_class = ''`),
and only the value that row already READS AS: the write's own class when it
carries one, otherwise `LEGACY_RELATION_CLASS` of that very word (the conflict
target pins `relation`, so stored word and incoming word are the same word). So
the conflict path is the migration's materialization reaching one more row, not
a correction. An already-classified row is left exactly as stored — D2 holds, a
restatement never overwrites a claim, and correcting a class is still
retract-then-write.

### Measured on a clone of production (APFS clone of `repro/copy.db`, 2.28 GB)

Before, 5,682 edge rows and NO class columns at all (the clone predates ticket
02's ALTER). After one `initializeSchema`:

| relation | before rows | class | coverage | after rows |
|---|---|---|---|---|
| `override` | 305 (19 asserted / 286 judged) | correct | full | 305 |
| `narrows` | 292 (48 / 244) | correct | partial | 292 |
| `verifies` | 326 (14 / 312) | verify | `''` | 326 |
| `extends` | 1,272 (128 / 1,144) | use | `''` | 1,272 |
| `indexes` | 645 (287 / 358) | use | `''` | 645 |
| `consume` | 488 (143 / 345) | use | `''` | 488 |
| `grounds` | 471 (88 / 383) | use | `''` | 471 |
| NULL, `judged` | 696 | `''` | `''` | 696 |
| NULL, `text-ref` | 1,187 | `''` | `''` | 1,187 |

3,799 worded rows classified (spec says 3,661 — stale by 138; the corpus grew).
1,883 wordless rows untouched. Row count 5,682 before and after; the `relation`
histogram is identical before and after.

Receipt written once:
`{"classifiedByRelation":{"override":305,"narrows":292,"extends":1272,"indexes":645,"consume":488,"grounds":471,"verifies":326},"classified":3799,"bareRowsLeftUnclassified":1883,"unknownWordRowsLeftUnclassified":0}`

**Reader equivalence: 5,682 rows checked, 0 mismatches.** `edgeRelationClass`
returns the identical answer for every row before and after.

Elapsed: cold `initializeSchema` on the clone 1,505 ms (dominated by the two
ALTER TABLEs and the still-unreceipted tenancy reindex); a second open with
every one-shot receipted, 19 ms. The classification itself, timed in isolation,
7.31 ms.

### Verified — S15069/T2405

`npx tsc --noEmit` 0; new tests typechecked under a temp tsconfig extending the
project's, 0. Full `bun test` 4651 pass / 0 fail / 255 files — baseline
4630/0/254 plus this ticket's 21 tests in 1 new file, nothing else moved.
`npm run build`; `tests/shared/release-artifacts.test.ts` 11/0;
`git diff --check` clean; no raw control bytes;
`grep -c anthropic-ai plugin/scripts/worker.cjs` = 0.

Five mutation probes, all RED, all md5-restored: coverage hardcoded to `full`
(3 fail); the `relation_class = ''` guard dropped from the UPDATE (2);
the receipt not written (5); the `ON CONFLICT` fill reverted to ticket 02's
state (3); wordless `judged` rows classified as `use` (4).

### For 05a, beyond ticket 02's section 7

Nothing new is required. Two facts it can now rely on: every worded row in a
swept database carries its class, so 05a may key scoring on `relation_class`
directly instead of going through `edgeRelationClass`'s fallback — but it should
still go through the accessor, because a database opened for the first time
under 05a has not been swept yet at the moment its readers run. And
`relation_class = ''` is no longer a synonym for "legacy": after the receipt it
means bare row, so any 05a query that treats `''` as "old vocabulary" is wrong.
