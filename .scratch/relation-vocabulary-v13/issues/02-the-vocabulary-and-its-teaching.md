# 02 — Three classes, one criterion, in the rubric and the tool

**What to build:** the vocabulary itself — what a writer is taught, what the tool accepts, and the one criterion that decides every case.

**Blocked by:** 01 — the cost direction must be known first.

**Status:** LANDED — arm B ships (user ruling S15069/T2391, 先直接落地 B). Previous status line: ready-for-agent — user ruling S15069/T2391 (先直接落地 B). The spec governs where this ticket's bullets predate its restatements: the deciding rule is the three-step PRECEDENCE, and the endpoint rule does not dissolve the `''` machinery (see spec RULING 5). Previous status line: BLOCKED on ticket 06 (user ruling S15069/T2332: v13 does not advance until the shadow settlement comparison returns). The lane-placement question that used to block this is RULED — S15069/T2331, the empty side is legacy compatibility only, readable but never newly created; S15069/T2332, one row per pair at the honest placement. Earlier blocker follows: design-peer verdict 2026-09-01 (NOT READY). Do not dispatch until the semantic rulings listed at the end of the spec are made. See the spec's Status block for what changed and why.

Spec: `.scratch/relation-vocabulary-v13/spec.md` — the classes, the criterion and the sufficiency law are FROZEN from it.

- [x] Three relations replace seven: overturn/correct (carrying a FULL-or-PARTIAL bit), verify/support, use. The tool's schema, the rubric's concepts half, and the settlement teaching all move together — a writer taught one vocabulary and judged by another is the defect this batch exists to remove.
- [x] The deciding criterion ships as ONE sentence, not seven definitions: nodes working towards one conclusion use classes 1 and 2, nodes whose outputs are different conclusions use class 3. Every example in the teaching must be resolvable by applying it.
- [x] The endpoint rule: both endpoints must have a conclusion or output; a turn with no output is not a legal endpoint. Say what this replaces (the DRAFT/unsettled-side machinery) and remove what it makes dead rather than leaving it beside the new rule.
- [x] The sufficiency law, conditional as ruled: where the conclusion rests on earlier nodes, those must be cited; evidence made in this turn owes nothing. Taught as a writing law, with the "mentioned in prose but never cited" lint as its only mechanical proxy (warn, never block — the writer is the only one who knows what is load-bearing).
- [x] The FULL/PARTIAL bit is a stored field, not prose: a reader deciding "can I still rely on the cited claim" must get that answer from the row.
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.

---

## Implementation report — landed

### Storage decision

`memory_edges.relation` KEEPS its seven-word CHECK, untouched. Two columns are
ADDED beside it by `ensureMemoryEdgesRelationClassColumns` (`src/db/schema.ts`,
ALTER TABLE, idempotent, run last in `initializeSchema` after every
`memory_edges` rebuild):

- `relation_class` — `''` | `correct` | `verify` | `use`
- `relation_coverage` — `''` | `full` | `partial`, with a cross-column CHECK
  making the bit exist EXACTLY when the class is `correct`

A new three-class write fills both AND lands in `relation` under the INTERIM
equivalence (`shared/relation-class.ts`'s `INTERIM_LEGACY_RELATION`:
correct/full→override, correct/partial→narrows, verify→verifies, use→extends).
`shared/relation-class.ts` is the whole mapping layer: `LEGACY_RELATION_CLASS`
(old word → class + bit) is the ONE accessor path every class-reader uses
(`edgeRelationClass`), and `LEGACY_RELATIONS_BY_CLASS` is what makes retraction
class-level so a stored `grounds`/`consume`/`indexes` row is still deletable
(the E2 deadlock).

**Rejected alternative:** put the class word into `relation` itself and widen
the table CHECK to `correct`/`verify`/`use`. Rejected for three reasons.
(1) SQLite cannot alter a CHECK in place, so it forces a full rebuild of the
production edge table in THIS ticket, which is ticket 03's remit.
(2) It makes every new edge invisible on day one to every reader still keyed on
the seven words (milestone election's frozen weights, `db/edge-signals.ts`,
the lane checker's coupling groups) unless all of them are re-keyed here —
ticket 05a's job, and re-keying them in the same release as a vocabulary change
would leave the two effects inseparable in production.
(3) Ticket 03 would then have to REWRITE `relation` in place on existing rows,
so rollback would stop being a read-side switch and become a data restore.

### What ticket 03 and 05a need

- Columns: `memory_edges.relation_class`, `memory_edges.relation_coverage`.
  Migration is: fill both for existing rows from `LEGACY_RELATION_CLASS`,
  never touch `relation`. Reversal is `UPDATE … SET relation_class = '',
  relation_coverage = ''` (or simply stop reading them).
- Mapping function: `edgeRelationClass(row)` in `src/shared/relation-class.ts`.
  It already falls back to the legacy word, so the migration is a
  MATERIALIZATION, not a semantic change — readers answer identically before
  and after it runs.
- Known gap left for 03: `writeMemoryEdges`' idempotent `ON CONFLICT` does NOT
  set the class columns, so re-asserting a class over a pre-existing legacy row
  leaves that row unclassified. Deliberate — classifying existing rows is 03's,
  with 03's reversibility story.
- Interim table for 05a: `INTERIM_LEGACY_RELATION` in
  `src/shared/relation-class.ts`, ONE call site (`interimLegacyRelation`, from
  `attachTurnRelations` in `src/db/citations.ts`). Pinned by
  `tests/shared/relation-class.test.ts`'s two tests that name it INTERIM.
  05a re-keys `shared/milestone-election.ts`'s `IN_DEGREE_RELATIONS` and
  `mcp/timeline.ts`'s `FRONTIER_*_EDGE_WEIGHTS` onto (class, coverage) and
  deletes the table plus its call site.
- `mcp/timeline.ts`'s `FrontierEdge` now carries BOTH `relation` (the stored
  word, the scoring key) and `relationLabel` (what renders). 05a moves the
  scoring onto the class; the label needs no further change.

### Deliberate non-changes

- The sparsity rule STAYS in the rubric and the settlement prompt (arm B;
  ticket 04 deferred by ruling S15069/T2391), and a test pins it present.
- The `''` unsettled-side machinery is untouched (spec WITHDRAWN + ruling 3).
- No election weight moved.
