# 05 — Delete the retired fields. There is no migration.

**What to build:** the removal. `done`, `decisions`, `next_steps` and the legacy `content` text leave the product. No backfill job, no generated initial impressions, no per-task cutover, no model channel. A task's impression starts empty and settlement writes it the first time it touches one of that task's lanes, exactly as it does for any other lane.

**Blocked by:** None.

**Status:** implemented — awaiting review. `npx tsc --noEmit` clean; full `bun test` 4688 pass / 0 fail; bundles rebuilt; stale-bundle guard green; `git diff --check` clean. Six mutation probes run, every source file restored from a `/tmp` copy and md5-verified (no working-tree revert anywhere).

## Why the original ticket is gone

Everything it built existed to preserve the legacy field text: an asynchronous per-task migration job, a five-coordinate source-snapshot fence, anchor re-sourcing through the member index, unresolved-refuses-cutover, an ordered seed→pointer→retire cutover, and a model channel to generate the seeds. If the legacy text is not preserved, none of it has a reason to exist.

It also never ran. Verified: `src/worker/server.ts` references the backfill zero times, and nothing outside the backfill modules imports them — the runner was compiled and unreachable, alive only in its own tests.

## What "delete" means here, and what it deliberately does not

The FIELDS leave the product — the write face, the card render, the tool schema, the teaching. The COLUMNS go inert rather than being dropped. `segments.content` is the one exception in the other direction — the column STAYS as the task-tier impression's home; only its legacy text stops being read and written.

Blast radius, measured on production before the removal: **218,000 characters across all segments** — content 124K, next_steps 40K, decisions 36K, done 17K. `goal`, `constraints` (22K), `reference` and `insight` are KEPT. Nothing was deleted from storage.

## Acceptance criteria

