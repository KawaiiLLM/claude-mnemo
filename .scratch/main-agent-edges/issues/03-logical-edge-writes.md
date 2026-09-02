# 03 — Logical-edge writes: declare in place, promote in place, retract by class, cap by pair

**What to build:** spec D4 + D5 + the read-once 00 addendum. `declareEdgeSides` (three-state patch, cardinality < 2 refused, in place, one stamp, lane touches); `attachTurnRelations` precedence (most specific; same-call full+partial refuses the call; stronger promotes in place; weaker no-op; never a second row); retraction resolves by materialized class; 20/20 caps count logical edges; the fresh-turn gate exception (zero outgoing relation atoms → no relations read required, writer-agnostic, in the write transaction, bare rows not counted); the public `note` entry union (strings for verify/use, `{turn, coverage}` for correct; two-sided entries refused) split from the settlement shape (R10-5); declaration addressed by pair with class as a CAS precondition.

**Blocked by:** None (works on the current schema; must stop writing the `relation` word — write class/coverage only — and stop producing bare rows: R10-2's producers/restorers deleted here).

**Status:** LANDED **VERIFIED S15069/T2437 at 071b4de3+e7354ab2 (merged 16dc1087; one comment conflict with ticket 08 kept both)**: tsc 0, 4793/0/267 (−12 net, +1 file, accounted), guards clean. My real probes: the declare CAS ignored → RED (1); the equal-class tie-break flipped to the highest row id → SURVIVED — the report's "same tie-break as D9's fold" was a comment, not a pin; pinned in this commit with a two-row fixture (RED under the mutant). Peer implementation review requested. Worker findings carried: the prose-mention lint never existed (settlement prompt teaches a warning nothing implements → ticket 06); qualified `[S/T]` prose no longer feeds the citation graph → tickets 05/06 decide whether `note` still teaches that form; `dropBarePairRow` and the `retracted-bare-restored` CHECK value survive until ticket 01.

- [x] Every rule above pinned; retraction of a promoted edge by its NEW class succeeds and by the old fails by name; caps count pairs.
- [x] Wordless-row producers and restorers (`recomputeTurnCitedPairs`, `reconcileCitedPairs`, `restoreBareRowsForEmptiedPairs`, `relation: null` writes, the "Cites N pair(s)" receipt line) deleted; the prose-mention lint DOES NOT EXIST as code — see the report.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY; measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean`. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. ≥3 mutation probes of your own, RED, md5-restored — and a probe whose mutation did not apply is not a probe.
- Dispose of every applicable line of `../acceptance-matrix.md` in your report.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once with every delta accounted; `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

**Pinned (T2432, P1):** `declareEdgeSides` and retraction address the PAIR `(citing, cited)`; `class` is an optional CAS precondition — supplied and mismatched → refuse naming the current class; omitted → no check.


---

## Report

### What landed

**`src/db/memory-edges.ts` — one pair, one row.**
`writeMemoryEdges` no longer inserts per `(pair, relation, tail, head)`. It reads the pair's
row (`selectLogicalEdgeRow`, exported: most specific class, then lowest row id — the same
tie-break D9's fold uses, so the write path and the migration cannot disagree about which row
IS the edge) and then either INSERTs, PROMOTEs in place, or no-ops. The promotion assigns
`relation`/`relation_class`/`relation_coverage` by ROW ID; `provenance`, `created_at_epoch`
and both side tags are absent from the `SET` list, and that absence is the contract.
`WriteEdgesResult` gains `promoted`. `RELATION_CLASS_SPECIFICITY` (`use` < `verify` <
`correct`, coverage NOT in the rank) is exported for both this file and `citations.ts`.
`updateEdgeSides(db, rowId, {tailTag, headTag})` is the new declaration primitive — it
rewrites the side index and assigns nothing else.

**The wordless write path is refused by name.** `WriteEdgeInput.relation` is non-null;
a `relation: null` input returns `bare-row-retired` rather than being dropped silently.
`insertBarePairRow`/`readPairRow`/`reconcileCitedPairs` are deleted. `dropBarePairRow`
SURVIVES: pre-cutover rows still stand until ticket 01 deletes them, and a relation write must
still displace the stale wordless row on its pair.

**Retraction addresses the pair (T2432 P1).** `RetractEdgeInput` is `{citing, cited}` and
`retractMemoryEdges` deletes every row of the pair — including a legacy wordless one, since the
pair is the edge. The CLASS moved up a layer into `retractTurnRelations` as an OPTIONAL
compare-and-swap precondition over a new `TurnRetractionFieldInput`
(`relationClass: RelationClass | null`): mismatched refuses the whole call by name
(`stale-class`, carrying `currentClass`), `null` checks nothing. Side tags left the address
entirely, so a retraction no longer fails because somebody declared a lane since.

**`src/db/citations.ts` — precedence, caps, declaration.**
`attachTurnRelations` resolves the call per PAIR before writing: several classes on one pair
collapse to the most specific; `correct(full)` + `correct(partial)` on one pair refuses the
WHOLE call (`coverage-conflict`, a new reason — the two bits are the same specificity and
contradict each other, so there is no most-specific to pick). `written` now means CHANGED
(created or promoted) and `restated` means the row already said it at least as strongly.
Caps count LOGICAL edges: `countLogicalOutgoingEdges`/`countLogicalIncomingEdges` count
distinct pairs carrying a class, and the cap's "additions" filter is by pair, so promoting a
stored edge at the cap succeeds. `declareEdgeSides` is new (D4) — see below.

**`src/db/write-gate.ts` — the fresh-turn exception.** `hasNoOutgoingRelationAtoms` runs
inside the write transaction, after the own-writer stamp shortcut and BEFORE the completeness
lookup, writer-agnostic, `relation IS NOT NULL` so wordless rows do not count. One atom closes
it and staleness is untouched.

**`src/mcp/definitions.ts` + `src/mcp/note.ts` — the public entry union (R10-5).**
`publicRelationTargetEntryShape` (string, or `{turn, coverage}`, `.strict()`) and
`publicRetractionTargetEntryShape` (string) are the main agent's; `settlementNoteInputShape`
declares its OWN six against the unchanged two-sided `relationTargetEntryShape` instead of
borrowing `noteInputShape`'s objects by identity. `note.ts`'s `isRelationTargetEntry` refuses
`tailTag`/`headTag` for a caller that bypasses zod.

**The settlement facade exposes `declareEdgeSides` as `declare`** — settlement-only,
`{turn, class?, tailTag?, headTag?}`, applied after the attach (a run may fill an edge and
declare its side in one call), all-or-nothing, touches pushed onto the run's `laneTouches`,
outcome gains `declared: number` and a receipt line. It rides the same `type` gate and
relations gate as any other edge mutation.

### R10-2's producers and restorers, disposed

Deleted: `recomputeTurnCitedPairs` + its two result types (`db/citations.ts`);
`reconcileCitedPairs` (`db/memory-edges.ts`); `restoreBareRowsForEmptiedPairs` and
`readTurnBodyFields` (`db/citations.ts`); `reconcileSegmentCitedPairs` and its EIGHT call
sites (`db/segments.ts`); both session-field rescans (`db/sessions.ts`); `clearLane`'s
restoration, the `bareRowsRestored` receipt field and its `remember` receipt line
(`db/lanes.ts`, `mcp/remember.ts`); the `"Cites N pair(s)"` line and the whole `citations`
result channel (`mcp/note.ts`); the facade's own recompute call
(`worker/note-settlement-turn-facade.ts`); the legacy `turn_citations` fold's wordless winner
(`db/schema.ts` — skipped rather than folded).

`formatRetractionReceipt` lost its `restored` number. The homeless retraction audit stops
PRODUCING `retracted-bare-restored`; the value stays in the storage CHECK and its reader stays
with it, because rows written before this release still carry it.

**The prose-mention lint: DELETED BY CALL-SITE SWEEP — because it never existed as code.**
A sweep of `parseInlineCitations` / `parseQualifiedReferences` call sites, of `text-ref`
readers, and of the lane-checker's finding classes found no mechanical "mentioned in prose but
never cited" check anywhere in `src/`. The only trace is one teaching sentence in
`worker/note-settlement-prompt.ts` (~1050-1058) claiming such an address "is reported as a
WARNING only" — which is FALSE AT HEAD and was false before this ticket. It is left in place:
it is settlement teaching, ticket 06 owns that surface, and correcting it here would collide
with 06's rewrite. Flagged in the report as a pre-existing false teaching.

### Expected deltas

- Prose in `title`/`insight` no longer contributes to `getEffectiveCitations` (only the
  deleted rescan scanned those fields; the surviving union parses `content`). Recorded in
  `tests/db/citations.test.ts`.
- The qualified `[S<n>/T<m>]` form no longer contributes at all — the surviving prose reader
  parses the inline `[T<dbid>]` grammar. Same test.
- A legacy `turn_citations` pair whose winning relation was null is no longer folded across.

**Peer implementation review (S15069/T2438): storage mechanics SOUND; six escapes.** F1 (false teaching created by this ticket's deletion) → ticket 06, recorded as a 03 escape; F2 (`declare` production route untested end to end), F3 (dead test via duplicate object key; no tests typecheck), F4 (retract+attach at the cap pinned below the call boundary), F5 (second copy of the endpoint-lane rule; two-task fixture missing), F6 (non-stamping restatement unpinned) → ticket 03b. R10-6 stays OPEN against tickets 02/04 (P2), not disposed here. Review base for this ticket is a30080d6..16dc1087 (44 files, +4290/−3023 src+tests).
