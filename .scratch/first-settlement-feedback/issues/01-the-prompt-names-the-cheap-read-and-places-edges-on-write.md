# 01 — The prompt names the cheap read, places edges on write, and teaches the anchor grammar

**What to build:** the first two production settlement runs under 0.29.0 (jobs 170 and 171, 2026-09-02) each paid for something the prompt could have prevented. Three teaching repairs, each anchored to what was observed, none of them a new rule — every one is a rule the tools already enforce that the prompt never told the writer about.

**Blocked by:** None.

**Status:** LANDED `95a14842`, VERIFIED S15069/T2369. Independent check: tsc 0, full suite 4583/0/252, my own probe (degrade the address form to a bare session range) drives the step-1 pin RED. The worker falsified this ticket's third premise — the anchor grammar WAS already in the prose (QUALIFIED FOLD, THE STATE CEILING) in the prompt job 171 received — and restated it at the failure actually made instead of adding a rule; accepted. **UNVERIFIED and stays so until a live run:** whether the new sentences change writer behaviour.

## What was observed

**A. A six-minute read.** Job 170's first tool call was exactly what the topic-pass procedure dictates — `filter={fields:[title,metadata,content,prompt], fieldBudgets:{prompt:50}}`, `turn` 280, `pageSize` 100 — but the procedure never says which ADDRESS to pass, so the writer reached for `filter.session="15069"` with no `id`. On a 2365-turn session that route materialised 12,874 items into 4,612 pages before returning page 1: **6 minutes 10 seconds**, 62% of the 10-minute lease, on a job already on its last attempt. The same shape took 0.6 s on a 156-turn session (job 171). The writer then found the range form on its own — `E60/S15069/T2302..S15069/T2311` — and every subsequent read returned in 0–8 s. It also hit `Parameter error: S15069/T2312 is not a member of E60` and had to re-address from T2313: a window can contain turns that are not members of the task, and the segment-scoped range refuses them.

**B. Thirty-nine edges written bare, then re-placed.** Job 171's edge pass wrote 66 `note` calls with bare addresses. Its first `lane_check` returned **39 E6 errors** — "DRAFT edge, neither side names a lane" — and the writer spent ~45 seconds and ~80 tool calls retracting every edge and re-adding it with `tailTag`/`headTag`. The gate is correct (E6 is an ERROR by spec). The writer simply was not told that an edge is placed AT WRITE, not repaired after.

**C. Two refused commits before the first impression landed.** Job 171's first `commit` carried four impressions and was refused on: `line-cap` (62 > 60), `total-cap` (309 > 270), **eleven `anchor-format` violations** ("bare anchor `T18` has no preceding full `S<n>/T<m>` on its line"), and one `delivery-anchor` ("released" with no anchor). The second commit still overshot `total-cap` (287 > 270). The third landed. The caps are pressure by design and the refuse-and-repair loop is the mechanism working. The anchor grammar is not — it is a rule the validator enforces that the teaching states only in the sample, never in the prose.

## What to change

