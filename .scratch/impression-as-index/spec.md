# The impression becomes an index — one line per stage, newest first, bounded by curation

**Status:** DRAFT Rev 1, for design review. User rulings S15069/T2346 (the write path moves to `remember`; the impression's job is to INDEX) and S15069/T2348 (the form: one line per stage, newest first, bounded curation).

## Problem Statement

A lane impression is prose settlement writes as the model a reader keeps after the chronology is forgotten. It is TWO-TIER today: at most 8 newline-delimited lines under a cap of `clamp(10 × settledMembers, 100, 500)` tokens, with LINE 1 special — self-contained, at most 150 tokens, carrying the lane's whole shape, because a fixed-size surface is meant to take exactly line 1.

Its acceptance gate failed, and the ablation that followed says the two-tier design is the wrong thing to repair.

**Measured, on two uncontaminated lanes, three blind readers per arm:**

| | baseline | + state-scope repair | flat 150 |
|---|---|---|---|
| frontier answerable | **0/6** | 6/6 | 6/6 |
| governing law answerable | 6/6 | 4.5/6 | 6/6 |
| state over-reads | 0 | 0 | 0 |
| causal law present in full text | 4/5 | 3/5 | **2/5** |
| bindings present | 8/8 | 5/8 | 6/8 |

Four findings drive this spec:

1. **The budget was never the constraint.** Measured with the runtime tokenizer on every produced global line: the baseline arm had 150 tokens available, used at most **98** (mean 67), and still scored 0/6 on frontier. It dropped frontier because the teaching does not ask for it — the shipped line-1 clause names THREE duties where the gate demands four. A specification failure, not a capacity failure.
2. **150 tokens holds the assertions, not the synthesis.** The repair arm carried all four duties in 84–142 tokens, every sample under the cap — but that lane's full impression ran 351 tokens, and the other 209 held the REASONS. When the flat arm deleted them, causal law present fell to 2/5 and one lane's governing law vanished entirely; two readers asked for the causal model answered "the user thought it looked ugly" — true, and at the wrong level.
3. **The defect is real, reproducible, and probabilistic.** State inflation happens through apposition: list members carrying no state predicate of their own inherit the matrix clause's delivery predicate. It fired on 1 of 3 readers, not 3 of 3 as the acceptance gate reported. The shipped golden sample exhibits the construction.
4. **The sample is the teaching.** Writers copied the sample's construction near-verbatim, defects included. One writer given the unmodified sample declared it would treat the sample as form-only because its content contradicted the task — a sample a writer must actively resist is itself the defect.

And the premise underneath the whole two-tier design does not hold today: **no surface takes line 1 alone.** The segment card renders every line; the lane route splices the whole stored text; the search spine deliberately renders none; `src/hooks/` holds zero impression references. The intended fixed-size consumer is the frontier block — landed, but never wired to impressions.

## Solution

### The form

**One line, one STAGE of work. Newest first. No line is special.**

```
S18993/T196..T199: the 32x16 blur is fixed by nearest+mipmap integer zoom; K3ST is
                   identified as mapA's elevation and decoded — client integration and
                   any elevation-combat rule remain open
S18993/T160..T168: road cells became whole connected road tiles, replacing the rejected
                   mid-tile stripe; committed
S18993/T124..T133: diagonal-brick diamond geometry ruled — top-down reading comes from
                   axis-aligned gridlines, not 2:1 foreshortening
```

A fixed-size surface takes the first N lines. There is no summarisation step, so the defect class in finding 3 has nowhere to arise: a line that says what a range of turns DID makes no completion claim for a reader to over-read, and there is no matrix state predicate for a sibling to inherit.

### The address is a real range, not a rendered ordinal

Each line leads with `S<a>/T<b>..S<c>/T<d>`, the range form `recall` already parses: endpoints are ordinary pasteable turn addresses and the range runs over **the task's own event order** between them. This is load-bearing — a range of session prompt numbers would sweep in turns that are not members of this lane, which is exactly the misdirection this redesign exists to remove. A single-turn stage uses a bare `S<a>/T<b>`.

### Bounded by CURATION, not by truncation

The bound is on **LINE COUNT, not tokens**. A token bound reimports the cram pressure that produced the defect; a line bound spends the budget on how many stages survive.

**Overflow is a MERGE, never a drop.** When a new stage would exceed the bound, the two oldest adjacent stages fold into one line covering both ranges (`S18993/T100..T160: early geometry work, since overturned`). One line is spent to buy one slot. Dropping the oldest line instead makes this a ring buffer and forgets a lane's origin silently; merging is what makes it curation, and it is the only place this form asks settlement to exercise judgment.

### The write path moves to `remember`; `commit` checks the duty

Impressions leave `commit`'s payload. `remember` gains the impression write, alongside the container verbs it already owns (`create`/`write`/`edit`/`merge`/`retag`) — an impression IS container state, and smuggling it through a gate tool is the misplacement that lets one malformed impression refuse an entire commit.

`commit` keeps a check, and its object changes from the PAYLOAD to the DUTY: every container this run touched must carry a current impression decision. The lease is already checked on every call, so `remember` inherits the authorisation it needs.

**The one real coupling to cut:** a `replace` clears `impression_stale`, and STALE means "must be rewritten". If `remember` clears it and the run's `commit` then fails, a run that produced nothing has discharged an obligation. The flag's clearing must ride the commit, not the write.

## Open questions

1. **Identity under newest-first.** A fixed-size surface showing the newest N stages never shows a lane's founding decision. "What is this lane" is one of the four reader questions. Either the lane tag plus recent stages carries identity well enough, or a pinned identity line is needed — and a pinned line reintroduces the privileged line this redesign deletes. **To be measured, not argued:** blind readers given only the newest 3 lines, scored on identity.
2. **What a "stage" is.** The form assumes stages are recognisable and roughly contiguous in event order. A lane that interleaves two threads may have no clean stage boundary. Unruled.
3. **Migration of existing impressions.** Every stored impression is in the synthesis form. Rewrite on next settlement touch, or leave both forms readable?

## What survives, and what dies

**Survives unchanged** — the expensive half. Storage (`impression` text + `impression_revision` + `impression_stale`), the CAS fence, the fold-on-merge concatenation, the STALE-retain refusal, the lifecycle debts, and the display surfaces. All are form-agnostic.

**Survives with its numbers re-read** — the deterministic validator. Line count ≤ 8 becomes the stage bound; per-line ≤ 60 tokens fits a stage line comfortably (8 × 60 = 480, just under the 500 ceiling); anchor format and resolution become MORE central than before. Two checks change: line 1's ≤150 special cap has no subject any more, and the delivery-word rule needs re-examination — an index line naming a delivery is ordinary, not suspicious.

**Dies** — the semantic tier. The four-question writing law (S15069/T2230, refined T2240), the "revision of the current mental model" definition (S21460/T308), both golden samples, and the line-1 duty clause. This is a real reversal of about ten turns of rulings, and it is a reversal on measurement, not on taste.

## Testing Decisions

Judged at the existing seams — the rendered lane route, the segment card, and the blind-reader instrument — never on writer internals.

**The sample is written FIRST and is the primary artefact.** Finding 4 is the reason: writers imitate the sample, so a spec whose prose is right and whose sample is wrong ships the wrong thing. The sample must be produced from a real lane's real windows, and must itself pass the validator.

The instrument of record is the blind battery: a fixed question set, a key written from source before any arm answers, MULTIPLE independent zero-tool readers per rendered text, and two axes scored separately — coverage (identity / governing law / current state / frontier answerable without guessing) and state precision (zero false "finished" beliefs, elicited by a free-form "what do you now believe is finished?"). One reader over N lanes is N correlated observations, never n=N.

Arms hold everything constant but the form. The repair arm (state-scope rule plus rewritten synthesis sample) is the control this must beat, not the failed baseline.
