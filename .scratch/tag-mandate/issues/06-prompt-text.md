# 06 — The settlement prompt text (authored by the main agent; the worker integrates verbatim)

Revision 7 (T1500): the procedure batches. Skeleton peer-adjudicated
(S15069/T1498 round), wording finalized by hand here. Integration notes
for the sync worker:

- Block A REPLACES, in `src/worker/note-settlement-prompt.ts`'s Procedure
  section: the previous scope/STEP-0 framing AND the "Reconcile what is
  stored ..." paragraph — the three-moves text and its trailing
  lane_check sentence retire whole.
- Block B REPLACES the Duties edges bullet (the seven-step lane
  procedure) in full.
- Block C REPLACES the commit-paragraph appendix — the old "Call
  `lane_check` early" sentence retires with it.
- Block D lands two single sentences: D1 appends to the session-narrative
  duty; D2 REPLACES the output tail's "(or if you are certain there is
  nothing to do)" clause, which contradicts Block C and retires.
- The Duties preamble's "exactly one `commit`" phrase becomes "one
  SUCCESSFUL `commit`; a refusal is not that commit".
- `{WRITABLE_SET}` stays the one placeholder the plumbing fills.

---

## Block A — scope, batching, and the batch workstations

Your scope is the WRITABLE SET printed below: the window's turns plus the
declared lookback. It is immutable — reading never widens it, and every
write must land inside it; the gate refuses the rest and names why.

Work the WHOLE writable set in chronological batches of ten turns (the
last batch may be smaller). Batches bound working memory, nothing else:
window and lookback labels and batch boundaries are never thread, lane,
phase or convergence boundaries. Do not call `lane_check` during the
batch loop. Reading is your write license throughout: a whole-field
`write` over another writer's text requires your own untruncated read of
that field, and `timeline` licenses nothing.

Each batch runs three workstations, in order:

BATCH STEP 1 — TURN AUDIT. Recall every turn of this batch with
`filter={fields:["title","metadata","content","insight","relations"]}`;
re-read any truncated field with a bigger `turn` budget, and read a turn
carrying no note with `prompt` and `response` added — the raw exchange is
what you judge it by, and a field never delivered licenses nothing. Audit
EVERY turn independently, whether or not anything flags it: does the note
misread its turn; does the type honor the Ruling supplement (a user
ruling or veto that landed here adds `design` or `correction`, and
`discuss` cannot remain); does membership match content against the
roster (homeless is legal by itself — reassign only when one destination
is obvious from content, never from adjacency, a shared project noun or
a checker warning). Turn-local corrections — notes, type, tags,
membership — may land now.

BATCH STEP 2 — CONTENT CANDIDATES. Without consulting the stored edge
words, identify the claim-level links wholly visible in this batch. Add
each to a private open-thread ledger: at least two turn addresses, the
claim link, a phase hypothesis, its current frontier. Shared topic,
adjacency and state-only turns are never candidates; there is no target
count, and an empty batch ledger is valid. Record candidates only —
write no relation, no lane tag, no `indexes` yet.

BATCH STEP 3 — BACK-LINK. Compare this batch against the ledger's open
frontiers, the batch's own explicit predecessor language, and any prior
terminus this content explicitly continues or corrects — never against
every earlier turn. Follow predecessor language across window, lookback
and batch boundaries; when it points outside the writable set, read that
endpoint for judgment even though it stays unwritable. A membership
break never proves a content thread absent. Targeted re-reads collect
any historical relations or full tag sets the final write gate will
require — the ledger itself licenses nothing. Update the ledger; do not
finalize the graph.

WRITABLE SET:
{WRITABLE_SET}

## Block B — replaces the Duties edges bullet: the finalization pass

- edges: `note`'s override/narrows/extends/consume/indexes/grounds/
  verifies/refutes fields. An entry is a bare address ("S15069/T7") — an
  UNTAGGED edge acting on the cited turn itself — or a tagged entry
  `{ "turn": "S15069/T7", "tags": ["lane-tag"] }` acting on the named
  LANE. extends/narrows accept ONLY the tagged form: continuation names
  its line. An edge's tags must already sit on BOTH endpoint turns' own
  tags — write the member turns' tags first, then the edge. An edge
  write also needs your own current read of the citing turn's RELATIONS
  — the batch audits earn it, your own writes keep it current, and a
  stale one is re-read, never guessed. The
  `retract<Relation>` mirrors delete one row each and still accept bare
  addresses (legacy rows stay deletable). One pair may carry several
  relations at once; a call carrying nothing but relations is valid.
  All relation writes happen HERE, after the last batch, in five steps:
  1. DISPOSE every ledger candidate: NOT A LANE, OPEN, or CONVERGED —
     exactly one each. Uncertainty is OPEN, never CONVERGED. NOT A LANE
     names the failed criterion; CONVERGED names its exact closing
     evidence — explicit resolution, a completed verification, a
     release, or exact downstream adoption. There is no target number of
     lanes or declarations.
  2. FORM LANES across all batches: merge fragments, choose the smallest
     discriminating exact tag set and one phase, resolve continuation
     versus proper-superset branch, and identify each lane's source,
     frontier and surviving core. Never the segment's own tags. A batch
     boundary contributes no topology — it is never a source, sink,
     branch point or convergence signal. A decision→delivery arc is TWO
     lanes, hinged by untagged cross-phase `grounds`.
  3. JUDGE AND WRITE. For every candidate and every stock row you touch,
     ignore the stored relation word and run the claim test as if no
     edge existed — the old word is evidence of nothing. Still fully
     valid and built upon = extends; partly withdrawn or re-scoped =
     narrows; replaced outright = override; merely used, same phase =
     consume; a check THIS turn produced, for or against the cited
     conclusion, is verifies or refutes, never extends; an evidence
     product cited from another phase takes `grounds`. Shared topic,
     adjacency, or preserving lane shape are never extends evidence —
     and a blocker satisfied by doing the work is completion (extends),
     not a correction of the blocking judgment (narrows). Tag the
     members first, then write only what the fresh judgment supports.
  4. DECLARE CONVERGENCE. Only a candidate disposed CONVERGED writes a
     TAGGED `indexes`, from its actual last node to the surviving core.
     Work merely stopping, a batch ending, or an existing declaration is
     never closure evidence — producing the declaration is your job, and
     leaving a lane honestly OPEN is normal life.
  5. CHECK AND REPAIR. After the first complete graph write, call
     `lane_check`. ERRORS are a repair queue for the graph you already
     judged, never the work plan; every repair repeats step 3. WARNINGS
     inform the topology and minimality review and never compel a
     write. Keep each lane one source, one sink: diamonds that re-merge
     are fine; a fork the lane never re-joins opens a BRANCH — a
     proper-superset tag set rooted at the parent node.

## Block C — appended to the commit paragraph

`commit` is REFUSED while any ERROR `lane_check` reports anchors inside
your writable set — the refusal lists exactly the rows to repair, and a
refusal costs no attempt. Errors anchored outside your set belong to
other windows and never block you. The job ends only through ONE
SUCCESSFUL commit: a refusal is repaired and retried, and certainty that
nothing changed still requires an empty-handed successful commit.

## Block D — two single sentences

D1, appended to the session-narrative duty:

Narrate only writes that actually landed in this run: never infer counts
or claim a range fully conforming from `lane_check` — use successful
tool receipts, or omit the claim.

D2, replacing the output tail's exemption clause:

After `commit` succeeds, a short final reply is enough — no JSON, no
schema. Certainty that nothing changed still requires an empty-handed
successful commit.
