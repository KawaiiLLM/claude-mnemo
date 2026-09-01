# 09 — Repair the teaching, then clear the gate the batch failed on

**What to build:** the batch's failing acceptance gate passes on the SHIPPED artefacts, because the teaching that produces impressions has been repaired at the three places measurement found broken. This is the last ticket before release (user ruling S15069/T2359: fix the batch, then ship).

**Blocked by:** None — 01-05, 07 landed, 06 and 08 reported, and `.scratch/impression-as-index/issues/01` reported.

**Status:** LANDED. All three repairs shipped in the prose AND in both rewritten golden samples,
each pinned by a test that a mutation probe drives RED. **The corrected-C gate's line-1-only reader
arm now PASSES: Q4 frontier 9/9 across 3 readers × 3 lanes, against ticket 06's 0/3 with six honest
abstentions**, with zero over-reads on 9 observations and one charged under-read. The liveness arm
is new and replicates the effect the gate never tested: **4/5 unmarked → 0/5 marked** on a minimal
pair. **The state-inflation audit is NOT RUN** — three independent blockers, listed below.
**One negative result, reported as one: the supersession rule's WRITER-side effect on the
uncontaminated lane is not demonstrated** — that writer deleted the history instead of marking it,
exactly as the unrepaired arm did. Raw data: `experiments/run-t09/records.md` and
`experiments/liveness/records.md`.

## What is broken, and how it was measured

Three defects, each with data behind it. All three are in the TEACHING and its golden sample, not in the storage or the write path — those landed clean and are not touched here.

**1. The line-1 clause names three duties; the gate demands four.** The shipped text says line 1 carries "what it is, its governing law, its current state" — and the acceptance gate requires identity / governing law / current state / **frontier**. The golden sample's own line 1 carries four. Sample and prose disagree, and writers followed the prose: a blind reader given only line 1 answered the frontier question for **0 of 3 lanes**, six honest abstentions.

Not a budget problem: measured with the runtime tokenizer, those global lines ran 46–98 tokens against a 150 cap, mean 67. Repairing this costs no budget.

**2. Mixed-maturity items share one delivery predicate.** List members carrying no state predicate of their own inherit the matrix clause's. The shipped golden sample does it — three items sit under "locked and shipped through ticket 004" and one of them is a provenance fact a reader read as delivered. Real and reproducible, but rarer than the gate reported: it fired on 1 reader in 3, on the contaminated lane only, and produced **zero** over-reads across 60 observations on clean lanes in two experiments.

**3. THE LARGEST SINGLE EFFECT, and the one nobody predicted: a superseded item is not marked dead.** An impression that keeps a dead path readable, next to the work that killed it, joined only by sequence ("… ; X then …"), leads readers to take the dead path as live frontier — **5 of 5 readers**, against 0 of 5 for a text that simply omitted the history. The two failure shapes are mirrors: keeping history without marking it dead misleads, and marking what is in force by DELETING history is what the passing arm was silently doing. Neither is acceptable; the rule below is what makes keeping history safe.

## What to change

- [x] **The line-1 clause gains the fourth duty.** Line 1 must carry the open boundary. Wording is yours; the duty list in the section header (GLOBAL IMPRESSION / CAUSAL MODEL / BINDINGS / FRONTIER) and the line-1 clause must stop contradicting each other.
- [x] **A state-scope isolation rule.** A state predicate governs only the items named in its own clause; source, ruling, design, preview and decoded-only evidence never appear as unlabelled siblings of delivered work. Each state transition starts its own locally-qualified clause.
- [x] **An obsolescence rule — the load-bearing one.** When a line names work that a later decision superseded, that line says so. Sequence words are not supersession: "then" reads as chronology and was measured doing exactly that.
- [x] **BOTH golden samples are REWRITTEN to obey all three.** This is not optional polish and not secondary to the prose. Measured twice: writers copy the sample's construction near-verbatim, defects included — two independent writers in two independent draws reproduced the same four lines of a sample verbatim. A repair that fixes the prose and leaves the sample ships the defect. The rewritten samples must pass `validateImpression()` themselves; assert that in a test.

## What to prove, honestly

- [x] **Re-run the corrected-C gate — RUN, PASSES (Q4 frontier 9/9).** On the shipped teaching and shipped validator, with the artefacts and method of `.scratch/lane-impressions/experiments/` (reuse, do not rebuild). The line-1-only reader arm must now hold frontier. Report per reader, per lane, raw.
- [x] **Add a liveness arm — RUN; 4/5 unmarked → 0/5 marked.** Material where a superseded path is still readable, and show the obsolescence rule moves it. This is the change with the largest measured effect and the gate did not test it.
- [ ] **The state-inflation audit is NOT RUN, as the ticket instructed it should stay unless a live settlement run is genuinely available.** It needs the worker driving a real segment end to end, and `~/.claude-mnemo/` is read-only here. Do NOT substitute a synthetic corpus and call the gate passed — the previous ticket was right to refuse that, and the refusal is the precedent. If it cannot run, say so and say what would let it.

