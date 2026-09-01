# Settlement gate taxonomy — one voice for `lane_check` and `commit`

**Status:** READY for tickets — user rulings S15069/T2274, design agreed with the `mnemo review` peer on 2026-09-01 (one round, peer overturned one of my factual claims; see "What the peer corrected").

## Problem Statement

A settlement run cannot tell, from `lane_check`, what `commit` will judge it on — and one of the things `commit` judges it on is a state the run may have no honest way to reach. On 2026-09-01 job 166 (S15069, window 2202-2251) burned 81 minutes and 21 refused commits across two attempts and was ABANDONED, terminal, leaving those 50 turns unsettled forever; window 2002-2051 died the same way on 08-30. Measured over 14 days: runs that call `commit` three or more times are 17% of runs and 48% of the settlement cache-read spend, and per-run cost rose from $0.77 to $12.43.

Two written contradictions sit in the source today:

- the report section header calls warnings "aspirations, never enforced", while `commit` refuses over one of those warnings (severed-lane fractures);
- `E3` is printed under `## ERRORS` and then hand-carved out of the commit gate as "beyond authority".

## What the peer corrected

My first framing — that `lane_check` and `commit` scope by different sets — is **false at HEAD**. `actionable` IS the writable set, and a source comment records that scoping it to `provenance.window` was tried and reverted under user ruling S15069/T1778. Both surfaces share `checkWindowLanes()` and `evaluateLaneDispositionGate()`.

The second live evaluator is `remember(justify)`, which builds its own whole-lane projection and recomputes fractures. Underneath both: `loadLaneCheckScope`'s WIDEN step loads every involved lane's FULL membership and full tagged edge set, so **whole history enters at the LOADER** and every narrowing today happens downstream at render and gate time. That is why touching one turn in a 2000-member lane produces 436 errors and 79K characters of output.

The observed disagreement between the two fracture coordinate sets is **NOT yet explained**. The worker that produced those logs runs 0.27.0, not HEAD, and the agent wrote edges between the two calls. No root cause may be asserted until a frozen-DB reproduction says otherwise.

## Solution

### The classification rule

> **BLOCKING ERROR = a hard post-state invariant of this stage is violated, AND the finding anchors inside this run's judgment set, AND this run has a bounded, legal, honest repair action.**

All three, or it is not an error. "Authority plus addressability" is necessary but not sufficient: a fracture may have both writable endpoints and still admit no truthful relation between them, and forcing a repair there manufactures a false edge — which the project already ruled worse than an honest fracture.

| Check | Class | Why |
|---|---|---|
| E6 — DRAFT edge, a side names no lane | **ERROR** | Not a legal terminal state; the citing turn can settle the side or retract |
| E4 — edge tag missing from an endpoint's tags | **ERROR** | Structural invariant; retract/re-place on the citing turn |
| E3 — turn type outside the vocabulary | **WARNING** at stage 2 | Repairable only through a `type` field write; the edge pass holds no such pen. Stage 1 owns it as a blocker |
| Severed-lane fracture / connectivity | **WARNING** | Connectivity is a quality goal, not a legal post-state; a writable pair does not imply a truthful relation |
| Reports 3 / 4b / 4c / attribution / stock | WARNING | unchanged |

No third finding class — "repairable but not compelled" simply IS a warning. But a third **tool result channel** is required.

### The third channel: SYSTEM / PROJECTION FAILURE

Missing production provenance, an unconstructible projection, a self-contradicting evaluator, or output that cannot be expressed inside the protocol (today's "result exceeds maximum allowed tokens", 35 occurrences in 7 days) must **fail closed and operator-visible**. They may never be demoted to warnings, and the agent must never be handed a list that pretends to be repairable.

### One evaluator, one scope definition, two evaluations

`lane_check` is a PREVIEW; `commit` recomputes with the SAME definition inside the terminal transaction. A literally shared snapshot is rejected — the run's own writes make it stale, and fixing that would mean revisioning the whole graph.

Three sets, never again collapsed into one:

- **Judgment anchors** — the window's 50 prompt numbers plus the 50 immediately preceding prompt numbers of the SAME session. Errors and warnings may anchor only here. (Prompt numbers, not the lane's own preceding 50 members: on a sparse lane that spans thousands of prompts and defeats the ruling's intent.)
- **Evidence closure** — the remote endpoints needed to explain those anchors. Readable; their own older findings enter neither the report nor the gate.
- **Boundary witness** — for each component the processing window touches, exactly ONE nearest out-of-window component, as a stitch target. Scanning the lane to find it is allowed; emitting more than that one is not.

Consequences: the agent-facing `scope: "all"` widening is removed, and a missing production provenance fails closed instead of falling open to whole history.

### Bound at the loader

Narrowing only at the render layer leaves the full membership and edge set loaded, the components computed over all of it, and the cost fully paid. The three sets above must reach `loadLaneCheckScope`.

### Warning wording

A warning that reads like an obligation buys a round trip. Warnings carry, verbatim:

> `WARNING — informational; does not block commit. Do not call justify or delay commit. Add a stitch only if a truthful relation is already supported by the material you are processing.`

`commit` succeeds and carries the same typed warning on its receipt.

## Out of scope

**Relation-write read grants** (271 refusals in 7 days, the single largest category) are an operation-level precondition, not a lane_check finding and not a terminal error or warning. They are not touched here. The count is evidence of a teaching/prefetch ergonomics problem that deserves its own investigation — never an argument that the safety boundary is useless.

**The `justify` / disposition ledger** is RETIRED from the settlement path (user ruling S15069/T2278), filed as ticket 06. Old rows and the table go inert rather than being dropped; any future "a human confirms this split is deliberate" need returns as an operator-owned annotation, never as an obligation unattended settlement must discharge.

## What is deliberately given up

Once fractures stop blocking, nothing guarantees that a run which touched a severed lane stitches or explains it before the job completes. Island counts may grow and lane-recall narrative quality may degrade. This is the accepted trade-off of ruling T2274 and **must not be caught by another hidden gate**. What still protects the graph: E4/E6 keep edge structure legal, and the relation read grants keep relation writes based on current state. Dropping the compulsion also removes a failure mode of its own — fabricating a bridge to pass a gate.

## Testing Decisions

The load-bearing fixture is a FROZEN one: on a static database with no intervening write, the pair set `lane_check` previews, the pair set the commit gate blocks on, and the pair set `justify` accepts must be identical. The `justify` arm is HISTORICAL after ticket 06 retires it — it stays in ticket 01 because ticket 01 is a diagnosis of what already happened, and because the version-skew hypothesis it tests (the running worker was 0.27.0 while the repo is past 0.28.0) outlives the retirement. Everything else in this batch is judged at two existing seams — the `lane_check` rendered output and the terminal `commit` verdict — never on evaluator internals.
