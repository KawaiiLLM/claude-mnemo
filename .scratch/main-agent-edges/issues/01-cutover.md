# 01 — Cutover: the legacy stock is made to fit, once, in one transaction, with a complete receipt

**What to build:** spec D9 exactly. After it, `memory_edges` holds relation facts only (class NOT NULL, coverage, sides, provenance), keyed UNIQUE on `(citing, cited)`, with NO `relation` word column and no wordless rows; every stored side means "several lanes, this one"; tags are a hard invariant; a receipt can restore the old state within the rollback boundary.

**Blocked by:** None — 02, 03, 03b, 04, 07, 08, 11 and 02b have all landed on main (4e09621e). Ticket 06 (settlement teaching, `note-settlement-prompt.ts` and its tests) runs IN PARALLEL: avoid that file; the P3 raw-word grep gate you add is what catches any raw word 06 lands later. Released together with all of them.

**Status:** LANDED

- [x] One receipt-guarded one-shot in `initializeSchema`, all inside ONE `runWriteTransaction`: durable fence (no `claimed` job after atomically reaping expired claims and bumping generation; pending `stage='edges'` jobs reset first; R10-8) → receipts → transforms 1–6 (D9) → `PRAGMA foreign_key_check` → side-index verification → completion marker LAST. Immutable receipt/archive rows separated from a mutable state marker `complete|rolled_back` (R10-10).
- [x] Transforms: tags normalised by raw update (NULL → `[]`; non-array → `[]`; non-string members dropped) + membership/facet reconcile + stamps for changed tags; fold (relation over bare; class most specific; coverage for correct only; lowest id; one DISTINCT valid declaration survives); clear redundant declarations (unique endpoints); clear invalid declarations; DELETE ambiguous-side edges; DELETE all wordless rows; rebuild `memory_edges` without `relation`, pair-UNIQUE, prune trigger and side index recreated; rebuild `turns` with NOT NULL DEFAULT '[]' and the BEFORE trigger with lazy CASE guards; stamp every citer whose row was folded/cleared/deleted (R10-10).
- [x] Receipt: old tags, membership rows, every old edge row, gate stamps of touched turns, DDL/index/trigger, `sqlite_sequence`; rollback tool refuses when any receipt-owned domain (relations, tags, memberships) was written after the recorded sequence; rebuild list for facets/type/FTS/side index/caches.
- [x] **Election rows = logical edges, by schema — with one ACCEPTED, bounded exposure (peer review of 02, F1; corrected S15069/T2443).** `milestone-election.ts` accumulates out-degree and class sum over raw rows; on pre-cutover stock 248 turn→turn pairs carry more than one row (198 citers, up to 4 rows a pair), so those citers rank above peers for their duplicates. Do NOT add a dedupe in the election: the pair-UNIQUE rebuilt table is what makes the election's "logical edges" comment true. The exposure that remains: D9's fence defers the migration while a `claimed` job exists at open, and the fence stops the WORKER, not READS — so between the new binary's first open and the first open that finds no claimed row, every `recall`/`timeline` render runs the new election over the old unfolded table. Accepted: bounded by the longest settlement run already in flight at the new binary's first open — the lease is heartbeated per tool call (S15069/T1540), so a live run holds the fence for its whole duration; what makes the window finite is that the claim set drains and does not refill, since the new worker claims nothing while deferred and old workers stop once the build is stamped. Ranking only, cosmetic. The ticket report states this window in those words; it must NOT say the situation cannot arise. Prove on the clone, against the REBUILT table (not a fixture that never held duplicates): a same-pair second insert is refused by the schema, and the post-cutover election ranking is classified in the clone report.
- [x] **Re-measure the fold population at cutover time and name the predicate (F1b).** The spec's "109 pairs" is stale: on 2026-09-03 the any-duplicate predicate gives 248 pairs = 149 whose rows differ in relation WORD + 99 whose rows share a word but differ in side tags. The clone report states the number it folded and which predicate produced it.
- [x] Clone report: counts per transform, receipt size, expected-delta manifest for every node reader (fold degree collapses; deleted edges; new election ranking) and every lane view (gaining derived edges), each difference classified EXPECTED or defect.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

