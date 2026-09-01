# 06 — Acceptance gates and integration verify

**What to build:** the experiment-class gates the peer ruled are ACCEPTANCE, not paperwork — proven on the real implementation, plus the batch's final integration pass.

**Blocked by:** 02, 03, 04, 05 — everything must have landed.

**Status:** RUN AND REPORTED — one gate FAILS, one NOT RUN, three PASS. The failure is real and is
NOT repaired here: repairing it means rewording the FROZEN teaching, which is the spec's to change,
not this ticket's. Integration pass complete. `npx tsc --noEmit` clean; full `bun test`
4563 pass / 0 fail across 251 files (baseline 4562/250 — the delta is this ticket's one new file);
`npm run build` clean, stale-bundle and release-artifacts guards green; `git diff --check` clean;
no raw control bytes; `grep -c anthropic-ai plugin/scripts/worker.cjs` = 0. Four mutation probes,
every mutated file restored from a `/tmp` copy and md5-verified (no working-tree revert anywhere).

Spec: `.scratch/lane-impressions/spec.md` (Rev 8 READY) — the "Acceptance gates that are experiments" list governs.

- [x] **Corrected-C regeneration** — RUN. **The full-impression arm PASSES with ZERO state
  inflations. The LINE-1-ONLY READER ARM FAILS, so the criterion as written FAILS.** See
  "Corrected-C regeneration" below for the corpus, the shipped-teaching provenance, the grading and
  the root cause (the teaching's line-1 clause names three duties where the gate demands four).
- [ ] **State-inflation audit** (one real segment regenerated end-to-end through the shipped write
  path) — **NOT RUN.** It needs a live settlement run against a real segment: the worker driving its
  SDK agent over production rows, then writing impressions back. `~/.claude-mnemo/` is read-only to
  this ticket and no live run was available. Nothing here substitutes for it. The corrected-C arm
  above audits GENERATED impressions against their source windows, which is the same question asked
  of a synthetic corpus — it is not this gate.
- [x] **Payload measurement** — RUN. **The 256 KiB constant is VALIDATED and unchanged.** Numbers
  below.
- [x] ~~**Migration scale gate**~~ — STRUCK 2026-09-01. Ticket 05 was rewritten to a deletion (user ruling S15069/T2320): there is no migration, no backfill job and no per-task cutover, so there is no scale to gate. Nothing replaces it; the removal is the whole of it.
- [x] Generation-acceptance delivery case — RUN, **PASSES**, on a deliberately uncontaminated
  corpus. Details below.
- [x] Cross-surface integration corpus — BUILT and green:
  `tests/e2e/lane-impressions.cross-surface.test.ts`, one seeded story through all six surfaces.
- [x] Docs sweep — CONTEXT.md gains **Impression**, **Lifecycle debt**, **Impression fold** and
  **Canonical lane route**, and its **Summary layer** / **Working State** entries are corrected;
  ADR-0002 gains Amendment 4 (the impression is the one field class settlement writes ALONE).

---

## Corrected-C regeneration — the arm that fails, and why

### Provenance, stated first because the gate is worthless without it

Both halves ran under the **SHIPPED** artefacts, not a draft:

- teaching = `renderImpressionTeaching()` from `src/worker/note-settlement-impression-teaching.ts`,
  rendered to a file at HEAD and handed to the writer as its whole law;
- validator = `validateImpression()` from `src/shared/lane-impressions.ts`, run on the writer's
  output at the real per-lane cap, with the corpus's own resolvable anchor set;
- caps = `clamp(10 × settledMembers, 100, 500)` computed on the CUMULATIVE settled membership at each
  window, exactly as the post-commit projection would.

Corpus of record: `/tmp/impression-gen/w1..w4.txt`, the four-window SAN11 chain, two lanes
(`#visual-style`, `#map-data-extraction`). w1 has zero members in both lanes, so the chain is three
generating rounds. Each round was a FRESH writer agent given only the teaching, its window, and its
coordinates — the "unreviewed writer" condition arm C names.

### What happened, round by round

| round | caps | validator verdict | outcome |
| --- | --- | --- | --- |
| w2 | 100 / 100 | accepted first pass | 2-line and 2-line impressions |
| w3 | 280 / 100 | **REJECTED** — `line-cap` (64>60), `total-cap` (296>280 and 101>100) | the shipped refusal text was fed back verbatim; compress-only regeneration accepted at 249 / 93 tokens |
| w4 | 370 / 110 | accepted first pass | 5-line and 2-line impressions, 314 / 106 tokens |

The w3 refusal is worth recording as a positive result: the deterministic tier caught a real
over-cap, the compress-only regeneration loop repaired it without dropping a lane's judgment, and
the writer paid for new material by trimming spent detail rather than adding a line.

w4 also exercised the unconditional anchor invalidation — `T160 --override--> T133`, an anchor the
standing text rested on. The writer replaced and revised the sentence rather than carrying it
unchanged.

### The full-impression state audit: ZERO inflations

Every claim in the two final impressions was checked against its anchors' own window text. Nothing
is written above the state its anchor proves. The trap the experiments of record named — T199's
hillshade, a `/tmp`-class preview — is held correctly in the full text:

> Frontier: K3ST is mapA's elevation (S18993/T198), overturning the "relief needs invented data"
> verdict (T197); the hillshade is an offline preview only — client integration and any
> elevation-combat rule stay open (T199).

### The line-1-only reader arm: FAILS, 0 of 3 lanes

A fresh blind reader was given ONLY line 1 of each lane (the two SAN11 lanes plus the delivery-case
lane) and asked the four questions, with an explicit "NOT ANSWERABLE FROM THIS LINE" escape so it
would not guess.

| lane | identity | current law | state | frontier |
| --- | --- | --- | --- | --- |
| `#visual-style` | held | held | held | **NOT ANSWERABLE** |
| `#map-data-extraction` | held | held | held | **NOT ANSWERABLE** |
| `#latency-budget` | partial (domain unknown) | held | held | **NOT ANSWERABLE** |

Three of three global lines carry no frontier. The criterion's own words — "a passing full
impression never excuses a failing global line" — make this the verdict for the gate.

**It is worse than an omission.** The reader was asked what it now BELIEVES is finished, and named
two inflations it absorbed from lines that contain no delivery word at all:

- `#visual-style` — "瓦片形制、scrabling pack、萌战武将/头像 都已经装进项目里了 … 一个交付动词都没有,
  但它们与两条真正的完成态并列在同一个分号句里, 被完成态的语气拖着一起显得像已落地."
  Sources and rulings inherited the finished tense of the two genuinely-committed clauses beside
  them.
- `#map-data-extraction` — "误信风险最大的一处: **4793.K3ST 的高程已经接进去了**." The line only
  identifies K3ST as the elevation data; the reader came away believing it is INTEGRATED. That is
  precisely the preview→shipped inflation this batch exists to prevent, absorbed verbatim, and the
  full impression's own frontier line says the opposite.

### Root cause, and why nothing here is repaired

The shipped teaching's line-1 clause names THREE duties:

> LINE 1 IS THE GLOBAL IMPRESSION: one self-contained line … carrying the lane's whole shape — what
> it is, its governing law, its current state — written to stand ALONE

The acceptance gate demands FOUR: identity / current-law / state / **frontier**. The golden sample's
own line 1 models four ("…is decoded (S18993/T198) but its client integration and combat meaning
remain open"), so sample and prose disagree, and the writer followed the prose. The deterministic
tier cannot help: parataxis-carried inflation has no delivery word to catch, and line-1
self-containment is explicitly a semantic duty.

The repair is a teaching change — line 1 must carry the open boundary, and must not let a ruling or
a source share a clause with a delivery claim. **The teaching is FROZEN from the spec** (ticket 02's
hard rule: nothing reworded, no rule added, no clause dropped). Rewording it to pass a gate this
ticket is running would be the writer grading its own exam. Flagged, not fixed; it belongs to the
spec.

### One honest confound in the corpus, disclosed

The shipped teaching's full golden sample IS this corpus's own `#visual-style` lane, including a
frontier clause about T198/T199. So the `#visual-style` arm is contaminated: the writer was shown a
correct answer for the very lane it was asked to write. Checked, and it did not turn into
fabrication — the one clause whose wording tracks the golden sample (`officer stats and portraits
from the 萌战 package (T133)`) is independently sourced from w3's T133, which the writer had read.
`#map-data-extraction` has no golden sample and is the cleaner arm — and it is the arm that produced
the sharper line-1 inflation.

## Generation-acceptance delivery case — PASSES

Run on a purpose-built single-lane window (`/tmp/imp-gate/delivery/window.txt`, a latency-budget
line in a domain no golden sample touches, so no leakage), carrying both a genuinely landed item
(T44, committed with a hash and a measurement) and a `/tmp` preview-only item (T57, "NOTHING IS
WIRED IN — the prototype lives at /tmp/resamp_proto.c"). The writer's first submission was refused
by the shipped validator on `total-cap` (107 > 100) and repaired by compress-only regeneration.
Accepted text:

> Latency lane: 120ms total, split capture 25 / transform 60 / playback 35 by ruling — legs trade,
> the total never grows (S22040/T41); capture landed under its leg (T44).
> Transform's cost is the coefficient recompute, not the FFT (S22040/T51).
> Open: the fix stays a /tmp prototype (S22040/T57); playback's 35ms deferred, unexamined (T60).

`landed` is used once, for the one thing whose anchor proves it. The prototype is called a `/tmp`
prototype and put under `Open:`. The blind reader on this lane's line 1 was the only one of three
that did NOT over-read: "我没有被诱导相信 transform 和 playback 已完成 — 因为「capture landed under
its leg」这个单点报捷反而反衬出另两条腿没有报捷." A single scoped delivery claim protects the
boundary; a run of them dissolves it.

## Payload measurement — the constant is VALIDATED

**The real maximum JOB touched set, by read-only query over production** (`sqlite3 -readonly`;
nothing was written, and the shape below was replayed on a fresh in-memory database rather than
executed against production):

The touched-set union the shipped code computes — frozen worklist ∪ `lane_run_touches` (`lane` rows
direct, `turn-tag` rows qualified through the turn's owning segment, which is exactly how a
cross-task HEAD lane enters) ∪ claimed debts, kept only where `(segment, tag)` is a declared lane,
plus one task tier per distinct segment — over all 143 settlement jobs:

| job | lanes | tasks | containers |
| --- | --- | --- | --- |
| **159** | **19** | **1** | **20** |
| 158 | 16 | 1 | 17 |
| 161 | 14 | 1 | 15 |
| 149 | 14 | 1 | 15 |

**Cross-task HEADs were included in the query and production contains none** — every job in this
database touches exactly one task. Stated rather than glossed: the "one task's 33 lanes is not the
job bound" worry is real in the mechanism and has no instance in the data yet. Production's whole
lane population is 65 lanes across 70 segments, so the absolute ceiling a job could reach today is
135 containers.

Job 159's 19 lanes carry 299/181/163/103/84/80/71/46/42/40/39/27/21/15/11/8/6/3/2 settled members,
so its caps sum to **6810 tokens** — that is the largest LEGAL payload production can currently
produce. Serialized through the real payload shape:

| text byte class | payload bytes | % of 256 KiB | headroom |
| --- | --- | --- | --- |
| CJK-dense | 15,914 (15.5 KiB) | 6.1% | 16.5× |
| ASCII prose | 37,324 (36.4 KiB) | 14.2% | 7.0× |
| Cyrillic (worst bytes/token measured, 8.94) | 58,058 (56.7 KiB) | 22.1% | **4.5×** |

The spec pinned the constant "provisional at ≥4× today's largest real cross-task shape". Measured at
the adversarial byte class over the largest real job: **4.5×**. The constant holds; it is not
adjusted, and the mechanism is untouched. Linear in containers × cap: at this shape's mean entry
size the cap admits ~90 containers in the worst byte class, against a real maximum of 20.

**Wall clock through the terminal commit path** — `settleImpressions` inside its write transaction,
all 20 containers replaced at their caps, 5 consecutive commits:
163.8 / 165.1 / 164.9 / 162.5 / 162.1 ms, **median 163.8 ms**. That is the impression half of one
terminal commit at production's worst real shape; the dominant cost is re-deriving 19 lanes'
settled-member sets and tokenizing 6810 tokens, both of which the fence requires.

## Cross-surface integration corpus

`tests/e2e/lane-impressions.cross-surface.test.ts` — ONE test, deliberately not six. It seeds one
story and walks it through every surface the batch built, in deployment order:

settlement writes (the real `commit` path, with the real maintainer and the real attached-debt
claimer) → the lane route renders the exact stored bytes at the head of page 1, and only its own
lane → the card renders the task tier in its content slot, and only the task tier → a manual
`remember(merge)` leaves a debt, marks the survivor STALE, concatenates the two impressions and
MOVES the CAS coordinate → the STALE survivor still renders its join, with no marker → the next
attached run's `retain` is refused naming STALE → its `replace` clears the flag and acks the debt in
the same commit → the reader sees the rewrite, not the join.

Split into six tests each would re-seed its own state and the joins — which is the only thing no
single-mechanism suite can see — would go back to being untested. That is the design call.

### Mutation probes (each restored from a `/tmp` file copy, md5-verified; no git revert anywhere)

| probe | result | new test among the dead? |
| --- | --- | --- |
| P1 — `foldLaneImpressionIntoSurvivor` call removed from `mergeLaneTag` | **7 fail** / 4 suites | yes |
| P2 — the terminal fence's STALE-retain refusal disabled | **4 fail** / 4 suites | yes |
| P3 — `ackClaimedImpressionDebts` replaced by `0` | **4 fail** / 3 suites | yes |
| P4 — `impression_stale = 0` dropped from `replaceLaneImpression` | **2 fail** / 7 suites | yes |

**Stated rather than dressed up:** none of these four is killed ONLY by the new test — each also
kills the single-mechanism suite that owns its rule. The integration test's contribution is the
joins, and the honest measure of it is P4, where the whole seven-suite impression family produces
just two kills and this test is one of them: nothing else asserts that the flag's clear and the
debt's ack are the SAME commit's work.

## Docs sweep

- `CONTEXT.md` — new entries **Impression**, **Lifecycle debt**, **Impression fold**, **Canonical
  lane route (`E<n>/#<tag>`)**; corrected **Summary layer** and **Working State** (three fields
  now); a new **Retired task fields** entry recording that `done`/`decisions`/`next_steps` and
  `content`'s legacy prose left the product while their columns stay unread; the preamble cites the
  redesign.
- `docs/adr/0002-one-writer-per-layer.md` — Amendment 4. Amendment 3 had relaxed the table to
  PRIMARY writer; the impression is the exception that stays SOLE writer, and that is what made the
  field retirement affordable. Also records that the "Segment fields | main agent" row now means
  `goal`/`constraints`/`reference`/`insight`, and that Amendment 2's `decisions` cadence note is
  moot a second time.
- `docs/design.md`'s `next_steps` occurrences are the SESSION field, which is live and untouched —
  not swept, and not stale.

## Verification, verbatim

- `npx tsc --noEmit` → exit 0, no output. **It does NOT typecheck `tests/`** (excluded by
  `tsconfig.json`). Checked separately against a temporary config that includes only the new test —
  which found a real error `TS2554: Expected 6 arguments, but got 7` in its INSERT parameter tuple,
  fixed, then clean. A test file's types are invisible to the repo typecheck and `bun test` does not
  typecheck either; that gap is worth someone's attention.
- `bun test` → `4563 pass / 0 fail`, 46501 expect() calls, 251 files, 74.14s. Baseline 4562/250: the
  delta is exactly this ticket's one new file with its one test.
- `npm run build` → clean. `tests/shared/release-artifacts.test.ts` → 11 pass / 0 fail (the
  stale-bundle guard is its `built bundles embed current worker + timeline logic` test).
- `grep -c anthropic-ai plugin/scripts/worker.cjs` → `0`. No exemption added.
- `git diff --check` → clean. Control-byte scan over every changed file → no match.

## UNVERIFIED / not done, in full

- **The state-inflation audit over a real regenerated segment did not run.** No live settlement run
  was available and production is read-only here. It is the gate the spec words as "zero inflations
  or the batch does not ship", and it is unpaid.
- **The generation gates are n=1 per arm, self-graded, on one corpus** — the same honest strength
  the spec already assigns the experiments of record. The blind reader is a genuinely separate
  context; the state audit against source windows is mine.
- **The bundles were rebuilt but are NOT in this commit.** This ticket changed no `src/` file, so
  the only bundle delta is the non-deterministic `BUILD_ID` line (verified: 1 insertion / 1 deletion
  per bundle, nothing else). Committing that is noise. The rebuilt files are left in the working
  tree rather than reverted, because reverting them is a working-tree rewrite.
- **The line-1 failure is reported, not repaired.** See the root cause above.
