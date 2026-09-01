# 05 — Backfill migration and per-task cutover

**What to build:** every task carrying legacy narrative fields (open AND closed, found by query) gets a one-time asynchronous migration job that reads the retiring fields (done/decisions/next_steps/content) plus the task's declared-lane roster and member/anchor index, generates per-lane initial impressions + the task-tier impression under the migration teaching variant, and commits them ATOMICALLY with the source-field clearing — fenced against every source input moving mid-generation. After a task's job commits, that task's card cuts over: slimmed fields, the mechanical pointer line, task-tier impression live.

**Blocked by:** 01 (schema/jobs), 02 (the teaching and validator the migration variant builds on).

**Status:** implemented — awaiting review. `npx tsc --noEmit` clean; full `bun test` 4733 pass / 0 fail; bundles rebuilt, stale-bundle guard green; `git diff --check` clean. 20 red-capable mutation probes run, every source file restored from a file copy and md5-verified.

Landed shapes:
- `src/worker/impression-backfill.ts` — the coverage query, the source snapshot and its comparison, the input assembly, the batch parser, and `commitImpressionBackfill` (the atomic cutover, run inside the caller's write transaction).
- `src/worker/impression-backfill-teaching.ts` — the migration teaching variant (ticket 02's `renderImpressionTeaching()` rendered VERBATIM inside it), the data block, and the whole prompt.
- `src/worker/impression-backfill-runner.ts` — the ASYNC half: coverage enqueue, claim, bounded retry, idempotent re-read, stale-claim lease. The model is a SEAM (`ImpressionBackfillGenerator`); nothing this module reaches names a model client.
- `src/db/segments.ts` — `retireSegmentImpressionSourceFields`, the one writer of the field clear (FTS + citations reconciled; `content` deliberately not in it — that column is `replaceSegmentTaskImpression`'s).
- `src/shared/segment-fields.ts` — `SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER`, `SEGMENT_WORKING_STATE_FIELDS_AFTER_CUTOVER` (derived, not spelled twice), `SEGMENT_IMPRESSION_SOURCE_FIELDS`.
- `src/mcp/segment-card.ts` — the cutover question asked ONCE (`readTaskImpressionSlot`), driving three things at once: the content slot's tenant, the pointer line, and the Working State field list.
- `src/mcp/definitions.ts` — `remember`'s `field` describe names the new surface. The ENUMS ARE NOT REMOVED (spec pins that to a later release).

## THE SCALE GATE — measured, on a clone of production made outside the data root

Production (`~/.claude-mnemo/`) was read `-readonly` for the survey; the end-to-end run used an APFS `cp -c` clone at `/tmp/mnemo-scale/`. Production's E60 still carries its 90,866 source chars, verified after the run.

- **Coverage by query: 61 tasks** (of 70), in **3.1 ms**. By status: `delivered` 42, `closed` 15, `open` 3, `abandoned` 1 — i.e. **58 of 61 carry a status word the current vocabulary does not even contain**, which is why the coverage query names no status at all.
- **Largest task: E60** — 90,866 source chars, 34 declared lanes, 2,348 members (2,210 live), exactly the spec's predicted candidate.

| axis | E60 |
| --- | --- |
| input assembly | **1,177 ms** |
| source fields | 92,648 UTF-8 bytes / 23,312 tokens |
| lane caps | min 100, max 500 (34 lanes); 1,807 lane memberships |
| rendered input block | 369,920 bytes / **99,441 tokens** |
| **model context (law + task)** | 379,213 bytes / **101,672 tokens** |
| output batch, every lane at its cap | 34 lane texts + task tier, **33,332 UTF-8 bytes** |
| **committing transaction** | **3,317 ms** — 34 lanes seeded, `origin=backfill`, fields cleared |

Context breakdown (measured separately): teaching ~2,231 tok + source fields 23,312 tok + task anchor index (2,210 rows with titles) **52,691 tok** + per-lane address lists ~23,438 tok.

**THE GATE'S REAL FINDING, for ticket 06 to rule on:** E60's model context is **~102K tokens, and 76K of it is the member/anchor index**, not the legacy prose. That is one expensive call, but it is ONE call for ONE task: the next largest task is E37 at 9,855 source chars with ZERO lanes and ZERO members, so the whole remaining corpus is trivial. The index is rendered WHOLE on purpose — truncating it would make "re-source every load-bearing claim through the index" unachievable for any claim about an early turn, forcing either an invented anchor (refused) or an `unresolved` report that refuses the whole task's cutover for no reason but a render budget. The spec answers input size with a measurement gate, not a cap, so nothing here caps it. If ticket 06 wants a cheaper E60, the honest levers are (a) drop titles from the index (−52K → −~35K tok), or (b) split E60's job per lane, which the spec's "one atomic batch per task" forbids. **Neither is taken here.**

The output batch at 33 KiB is ~13% of the settlement payload cap (256 KiB), so nothing suggests adjusting that constant from this side.

## Acceptance criteria

- [x] **Job lifecycle**: durable pending/claimed/done/failed rows (ticket 01's table, unchanged), bounded retry (`IMPRESSION_BACKFILL_MAX_ATTEMPTS = 3`, spent only on REGENERABLE refusals), idempotent re-claim (every attempt calls `assembleBackfillInput` again — there is no cached half-state), async execution (`runImpressionBackfillJobs` awaits the generator seam; opening the database enqueues nothing, asserted).
- [x] **Source-snapshot fence**: five coordinates, compared separately so a refusal names WHICH input moved — the four retiring fields' content digest, the declared-lane roster digest, the member/anchor index digest, the task-tier impression revision, each lane's impression revision. Fixtures move **one coordinate at a time**: a field append (fields only), a lane declare (roster only), a member's lane words rewritten (index only), a settlement lane replacement (that lane's revision only), a task-tier write (task revision only) — each asserting the message that names IT and that the other coordinates are NOT named. The spec's own two named fixtures (field append mid-call, lane merge mid-call) are both present; the merge moves two coordinates by nature, which is exactly why the four single-coordinate probes exist beside it.
- [x] **Anchor re-sourcing**: every anchor in a seeded impression must be an address the member/anchor index showed the writer (`anchor-index` refusal). Fixtures: an address that resolves to a REAL turn in another session is refused; a rolled-back member leaves the index and citing it is refused; the shared validator's own rules still bind (delivery-word-without-anchor, line-1 cap).
- [x] **Unresolved refuses cutover**: the fixture asserts the fields are **still POPULATED, byte for byte** (`toEqual` against the pre-attempt values), `impression_origin` still NULL, NEITHER lane impression written, the lane count and segment count unchanged (no residual container), and the refusal carries both `claim` and `reason`. Unresolved is checked BEFORE the fence, so an operator sees the mapping problem rather than a snapshot message, and it is NOT regenerable — one generation, then `failed` with the claim in `last_error`.
- [x] **Cutover order**: seed lanes → seed the task tier (which flips `impression_origin`) → retire the fields, as statement order in ONE transaction. The pointer line and the slimming hang off the SAME flip, so a reader who finds `done` missing always finds the pointer in the same response. `origin='backfill'` on every seeded row. Probed: keying the card's slimming on "the fields are empty" instead of on `impression_origin` goes red on the fixture that retires the fields with no impression seeded.
- [x] **Coverage by QUERY** (61 tasks, all statuses, open and closed alike) and **the largest such task measured end to end** — numbers above.
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` once (4733/0); bundles rebuilt, stale-bundle guard green.

## Card slimming, as shipped

`done` retires, `decisions` dissolves, the `next_steps` narrative retires; `goal`/`constraints`/`reference` keep and `insight` keeps beside them; `content` becomes the task-tier impression (`- impression:` rows, ticket 04's shape); the pointer line renders as `- lane impressions: recall(id="E<n>/#<tag>")` with the `<tag>` PLACEHOLDER intact — "no vocabulary expansion on the pointer". It sits in the fixed header, so a tight budget cannot drop the one row that says where the retired narrative went. Page ≥2 is slimmed identically. A retired field emits no `fieldCompleteness` entry, because it renders no row.

## Design calls the spec left open (all reported to the caller)

1. **THE MODEL SEAM IS NOT WIRED TO A PRODUCTION CLIENT, and that is the one gap I am flagging rather than filling.** The spec says the job "runs asynchronously after deployment" and never says through what channel. Settlement's own model client had to cross a process boundary (`settlement-child.cjs`) to satisfy the worker core's no-model substring guard, and its request wire is shaped entirely around a settlement job (jobId, sessionId, scope provenance). Adding a third `mode` to it is a plumbing ticket of its own. So this ticket ships the runner with an injected `ImpressionBackfillGenerator` and no SDK-backed implementation — inventing a dispatch channel would have been design the spec does not authorise. **Consequence, stated plainly: phase 2 cannot begin until someone wires a driver.** My recommendation is a fourth build target beside `settlement-child.cjs` driven by an operator command, not a new `mode` on the settlement wire.
2. **The admissible-anchor set is TASK-scoped, not lane-scoped.** The job reads one task and shows the writer that task's whole roster and index at once, so "cited through the index" is a task-level fact. Which of those addresses belongs in WHICH lane is lane relevance, and lane relevance is a teaching duty under the spec's own two-tier split — making it a code rejection would smuggle a semantic ruling into the mechanical tier.
3. **The lane and task IMPRESSION REVISIONS are fence coordinates too.** The spec lists three (fields, registry, member snapshot) and notes the impression revision is "insufficient ALONE" — not that it is excluded. Without it a backfill would silently clobber a settlement replacement that landed mid-generation, which is the one direction the three named coordinates cannot see. Two fixtures cover it.
4. **A declared lane the fields say nothing about gets NO impression, and the cutover still happens.** The spec's `unresolved` is about CONTENT with no home, not lanes with no content; a first impression invented out of nothing is the failure the whole surface exists to avoid. The task-tier text is the one REQUIRED entry, because its arrival is what flips the discriminator.
5. **A task carrying no legacy field at all is not covered and never cuts over.** It has nothing to migrate; its lanes get impressions from ordinary settlement, and its card keeps the legacy shape until the enums leave in the later release. Nothing in the spec asks for a cutover with no source.
6. **The pointer line renders unconditionally on cutover, even for a task that declares no lane.** It is the spec's word — "mechanical" — and conditioning it on the roster would make the card's shape depend on a second fact. A lane-less cut-over task shows a pointer to a route it has no lanes for; that is noise, not a lie, and the alternative costs a second predicate.
7. **A crashed runner's `claimed` row is taken back through `failed`.** `requeueImpressionBackfillJob` moves `failed` rows only by ticket 01's design, so the stale-claim path goes `claimed → failed → pending`, which also records the reason and consumes a retry. A crash is a failed attempt, not a free one. Lease: 15 minutes.
8. **A throwing generator is a failed attempt, not a crashed runner** — caught, sanitised through `sanitizeSecretString`, spends one attempt. Otherwise a model timeout would strand the job in `claimed`.
9. **The digest is length-prefixed rather than separator-delimited**, so a NULL field and an emptied one produce different digests (fixture) and no control byte appears in source.

## UNVERIFIED

- **Everything about a real model's output.** Every fixture supplies its own generator, so what is verified is the runner's discipline and the commit's fences — not that a model writes a good initial impression, and not that it correctly reports `unresolved` rather than inventing an anchor. That is ticket 06's acceptance-gate work (the corrected-C regeneration and the state-inflation audit), and it cannot be done from here without the wiring in design call 1.
- **The scale numbers are for E60 on today's corpus.** They will drift with its membership; the transaction time in particular (3.3 s) includes FTS reindexing of a 92 KB content column and 34 CAS-fenced lane writes, and was measured on a warm clone, single-writer, no contention.

## Mutation probes (each restored from a file copy, md5-verified; no working-tree revert used anywhere)

- source-fields digest disabled → 2 fail. Lane-registry digest disabled → 1 fail. Member-index digest disabled → 1 fail. Lane impression revision disabled → 1 fail. Task impression revision disabled → 1 fail.
- Unresolved refusal disabled → 7 fail. Anchor-index check disabled → 3 fail. Roster check disabled → 1 fail.
- Coverage query given a `status = 'open'` predicate → 1 fail.
- Runner caching the input across attempts → 1 fail (the idempotent-re-read fixture). Every refusal treated as regenerable → 1 fail. Generator throw rethrown → 1 fail. Stale-claim lease disabled → 1 fail. Attempt budget lowered to 1 → 4 fail.
- Pointer line removed → 4 fail. Slimming keyed on empty fields instead of `impression_origin` → 1 fail. Retired-field list shortened to two → 4 fail. Retirement clearing only two columns → 2 fail. Retirement also clearing `goal` → 1 fail. `origin` written as `settlement` → 5 fail. Tool teaching reworded off the surface name → 1 fail.

**A SELF-REFERENTIAL TEST WAS CAUGHT AND FIXED BY THESE PROBES, disclosed because it is exactly the failure this batch keeps paying for:** the first version of the card suite iterated `SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER` on both sides, so shortening that constant from three fields to two left the whole suite GREEN while `next_steps` quietly came back onto the card. The field names are now pinned literally in one test and asserted literally in the render tests; the probe goes red. The same shape was found and fixed for `IMPRESSION_BACKFILL_MAX_ATTEMPTS`.

Spec: `.scratch/lane-impressions/spec.md` (Rev 8 READY) — "Legacy backfill", "Segment card slimming", the deployment phases and Testing Decisions bullet 3 govern. The old field ENUMS are NOT removed in this batch.
