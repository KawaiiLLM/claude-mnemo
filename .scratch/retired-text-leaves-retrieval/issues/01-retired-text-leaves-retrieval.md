# 01 — Retired text leaves retrieval. Both halves, or neither.

**What to build:** text that no card will render is text no search will find. A `recall(query=…)` can no longer hit a segment on words the product has retired.

**Blocked by:** None. Do not start while another ticket is mid-flight in this working tree — it rebuilds bundles.

**Status:** LANDED `af326f69`, VERIFIED S15069/T2370. Independent check: tsc 0, full suite 4592/0/253 (delta = the new file). Three probes of mine, all RED, in the direction the worker did not probe: hardcode `impressionOrigin: null` on the incremental path (3 red incl. the ticket-05 first-class-hit test), `NULL AS impressionOrigin` on the rebuild path (2 red), delete the receipt write (4 red — the sweep would re-run on every open). The deviation from the literal third checkbox — a receipt-guarded SEGMENT-scoped sweep in `initializeSchema` instead of a full `rebuildSearchIndex` — is accepted on its evidence (>25 min unfinished on production-sized data; a full rebuild would also re-admit ~70k observation/turn rows the live index deliberately lacks). Correction to the worker's §6.1: production (read-only, 2026-09-02) has 70 segments, **2 tenanted** (E70 task-tier impressions written by 0.29.0 at 05:06) and 59 untenanted with content — the clone predated the first live impression write, so "zero tenanted rows" was clone timing, not a false ticket premise. Owed elsewhere, not here: `SegmentWrite.content` still lets `applySegmentWrites` write content without claiming the slot (no `src/` caller) — ticket 05's territory. — user ruling S15069/T2331 (「已经退役的文本，不要参与检索」). Implemented in the commit carrying this file (hash in the agent report; a commit cannot name its own hash inside itself). `npx tsc --noEmit` clean; full `bun test` 4592 pass / 0 fail / 253 files (baseline 4584 / 0 / 252, delta = this ticket's 8 new tests in 1 new file); bundles rebuilt, stale-bundle + release-artifacts guards green; `git diff --check` clean; four red-capable mutation probes run, every source file restored from a `cp` backup and md5-verified.

## Why

Lane-impressions ticket 05 took `done`, `decisions`, `next_steps` and the legacy `content` prose off the write face and the card render. Three of those four are safe by construction: they left `SegmentRecord`, and a property that does not exist cannot be indexed by accident.

**`content` is not safe, because it deliberately stayed** — it is the task-tier impression's home, and `impression_origin` is the tenancy mark that says whether its bytes are an impression or pre-ticket prose. That predicate is applied at the reader (`readSegmentTaskImpression`) and at the card. **It is not applied at the indexer:** `indexSegment` (`src/db/segments.ts`) passes `segment.content` to FTS raw.

The consequence is the inverse of what ticket 05's UNVERIFIED note assumed. For the three deleted fields, a segment that is never written again keeps stale index rows. For `content`, **writing the segment is what keeps the drift alive** — every later write re-indexes the untenanted prose. So `recall` surfaces a segment on words its card refuses to show, and will keep doing so indefinitely.

## The ruling, and its price

Both halves or neither — half of this is worse than none, because it leaves the live path and the stored index disagreeing.

Accepted and irreversible: **~218,000 characters stop being findable** (content 124K, next_steps 40K, decisions 36K, done 17K; E60 alone carries 89K). The bytes stay in their inert columns; only the index stops pointing at them. Nobody has watched a production card lose this text yet — ticket 05 landed unreleased.

- [ ] The tenancy predicate applies at the index seam: an untenanted `content` (`impression_origin IS NULL`) contributes NOTHING to FTS, on the incremental path and on `rebuildSearchIndex` alike. One predicate, one place — do not fork the rule between the two paths.
- [ ] The retired columns are already out of `indexSegmentToFTS`; assert it, so a future re-add is caught rather than reviewed.
- [ ] **A full `rebuildSearchIndex` sweeps the existing rows.** Decide and state HOW it runs — a one-shot migration step, an operator command, or a version-gated startup pass — and why that seam rather than the others. This is the design call the ticket leaves you; it is the difference between "new installs are clean" and "the ruling actually lands".
- [ ] A test proves the whole claim end to end: seed a segment whose `content` holds untenanted prose, index it, and assert a `recall(query=…)` on a phrase unique to that prose returns nothing — then claim the slot through the settlement write path and assert the SAME query now finds it. Both directions, or the predicate is only pinned one way.
- [ ] Report the measured before/after `memory_fts` row count and byte size on a COPY of production — never on `~/.claude-mnemo/` itself, which is strictly read-only from a session.
- [ ] `npx tsc --noEmit` clean (note it does not cover `tests/`); full `bun test` once; bundles rebuilt; stale-bundle and release-artifacts guards green; `git diff --check` clean.

## Out of scope

**Clearing the stored bytes.** The columns keep their text; this ticket changes only what the index points at. A storage sweep is a separate, separately-irreversible decision the user has not made.

---

## Implementation report

### What changed

- `src/db/search.ts` — `SegmentFtsRecord` gains a REQUIRED `impressionOrigin: string | null`; `tenantedSegmentContent` (one private function, the only copy of the rule) withholds `content` when the origin is NULL; `indexSegmentToFTS` applies it; the segment half of `rebuildSearchIndex` is lifted into an exported `reindexAllSegments` so the full rebuild and the one-shot sweep share one query and one projection.
- `src/db/segments.ts` — `indexSegment` reads `impression_origin` off the row it is projecting and hands it to `indexSegmentToFTS`. The predicate is deliberately NOT written on this side.
- `src/db/schema.ts` — `retireUntenantedSegmentContentFromSearch`, a `migration_receipts`-guarded one-shot at the end of `initializeSchema` (strictly after `ensureSegmentImpressionColumns`, whose column it reads). Receipt `retired-text-leaves-retrieval-segment-content` records `segmentsReindexed` / `untenantedRows` / `charactersWithheld`.
- `tests/db/retired-text-leaves-retrieval.test.ts` — new, 8 tests.
- `tests/mcp/recall.segments.test.ts`, `tests/db/search.test.ts` — fixtures updated (see "one fixture was lying", below).

### The design call: how the sweep runs, and why not the alternatives

**A receipt-guarded one-shot in `initializeSchema`, re-deriving the SEGMENT layer through `reindexAllSegments`.**

- It is the seam this codebase already uses for "existing rows must be re-derived after a rule change": `migration_receipts`, the same shell as `LANE_MODEL_V12_*`, `MEMORY_EDGES_RELATION_TURN_SCOPED_RECEIPT` and `TURN_ERA_GRANT_SEED_RECEIPT`. One row, runs once per database however many processes open it, and states in its payload what it did.
- **Rejected — a full `rebuildSearchIndex`.** Measured on a clone of production (2.28 GB): a full rebuild had not finished after **25 minutes** and was abandoned. `initializeSchema` runs in every hook process, so that cost lands on the hook critical path. Worse, production's `memory_fts` is deliberately PARTIAL — 25,699 of 94,862 observations and 11,694 of 14,132 turns — so a full rebuild would also ADD roughly seventy thousand rows nobody asked for, a corpus-wide change smuggled in under a segment-scoped ruling. The rule that changed is about segments; the layer re-derived is segments. `rebuildSearchIndex` still carries the predicate for every path that legitimately calls it.
- **Rejected — an operator command.** The ruling would land only when somebody remembered to type it.
- **Rejected — the worker's `repair_ledger` watchdog** (transcript-path-backfill's seam). That exists for repairs that touch the FILESYSTEM and cannot be bounded. This sweep is one scan of the segment roster (70 rows live) entirely inside SQLite; deferring it to the resident worker would only add a window in which recall still answers from retired words. Measured cost of the WHOLE of `initializeSchema` on the production clone, sweep included: **1,577 ms**.

