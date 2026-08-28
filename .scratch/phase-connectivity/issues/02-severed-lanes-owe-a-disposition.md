# 02 — A severed lane owes a disposition, or the commit refuses

**What to build:** the lane-connectivity rule (today: SEVERED = warning +
stitch-or-justify TEACHING, silent skip possible) upgrades to
**mandatory-disposition ERROR**. USER direction [S15069/T1948]: settlement is
passive — resuming a long-dormant lane, the agent won't connect
hundreds-of-turns-old predecessors though recall makes finding them cheap; a
lane should not split into components. Peer verdict (mnemo review,
2026-08-29): accepted in the refined form below, which unifies "no fabricated
bridges" with "no silent skips".

**Status:** resolved — landed as `322eaad` + repair `e655cd8`; suite 4052/0,
tsc clean. The repair closed JC3, a REAL defect the reviewer caught in the
worker's judgment calls: `touched` had been implemented as island∩
writableTurnIds, so lookback members of never-written old fractured lanes
would have blocked unrelated commits — the same hole peer P0-4 plugged on
ticket 01. Now `touched` derives from this run's own LANDED writes (edge
sides / landed tags / justify calls), accumulated live in the direct-write
engine and matched against the checker's own island membership (cannot
drift). Reviewer mutation reverting to the proxy turned the two
lookback-only tests red; restored byte-identical, green. Two worker
disclosures accepted: the reversed pinned test's fixture never actually
wrote into its lane (pre-seeded via DB inserts) — its premise was made
genuinely true with a non-curing restatement note; restated edges count as
touch by design (engagement is the write action, storage-idempotence
irrelevant). Also recorded: an Edit-tool call once wrote literal NUL bytes
into a .ts file, tolerated silently by tsc AND bun — treat any `Bin` line
in `git diff --stat` on a text file as a hard stop. Originally:
ready-for-agent — user ratified [S15069/T1951]. Switch 2
defaulted: duplicate-reason tracking reports into the settlement report
(surface to the user only when the rate is anomalous). Blocked by 01 (same
checker/commit territory; serialize behind it).
Reverses a PINNED test (`tests/worker/note-settlement-sdk-query.test.ts`
"commit succeeds with no stitching edge and no justification…") — that
reversal is this ticket's own act, never a side effect.

## The refined form (peer's, accepted)

- **A genuine stitch self-evidences**: after the edge is written, the
  re-run checker no longer reports the fracture — no disposition entry is
  demanded for a fracture that no longer exists.
- **Every REMAINING touched fracture requires a structured `justify`**,
  absence refuses the commit. Machine checks PRESENCE and BINDING, not
  truth: a justify binds `{task, lane, component fingerprint, both
  representative addresses, reason, read receipts}`; a topology change
  invalidates old justifies.
- **Post-state semantics**: the commit checks the graph as this run leaves
  it. Unsettled in-window turns never count as islands; a touched lane still
  fractured AT COMMIT owes its disposition now — no "wait one more window"
  (that would rebuild the exact hole the user named: the lane may not be
  touched again for a long time).

## Anti-grinding (peer's honesty boundary, accepted)

Machine cannot verify a reason is TRUE — that is the semantic limit. What it
can do: (1) the reason must name both current representatives and why none of
the seven words holds; (2) justifies persist as per-finding records (the
transient commit report is not storage); (3) duplicate-reason rate is
tracked, high rates trigger human review.

**Recall-before-justify cannot be enforced from the prompt alone** — read
grants today record entity ids, not selectors, so a lane read is
indistinguishable from a turn read. In scope: a **lane-read receipt**
`(task, lane, membership snapshot, page coverage, sequence)`, plus requiring
a full-content grant on the OTHER component's representative before a justify
is accepted. NB `recall(id="E<n>/#tag")` paginates (pageSize) — the teaching
requires covering the relevant component's pages, not a mythical one-shot
full read.

## Switches (settled)

1. Mandatory-disposition ERROR ratified [S15069/T1951].
2. Duplicate-reason tracking → settlement report (default; escalate only on
   anomaly).

## Out of scope

Ticket 01's phase predicate; retroactive stitching campaigns; the checker's
island-counting itself (unchanged).