- [ ] **The topic-pass read step names the address.** Where it dictates fields, budgets and `pageSize`, it also says: read the window as `E<n>/S<a>/T<b>..S<c>/T<d>` (the task's event-order range — cheap, members only), and when a window turn is NOT a member of the task, read that stretch as the plain session range `S<n>/T<a>..<b>`. It says plainly that `filter.session` without an `id` is a whole-session search and is never the way to read a window.
- [ ] **The edge pass says: place on write.** Every relation carries `tailTag`/`headTag` when it is written. A bare address is a draft the gate will refuse as E6 and cost a full retract-and-re-add round. Say it once, at the point where the edge verbs are introduced, not as a footnote.
- [ ] **The impression teaching states the anchor grammar in prose.** The first anchor on a line is the full `S<n>/T<m>`; later anchors on that line may fold to bare `T<m>`; a delivery-class word must sit on a line that carries an anchor. These are already validator rules — the writer should not have to discover them from a refusal.
- [ ] Each repair is a few sentences. Do not add rules the tools do not already enforce; do not reword anything else. Ticket 09 of lane-impressions is the precedent for how narrowly a teaching change is scoped.
- [ ] Tests pin each of the three additions the same way ticket 09 pinned its three (a `toContain` on the shipped prompt text, with a mutation probe that drives it RED).

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. The transcripts of jobs 170 and 171 are at `~/.claude/projects/-Users-zhaoqixuan--claude-mnemo/4c111837-*.jsonl` and `38019c64-*.jsonl` — read them if you need the exact observed shapes; do not modify them.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` — the whole class is banned. Restore from your own `cp` copies, md5-verified. Explicit pathspecs on every `git add`. No raw control bytes. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (baseline 4569/0 across 251 files); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. No version bump, no push.

---

## What landed

All three repairs ship, each pinned by a `toContain` on the shipped text with a mutation probe that
drives it RED. Scope is ticket 09's: a few sentences each, at the point the duty is introduced,
nothing else reworded.

1. **ADDRESS THE BATCH, NEVER SEARCH FOR IT** — `note-settlement-unified-prompt.ts`, procedure step
   1, between the `fieldBudgets` sentence and YIELD-REPAIR. Names the task's event-order range
   `id="E<n>/S<a>/T<b>..S<c>/T<d>"`, quotes the segment-scope refusal the run actually hit
   (`"S<n>/T<m> is not a member of E<n>"`), names `id="S<n>/T<a>..<b>"` as its fallback, and states
   what `filter.session` with no `id` is.
2. **PLACE EVERY EDGE AT WRITE** — same file, step 6, at the point the relation verbs are
   introduced. `{turn, tailTag, headTag}` in the writing call, both sides or neither, a bare address
   is a DRAFT and E6 blocks the commit. Verified against the schema (`mcp/definitions.ts`'s
   `relationTargetEntryShape` + `RELATION_TAG_FORM_LINE`) and against `lane-checker.ts`'s own E6
   definition — E6 fires when EITHER side is empty, and the sentence says either, not neither.
   The RESUME prompt (`note-settlement-prompt.ts`) already stated this call shape in full; the gap
   was the unified prompt's alone, which is why the repair lands only there.
3. **THE FOLD RESETS AT EVERY NEWLINE** — `note-settlement-impression-teaching.ts`, under ANCHOR
   DISCIPLINE, so it ships in BOTH prompts.

### One premise in this ticket is FALSE, and was not quietly acted on

Item C says the anchor grammar "is a rule the validator enforces that the teaching states only in
the sample, never in the prose". **It does not.** `ANCHOR DISCIPLINE`'s QUALIFIED FOLD paragraph
states the per-line rule verbatim, and `THE STATE CEILING` states the delivery-word rule — both were
present, to the byte, in the prompt job 171 was shown (checked against that run's own transcript,
`38019c64-*.jsonl`, not against HEAD). What the transcript shows is a different failure: the writer
used a bare `T<m>` for EVERY anchor on EVERY line of a four-line impression and never wrote the full
form once — it treated `T<m>` as the citation form, which it is elsewhere in this system.

So the repair that shipped is not a missing rule being supplied. It is the same rule restated at the
failure actually made, plus the one consequence the old text left the reader to derive: the fold does
not carry across a newline, and a bare-anchored impression is refused once per anchor rather than
once. Both halves are `anchor-format` / `delivery-anchor`; no rule was added that the tools do not
enforce. The module header records the false premise as false.

### Verification

`npx tsc --noEmit` clean (excludes `tests/`; the two changed test files typechecked separately under
a temp config with the project's own compiler options). Full `bun test`: **4573 pass / 0 fail across
251 files** — baseline 4569 plus exactly the 4 tests this ticket adds. `npm run build`; stale-bundle
and release-artifacts guards green; `git diff --check` clean; no control bytes in any changed file;
`grep -c anthropic-ai plugin/scripts/worker.cjs` still `0`. No version bump, no push.

Mutation probes, each restoring one defect: delete the ADDRESS paragraph → 1 test RED; delete the
PLACE-AT-WRITE paragraph → 1 RED; delete the FOLD-RESETS paragraph → 1 RED; open a golden-sample
line on a bare `T<m>` → 2 RED (the new sample pin plus the existing validator pin).
