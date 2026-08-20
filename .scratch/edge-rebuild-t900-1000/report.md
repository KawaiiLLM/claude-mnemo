# Edge rebuild — S15069 T900–T1000

**Date:** 2026-08-20 · **Writer:** `session:21460` · **Backup:** `edges-backup-2026-08-20.sql`

## Outcome in one paragraph

The window holds 101 turns: 96 with notes, 5 with none (T908, T917, T943, T967, T980),
4 rewound (T908, T956, T967, T980), 2 compact markers (T907, T944). I mapped 21
workflows and wrote **35 relation edges** (34 new pairs plus one upgrade of a legacy
`supersedes`), bringing the window to 36 relation edges over 42 total edges. **The
"unbroken chain" goal was not reached, and could not be**: the sanctioned write path
is budget-gated, and 54 of the 96 noted turns are already past the gate before I touch
them. This is finding A1 and it dominates everything else in this report.

## A1 first, because it bounds the rest

A relation parameter must ride a field written in the same call, and that field's
post-write state must contain the target address. The only field whose own contract
admits a citation is `content` ("…secondary conclusions, citations"). Live plugin
0.12.1 rejects any write that leaves `content` over 2× its 100-token budget:

```
Parameter error: content is 226 tok, over 2× its 100 tok budget (limit 200) — nothing stored.
```

The boundary is exactly 200 tokens inclusive — T999 and T942 both failed at 201 with a
19-character citation appended. Measured across the window's 96 noted turns:

| content size | turns | can carry an edge |
|---|---|---|
| ≤ 770 chars (~192 tok) | 42 | yes |
| > 770 chars | 54 | **no** |

So more than half the window is unwritable for reasons that have nothing to do with
whether the edge is legal, true, or useful. The carrier is full.

Three things make this worse rather than incidental:

1. **The gate was already retired** at repo HEAD by the field-semantics ticket
   ([S15069/T1074]) — `src/shared/note-budget.ts:71-86` says the 2× rejection is
   "RETIRED outright" and replaced by a 1.5× receipt warning. The live plugin predates
   that. So the blocker is pure version drift, and one reload dissolves it.
2. **The overage is self-inflicted by the same system.** `note-budget.ts:8-9` records
   that "measured on S15069, sixteen consecutive notes ran 1.5×–2.5× over". Those are
   these notes. The extraction pass wrote them over budget, and the write gate now
   refuses to let anything else be added to them.