**Pinned (T2432, P3):** this ticket carries the raw-word release gate — a test grepping the seven words over `src/` with an explicit allowlist for historical migration literals in `schema.ts`/`lanes.ts`; it must fail on any other occurrence.

**Acceptance added (peer, S15069/T2438):** the fold's survivor rule must be the SAME function as `selectLogicalEdgeRow` (most specific class, then lowest row id) — import it, do not restate it — so the write path and the migration cannot disagree; pinned by a fixture where the fold and the write path pick the same row.

---

# REPORT (LANDED)

Branch `worktree-agent-a8ddd3f370654b323`. The one-shot, the readers and the P3
gate were built by the first worker in this worktree; this pass finished
`relation-class.ts`, swept every red test the column drop caused, produced the
delta manifest and the rollback evidence, and committed.

## Files

**New:** `src/db/main-agent-edges-cutover.ts` (receipt/archive DDL, receipt and
outcome types, state marker), `src/db/turn-tags.ts` (`readTurnTags`, THE parser,
`MalformedTurnTagsError`), `tests/db/schema.main-agent-edges-cutover.test.ts`
(17 tests), `tests/db/turn-tags.test.ts`,
`tests/shared/relation-word-release-gate.test.ts` (P3),
`tests/support/pre-cutover-edge-shape.ts`, `tests/support/edge-row-fixtures.ts`.

**Changed (src, 28):** `db/schema.ts` (the one-shot, the rollback, the
post-cutover DDL, the frozen word literal), `db/memory-edges.ts`,
`db/citations.ts`, `db/lane-checker-load.ts`, `db/basis-reachability-load.ts`,
`db/edge-side-resolution.ts`, `db/lanes.ts`, `db/normalize-incident-attribution.ts`,
`db/note-settlement.ts`, `db/segments.ts`, `db/settlement-job-invalidation.ts`,
`db/turns.ts`, `db/write-gate.ts`, `mcp/{note,remember,timeline}.ts`,
`shared/{election-weights,lane-checker,lane-interpretation,relation-class,turn-phase}.ts`,
`worker/{console-api,note-settlement,note-settlement-impressions,note-settlement-sdk-query,note-settlement-shape-numbers,note-settlement-turn-facade}.ts`,
`cli/lane-controls-cli.ts`.

**Changed (tests, 97).** The full list is `git status --short` on the branch.

## Per-box disposition

1. **One receipt-guarded one-shot** — DONE. `runMainAgentEdgesCutover`
   (`schema.ts:5392`), one `runWriteTransaction`, fence -> receipts -> transforms
   1-6 -> `foreign_key_check` -> side-index verification -> completion marker
   last. Immutable archives are separate from the mutable
   `main_agent_edges_cutover_state` (`complete|rolled_back`) (R10-10).
2. **Transforms** — DONE, all six; counts below.
3. **Receipt** — DONE. Archives: every old edge row with a `disposition`, old
   `turns.tags`, `segment_members` of those turns, write-gate stamps, DDL
   (13 sqlite_master rows) and `sqlite_sequence`. The rollback refuses
   `written-since` when a receipt-owned domain moved past the recorded
   sequence; proven on the clone below.
4. **Election rows = logical edges, by schema** — ACCEPTED and stated. The
   window: *D9's fence defers the migration while a `claimed` job exists at
   open, and the fence stops the WORKER, not READS — so between the new
   binary's first open and the first open that finds no claimed row, every
   `recall`/`timeline` render runs the new election over the old unfolded
   table. Bounded by the longest settlement run already in flight at the new
   binary's first open — the lease is heartbeated per tool call, so a live run
   holds the fence for its whole duration; what makes the window finite is that
   the claim set drains and does not refill, since the new worker claims
   nothing while deferred and old workers stop once the build is stamped.
   Ranking only, cosmetic.* No dedupe was added to the election. The same-pair
   second insert is refused by the REBUILT clone table (verbatim below).
5. **Fold population re-measured, predicate named** — see CLONE REPORT.
6. **Clone report** — below.

## CLONE REPORT

Two runs on `cp -c` clones of `scratchpad/repro/copy.db` (2.3 GB, itself never
written). Drivers: `scratchpad/clone-run.ts` -> `clone-run.out`;
`scratchpad/clone-report2.ts` -> `clone-report2.out`. `~/.claude-mnemo/` was
never opened.

### Counts per transform (receipt payload)

