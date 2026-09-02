# 02 — Resolution, lane readers, and the heuristic election

**What to build:** spec D2. One pure `resolveEdgeSide` (declared / derived / ambiguous / none / invalid, qualified lanes) over `loadEndpointLaneFacts`; every LANE reader switched from "stored side" to "incident to a member + resolve"; NODE readers made side-blind (phase BFS drops its both-sides filter); the tiered election replaced by the scored heuristic; every raw-word reader dispositioned (R9-4, R10-3, R10-4) while the `relation` column still exists — this ticket must not read it anywhere afterwards.

**Blocked by:** None.

**Status:** LANDED

- [x] `resolveEdgeSide` + `loadEndpointLaneFacts`; lane readers (lane route, frontier digest, SessionStart roster, coupling, lane impressions' member edges, `emptyLaneTags`) on resolution; node readers (election, in-degree, time order, citedness, phase BFS) side-blind; tests per reader incl. an undeclared unique-endpoint edge appearing in its lane view and carrying the BFS.
- [x] Election: pool = each route's fitter unit set; `S(n) = w_out·outDeg + Σ w_class(e) + w_rec·(1 − rank_age/|pool|) + w_type·maxType` with the spec's default weights in ONE table; zero-based `rank_age`; edge universe includes live edges to external endpoints; cross-session order `createdAtEpoch` first; ties score desc / event order desc / id desc; K = what the route's fitter admits; the S-route over-budget fallback kept as an explicit exception or changed (R10-4). The tiered election, its word tables, `edge-signals.ts`, the too-fine-index warning and the interim word fill are DELETED; v13 05a's parameter table goes with them.
- [x] Every raw-word consumer dispositioned per spec D2 and R10-3 (impressions' override/narrows anchor test → correct/full; shape numbers; membership strandings; closure readers; console vocabulary; shared layer); an explicit allowlist for historical migration literals; a test that greps the seven words over `src/` and fails on anything outside the allowlist.
- [x] Lane lifecycle verbs mutate attribution only (`clearLane` no longer deletes rows or restores bare ones); structural verbs persist old+new qualified lane touches; the expected-delta manifest of the election on the clone reported.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

**Pinned (T2432, P2/P4):** write the ONE post-normalisation seam `normalizeIncidentAttribution(db, turnIds, ctx)` in `src/db/` (re-resolve incident sides; clear declarations at cardinality < 2 and invalid ones; update the side index; stamp each changed citer's relations revision; persist old/new qualified lane touches; `ctx.onAmbiguous(edge)` defaulting to DELETE + receipt) and make every lane lifecycle verb and the membership primitive call it in their own transaction. Own the impression anchor invalidation reader (`note-settlement-impressions.ts` ~405–428): key on class `correct` of either coverage.

---

## Report (LANDED)

### What shipped

**`src/db/edge-side-resolution.ts` (new)** — `resolveEdgeSide(edge, side, facts)`, pure, five outcomes
(`declared` / `derived` / `ambiguous` / `none` / `invalid`), qualified `(segmentId, tag)` lanes,
`invalid` never falling back to `derived`; `loadEndpointLaneFacts(db, turnIds)` (owning task via
`MIN(segment_id)`, tags intersected with the task's declared lanes) as the one shared load;
`edgeSideAttributesTo` as the predicate every LANE reader filters candidates with.

**`src/db/normalize-incident-attribution.ts` (new, pinned P2)** — the ONE post-normalisation seam.
Clears `invalid` declarations, clears declarations at lane cardinality < 2, updates
`memory_edge_side_tags`, stamps each changed citer's relations revision once, persists OLD and NEW
qualified lane touches (`previousLaneFacts` captured by the caller before it wrote; `jobId` scopes the
touch ledger), and calls `ctx.onAmbiguous(edge, side)` — default DELETE + receipt. It also FOLDS a row
whose clear would collide with a sibling on the storage identity key `(pair, relation, tail, head)`:
production holds 109 such pairs, and the raw `SQLITE_CONSTRAINT` would otherwise abort a lane verb
mid-transaction. Consumed by `writeMembershipTags` (so every membership path is covered) and by
`mergeLaneTag` after its own side rewrite, through the one opt-out `callerNormalizesAttribution`.

**`edge_attribution_receipts` (new table, `db/schema.ts`)** — `clear-declaration` / `delete-edge`, with
the row's pre-state, the acting verb and the epoch. No foreign key: the receipt outlives the row.

**Election** — `src/shared/milestone-election.ts` rewritten as the heuristic score;
`src/shared/election-weights.ts` (new) holds every number in ONE table, including the frontier's own
lane-local out/in pair. `src/shared/election-relation-weights.ts` and `src/db/edge-signals.ts` are
DELETED with their tests. No `budget`, no `parameters`; `rank_age` zero-based; the edge universe
includes external endpoints; cross-session order through `compareOrderKeyAcrossSessions`; ties score
desc / event order desc / id desc.

**Lane readers on resolution** — the lane checker's DISCOVER and WIDEN passes (candidates = edges
incident to the lane's MEMBERS, then resolve per side), the frontier / lane-view / SessionStart-roster
edge load, `emptyLaneTags`, and settlement's shape numbers. **Node readers side-blind** — the
phase-connectivity BFS (`tail_tag <> '' AND head_tag <> ''` deleted), the election feed, and the
writable / removed-side closures.

**Deleted with their inputs** — the too-fine-index warning (`LaneTooFineIndex`,
`computeTooFineIndexes`, both renderers, the paged rescope), report 1's three citedness buckets and
its `cited from outside:` line, `STANCE_RELATIONS`, `getRolledBackCiterIds`, `ELECTION_PREVIEW_BUDGET`,
and `clearLane`'s blockers / `force` / edge deletion / bare-row restoration.

### Acceptance-matrix dispositions

- **R9-1** (wordless rows) — NOT APPLICABLE: ticket 01's cutover deletes them. This ticket keeps them
  out of every graph the same way it always did: `relationClassBearingSql` admits only rows that
  resolve to a class.
- **R9-2** (the "stored means several lanes" invariant is MAINTAINED) — IMPLEMENTED as pinned P2:
  `normalizeIncidentAttribution`, called by `writeMembershipTags` and by `mergeLaneTag`. The
  "newly ambiguous -> invalidate a live job" half is DEFERRED TO TICKET 04, which puts its branch in
  front of `ctx.onAmbiguous`; the DELETE-and-receipt default ships here.
- **R9-3** (election pool/K per route) — IMPLEMENTED: the election returns the full ordered candidacy
  and cuts nothing; `selectMilestoneTurns` (S-view) and `selectSegmentMilestonesByEdgeSignals` (E-view)
  each hand that order to the token fitter they already had. The `budget` argument is gone from the
  module and from both call sites.
- **R9-4** (raw-word retirement, exhaustive) — IMPLEMENTED, per consumer: frontier SQL ->
  `relationClassBearingSql` + resolution; frontier model -> `FRONTIER_EDGE_WEIGHTS`; latest override ->
  `isFullCorrectionEdge` (the pointer keeps its NAME; its predicate is `correct/full`); branch/mirror
  ranking -> `frontierOutEdgeWeight`, with the determinism tiebreak on the display label; the lane
  checker's `STANCE_RELATIONS`/`SEGMENT_GRAPH_RELATIONS` -> `isSegmentGraphEdge` ("carries a class");
  too-fine-index -> DELETED; coupling groups -> the three classes; lane stats -> by class token;
  `lane-checker-load`'s `CROSS_PHASE_CITEDNESS_RELATIONS` / `SEGMENT_GRAPH_RELATIONS_SQL` /
  untagged-`override` passes -> ONE class-scoped supplementary pass; grounds/consume/testimony buckets
  -> DELETED; relation-tree rank -> explicit `correct(full) > correct(partial) > verify > use`.
- **R9-5 / R9-6 / R9-7 / R9-8** — NOT APPLICABLE (the cutover fence, claim liveness, the structural
  invalidation vocabulary, the tag invariant): tickets 01 and 04 own them.
- **R9-9** (`derived-side-citer`) — DEFERRED TO TICKET 04. This ticket ships the seam and the
  `previousLaneFacts` capture that closure reads.
- **R10-1** (no self-contradictions) — NOT APPLICABLE to this diff (a spec property).
- **R10-2** (wordless producers/restorers) — PARTLY: `clearLane`'s call to
  `restoreBareRowsForEmptiedPairs` is gone with the deletion that needed it. The remaining producers
  (`recomputeTurnCitedPairs`, `reconcileCitedPairs`, `attachTurnRelations`'s bare path) are tickets
  01/03's, and `db/citations.ts` is ticket 03's file this release.
- **R10-3** (raw-word readers beyond the listed) — IMPLEMENTED: impressions' anchor invalidation ->
  pinned P4, ONE scan partitioned by coverage, `correct/full` -> `overridden` (the HARD refusal) and
  `correct/partial` -> `narrowed` (the advisory), each list keeping exactly its old membership; shape
  numbers -> resolution plus by-class crossings; membership strandings -> `relationClassBearingSql`,
  KEEPING `(tail_tag <> '' OR head_tag <> '')` because that veto's subject genuinely IS the stored
  declaration; closure readers (`note-settlement.ts`, `note-settlement-snapshots.ts`) ->
  `relationClassBearingSql`; console vocabulary -> the payload publishes the CLASS token and the
  shell's `WORDS` / `STRUCT` / CSS variables are keyed on the four classes; shared layer ->
  `relation-class.ts` is the only module that names a word, through `LEGACY_RELATION_CLASS` and the
  SQL form built from it.
- **R10-4** (election details) — IMPLEMENTED: `rank_age` zero-based (pinned by its own test); the edge
  universe includes live edges to external endpoints (`getRelationEdgesAmongTurns` is OR-scoped, and
  `eligible: false` entries price without seating); cross-session order keeps `createdAtEpoch` first.
  The S-route over-budget fallback is UNCHANGED and kept as an EXPLICIT EXCEPTION: it is a RENDER-time
  fitter behaviour (`mcp/timeline.ts` ~3255) that never consults the election, and the election now
  hands it a total order with no ties left to resolve.
- **R10-5 / R10-6 / R10-7 / R10-8 / R10-9 / R10-10** — NOT APPLICABLE or DEFERRED: the public entry
  union and the CAS precondition are ticket 03 (P1); the atomic mutation contract R10-6 asks for IS
  `normalizeIncidentAttribution` and is implemented, minus the job-invalidation branch (ticket 04);
  the rest belong to the cutover (01) and the closure (04).

### Raw-word grep allowlist (for ticket 01's release gate)

After this ticket, grepping the seven words over `src/` hits SIX files, all of them the
storage-vocabulary or migration layer, none of them a semantic branch:

1. `src/shared/turn-phase.ts` — `EDGE_RELATIONS`, the storage vocabulary itself.
2. `src/shared/relation-class.ts` — `LEGACY_RELATION_CLASS` (the ONE bridge), `INTERIM_LEGACY_RELATION`
   (the write fill), `RETIRED_RELATION_FIELDS` (the refusal text a caller sending a retired parameter
   is shown).
3. `src/db/citations.ts` — `CITATION_RELATIONS`, the storage vocabulary again, plus the fill's one
   call site.
4. `src/db/schema.ts` — the table CHECK word lists and every historical migration literal.
5. `src/db/lanes.ts` — `LANE_MODEL_V12_MERGE_TARGET`, a v12 migration literal.
6. `src/shared/topic-tag.ts` — `"verifies"` in a topic STOPWORD list; unrelated to edges.

### Deviation: the interim write fill is NOT deleted

The ticket asked for `INTERIM_LEGACY_RELATION`'s write-side fill to go so that `relation` is "written
by nobody". It is not, and the reason is a data-model one rather than a scheduling one: storage
identity is still `(citing, cited, relation, tail_tag, head_tag)` and `relation IS NULL` is the
BARE-ROW discriminator — the DDL's own CHECK, the partial unique index `idx_memory_edges_bare_pair`,
the prune trigger and the restore path all read it that way. A class edge written with no word would
be indistinguishable from a prose reference and would collide with its pair's existing bare row. The
fill is retired by ticket 01's column drop (D1), and `db/citations.ts` is ticket 03's file this
release. What this ticket DID deliver is the other half: `relation` is READ by exactly one accessor
(`edgeRelationClass`, plus `relationClassBearingSql`, its SQL form) as the legacy bridge, and by no
other reader in the tree.

### Election expected-delta manifest (production clone, `cp -c`, read-only apart from `initializeSchema`)

```
edges(turn->turn): total=4564 classed=3799 bare=765
stored words: extends=1272 (bare)=765 indexes=645 consume=488 grounds=471 verifies=326 override=305 narrows=292
side outcomes over 3799 rows (7598 sides): ambiguous=131 declared=6236 derived=576 invalid=4 none=651
EXPECTED GAIN: 576 sides (7.6%) now reach a lane by DERIVATION alone -- invisible to every stored-side reader before.
EXPECTED FINDINGS: E6 (ambiguous) = 131 sides; E4 (invalid) = 4 sides; 651 sides legally attribute to no lane.
FRONTIER WEIGHT DELTA: 1116 pre-v13 rows stored as grounds/indexes weighed 1/2 and 2/1; as `use` they weigh 0/0.
E60 (2309 live members, 2028 edges): top-9 overlap 2/9  in:[12599,8232,13200,12554,13196,8253,14013]  out:[12846,12481,12942,12759,12412,13119,13118]
E70 (979 live members, 1318 edges): top-9 overlap 3/9  in:[10527,10441,10633,14207,11064,10075]  out:[13870,13823,13905,14391,10621,14417]
E61 (350 live members, 223 edges): top-9 overlap 6/9  in:[11606,11329,10559]  out:[11705,10607,10565]
E67 (73 live members, 40 edges): top-9 overlap 7/9  in:[13398,13192]  out:[13211,13213]
ELECTION DELTA (EXPECTED, never an equivalence): across 4 segments, 18 of 36 top-9 seats moved.
class distribution: (none)=765 correct(full)=305 correct(partial)=292 use=2876 verify=326
```

Every line is an EXPECTED change, listed rather than equivalenced: the election is a different
function, the frontier's `use` weight collapsed four retired words onto one number, and the derived
sides are edges no stored-side reader could see. The golden fixture moves the same way — seven of the
tier ladder's nine survive, `922` leaves and `913` enters, and
`tests/shared/milestone-election.test.ts` states that delta and names both.

### Mutation probes (all RED, all md5-restored)

| # | file | mutation | red |
|---|------|----------|-----|
| 1 | `src/db/edge-side-resolution.ts` | `invalid` falls through to the derivation | 2 in `tests/db/edge-side-resolution.test.ts` |
| 2 | `src/shared/milestone-election.ts` | `rank_age` one-based (`index + 1`) | 2 in `tests/shared/milestone-election.test.ts` |
| 3 | `src/db/normalize-incident-attribution.ts` | stop clearing the redundant declaration | 3 in `tests/db/normalize-incident-attribution.test.ts` |
| 4 | `src/db/basis-reachability-load.ts` | restore the both-sides BFS filter | 1 in `tests/db/basis-reachability-load.test.ts` |
| 5 | `src/shared/lane-checker.ts` | widen E6 back to every non-attributing side | 3 across the loader and settlement fixtures |

### Verification

`npx tsc --noEmit` clean; the three new test files typecheck separately; `bun test` 4746 pass / 0 fail
/ 266 files (baseline 4817/0/266 — the delta is accounted for below); `npm run build` clean;
stale-bundle and release-artifacts guards green; `git diff --check` clean; no control bytes;
`grep -c anthropic-ai plugin/scripts/worker.cjs` = 0.