3. **The other two fields are worse homes.** `title` (limit 40 tok) is the index
   surface and is already at 13–26 tokens; `insight` (limit 120 tok) is empty on 91 of
   96 turns and carries an episode-deletion contract that a bare pointer sentence fails.
   I declined to write pointer text into either — polluting 54 insight fields to satisfy
   a validator is the kind of trade the rubric exists to prevent. **This is the one
   decision in this task I made unilaterally and would hand back**: if you want the
   chains closed before a reload, the honest route is to *trim* the oversized contents
   (they are 1.5–2.5× over by the system's own measure), not to relocate citations.

## Workflow map

21 arcs. `→` is chronological order within the arc; **bold** marks turns whose edge
landed; ~~struck~~ marks turns blocked by A1.

| # | Workflow | Members |
|---|---|---|
| W1 | Repair-ticket triage against the two landed specs | ~~T900~~ → ~~T901~~ → ~~T902~~ → ~~T903~~ → ~~T904~~ → ~~T905~~ → **T906** |
| W2 | Repair batch closeout | ~~T905~~ → **T911** |
| W3 | Session-field redesign | T909 → **T910** → **T912** → **T913** |
| W4 | Rewind-marking diagnosis | T914 → **T915** |
| W5 | Recall-view diagnosis → view spec | ~~T916~~ → T918 → ~~T919~~ → **T920** → ~~T921~~ |
| W6 | Spec peer review + reconciliation | **T922** → **T923** → ~~T924~~ → ~~T926~~ → **T927** |
| W7 | Annotation-worker operations | T925 → **T928** |
| W8 | Edge-ownership ticketing and waves | **T929** → ~~T930~~ → **T931** → ~~T936~~ → ~~T942~~ → *T943(skipped)* → ~~T945~~ → ~~T946~~ |
| W9 | Relation vocabulary + rubric | **T932** → ~~T933~~ → ~~T935~~ → **T937** → ~~T938~~ → **T939** → **T940** → **T941** |
| W10 | Stale-plugin title-prefix correction | T934 |
| W11 | Batch peer review → fix | **T947** → ~~T948~~ → T949 *(edge pre-existed)* |
| W12 | Read-write-contract gate design | T950 → ~~T951~~ → ~~T952~~ → ~~T953~~ → **T954** → **T955** → *T956(rewound)* → **T957** → **T958** → **T959** |
| W13 | Spec peer review + amendments | **T960** → ~~T961~~ → ~~T962~~ |
| W14 | Settlement trigger retarget | ~~T963~~ → **T964** |
| W15 | Read-write-contract implementation | ~~T965~~ → **T966** → **T970** → **T971** → **T972** → **T973** → ~~T974~~ → ~~T976~~ → ~~T982~~ → ~~T984~~ → ~~T985~~ → ~~T989~~ → ~~T992~~ → ~~T996~~ |
| W16 | SessionStart injection and cadence | ~~T969~~ → ~~T977~~ → ~~T978~~ → ~~T979~~ → **T981** |
| W17 | Hook-slot collapse fix | ~~T990~~ → ~~T991~~ → **T993** |
| W18 | Commit peer review round two | ~~T983~~ → ~~T999~~ → ~~T1000~~ |
| W19 | Filter contract and stale skill docs | T986 → ~~T987~~ |
| W20 | Milestone anchoring / fourth key | ~~T994~~ → ~~T995~~ |
| W21 | Release 0.12.0 | ~~T997~~ → ~~T998~~ |
| — | Standalone | T968 (parallel-call rule), ~~T988~~ (pi-hermes research) |

## Edges written

35 relations across 34 calls (T959 and T971 each carry two).

| citing → cited | relation | citing → cited | relation |
|---|---|---|---|
| T906 → T900 | refines | T947 → T946 | depends-on |
| T910 → T900 | refines | T954 → T953 | refines |
| T911 → T905 | depends-on | T955 → T954 | refines |
| T912 → T910 | refines | T957 → T955 | refines |
| T913 → T912 | refines | T958 → T957 | **override** *(upgraded from legacy `supersedes`)* |
| T915 → T914 | grounded-on ‡ | T959 → T954 | encodes |
| T920 → T919 | refines | T959 → T958 | encodes |
| T922 → T921 | refines | T960 → T959 | depends-on |
| T923 → T922 | encodes | T964 → T963 | grounded-on |
| T927 → T926 | refines | T966 → T965 | encodes |
| T928 → T925 | depends-on | T970 → T966 | depends-on |
| T929 → T927 | refines | T971 → T964 | encodes |
| T931 → T930 | depends-on | T971 → T966 | depends-on |
| T932 → T930 | depends-on | T972 → T970 | depends-on |
| T937 → T935 | refines | T973 → T972 | grounded-on |
| T939 → T938 | refines | T981 → T979 | refines |
| T940 → T939 | encodes | T993 → T991 | depends-on |
| T941 → T935 | evidence-against | T1001 → T1000 | depends-on † |
| | | T1001 → T999 | depends-on † |

† Out of the authorized T900–T1000 range by one turn, written under a later explicit
ruling: T1001 is the 0.12.1 release and W18's true drain point (see Drainage below).

‡ Subsequently revised by another writer. Written here as `grounded-on` — the
least-wrong legal option, and an inverted counterfactual (A4). It now reads `refines`,
after T914 gained a `discuss` type so a decision-phase target existed. The A4 case
record stands: the mechanism gap is real, this instance just had a clean escape.

Final distribution: refines 15, depends-on 13, encodes 6, grounded-on 2, override 1,
evidence-against 1.

Distribution: refines 14, depends-on 11, encodes 6, grounded-on 3, override 1,
evidence-against 1.

### Rejections (3 calls, all the same cause)

| call | result |
|---|---|
| T901 refines T900 | content 226 tok > 200 — nothing stored |
| T999 depends-on T998 | content 201 tok > 200 — nothing stored |
| T942 depends-on T936 | content 201 tok > 200 — nothing stored |

No call was ever rejected for *illegality*. Every legality problem I met was
resolved before the call, by changing the relation or abandoning the edge — which is
why the rejection log is thin and Analysis A is not.

### Type additions

| turn | added | why |
|---|---|---|
| T915 | `correction` | It corrected both of T914's readings; `measure` alone left it with no legal edge to any predecessor. Rubric-supported ("纠正此前错误的结论"). |

No note was written for any skipped turn. T943 (the tickets 05+06 worker report) does
carry chain-bearing content, but its successor T945 is blocked by A1 anyway, so writing
a note there would not have closed anything — "能绕则绕" applied.

## Analysis A — what the edge design cannot express

Ordered by how often the window hit them.

### A2 · Delivery→decision has exactly one word, and it asserts artifact-carrying

`encodes` is the only legal relation from a delivery-phase turn to a decision-phase
one, and it means "my artifact carries that decision". Plenty of turns are *caused by*
a decision without carrying it. T902 takes stock of which repair tickets the two landed
specs superseded — caused by the specs, encoding nothing. There is no
"responds-to / derived-from" word, so the turn stays an orphan even though its
predecessor is obvious to any reader. Same shape at T903, T904, T918, T977, T986.

### A3 · `grounded-on` is direction-locked, so delivery turns cannot say what they rest on

The seventh relation exists precisely to let a decision name the finding beneath it —
but its source must be decision-phase. A **review or measurement** that rests on an
earlier measurement has nothing. T918 (review: eleven lived-experience view problems)
rests on T916 (measure: the E31 render on a production clone). `evidence-*` needs a
decision target; `depends-on` needs both ends in delivery and `measure` is
evidence-phase; `grounded-on` needs a decision source. Three near-misses, no word.

### A4 · Correcting a bad *reading* is inexpressible

`override`/`refines` require decision phase at **both** ends. T915 overturned T914's two
misdiagnoses; T914 is typed `review` only. I added `correction` to T915 so it had a
decision phase, but the target still could not take `override`, so the edge went in as
`grounded-on` — which inverts the counterfactual. `grounded-on` claims "if T914 were
false, T915 falls"; the truth is "T914 *was* false, which is why T915 exists". The
stored edge asserts the opposite of what happened. Identical shape at T990→T989
(the hook-slot fix overturning the ticket-14 acceptance) — there I left it unwritten
rather than store an inversion.

### A5 · One relation per (citing, cited) pair

The primary key is `(citing_kind, citing_id, cited_kind, cited_id)`, so a pair holds
one relation. T971 both commits T964's ruling and follows T966's dispatch — expressible
only because those are two different targets. Where both readings land on the same
pair, one is silently discarded by "先中先得". T959 encodes T954 and T958; had T958 also
been its process predecessor, the `depends-on` would have been unrecordable.

### A6 · Legality reads an editorial field, so a metadata gap becomes a graph gap

Phase legality is computed from the stored `type` array. T900 wrote the merged ownership
spec but is typed `design` only; under the rubric's own gloss ("纯转写 spec = ops,兼有新
裁决 = design+ops") it should carry `ops`. Because it does not, `T902 depends-on T900`
is illegal — the edge is blocked by how completely the extractor typed a turn a hundred
turns earlier. Fixing edges therefore means editing history, and every such edit is a
judgment the validator cannot check.

### A7 · No forward edges, so a prediction and its confirmation look identical

T995 pre-registers the expected differential for the fourth-key proposal in T994 — the
pre-registration *is* the load-bearing act. It can only point backward at T994. When the
anchoring eval eventually runs, that evidence turn will also point backward at T994.
Nothing in the graph distinguishes "I predicted this before measuring" from "I measured
it afterwards", which is exactly the property that makes a pre-registration worth
anything.

### A8 · Compact turns are outside every phase set

T907 and T944 are typed `compact`, which appears in no phase class, so they can be
neither source nor target. They sit inside W1/W3 and W8/W9 respectively and carry the
session's own summary of the arc they interrupt. Two structural holes in the middle of
two chains, by construction.

### A9 · The rollback marker and the override edge disagree about the casualty

T956 is `was_rolled_back=1` and may only be cited as a victim. But nothing overrode
T956 — its live twin T957 (same prompt, re-run) is what T958 overturned. So the graph
records `T958 override T957` while the rewind flag points at T956. A reader asking
"which turn was withdrawn" gets two different answers from two mechanisms.

### A10 · Mentions are not relations, and cannot become them

The window carries 38 `text-ref` edges. Six of the pairs I wrote were already text-refs
and upgraded cleanly by upsert. The remainder — including 25 edges from segment E48
citing window turns — carry `relation IS NULL` forever: the citation extractor sees an
address in prose and has no way to ask what kind of debt it is.

### A11 · The write path cannot express "this edge is retroactive"

`provenance` distinguishes `text-ref` / `judged` / `asserted` / `retrieval` / `rollback`,
and every edge I wrote landed as `asserted` — indistinguishable from an edge the turn's
own author wrote at the time. A whole-window retrospective reconstruction and a
first-hand citation are the same row.

## Analysis B — what this graph shape does to milestone election

Election scores only `encodes` / `refines` / `override` (`RELATION_IS_SCORED`),
`grounded-on` is recorded but unscored, and the sort is encodes-count → refines-excess
→ recency.

### B1 · No delivery turn can ever be elected — this is structural, not a timing lag

The working hypothesis was that a workflow terminus (a release, a batch close) writes
its note before anyone cites it, so its in-edges arrive too late. **The graph says the
mechanism is different and worse.** All three scored relations require a
**decision-phase target**: `encodes` points at design/discuss/correction by definition,
`refines`/`override` require decision phase at both ends. Therefore a turn typed
`implement`/`fix`/`review`/`ops`/`delegate`/`measure`/`research` — with no decision
type — cannot accrue a single scored in-edge *ever*, no matter how long you wait or how
many successors cite it.

In this window that permanently excludes, among others:

| turn | what it is | scored in-degree |
|---|---|---|
| T998 | 0.12.0 ships — seven version sites, green suite | 0, forever |
| T946 | ticket 08 verified, eleven-ticket batch closes at 504adc9 | 0, forever |
| T996 | ticket 10 lands, fifteen-of-fifteen batch closes at 9fd1bdb | 0, forever |
| T930 | the annotation experiment that *chose the ranking formula* | 0, forever |
| T990 | one-slot-one-block fix (6d106fb) | 0, forever |
| T911 | eight-ticket repair batch verified and committed | 0, forever |

Waiting does not help them. Writing more edges does not help them. Only the four
`depends-on` and `grounded-on` edges point at them, and both are unscored.

### B2 · The one relation that can point at a fact is the one that is not scored

`grounded-on` is the sole relation whose target may be evidence- or delivery-phase. It
is excluded from scoring. So the design has exactly one instrument for "many decisions
stand on this fact", and it is disconnected from the selector. T994 reached this
conclusion by reasoning; the rebuilt graph gives it a number — of my 35 edges, the 3
`grounded-on` and 11 `depends-on` (40%) are the only ones pointing at evidence or
delivery, and all 14 are invisible to election.

### B3 · The primary key does not discriminate; recency is the real sort

Scored in-degree over the whole rebuilt window:

- `encodes` in-degree = 1 for exactly six turns (T922, T939, T954, T958, T964, T965),
  0 for every other turn in the window.
- `refines` in-degree = 2 for T900, 1 for eleven turns, 0 for the rest.
- `override` in-degree = 1 for exactly one turn (T957) — and T957 is the *wrong-frame*
  turn, i.e. the one deliberately overturned.

A six-way tie at the top of the primary key means the primary key decides nothing; the
secondary key separates one turn (T900); everything after that is resolved by
timestamp. This reproduces the earlier null result — when 93–100% of candidates tie,
the "tiebreaker" is the actual ranking function.

### B4 · Election rewards being *superseded*

T957's only distinction is that it was overturned. Under encodes-then-refines-excess it
outranks T958, the turn that corrected it, because `override` in-degree is counted on
the **victim**. The milestone corrector-promotion rule exists to fix exactly this for
one case, but the general shape survives: in-degree measures *being talked about*, and
being wrong is a reliable way to get talked about.

### B5 · The graph is chains, not hubs, so there is nothing to centralise on

Max in-degree in the window is 2 (T900). 21 workflows produced 35 edges — a mean of
1.7 per arc, mostly `refines` ladders where each turn cites exactly its predecessor.
A selector designed to find hubs in a citation network is being handed a set of paths.
The A1 blocker makes this worse (54 turns could not cite anything), but even the fully
written arcs — W12's ten-turn gate-design chain — are linear: T953→T954→T955→T957→T958,
each with in-degree 1.

### B6 · What would actually change the ranking

1. **Score `grounded-on` in-degree** as a fourth key, as proposed at T994. It is the
   only key that can lift a measurement or a fix.
2. **Let a terminus be elected on out-degree, not in-degree.** T996 *encodes* fifteen
   tickets' worth of decisions; T998 encodes the release. Out-degree is available the
   moment the note is written and needs no successor.
3. **Do not count `override` on the victim** without the corrector-promotion rule
   applying generally.

Points 2 and 3 are cheap; point 1 is the one with a pre-registered validation set
already sitting in `.scratch/anchoring-eval/test-points.md`.

## Drainage — chains reaching a release

Added after the topology goal was set: the ideal shape is *idea (discuss, a legal
orphan root) → design refinement (refines/override/grounded-on) → landing (encodes) →
a release ops turn collecting what it delivered*.

### The window has one release turn, not two

- **T998** — 0.12.0 ships (c32d6a5), bumped from the unshipped 0.11.2. Everything
  committed in this window therefore shipped in this one release.
- **0.12.1 is T1001**, one turn past the window ("Peer round-two fixes landed and
  0.12.1 shipped before any reload ran", release db6cf26). Its content is 441
  characters — ample budget headroom, unlike T998. Crossing the range by one turn was
  ruled in afterwards, and W18 now drains into it:
  `T1001 depends-on T1000` (the round-two findings it fixed) and
  `T1001 depends-on T999` (the review that produced them). Note what could **not** be
  written even here: the user's order for the three fixes and the patch release lives
  at T1000, which is typed `review`+`measure` — no decision phase — so the release has
  nothing it may legally `encodes`. Even a release with budget to spare can only record
  process causality, never the ruling it carries (A2 again).

### Drainage statistic: 20 landing turns, 0 collected

Landing turns in the window (delivery turns that committed an artifact):

> T911, T936, T942, T943*, T945, T946, T949, T970, T971, T972, T974, T976, T982,
> T984, T985, T989, T990, T992, T996, T998 — 20 turns (*T943 has no note).

All twenty shipped in 0.12.0. **Zero are collected by T998.**

| workflow outcome | count |
|---|---|
| chains drained into a release turn | **1 / 21** (W18 → T1001, out of window) |
| chains that reached a landing turn but were never collected | 6 (W2, W8, W11, W15, W17, W19) |
| chains still on a decision with no in-window landing | 9 |
| ops-only / standalone arcs | 5 |

The cause is single and mechanical: **all drainage edges live on the release turn**,
because the release is the citing side and its targets precede it. T998's content is
796 characters. A bare `[S15069/T996]` — 13 characters, no prose — pushes it to 202
tokens against a 200-token ceiling. **The one turn that must carry the entire window's
drainage is three tokens too full to carry any of it.** There is no partial workaround:
a landing turn cannot cite the release instead, because that edge would point forward.

The `title` field would fit (T998's title is ~19 of a 40-token budget), and one address
appended to one title is a far smaller pollution than the 54 insight fields A1 ruled
out. **Ruled against**: a title is the index surface every browse and roster render
shows, its contract is one claim sentence, and polluting a durable index to route
around a budget gate that HEAD has already retired and one reload removes is the wrong
direction. T998's drainage edges belong to the same post-reload pass as the other 54
blocked notes, under the same mechanical criterion (content > 770 characters).

## B7 · Would terminus discipline plus the current selector surface a release?

**No, and the discipline pushes the ranking the wrong way.**

`src/db/edge-signals.ts` aggregates exclusively by `e.cited_id` (lines 159-207: three
queries, all `GROUP BY e.cited_id` / `WHERE e.cited_id IN (…)`). Out-degree is never
computed anywhere in the selector. So a release turn that dutifully writes twenty
collecting edges gains twenty units of a quantity no key reads.

Worse, trace where those edges *do* land:

- A release's `encodes` edges must target decision-phase turns (B1). Writing them adds
  `encodes` in-degree to design turns — the class that already monopolises the primary
  key.
- A release's `depends-on` edges to landing turns are legal but **unscored**, so the
  twenty landing turns gain nothing rankable.
- The release turn itself gains nothing at all.

So terminus discipline, faithfully executed, makes the already-winning class win by a
wider margin, leaves the delivery layer exactly as invisible as before, and never lifts
the release. It is worth doing for **readability** — a human or an agent tracing "what
shipped in 0.12.0" gets a real answer — but it is not a substitute for a
must-keep set, and it does not remove the need for B6's fixes. Of those, B6.2
(score out-degree, or treat a release's `encodes` fan-out as its own key) is the one
this goal makes urgent: it is the only change that converts terminus discipline into
selection power.

## What is left undone

- 54 turns still have no outbound edge, all blocked by A1 — including **T998**, whose
  drainage edges would collect all twenty of the window's landing turns. The list is
  derivable: every turn in the window whose `content` exceeds 770 characters.
- After a plugin reload onto a build carrying the [S15069/T1074] budget retirement,
  those 54 become writable and the chains can be closed in one more pass. T998 is the
  highest-value single write in that pass.
- T990→T989 was left unwritten rather than stored as an inverted `grounded-on` (A4).
- No note was written for skipped T943 (see "Type additions").
- A11 (a retrospective reconstruction and a first-hand citation both land as
  `asserted`) is recorded as an accepted cost, not a defect to fix.