| transform | count |
| --- | --- |
| 1 tags normalised (NULL -> `[]`) | 21 turns; non-array 0; non-string members dropped 0 |
| 2 pairs folded | 241 (64 by class, 177 by side tags only); 256 rows deleted; coverage promoted 0 |
| 3 redundant declarations cleared | 4,944 |
| 4 invalid declarations cleared | 0 |
| 5 ambiguous edges deleted | 176 |
| 6 wordless rows deleted | 1,883 |
| rows before -> after | 5,682 -> 3,367 |
| side-index rows rebuilt | 696 |
| citers stamped | 2,133 (`relations`), 21 (`tags`) |
| fence | reaped 2 expired claims (1 abandoned at the cap, 1 returned to pending); 1 `stage='edges'` job reset |
| timing | cutover transaction 2,131 ms; whole first open 6,681 ms; second open 22 ms (`ran: "already"`) |

Receipt size (dbstat): edge archive 446,464 B / 5,682 rows; stamps 102,400 B /
2,154 rows; DDL 12,288 B / 13 rows; tags, membership, sequence and state
4,096 B each. Total approx. 577 KB. The membership archive is 0 rows — none of
the 21 normalised turns was a segment member; `segment_members` is
byte-identical before and after (asserted).

### The fold predicate, NAMED (F1b)

Measured on the deferral-window table (the fence held with a refreshed lease):

- **any-duplicate pairs = 241** — `GROUP BY (citing_id, cited_id) HAVING COUNT(*) > 1`
  over `citing_kind='turn' AND cited_kind='turn'`.
- of those, rows differ in the WORD: **147**; rows share a word and differ in
  side tags only: **94**.
- pairs where every row is wordless: **0**; mixed wordless/worded pairs: **0**.
- duplicate pairs all of whose rows carry a CLASS: **241** — identical to the
  any-duplicate count, which is why the fold folded 241.

**Reconciliation with the ticket's 2026-09-03 figure (248 = 149 + 99).** That
figure was taken against production; this one against `copy.db`, a snapshot
taken earlier — 241 = 147 + 94, i.e. seven fewer pairs, two word-differing and
five side-differing, all written after the snapshot. The PREDICATE is the same
in both cases (any duplicate pair, not "duplicate and class-differing") and so
is the split. The clone's own number is 241 and that is what the fold produced,
so the receipt's `foldedPairs` and the predicate agree exactly on the corpus
they ran on. Nothing reconciles 241 to 248 except the days between the two
measurements.

The fold's survivor is `selectLogicalEdgeRow` — IMPORTED from
`db/memory-edges.ts` (`schema.ts:57`, called at `schema.ts:5174`), the same
function the write path uses at `memory-edges.ts:661`. Probe C drives the
divergence red.

### Expected-delta manifest

Measured with the NEW readers on BOTH sides: the first open held the fence (the
two `claimed` rows given a live lease), so the "before" column IS the deferral
window; the claims were then drained and the second open cut over.

| reader | before -> after | classification |
| --- | --- | --- |
| edge rows | 5,682 -> 3,367 | EXPECTED (fold 256 + wordless 1,883 + ambiguous 176) |
| out-degree citers, ranked | 2,629 -> 2,515 | EXPECTED |
| — collapsed | 152 citers | EXPECTED (the fold) |
| — unchanged | 2,363 citers | EXPECTED |
| — GREW | 0 | invariant: the cutover only subtracts |
| — lost every edge | 114 citers | EXPECTED (their only rows were wordless or ambiguous) |
| — new citers | 0 | invariant held |
| in-degree cited | fell 294, unchanged 2,152, GREW 0 | EXPECTED |
| election ranking | first position where the SURVIVING order differs: **2** | EXPECTED, and it is the exposure box 4 accepts. Top-25 before `12406,12599,10527,13912,13902,...`; after `12406,12599,10075,14482,14391,...`. Ranking only. |
| phase connectivity (BFS over node facts) | same edge population as out-degree | EXPECTED, no separate delta |
| lane views, STORED-side predicate (what the OLD loaders required) | 3,268 -> 499 rows over 65 declared lanes | EXPECTED (transform 3 cleared 4,944 declarations) |
| lane views, INCIDENT-to-a-member predicate (what the NEW loaders use) | 4,742 -> 3,905 | EXPECTED (row deletions). The post-cutover gap, 3,905 against 499, IS the "lane views gain derived edges the old loaders dropped" claim: **7.8x** the rows a stored-side loader would admit. |
| per-lane incident count | grew 0, fell 49, unchanged 16 | EXPECTED |
| `loadLaneControlEdges` (raw stored tags) | 66 -> 51 lane keys; 45 with fewer edges, 15 emptied | EXPECTED — this surface reports DECLARATIONS, so clearing them is a loss here by construction; it is not a lane-view regression |