- [x] **`done`/`decisions`/`next_steps` leave the write face, the card render, the tool schema and the teaching; their columns stay, unread and unwritten.** Stronger than "not rendered": they left `SegmentRecord`, `SegmentRow` and `SEGMENT_COLUMNS` (`db/segments.ts`), so a property that does not exist cannot be rendered, indexed, merged or reconciled by accident. `SEGMENT_WORKING_STATE_FIELDS` is three; `SEGMENT_EDITABLE_FIELDS` is four; `remember`'s `field` enum, its per-field definitions, the tool description's field list, `mergeSegments`' field fold and its write-gate stamps, `indexSegment`/`indexSegmentToFTS`/`rebuildSearchIndex`, `reconcileSegmentCitedPairs`, and `segment-maintenance.ts`'s intervals + criteria all follow.
- [x] **`segments.content`'s legacy text is no longer read or rendered; the column continues as the task-tier impression's home.** The card's content slot has ONE tenant; `renderSegmentHeaderLines`' `- content:` row (the search-hit spine) is gone with its `contentIsTaskImpression` parameter; `content` left `SEGMENT_EDITABLE_FIELDS`, so the main agent can no longer write it either.
- [x] **`impression_origin`'s remaining job, stated.** See "What remains of `impression_origin`" below — it is NOT left half-alive.
- [x] **The `7d34f585` machinery is REMOVED.** `src/worker/impression-backfill.ts`, `-runner.ts`, `-teaching.ts` and both their test files deleted; the backfill-job helpers deleted from `db/impressions.ts` (the whole `ImpressionBackfillJob*` surface); `retireSegmentImpressionSourceFields` deleted from `db/segments.ts`; `SEGMENT_FIELDS_RETIRED_BY_IMPRESSION_CUTOVER` / `SEGMENT_WORKING_STATE_FIELDS_AFTER_CUTOVER` / `SEGMENT_IMPRESSION_SOURCE_FIELDS` deleted. `impression_backfill_jobs` stays declared and INERT, with a test that asserts both halves (the table exists; `db/impressions.ts` exports nothing matching `/Backfill/i`).
- [x] **The pointer line stays**, and now renders UNCONDITIONALLY — every card is the slimmed card, so a task with no impression yet needs it most.
- [x] **A task whose lanes settlement has not touched renders NOTHING.** `tests/mcp/segment-card.retired-fields.test.ts` seeds all four retired columns by direct SQL, asserts the seed is really in storage, then asserts the card shows no `- content:` row, no `- impression:` heading, no placeholder, and none of the seeded text — and that the bytes survive the render.
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` once (4688/0); bundles rebuilt, stale-bundle guard green; `git diff --check` clean.

## What remains of `impression_origin`

It carried three jobs and has lost two. It no longer tells a backfill seed from a settlement replacement (there is no backfill, so every impression is settlement-grown and the future comparison test has nothing to select on), and it no longer gates the card's SHAPE (there is no per-task cutover to gate — the card's shape is now a constant).

**One job is left, and only on `segments`: the TENANCY of the `content` column.** NULL means the bytes there are the prose the main agent used to write before ticket 05 took the field off the write face — not an impression, read by nothing. Non-NULL means settlement has written this task's impression. That question is unavoidable while those bytes remain (and this ticket does not delete them), and `readSegmentTaskImpression` is its ONE reader: it answers by nulling `text`, so no caller above it asks a second time. `readTaskImpressionSlot`'s third state (`null`, "leave the slot to the legacy renderer") is gone with the legacy renderer — the function is now `taskImpressionDisplay`, symmetric with `laneImpressionDisplay`.

`lanes.impression_origin` is INERT. Nothing reads or writes it: the lane tier never had the tenancy job (a lane's `impression` column has only ever held an impression), and its only reader was the fold's origin carry-over, which existed to protect the comparison test's eligibility across a rename. `ReplaceLaneImpressionInput.origin`, `StoredImpression.origin`, `ImpressionOrigin` and settlement's `SETTLEMENT_ORIGIN` constant are all deleted; the advisory block's `current (origin …):` line is now `current:`.

`impression_revision > 0` was considered as a replacement predicate and REJECTED: `markSegmentTaskImpressionStale` bumps the revision without writing text, so a task merge between two impression-less tasks would make it claim tenancy falsely.

## Design calls the ticket left open

1. **`content` leaves the `remember` write face, not just the render.** The ticket's prose says the legacy text "stops being read and written"; the acceptance bullet only says "read or rendered". Removed from the enum, because leaving it offers the main agent two ways to lose: writing while no impression exists puts bytes on a surface that renders none, and writing after settlement has been there clobbers an impression outside its CAS fence.
2. **`mergeSegments`' content fold, rewritten.** Ticket 07's rule was "join only when BOTH sides hold an impression, otherwise prose-merge". With the legacy tenant gone that rule silently DESTROYS an impression (donor has one, survivor is pre-impression → the join is refused and the impression is appended as invisible prose). Now: `concatenateImpressions` over the two tenancy-resolved texts; when it yields text the survivor's slot is written AND CLAIMED (`impression_origin` set); when it yields null — neither side has an impression — `into`'s stored bytes are left EXACTLY as found. Nothing is invented and nothing is deleted.
3. **The retired columns stop being INDEXED.** `indexSegment`, `indexSegmentToFTS` and `rebuildSearchIndex` were kept in step (their own comment forbids drift). Already-indexed FTS rows keep the old text until that segment's next write or a full rebuild — this ticket switches fields off, it does not sweep storage.
4. **`reconcileSegmentCitedPairs` stops scanning them.** A citation carried only by a retired field stops being asserted at that segment's next write — lazily, not as a sweep.
5. **A task MERGE now discards the donor's retired-column text** (the source row is deleted at step 6b and the merge no longer copies those three columns). Pre-ticket it carried them over. Accepted: they are not fields of this product, and importing dead text into the survivor's inert columns is not preservation.
6. **The `impression_origin` CHECK still admits `'backfill'`.** Tightening the vocabulary means rebuilding both tables; the value is simply unreachable from code. Asserted as such in `tests/db/impressions.test.ts`.
7. **The `constraints` reminder's three-way routing** used to send task-scoped rulings to `decisions`. That leg now reads "nothing of yours; settlement writes it into the task's impressions" — a routing target that no longer exists would teach a field the tool refuses.
8. **`tests/mcp/segment-card.impression-cutover.test.ts` was replaced, not edited**, by `tests/mcp/segment-card.retired-fields.test.ts`: every test in it was about a mechanism that no longer exists.

## Mutation probes (each restored from a `/tmp` file copy, md5-verified)

| probe | result |
| --- | --- |
| A — restore the legacy `- content:` row when no impression exists | **7 fail** across the retired-fields, lane-impressions-display and golden-sample suites |
| B — put `decisions`/`done`/`next_steps` back on `SEGMENT_WORKING_STATE_FIELDS` | **12 fail** across retired-fields, definitions, golden-sample, segment-maintenance |
| C — make the pointer line conditional on an impression existing | **5 fail** |
| D — re-index a retired column into FTS (incremental + full rebuild) | **1 fail** ("a phrase that lives ONLY in a retired column is not indexed") |
| E — restore the prose merge on the content slot | **1 fail** ("NEITHER side has an impression: the survivor's stored bytes stand untouched") |
| F — drop the tenancy predicate (`text: row.content` unconditionally) | **12 fail** over the FULL suite — this is what pins `impression_origin`'s one remaining job |

**OVER-DETERMINED, and it is worth naming because the ticket asked.** Probes D and E each kill exactly ONE test. For D that is by construction: the assertion is the acceptance criterion itself and no other fixture puts text in a retired column. For **E** it is a real thinness — the "survivor inherits the donor's impression" and "donor contributes nothing" arms are BOTH satisfied by `concatenateImpressions`'s degenerate cases, so no single mutation of the merge branch can falsify them independently; only the both-empty arm distinguishes the new rule from the old one. I did not add fixtures to manufacture more kills for it.

## UNVERIFIED

- **Nothing here was run against production.** `~/.claude-mnemo/` was not opened at all — the 218K figure is the caller's measurement, taken before this ticket started. The consequence of that: the FIRST real read of a pre-ticket task's card in production will show a card with no impression and no content row, and nobody has watched that happen.
- **The FTS drift after this deploys is stated, not observed.** A segment whose row is never written again keeps its retired text in `memory_fts` indefinitely, so `recall(query=…)` can still hit a segment on a phrase the card no longer shows. Whether to force a `rebuildSearchIndex` is a call the user has not made and this ticket did not take.
- **Whether to CLEAR the stored text** of the four columns is likewise untouched, deliberately — the ticket says the columns keep their bytes and that a sweep is a separate decision.

Spec: `.scratch/lane-impressions/spec.md` — "Segment card slimming" is the surviving part; the whole "Legacy backfill" section is dead. The spec file still carries that section and Testing Decisions bullet 3; it was NOT edited (this ticket's brief limits `.scratch/` writes to this file).