## Two acceptance rules that do not discriminate — report, do not silently drop

- [x] The **state-precision axis** produced zero over-reads on every arm of two experiments, 60 clean observations, with reader counts chosen so a 1-in-3 defect would be visible. Report this. Whether to retire it is the user's call, not this ticket's.
- [x] The **8-line bound never engages**: every refusal in both experiments was `total-cap`, and under any cap below 480 the line bound is unreachable. Report it as the spec inconsistency it is; do not change the constant here.

## Constraints

- Storage, CAS fence, fold-on-merge, lifecycle debts and every display surface are OUT OF SCOPE and must not change. This ticket is the teaching, its samples, and the tests that pin them.
- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` — that whole class of working-tree rewrite is banned. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` must stay `0`.
- [x] `npx tsc --noEmit` clean (note it excludes `tests/` — typecheck new test files separately); full `bun test` once (baseline 4563/0 across 251 files, account for any delta); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push — the release is a separate step.

---

## What landed, and what each repair actually moved

### The three repairs, in `src/worker/note-settlement-impression-teaching.ts`

1. **Line 1's fourth duty.** The duty list now reads "what this lane is, its governing law, its
   current state, AND its open boundary. All four, in one line", the line-form clause reads
   "— what it is, its governing law, its current state, AND ITS OPEN BOUNDARY —", and a new
   paragraph, `THE OPEN BOUNDARY IS LINE 1'S FOURTH DUTY, NOT AN OPTIONAL FIFTH CLAUSE`, names the
   failure mode measured: a reader given a line 1 with no boundary does not abstain, it takes the
   newest finished thing for the frontier. The surviving three-duty formulation is gone.
2. **STATE-SCOPE ISOLATION**, placed after THE STATE CEILING. Ticket 08 arm 2's text, which is the
   version that was measured, plus one clause the ablation's data asked for: every state
   TRANSITION starts its own locally-qualified clause, and a delivery word never leads a clause
   whose other members are not delivered.
3. **SUPERSESSION.** New. It forbids BOTH failure shapes in one breath — keeping a dead path
   unmarked, and the mirror repair of deleting the history to buy clarity — and it names the
   mechanism: sequence is not supersession, and the writer's own `override` edges are the
   mechanical source of truth for what a later decision killed.

### The samples, which are the real teaching

Both rewritten. The full sample's old line 1 opened `the look is locked and shipped through ticket
004 —` with no anchor in that clause and three items of three different maturities hung off the
dash; its new line 1 gives each item its own predicate in its own clause and ends on the open
boundary (147 tok / 150 cap), and a new fourth line names three dead paths with the ruling that
killed each. The thin sample stayed ONE line and gained the fourth duty it owed as a line 1.
Both pass HEAD's `validateImpression()` with zero rejections and zero warnings.

### What did NOT move, stated because it did not

The **supersession rule's writer-side effect on the uncontaminated lane is not demonstrated.** At
r3, lane B's whole stored prior was the bin-editor route and the window killed it; the writer under
the repaired teaching DELETED the history rather than marking it dead — the same choice arm 2's
writer made without the rule. The only writer-produced supersession markers in the run are on the
contaminated lane, where the sample supplied them.

### Why the state-inflation audit could not run — three independent blockers

1. `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY to this ticket; a live settlement
   run writes impressions into `claude-mnemo.db`.
2. The running worker is `claude-mnemo/0.27.0/scripts/worker.cjs`, and
   `grep -c 'settleImpressions' ` on that bundle returns **0** — the live worker has no impression
   write path at all.
3. The newest cached bundle, 0.28.0, does not carry this ticket's repair either
   (`grep -c 'STATE-SCOPE ISOLATION'` → 0), and no process runs it.

What would let it run: this commit released, `/plugin` updated, the worker cold-restarted onto the
new bundle, and the user's explicit go-ahead to let a real settlement run write impressions into
production — then every claim in one regenerated segment audited against its anchors.

### The two acceptance rules that do not discriminate

- **State precision.** 0 over-reads on 9 reader-lane observations here, on top of ticket 08's 0 on
  60 clean observations and impression-as-index's 0 on 30. Across three experiments this axis has
  fired twice, both on the contaminated lane, both traceable to one sentence in one shipped sample
  — the sentence this ticket deleted. **Reported, not retired: whether to retire it is the user's
  call.**
- **The 8-line bound.** `line-count` has now never fired in four experiments. This run's 7
  lane-writes produced 3 refusals, all SIZE refusals (`line-1-cap` ×3, `total-cap` ×3, `line-cap`
  ×1). The bound is reachable in principle (9 short lines under a 500 cap), but with lines
  averaging anywhere near their 60-token cap the total cap always binds first. **Reported as the
  spec inconsistency it is; the constant is unchanged.**