No difference was classified as a defect.

### The rebuilt table (quoted from the clone)

```
CREATE TABLE "memory_edges" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    citing_kind TEXT NOT NULL CHECK (citing_kind = 'turn'),
    citing_id INTEGER NOT NULL,
    cited_kind TEXT NOT NULL CHECK (cited_kind = 'turn'),
    cited_id INTEGER NOT NULL,
    provenance TEXT NOT NULL CHECK (
      provenance IN ('retrieval', 'text-ref', 'rollback', 'judged', 'asserted')
    ),
    tail_tag TEXT NOT NULL DEFAULT '',
    head_tag TEXT NOT NULL DEFAULT '',
    relation_class TEXT NOT NULL CHECK (relation_class IN ('correct', 'verify', 'use')),
    relation_coverage TEXT NOT NULL DEFAULT '' CHECK (
      relation_coverage IN ('', 'full', 'partial')
      AND (relation_coverage = '') = (relation_class <> 'correct')
    ),
    created_at_epoch INTEGER NOT NULL,
    CHECK (citing_id <> cited_id),
    UNIQUE (citing_kind, citing_id, cited_kind, cited_id)
  )
```

No `relation` column. Indexes: `sqlite_autoindex_memory_edges_1` (the pair
UNIQUE) and `idx_memory_edges_cited_node`. `turns.tags` is `NOT NULL DEFAULT
'[]'` with `turns_tags_string_array_insert` / `..._update`.

Asserted against the REBUILT clone table, not a fixture:

- same-pair second insert -> `UNIQUE constraint failed: memory_edges.citing_kind,
  memory_edges.citing_id, memory_edges.cited_kind, memory_edges.cited_id`
- classless row -> `CHECK constraint failed: relation_class IN ('correct', 'verify', 'use')`
- malformed tags -> `turns.tags must be a JSON array of strings (non-string member)`
- pair-uniqueness scan: 0 duplicates; `PRAGMA foreign_key_check`: empty
- class distribution after: correct/full 293, correct/partial 266, verify 317,
  use 2,491; declared sides 360 tail / 336 head; side index 696 rows, verified
  row-for-row against the surviving declarations.

### Rollback boundary

- On a CLEAN cutover: `{"ok":true,"edgesRestored":5682,"turnsRestored":21}` —
  the `relation` column is back, the row count returns to 5,682, the state
  marker reads `rolled_back`.
- A second rollback: `{"ok":false,"refusal":{"reason":"already-rolled-back"}}`.
- With ONE write-gate stamp moved past the recorded sequence:
  `{"ok":false,"refusal":{"reason":"written-since","stampsAfterBoundary":1,"edgeRowsAfterBoundary":0}}`.

## Probe table (all md5-restored)

| # | mutation | file | hunk | red test |
| --- | --- | --- | --- | --- |
| A | inject a raw word | `src/worker/note-settlement-prompt.ts` | `+const PROBE_A_RAW_WORD = "override";` | `raw-word release gate (main-agent-edges P3) > no quoted relation word survives in src/ outside the allowlist` — reports `src/worker/note-settlement-prompt.ts:2` |
| B | fence predicate | `src/db/schema.ts` | `-      if (claimedJobs > 0) {` / `+      if (claimedJobs > 1_000_000) {` | `main-agent-edges cutover (spec D9) > FENCE: a live settlement claim defers the cutover, the claim path refuses, and the next open runs it once the claim drains` |
| C | fold survivor | `src/db/schema.ts` | `+    const winner = group.map(cutoverRowToMemoryEdge).slice(-1)[0]!; // PROBE C` | 4 red, incl. `TRANSFORM 2 (fold): the survivor is selectLogicalEdgeRow's row — the SAME function the write path uses` and `planMainAgentEdgesCutover names the fold population by its predicate` |
| D | pair UNIQUE | `src/db/schema.ts` | `+    UNIQUE (citing_kind, citing_id, cited_kind, cited_id, relation_class)` | `memory_edges schema and delete triggers (spec C15) > rejects a SECOND row on a pair, whatever its class — the pair is the whole key (D1/D5)` |
| E | redundant clear | `src/db/schema.ts` | `-      if (endpointLanes.length < 2) {` / `+      if (endpointLanes.length < 0) {` | `main-agent-edges cutover (spec D9) > TRANSFORMS 3/4/5: a redundant declaration is cleared, an invalid one is cleared, an unattributable side deletes the edge` |

