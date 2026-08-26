# Peer round three — six deferred findings

**Source**: peer review of `121d59a..3f61fae` ([S15069/T1773]), nine findings.
**Closed already**: #1 (task/lane namespace), #2 (unnamed-merge member loss), #9 (`id` describe) — fixed and regression-tested.
**Status**: the six below are OPEN. All predate this batch's teaching-surface work and none is released.

Two runnable reproductions are preserved verbatim in `repros/` — they were written against the
pre-fix tree and now demonstrate the guards instead.

---

## P1 — bounded reads and snapshot semantics

### 01 — `lane_check` pages are recomputations, not pages of one result

The tool description promises "the SAME check's own findings — not a re-run". The handler reruns
`checkWindowLanes` on every page call, so a note or edge write landed between page 1 and page 2
can make a finding vanish, shift a page boundary, or duplicate an entry across pages.

Decide first: is the promise the contract (then a run needs a stored snapshot keyed by a token the
first page returns), or is recomputation the contract (then the description must stop claiming
otherwise and say what a caller should do about drift)? The existing two-page test holds the
database still and cannot see the difference — it asserts neither one checker invocation nor
snapshot identity.

### 02 — `lane_check` has no hard result cap

`pageBudget` is positive-only, so `1_000_000` is accepted, and the settlement SDK tool returns the
rendered string directly rather than through the worker's capped envelope. Independently, one lane
stats/component block can exceed 100K on its own: blocks are indivisible and the packer emits an
oversized first block rather than splitting it. Either shape recreates job 98's tool-result failure.

Needs a clamp independent of caller input AND a per-block ceiling (or a way to split a large member
block), not one or the other.

### 03 — public size controls are unbounded across the read surface

Same shape one level up, and already known before this review: a large `pageSize` renders
arbitrarily many timeline turns or task members into one page, a large `pageBudget` admits
arbitrarily many task-card/search/lane blocks. Worker handlers truncate at 100K instead of yielding
the promised next page; audiences without that envelope can exceed the host limit outright.

Tests assert default-budget fixtures only, so no fixture exercises a caller-supplied maximum.
Needs maximums independent of caller input plus final-envelope assertions.

## P2 — contract accuracy

### 04 — default `lane_check` can report clean where `commit` refuses

`scope:"actionable"` projects findings to the window; `commit` gates every anchor in
`writableTurnIds`, which includes base-lookback and closure turns. An E3/E4/E6 carried only by one
of those is invisible by default and fatal at commit, while the prompt says commit is refused for
errors `lane_check` reports inside the writable set.

The scopes may stay different — what must change is the claim. State that the default is not a
commit preview, and direct finalization at `scope:"all"`.

### 05 — actionable projection filters instances but keeps global totals

Two out-of-vocabulary edges, one touching the window: the output renders one entry under a header
reading `2 edge(s) … showing first 1`, so an edge outside the window reads as an omitted actionable
item. Unattributed clusters have the same mismatch. D3 asked for excluded findings to become an
explicit outside-window summary; recompute the scoped counts and label the excluded total
separately.

### 06 — lane retag namespace collisions escape as unhandled tool errors

`renameLane` reaches `insertLane`, which throws `TagNamespaceCollisionError` when the destination
word is a task tag. `handleRetagLane` has no precheck or catch and `rememberTool` has no outer
conversion, so the caller gets a failed MCP call rather than a refusal naming the holder. The
`create` path got exactly this pre-check in the round-three fixes — retag needs the same one.