### Measured, on a clone of production (never on `~/.claude-mnemo/`)

| | before | after |
|---|---|---|
| `memory_fts` rows | 37,747 | 37,747 |
| `memory_fts` bytes (`dbstat`) | 395,128,832 | 395,153,408 |
| segment FTS rows carrying `content` | 61 | 0 |
| characters of `content` indexed | 124,525 | 0 |

Receipt written: `{"segmentsReindexed":70,"untenantedRows":61,"charactersWithheld":124525}`.

Row count is unchanged and bytes go marginally UP (+24 KB, 6 pages) because FTS5 is append-only — deleting terms writes delete markers rather than shrinking the index. **The ruling removes findability, not bytes.** Reclaiming the space would need an FTS5 `optimize`, which is not in this ticket.

Live proof on the clone: `searchMemory(scope=segments, query="file-set-driven schedule")` returned `[37, 14, 33]` before and `[]` after — that phrase lives only in E37's untenanted `content`.

### Findings the ticket did not anticipate

1. **`segments.impression_origin` is non-null on ZERO production rows** (70 segments, 70 untenanted). Ticket 05 landed unreleased and no settlement impression write has ever run against the live database, so the sweep withheld every segment's `content` — the ticket's ~124K figure is the whole of it, not a share.
2. **A full `rebuildSearchIndex` is not a neutral instrument on this database** — see the design call above. The ticket's third checkbox assumed it was the vehicle; it is the wrong vehicle, and running it would have been a much larger, unasked-for change than the one ruled on.
3. **One fixture was lying, and the change exposed it.** `tests/mcp/recall.segments.test.ts` seeded a segment body through `applySegmentWrites({ content })`, which writes `content` WITHOUT claiming the slot — a shape settlement never produces. Its "a segment's content field row is a first-class FTS hit" test went red for exactly the right reason. The fixture now claims the slot through `replaceSegmentTaskImpression`, the real settlement write path.
4. **`applySegmentWrites` can still write `content` without claiming the slot** (`SegmentWrite.content`), and any bytes it lands there are now invisible to search. It has NO caller in `src/` — the path is test-only today — so nothing regresses, but the field is a live trap: `content` should leave `SegmentWrite` the way it left `SEGMENT_EDITABLE_FIELDS`. Not done here; it is ticket 05's territory, not this one's.