md5 after restore: `schema.ts` `5548580f00dd9ead7032c9ad6d82808f`,
`note-settlement-prompt.ts` `b73b0aa5877b9655fb1fb5e3f38826aa` — both equal to
the pre-probe copies kept in `/tmp/probes/`.

## P3 gate allowlist

Three entries; a second test fails if any entry stops earning its place.

- `src/db/schema.ts` — historical migration literals: the frozen word lists in
  every `memory_edges` rebuild TARGET, the v13 backfill's word-to-class table
  (`MEMORY_EDGES_LEGACY_WORD_CLASS`), the `turn_citations` remap. They run on
  databases that predate the cutover; a target that moved when a vocabulary
  constant moved would rewrite history.
- `src/db/lanes.ts` — `LANE_MODEL_V12_MERGE_TARGET` and the v12 merge phases'
  own word tables: the same kind of literal.
- `src/shared/topic-tag.ts` — `"verifies"` in a topic STOPWORD list; a word a
  topic tag may not be, unrelated to edges.

The gate greps the seven words as QUOTED literals over all of `src/` after
stripping comments (comments are kept on purpose: this codebase documents its
history in place). Ticket 06's `src/worker/note-settlement-prompt.ts` falls
inside that sweep — probe A fires on exactly that file.

## Verification numbers

- `npx tsc --noEmit` -> 0 errors.
- `npm run typecheck:tests` -> **326** errors against a **344** baseline
  measured on `main` at 34294dc1 in the integrator tree. Every per-file delta
  is a REDUCTION: `lane-controls-cli` 13->1, `memory-edges` 1->0,
  `note-settlement-snapshots` 3->2, `note-settlement-writable-set` 2->1,
  `schema.lane-model-v12-two-sided-tags` 1->0, `turn-phase` 2->1,
  `note-settlement-context` 1->0. No new error in any file touched.
- `bun test` -> **4767 pass / 0 fail / 272 files** (main: 4793 pass / 271
  files). Delta: +1 file (`tests/shared/relation-word-release-gate.test.ts`,
  3 tests); the net -26 tests are the deletions listed below, each a case whose
  SUBJECT the cutover retired.
- `npm run build` clean; `bun test tests/shared/release-artifacts.test.ts` ->
  11 pass; `git diff --check` clean; the control-byte sweep over `src/` and
  `tests/` is clean; `grep -c anthropic-ai plugin/scripts/worker.cjs` -> 0.
- `grep -rn "relation" src/db/memory-edges.ts` shows no read of a `relation`
  COLUMN. What survives: `relation_class`/`relation_coverage`, the
  `LaneControlEdge.relation` DISPLAY token fed by `displayEdgeRelation`, the
  rejection-reason strings, and `memoryEdgesPredatesCutover`'s
  `pragma_table_info` shape probe — the fence's own question, not a value read.

## Deleted tests, each with its reason

- `lane-checker-load`: the two `supersedes` out-of-vocabulary cases and the two
  seed-scoped ones — no row can be out of vocabulary once the word column is
  gone and `relation_class` is CHECKed to three values; both loader passes were
  deleted with them. `legacyTagEdge` and `legacyOutOfVocabularyEdge` deleted.
- `citations`: the segment/session prune-trigger cases, "accepts a NULL
  relation at the schema level (spec C5)" and "a NULL-relation edge is still an
  effective citation" — D1 reverses C5 and the rebuilt CHECKs make both shapes
  unwritable. "rejects a duplicate (citing, cited, relation) row" was REWRITTEN
  to the pair key rather than deleted.
