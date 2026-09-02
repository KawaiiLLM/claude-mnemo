# 01 — One read contract: the taught route paginates by cost, honours budgets, names its cuts, grants per member

**What to build:** the settlement writer reads the initial writable set in as few pages as the envelope allows and never re-reads anything the response did not name as `cut` or `dropped`. Spec D1 + D2.

**Blocked by:** 00, 06 (the `relations` budget is taken from 06's renderer).

**Status:** LANDED

- [x] The segment-member routes (`E<n>/S/T..S/T`, `E<n>/T*`, `E<n>/#tag`) adopt the plain range's behaviour: `paginateByRenderedPageCost`, `fieldBudgets` forwarded, PER-MEMBER ledger marks (a member is granted when its block was delivered whole, not when the page was). Test: `prompt:50` is honoured on the task-scoped range; a member on a delivered page is granted, one on a cut page is not.
- [x] `boundedFields: [<field>…]` on `recall` ONLY (not on the shared `MemoryFilterInput`; `timeline` refuses it by name). Subset rule: `boundedFields ⊆ selected ∩ keys(fieldBudgets)`, violator refused by name. `relations` is refused by name inside it. Gate semantics unchanged by intent: a bounded gated field that was shortened records `complete=false` and grants nothing (test: bounded metadata → tag write refused).
- [x] Four field states per rendered turn, produced by the renderer over ALL selected fields: `complete | bounded | cut | dropped`. Footer `truncated: <field> cut; <field>, <field> dropped` lists only cut/dropped; it is a fixed element with RESERVED budget inside the measured structural overhead (worst case = every budgetable field + `title cut`), counted in page cost, envelope and ledger end-offset. Test: `turn = label + worst-case footer`, body allowance 0 → footer whole and both costs counted; a prompt over 50 with `boundedFields:["prompt"]` → `bounded`, no footer; same call without → `cut`.
- [x] Render-side title cap: a label longer than N chars is cut to N with a marker and reported `title cut`; no write-side refusal on either `note` schema.
- [x] Budget contract executed and reported: per-field numeric budgets for content/prompt/insight/relations/metadata (title excluded, enters overhead at the render cap); `relations` = 40 atoms × current widest atom; others p95 over the last 30 days of production (clone); `turn` = Σ + overhead + 10%, `content` takes the remainder past `MAX_TURN_BUDGET` 5000; explicit `pageBudget`; go/no-go on turns/page against `MAX_PAGE_BUDGET` 25000 — report the real turns/page, squeeze nothing.
- [x] The stage-1 teaching: read the writable set with the field union (title, metadata, content, prompt bounded 50, insight, relations) in the fewest pages; re-read only a named cut/dropped field, that turn, that field alone; a CUT `relations` needs no re-read for writing, a DROPPED one must be read once.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.

## Implementation report

Landed on a worktree branch off `3de2e897` ("build(read-once): rebuild bundles after ticket 02").
Baseline before the change: **4780 pass / 0 fail / 263 files**. After: **4804 pass / 0 fail / 265
files** (+24 new tests, +2 new files; four pre-existing tests amended, none removed).

### What changed, per box

**1. The segment-member routes adopt the plain range's behaviour.**
`renderSegmentMemberOrdinals` (src/mcp/recall.ts) packs with `paginateByRenderedPageCost` instead
of `paginateItems`, takes `pageBudget`/`fieldBudgets`/`boundedFields`, and hands the ledger down to
`renderSegmentMembersByOrdinal` (src/mcp/segment-card.ts), which marks each member at the offset
where ITS block ends — the same cursor arithmetic `renderTurnScope` has always used. The route's
own page-end mark now names the SEGMENT only; crediting a read of the task from a `[E<n>]` header
line would be the over-grant P1-6 removed everywhere else. Trial renders during packing pass no
signal, no ledger and no receipt collector.

**2. `boundedFields`, on `recall` only.** A top-level input (`recallInputShape`), NOT a member of
the shared `memoryFilterShape`; `timelineInputShape` defines it solely so `timelineInputSchema`'s
superRefine can refuse it by name. Validation lives in `parseBoundedFields`
(src/mcp/memory-filter.ts) and enforces the subset rule with a separate, named refusal per half —
"not in filter.fields" and "has no filter.fieldBudgets[…] cap" need different repairs. `relations`
is absent from the zod enum (`BOUNDED_FIELD_NAMES`) AND refused by name at runtime, with the
reason. Intent never reaches the gate: a bounded `metadata` read that was actually shortened still
records `complete=false` and refuses a `tags` write.

**3. Four states and the reserved footer.** `formatTurnBody` records a `FieldRenderMark` per
reportable field (start/end line, own-cut) instead of only the `relations` placement ticket 00
added; `capRenderWithOutcome` gained `lastLinePartial`, so a field ending exactly at the last
contributing line is told apart from one the ladder cut mid-way. `renderNode` subtracts
`worstCaseTruncationFooter`'s cost from the turn budget BEFORE capping the body, then appends the
real footer. The footer's vocabulary is `REPORTABLE_TURN_FIELDS` (the five budgetable fields) plus
`title`; `response`/`files`/`observations` are deliberately out, because every admitted name is a
standing per-turn tax and those three are neither budgeted by the contract nor selected by
settlement — they keep HEAD's silent-drop behaviour. `TurnRelationsPlacement` is deleted: the
generalized marks subsume it, so the delivery predicate has one source rather than two.

**4. Render-side title cap.** `TURN_TITLE_RENDER_CAP_CHARS = 180` — production's longest stored
title today is 171 (clone, 11,503 titles; p50 76, p95 109), so the cap bounds the contract's
overhead without cutting anything that exists. A cut label ends in the same `…` every other cut
uses and reports `title cut`; `title`'s ledger row becomes `!titleCut` rather than an unconditional
`true` — the never-overclaim direction. No write-side refusal: both `noteInputSchema` and
`settlementTurnWriteInputSchema` still accept any title, pinned.

**5. Budget contract.** Constants live in `src/worker/note-settlement-read-budgets.ts` with their
measurement; the prompt RENDERS them, so a re-measurement cannot leave two numbers disagreeing.

**6. Teaching.** Only step 1 of `note-settlement-unified-prompt.ts` changed (ticket 04 owns the
rest of stage 1). Four pins, each mutation-driven.

### Budget contract, measured

Clone of `scratchpad/repro/copy.db` (14,132 turns); window = the last 30 days present in the data,
2026-08-02..2026-09-01, 4,532 turns. p95 of each field's own estimated token cost.

| field | n | p50 | p90 | p95 | p99 | max | budget |
|---|---|---|---|---|---|---|---|
| content (non-compact) | 3,746 | 185 | 299 | 354 | 475 | 790 | **360** |
| content (all turns) | 3,951 | 190 | 352 | 3,395 | 7,103 | 10,760 | — |
| insight | 1,029 | 56 | 89 | 98 | 118 | 155 | **100** |
| metadata | 4,532 | 18 | 26 | 29 | 35 | 47 | **30** |
| prompt (user_prompt) | 4,327 | 36 | 1,835 | 2,217 | 3,331 | 72,562 | **50**, bounded |
| relations | — | — | — | — | — | 40 atoms = 770 | **800** |
| title (characters) | 4,031 | 76 | 101 | 109 | 125 | 171 | render cap 180 |

**The one judgment call, stated:** content's all-turns p95 of 3,395 is ONE artifact class. The 205
compact-synthetic rows (5.2%) run p50 5,540 / max 10,760 and are 100% of everything above 790.
Sizing every turn for them puts `turn` near `MAX_TURN_BUDGET` on its own and costs the page two
thirds of its turns. The budget is therefore the non-compact p95, and a compact row reports
`content cut` — which is what D2's footer exists for.

`turn`, measured through the real renderer on a turn with every field at its cap, a 180-character
title, and 40 atoms spending the whole relations budget:

```
Σ field budgets                                    1,340
structural overhead (capped label, field labels,
  per-line indentation, 40 atom-row indents)         115
RESERVED worst-case `truncated:` footer               20
                                                   -----
worst-case rendered turn                           1,475
+ 10%                                              1,623  ->  turn = 1,625
```

Well under `MAX_TURN_BUDGET` (5,000), so `content` keeps its p95 target — the "content takes the
remainder" clause does not fire.

**`pageBudget` = 23,000**, explicit, derived from the CHARACTER envelope rather than from
`MAX_PAGE_BUDGET`: this render prices at 4.26 characters per estimated token (indentation folds
into space-run tokens), so 25,000 tokens would translate to ~106,500 characters — past the
100,000-character worker envelope. 23,000 translates to ~97,990.

**GO/NO-GO — GO at 15 turns/page.** The spec's conservative test: 15 × 1,625 + 19 framing =
**24,394 ≤ 25,000**; 16 gives 26,019 (no). The same page as REAL rendered text — fifteen blocks
each at every field's cap — is **21,844 tokens / 93,074 characters**, inside both ceilings with
about 7% of the envelope spare. Nothing was squeezed: the packer measures actual cost, so an
ordinary page (p50 content 185 against a 360 cap) carries considerably more.

### Deltas against the 4,780 baseline

New: `tests/mcp/recall.read-contract.test.ts` (14), `tests/worker/note-settlement-read-budgets.test.ts`
(6), four teaching pins appended to `tests/worker/note-settlement-unified-prompt.test.ts`.
4,780 + 24 = 4,804.

Four existing tests were amended, each because the CONTRACT moved, not the assertion:

1. `format.test.ts` "a bigger budget shows strictly more" — `turnBudget` 30 → 50. The reserved
   footer is paid before the body ladder and `ALL_FIELDS` makes the reserve widest; 50 restores the
   body allowance this test has always been about.
2. `recall.relations-delivery-gate.test.ts` "dropped" — `turn` 20 → 33, same reason. The state it
   pins (header rendered, no atom, no row, write refused) is unchanged.
3. `recall.segments.test.ts` "a lane page the caller's envelope cut writes NO receipt" — the call
   now passes `pageBudget: 1_000_000`. Six 20K-character members no longer land on one page under
   the default budget, which IS this ticket's fix; an explicit budget still assembles the oversized
   page the receipt rule needs.
4. `recall.lane-impressions-display.test.ts` "the preface shifts the member grants' offsets" — one
   character short used to credit NOTHING (all-or-nothing at page end) and now credits the member
   whose block was delivered whole. The pin was made stricter: it names which member survives.

### Verification

- `npx tsc --noEmit` — clean.
- New/edited tests typechecked under a temporary tsconfig (deleted afterwards): clean for this
  ticket's files. Four PRE-EXISTING errors surfaced in files this ticket edits elsewhere and did
  not introduce — `recall.lane-impressions-display.test.ts:105,163` (`origin` not on
  `ReplaceLaneImpressionInput`) and `recall.segments.test.ts:126,473` (`status: "delivered"`).
- Full `bun test`: 4,804 pass / 0 fail / 265 files.
- `npm run build` + `tests/shared/release-artifacts.test.ts`: 11 pass / 0 fail.
- `git diff --check` clean; no control bytes; `grep -c anthropic-ai plugin/scripts/worker.cjs` → 0.

### Mutation probes (7, all RED, all md5-restored)

| # | mutation | test driven RED |
|---|---|---|
| 1 | drop the "RELATIONS ARE THE ONE ASYMMETRY" sentences | "it draws D0's line: a CUT relations needs no re-read…" |
| 2 | drop "RE-READ ONLY WHAT THE RESPONSE NAMED" | "it states the re-read rule: that turn, that field…" |
| 3 | `paginateByRenderedPageCost` → `paginateItems` on the segment-member route | "the range packs its page by rendered cost, not by pageSize alone" |
| 4 | remove the per-member `ledger.mark` in `renderSegmentMembersByOrdinal` | "a member on a delivered page is granted…" + the lane-preface splice test |
| 5 | stop subtracting the footer reserve before the body ladder | "turn = label + worst-case footer, body allowance 0…" |
| 6 | `titleCut = false` (the render cap never fires) | "a label past the cap is cut… and reported `title cut`" |
| 7 | record `type`/`tags` completeness as unconditionally `true` (intent leaks into the gate) | "a bounded metadata read that was shortened grants no tag write" |

### Notes for the integrator

- `note-settlement-unified-prompt.ts`: this ticket's only hunks are step 1's READ paragraph, the
  file's own doc-comment amendment, and one import block. Ticket 04 owns the rest of stage 1.
- `db/schema.ts` and `segments.ts` are untouched here (ticket 03's files).
- `src/worker/note-settlement-read-budgets.ts` is new and stands alone; the prompt imports it.
