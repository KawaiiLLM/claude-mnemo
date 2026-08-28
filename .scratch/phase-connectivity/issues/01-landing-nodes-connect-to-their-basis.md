# 01 — Phase connectivity: a landing reaches its basis (Rev 2)

**What to build:** settlement's second connectivity law. **USER RULING**
[S15069/T1945][S15069/T1947] — the principle only: a landing-phase node must
be traceable (回溯) to other phases regardless of lane; a landing with
genuinely no external upstream is itself a compound node; this is the
connectivity family's second member. **Everything below the principle is a
SWITCH** — Rev 1 mislabeled reviewer defaults as rulings (mnemo review P0-1,
accepted); Rev 2 marks every switch's owner.

**Status:** resolved (gate OFF) — landed as `db5927c`; every criterion
re-checked per-item; suite green, tsc clean. Dry-run replicated exactly by
the reviewer: violations 4/41 = 9.8%, compound exit 70.7%, paths 1-2 hops,
basis words review 17 / design 11 / correction 4 / measure 3 / research 2 —
the review-in-basis ruling is data-backed. **AMENDED by ticket 06**: arming
is UNWIRED, not "a one-line flip" as this Status previously claimed — that
sentence was false against source (the evaluation runs inside `commit`'s
`appendReports`, which on the success path executes AFTER `writes.commit()`;
`PHASE_CONNECTIVITY_GATE_ARMED` was written once and read nowhere). Ticket 06
deleted that dead constant; arming now requires moving the refusal into the
pre-commit gate sequence against a single fenced read of the graph — its own
ticket with its own dry-run. The dry-run numbers above stay: they were
measured and replicated — but ONLY against their own five windows: the
script's default sampler picks five EVENLY-SPACED done jobs out of all done
jobs, so it drifts as the job table grows (ticket 06's worker re-ran it and
got 1/28 = 3.6% off a different sample, jobs 1/33/65/98/130). The numbers
above are jobs **21,87,98,101,130**; re-run them as
`bun scripts/phase-connectivity-dry-run.ts --jobs 21,87,98,101,130`, which
the reviewer did after ticket 06 landed: 4/41 = 9.8%, 70.7%, basis
distribution byte-identical — the cap-semantics change moved no verdict.
Quoting a bare dry-run number without its job list is not a comparison. Worker judgment calls accepted: typeReason
enforcement live now (narrow machinery, ungated by the ticket's own text);
tests-outside-tsc noted as a pre-existing repo fact. Originally:
ready-for-agent — user approved Rev 2 whole [S15069/T1951],
review-in-basis settled affirmative. SEQUENCING IS PART OF THE TICKET: the
worker builds the FULL machinery with the gate OFF (report-only findings in
lane_check/commit output), runs the dry-run on real windows, and REPORTS the
numbers; arming the refusal is the reviewer's one-line follow-up after
judging the dry-run — never the worker's call.

## The predicate (peer-corrected, ACCEPTED — it restores the ruling's own word)

A live, landing-only node passes iff a **DIRECTED walk along its out-edges**
(citing→cited, the graph's one direction) over commit-valid edges reaches ANY
basis-type node, at any depth, crossing lanes and tasks freely. A compound
node (landing + basis words in its own type) passes at zero hops.

- Rev 1's "undirected, one hop" was WRONG twice over: 回溯 is directional
  (the user's own word), and one-hop misfires on chains
  (`D ←grounds— I1 ←extends— I2`: I2 reaches D transitively; one-hop would
  demand a redundant I2→D edge). A later `verifies`/`override` INTO the
  landing proves downstream evaluation, not execution basis — undirected
  would wrongly accept it.
- **All seven words carry the walk** (each means "citing runs on cited";
  restricting to grounds/consume/verifies would force duplicate edges beside
  existing extends/indexes paths). The DIRECTION is the thing that never
  relaxes.
- Draft/E6-invalid edges do not carry; basis endpoints may lie outside the
  writable window but must be live.

## Type sets (set-membership on raw types; NEVER reuse TYPE_PHASE —
phasesForTypes maps discuss→decision and review/ops/delegate→delivery,
which would let implement+discuss self-pass; verified in turn-phase.ts)

- **landing** = type ∩ {implement, fix, refactor} ≠ ∅ (so ops+fix IS landing
  — the Rev 1 "ops exemption" is deleted; pure ops never triggers anyway).
- **basis** = design | correction | measure | research | **review** — SETTLED
  by user [S15069/T1951]: review findings are often a fix's direct basis;
  direction already excludes rubber-stamp approvals (review→landing is the
  wrong way).
- discuss / ops / delegate alone: neither trigger nor satisfy.

## Enforcement (peer verdict + user's ERROR push [S15069/T1948])

Endgame = **clean-graph ERROR**: directed reachability or honest compound,
else the commit refuses. Unlike lane fractures there is no "honestly
separate" legal state — the user made compoundness the invariant's own
escape. BUT the gate may not switch on until the prerequisites below are met;
until then the check runs REPORT-ONLY.

**Compound-retype is not a free pass**: the added word must be the ACCURATE
basis the turn's content actually carries (a measurement adds `measure`,
an investigation `research`, a review finding `review` — never default
`design`); `design`/`correction` only when the turn truly set or revised a
commitment (a genuine compound entering the C decision tier is a correct
outcome, not pollution). Every retype writes a persistent audit record
`{job, turn, old_types, new_types, basis_word, reason}` — a structured slot,
not a line in the transient commit report (storage design in scope).

## Prerequisites before the gate arms (peer P0-3/4/5, all accepted)

1. **A dedicated basis-reachability loader** — `loadTaggedEdgesTouching`
   excludes double-empty sides and partial relations; the walk needs its own
   fixpoint load. Patching checkLanes alone would emit false ERRORs.
2. **Obligation anchor = the run's target window** (`windowTurnIds`), never
   the writable lookback/closure set — else old orphans dragged in by
   lookback block unrelated new windows. A backfill's target range is its
   window; untouched backlog is never scanned or migrated.
3. **Dry-run with the FINAL predicate on real windows** before arming:
   hit rate, path-length distribution, basis-type distribution, expected
   compound-exit share. (Rev 1's "61%" was a different population and a
   different predicate — it is NOT the expected refusal rate.)
4. Backfill runs the same prompt/commit path, so it carries the rule the day
   the gate arms — "new windows only" means no retroactive migration,
   nothing more.

## Property tests (peer's list, in scope)

directed two-hop passes / reverse-only fails; each of the seven words
carries; draft edges don't; cross-lane, cross-task, out-of-window basis pass;
implement+discuss and ops+fix do NOT self-pass; all basis compounds pass;
lookback orphans don't block, the same turn as backfill target does; the
registered refusal names the landing and both exits; a real backfill job's
prompt contains the rule.

## Related

The LANE rule's upgrade (mandatory-disposition ERROR) is ticket 02 — it
reverses a pinned test and needs its own machinery (component fingerprints,
lane-read receipts); never bundled here.