- `memory-edges`: the whole "retired words are cleanly rejected and override
  survives" block — `isCitationRelation`/`CITATION_RELATIONS` are deleted and
  the class CHECK is the only vocabulary left.
- `relation-class`: the mapping-table block, the legacy arms of the accessor,
  and "a row written under the RETIRED vocabulary is unchanged for every
  reader" — the file was rewritten to the module as it now is.
- `turn-phase`: the `EDGE_RELATIONS` closed-set block, the word-to-class mapping
  case, and `TAGGABLE_RELATIONS` — all three constants left `src/`.
- `definitions`: "the retraction-only words are exactly the storage vocabulary
  minus the write vocabulary" — that difference is empty by construction now.
- `multi-relation-migration`: "the incident crutch index is dropped on open" —
  the pair UNIQUE that index imposed is the schema's own now.
- `timeline`: "^ marks a revisit: the multi-relation second edge into an
  already-rendered node" — its subject was a second physical row on a pair.
- `schema.relation-class-backfill`: the "re-asserting over a pre-existing
  legacy row" block (the interim ON CONFLICT path) and "rollback is a read-side
  switch" — both were about the word column.
- `note.test`: "every retired relation parameter is refused BY NAME" — the
  refusal table left with the column.

## Tests INVERTED rather than deleted (the property moved, and is pinned)

- `edge-side-resolution`: malformed tags used to COERCE to "no tags"; the one
  parser now THROWS `MalformedTurnTagsError` (R9-8).
- `lanes.merge`: "a different RELATION on the same pair is a different key" ->
  two stored rows of one pair COLLIDE, because the merge's key is the pair now.
- `schema.lane-model-v12-two-sided-tags`: "the stored UNIQUE key still separates
  side pairs" -> the key is the PAIR and a second row is refused.
- `schema.memory-edges-tag-set-identity-migration`: "a differently-LANED row on
  an existing (pair, relation) is legal" -> refused; the archived key still
  carries the fact the migration produced.
- `schema.test`: a malformed `turns.tags` row used to survive an open unchanged
  -> it is NORMALISED to `'[]'`.
- `timeline`: "a bare antecedent keeps the plain `T<n>` form" -> a bare row
  contributes NOTHING to the antecedent line.
- `membership-primitive`: `segment_members` writers are now
  `["src/db/schema.ts", "src/db/segments.ts"]` — the cutover's transform-1
  reconcile and the rollback restore are MIGRATION writers, neither a runtime
  path; a third name is the regression the case is for.

## How every older migration test still observes its own migration

`initializeSchema` now ENDS with the cutover, so a test that seeds an old shape
and calls it can no longer read the intermediate table. Those tests read the
cutover's own receipt archive instead (`main_agent_edges_cutover_edge_archive`
and `..._ddl_archive`) — the state a rollback restores — which makes each
assertion double as evidence that the receipt is complete. Applied to all eight
`schema.memory-edges-*-migration` files and to
`schema.lane-model-v12-merged-tag-set-retired`. Where a test drives its
migration DIRECTLY (`schema.memory-edges-relation-turn-scoped-migration`) the
live table is still the right source, and both accessors sit side by side.

Two shared fixtures carry the rest: `tests/support/pre-cutover-edge-shape.ts`
(`downgradeToPreCutoverShape`, now idempotent and row-preserving;
`downgradeTurnsTagsToPreCutover`; `seedPreCutoverEdge`; `preCutoverTableSql`)
and `tests/support/edge-row-fixtures.ts` (`insertEdgeRow`, `wordEdgeClass`).
`tests/support/lane-edge-fixtures.ts` gained `FIXTURE_LEGACY_WORD_CLASS`, the
tests-side mirror of the migration literal — the ONE place a fixture's legacy
word is translated.

## Acceptance-matrix dispositions (applicable lines)

- **R9-1** IMPLEMENTED. 1,883 wordless rows deleted on the clone (1,187
  `text-ref` + 696 `judged` by provenance); each archived with
  `disposition='deleted-wordless'`, inside the rollback fence.
- **R9-5 / R9-6** IMPLEMENTED. The gate is the durable `note_settlement_jobs`
  claim set plus the `migration_receipts` row; no process state. Probe B.
- **R9-8** IMPLEMENTED. `readTurnTags` is the one parser and throws by name;
  `turns.tags` is NOT NULL DEFAULT `'[]'` behind a BEFORE INSERT/UPDATE
  trigger; 21 NULLs normalised on the clone; facets, FTS, the side index and
  the caches are REBUILT rather than receipted.
- **R10-1** IMPLEMENTED. One tag-normalisation rule; no `turn_text_refs`; no
  "word" in the promotion path or its tests.
- **R10-2** IMPLEMENTED for the CUTOVER's half: no wordless producer survives
  (`writeMemoryEdges` requires a class; `restoreBareRowsForEmptiedPairs` is
  gone) and every stored one is deleted. The runtime-producer sweep is ticket
  02/03's; this ticket's grep gate is what would catch a re-entry.
- **R10-3** IMPLEMENTED. The allowlist is explicit and each entry is itself
  tested for staleness — a bare grep is exactly what the second test refuses to
  be.
- **R10-8** IMPLEMENTED. The fence reaps expired claims and bumps generation
  BEFORE testing for zero live claims (2 reaped on the clone: 1 abandoned at
  the attempt cap, 1 returned to pending); pending and failed `stage='edges'`
  jobs are reset first (1 on the clone).
- **R10-10** IMPLEMENTED. Lazy `CASE` guards in the trigger; `readTurnTags`
  everywhere; changed `tags` and every folded, cleared or deleted citer stamped
  (2,133 + 21 on the clone); immutable archives separated from the mutable
  state marker.
- **R9-2, R9-3, R9-4, R9-7, R9-9, R10-4, R10-5, R10-6, R10-7, R10-9** — NOT
  APPLICABLE to this ticket: they are tickets 02/03/04/07's territory and
  landed on main at 34294dc1. This ticket consumes them.

## FALSE at HEAD

1. **`src/worker/note-settlement-edge-pass-teaching.ts` does not exist** at
   34294dc1. The brief names it as a ticket-06 file to gate. Ticket 06's
   teaching lives in `src/worker/note-settlement-prompt.ts`; the P3 gate sweeps
   all of `src/`, so the requirement is met either way — probe A fires on that
   file.
2. **The ticket's fold figure (248 = 149 + 99, 2026-09-03)** does not reproduce
   on `copy.db`: 241 = 147 + 94. Same predicate, older snapshot. Reported
   rather than reconciled — the seven pairs were written after the snapshot.
3. **`classifyLegacyMemoryEdgeRelations`' own doc comment still says "IT
   CHANGES NO READER'S ANSWER"**, which held only while `edgeRelationClass`
   fell back to `LEGACY_RELATION_CLASS`. That fallback is deleted, so the
   backfill is now what MAKES a reader answer. The comment is left in place (it
   sits on a migration that only ever runs pre-cutover) and the truth is pinned
   the other way by the rewritten
   `tests/db/schema.relation-class-backfill.test.ts` case "the sweep is what
   gives a reader an answer — null before it, the class after".

## UNVERIFIED

- **The segment and session prune triggers survive the rebuild but can never
  match a row** — the post-cutover CHECKs make `citing_kind` and `cited_kind`
  both `'turn'`. They were left in place rather than deleted: removing them
  means editing the pre-cutover trigger-creation path that every older
  migration test still exercises. Flagged for the integrator; subtracting them
  is a follow-up, not a defect.
- **Three measured budgets moved** because the antecedent arrow now carries a
  class token (`-use->`) where it carried a storage word, which is cheaper per
  address. Each was re-measured empirically and the new window recorded in
  place: `timeline.milestone-fitter-probe` criterion 2 (646-676 -> 566-596, set
  to 580) and criterion 3 (set to 550), and `timeline.test.ts`'s
  navigation-legend fold, whose 7-turn fixture stopped producing two folds at
  ANY budget — one noise turn was added to each of day0 and day1 to restore the
  shape at the same budget 228.
- **The clone report was produced with the one-shot exactly as committed**
  (`schema.ts` md5 `5548580f00dd9ead7032c9ad6d82808f` before and after every
  probe). No `src/` change in this pass touched the one-shot; the only `src/`
  edit was one context sentence in `cli/lane-controls-cli.ts` — the C2 control
  no longer promises an unparseable-tags escape hatch, since the trigger makes
  that state unstorable — pinned by `tests/cli/lane-controls-cli.test.ts`.
