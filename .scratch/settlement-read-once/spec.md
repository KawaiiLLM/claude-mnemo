# Settlement reads once, tags by topic, and writes edges without re-reading

**Status:** READY — peer verdict READY at round 10 (S15069/T2406) after nine NOT READY rounds (T2389–T2405), every finding verified against HEAD and absorbed. User rulings: T2385/T2386 (process, batch tags, topic-first, audit kept), T2388 (relations like timeline), T2393 (D0 outgoing-only; D5 freeze legacy), T2397 (retag A), T2404 (20/20 caps; delivered suffices). Tickets 0–7 published under `issues/`. Rev 10 status line for history:

## Problem Statement

A settlement run costs about $2.3 at API prices and reaches 200–230K tokens of context on a 50-turn window (jobs 170, 171 under 0.29.0):

| where the context goes | share |
|---|---|
| thinking, kept for the whole run because one prompt drives the whole tool loop | 32–35% |
| `recall` results — the window read 1.5–2×, in ten-turn batches, one batch per round trip | 25–30% |
| the model's own tool_use JSON | ~15% |
| `lane_check` (9K each), `finalize`, `commit` (5K each, ×3) reports | 10–15% |
| `note` results (77–109 calls) | 1% |

Cost is round trips × prefix. Stage 1 of job 170 was 29 API calls, 26 of them `recall` (15 ten-turn batches, 8 single-turn re-reads after truncation, 2 address lists) and 2 parallel `note` calls carrying 6 notes. The edge pass then read the same turns again for `relations` (4–5 list reads of 16–40 addresses) because step 1's field list never included it. On job 171 that field was EMPTY for every window turn — its 40-address relations read returned 2,320 tokens and zero relation lines (a first settlement of a window: edges point backward, none written yet). A retry, a re-settlement or a window with earlier edges would not be empty; the design does not depend on emptiness.

Four defects underneath, each verified at HEAD:

1. **The read route the prompt teaches as primary — `E<n>/S<a>/T<b>..S<c>/T<d>` — paginates by `pageSize` only, forwards no `fieldBudgets`, and grants all-or-nothing at page end** (`renderSegmentMemberOrdinals`, recall.ts ~2230–2288; segment-card.ts ~821–948). `prompt:50` is silently ignored on it; a page cut by the 100K-character envelope earns no grant for any member. Only the plain session range has rendered-cost pagination and per-field budgets.
2. **A cut is not named per field.** The whole-turn ladder renders metadata → content → prompt → insight → relations, cuts the first line that does not fit, drops every later field, and marks only the cut line (format.ts ~693–706, 1197–1289). The write-gate's completeness record covers gated fields only and cannot tell cut from dropped (format.ts ~135–167, 1337–1369).
3. **Not every mutator of a turn's outgoing edges stamps its relations revision.** `stampTurnRelationsRevision` is called from `note` and the settlement turn facade only; `mergeLaneTag`, `clearLane` (db/lanes.ts ~730–795, 1079–1120) and compact repair (hooks/capture-repair.ts ~230) rewrite or delete rows without it.
4. **Membership has two truths.** Task-tier `remember(create, members)` writes `segment_members` directly and adds no task tag (remember.ts ~491–546, ~1762–1769); lane-tier `create` ignores `members` (~420–439); task `retag` renames the container and leaves members' tags untouched by design (~1338–1341). Production, read-only 2026-09-02: 70 tasks, **66 with no task tag** (8 open) owning **185 member turns** (159 in open tasks); 98 members of NAMED tasks lack the tag on the turn; 0 foreign-task conflicts.

## Solution

**Stage 1 reads the initial writable set once**, through a route that paginates by rendered cost, honours per-field budgets, names per turn what it cut or dropped, and grants per member. Its field list is the union both stages need. Re-reads have exactly two causes: a field reported `cut`/`dropped`, and the delta `finalize` names.

**Stage 1 works topic-first**: list the window's topics; declare a lane where no synonymous lane exists; tag each topic's turns in ONE additive, all-or-nothing call; correct the titles/types/tags the audit caught (the minority); `finalize`.

**Stage 2 reads the finalize delta once** — the set difference between what finalize froze and what stage 1 already read, split by authority — then writes edges, runs `lane_check`, decides impressions, commits. The stage-1 `relations` grant carries: same `(job, generation)` writers are one principal (write-gate.ts ~107–145; `tests/worker/staged-settlement-grant-carry.test.ts`), and stage 1 writes no edges.

**The `relations` field becomes the turn's direct edge set** in the lane view's arrow grammar, from the full live rows, both lane sides shown raw, every relation atom rendered.

**Membership gets one primitive** — write tags, derive `segment_members` — shared by every path that moves membership; legacy ownership in the 66 unnamed tasks is frozen and read-only until a task is named, at which point it thaws into the single truth.

The round-trip projection (~51 → ~20 per run) is the HYPOTHESIS ticket 07 tests; it predates defect 1 and is not an expectation.

## User Stories

1. As the settlement writer, I want one read to deliver every field both stages use, so that I never pay a round trip to fetch what I already saw.
2. As the settlement writer, I want the response to say, per turn, which fields were `cut` or `dropped` — and NOT to flag a field I asked to be bounded — so that my only re-reads are real gaps, one field at a time.
3. As the settlement writer, I want the route I am taught to honour `fieldBudgets` and paginate by rendered cost, so that a page never silently overruns the envelope and loses its grants.
4. As the settlement writer, I want to declare a lane and tag its members by topic, in that order.
5. As the settlement writer, I want one call to add the same lane tag to every turn of a topic, so that N members do not cost N calls and N results.
6. As the settlement writer, I want a batch tag write to refuse whole and name every failing member, so that one repair call fixes the batch.
7. As the settlement writer, I want a batch tag write to ADD tags and never replace a set, so that each turn's `topic:` words survive.
8. As the settlement writer, I want a batch tag write to supply the task tag to a member that lacks it, and to refuse a member carrying another task's tag.
9. As the settlement writer, I want `finalize` to list the addresses that were NOT in my mandated initial sweep, split into what I may write relations on and what I may only read, so that stage 2 reads that list once and nothing else (a turn I chose to read early may appear again; that costs a re-read, never safety).
10. As the settlement writer, I want the edge pass refused when a turn's OUTGOING relation rows changed under me by any path, so that concurrency stays detected; incoming edges and lane qualifiers are advisory (D0).
11. As the settlement writer, I want the `relations` field to show this node's direct edges — outgoing first, then incoming, both raw lane sides, placed / half-settled / unplaced — and nothing downstream, so that I see how this node's edges stand and how they are placed; and I want to be allowed to write once I have seen it, not once a budget certifies I saw all of it.
12. As the user, I want stage 1 to keep auditing title, type and tags while it reads; edits are the exception.
13. As the user, I want the per-turn `note` unchanged for corrections.
14. As the user, I want every membership mutation AFTER cutover to go through one primitive (tags written, members derived), with the unnamed tasks' legacy rows as a read-only exception that thaws when the task is named.
15. As the operator, I want every teaching change pinned by a mutation-driven test.
16. As the operator, I want cost AND work equivalence measured before "cheaper" is believed.
17. As a reader of `timeline(id="S/T")`, I want the 3-hop tree kept there.

## Implementation Decisions

### D0. The gate fences the turn's OUTGOING rows; every mutator of them stamps (RULED, T2393; blocking prerequisite)

`checkRelationsGate` protects what it was built for: the rows a turn WRITES. A stage-2 relation write on X is refused when X's outgoing rows changed by another writer since this run's read. **What counts as "this run's read" (RULED, T2404): the turn's `relations` field was DELIVERED to this run after the turn's last relations stamp — delivered, not "delivered whole".** Mapped onto the EXISTING completeness row, no new column: `complete` → row(true); `cut` (some atoms rendered, budget stopped the rest) → row(false) — GRANTS; an empty set that was actually evaluated → row(true) — grants; `dropped` (the field never rendered a byte because the ladder ran out before it) → NO row — does not grant, because "dropped" is "not seen"; an envelope cut before the item's delivery offset → no row. The gate checks that a row exists with a sequence after the last stamp and IGNORES `complete`; staleness unchanged. Today's recorder writes `complete=false` for a wholly dropped gated field (format.ts ~1337–1368), so the relations-specific recorder that distinguishes cut from dropped SHIPS WITH the gate change in ticket 0 — never the relaxation alone. An older row after the stamp is not withdrawn by a later drop: the run did see the set. Tests: cut grants; dropped refuses; empty grants; a cut row followed by another writer's stamp refuses as stale. **Degree caps (RULED, T2404):** at most 20 outgoing atoms per citing turn and 20 incoming atoms per cited turn, enforced ONCE in the shared `attachTurnRelations` (both write faces already go through it) on PROSPECTIVE post-call counts: after address/legality dedupe, after the same call's retractions (which run before attaches), excluding restatements of atoms already stored; if any citer or cited would exceed 20, the whole call is refused by name with zero writes. Pinned cases: 19 outgoing + 2 new → refused whole; 20 + a restatement → succeeds as a no-op; 20 with retract 1 + attach 1 in one call → succeeds; a cited turn at 19 incoming + 2 new atoms → refused whole. Legacy rows never exceed the cap (production, read-only: max outgoing 18, max incoming 7, max total 20). With both caps a node's direct set is at most 40 atoms — the COUNT is bounded; rendered width is not (lane tags are canonical but unbounded in length), so the field's default budget is measured from the current widest atom, and a wider legal atom may still `cut`, which D2 reports and which does not affect the grant. The rendered field also shows incoming edges and `E<n>/#tag` qualifiers resolved from endpoints' CURRENT owning tasks; those are advisory — current at read, not fenced — and the field's legend says so in one clause. A task merge or membership change that re-resolves a qualifier does not stale a grant.

Ships first, alone, together with the delivery-not-completeness gate rule and the two degree caps: `mergeLaneTag`, `clearLane`, compact repair, AND turn/session deletion stamp `stampTurnRelationsRevision` for every citing turn whose outgoing rows they rewrite or delete, in the same transaction. Deletion is the case a trigger hides: `memory_edges_prune_deleted_turn` (schema.ts ~1796) removes surviving citers' `Y→X` rows when X is deleted — by a direct DELETE, a cascade, or any SQL path — so the stamp must live where the prune lives: **the trigger itself advances the relations revision of every surviving citer of `OLD.id`, writing the field stamp with a reserved writer id (`trigger:prune`)**, in the same statement sequence. No TypeScript path can bypass it, and "every mutator" is then literally true. Test: delete a cited turn by direct SQL → the surviving citer's stale grant is refused naming `trigger:prune`. Test per path (incl. delete a cited turn): grant → mutation → write refused as stale naming the path's writer; a task merge → NOT refused.

### D1. One read contract for every turn-rendering route

The segment-member routes (`E<n>/S/T..S/T`, `E<n>/T*`, `E<n>/#tag`) adopt the plain range's behaviour: `paginateByRenderedPageCost`, `fieldBudgets` forwarded, per-member ledger marks (a member is granted when ITS block was delivered whole). The prompt keeps teaching the task-scoped range as primary, and it now behaves as taught.

Fields: `title`, `metadata`, `content`, `prompt`, `insight`, `relations`. Budget contract, numbers taken at implementation:

- **Budgetable fields — `content`, `prompt`, `insight`, `relations`, `metadata` — each get a numeric `fieldBudgets` entry**; the even split is not relied on. `title` is NOT budgetable (the label line is never cut below the render cap) and enters the structural overhead at the render cap's cost (D1 `turn` line below).
- **Intent is part of the call**: `recall` gains `boundedFields: [<field>…]` beside the numeric budgets. A field listed there is read INTENTIONALLY short — reaching its cap is the contract, not a loss. Every other budgeted field is REQUIRED whole: its cap is a ceiling meant to hold the p95, and reaching it is a `cut`. Numeric budgets stay numeric; one extra list carries the bit. Settlement passes `boundedFields:["prompt"]`. Contract: `boundedFields ⊆ selected fields ∩ keys(fieldBudgets)` — a listed field without a numeric cap or not selected refuses the call naming it. **Gate semantics are unchanged by intent**: a bounded GATED field (`content`, `metadata`→type/tags) that was actually shortened still records `complete=false` in the write-gate ledger — bounded means "do not nag me", never "treat as read whole"; a bounded read of `metadata` therefore grants NO tag write. `relations` is NOT a bounded-able field: it is delivery-gated (D0), is refused by name inside `boundedFields`, and is absent from the legal enumeration. Test: `boundedFields:["metadata"]` with a cap that shortens → a tag write is refused as incomplete-read; `boundedFields:["relations"]` → refused by name. **Schema home is `recall` only**: `fieldBudgets` lives on the shared `MemoryFilterInput` that `timeline` also parses; `boundedFields` is NOT added there — it is a `recall` input, and `timeline` refuses it by name if passed.
- `prompt` stays at 50 and bounded — the user's opening words as topic ground truth, never authority text (the teaching already says this).
- `relations`: sized from the CAP — 40 atoms (20 out + 20 in) at the D8 renderer's CURRENT widest atom, so today's nodes render whole; a wider legal atom in future may cut, and a cut `relations` still grants (D0). `relations` is never in `boundedFields`. `content`, `insight`, `metadata`: p95 over the last 30 days of production; the ~5% longer ones are the `cut` re-reads D2 pays for, by design.
- `turn` = Σ field budgets + structural overhead (label at its RENDER cap, field labels, indentation, the worst-case D2 footer incl. `title cut`) + 10%. The label's cost is bounded **in the renderer**: a label longer than the render cap (N characters, chosen at implementation with room over the rubric's ~20-token teaching; production max today 173) is cut to N with a marker and reported as `title cut` in the footer — the one case `title` appears there. No write-side refusal is added: `note` titles stay unconstrained on both the public and the settlement schema, so no new eligibility predicate enters the product. The footer's "cannot cut itself" rests on the render cap, an invariant, not on an observed p100. If the sum exceeds `MAX_TURN_BUDGET` (5000), `content` takes the remainder and its p-target is reported as what fits.
- `pageBudget` explicit; turns/page = what fits under `MAX_PAGE_BUDGET` (25,000) and the 100K-character envelope with measured margin. **Go/no-go:** 15 turns/page requires `15 × turn + headers + footer ≤ 25,000`; if not met, the ticket reports the real turns/page and ticket 07's hypothesis is re-derived; nothing is squeezed.

### D2. Per turn, per field: `complete | bounded | cut | dropped` — reported in a footer that cannot cut itself

The renderer produces, for every rendered turn, its own structure over ALL selected fields (not derived from the write-gate ledger):

- `complete` — delivered whole;
- `bounded` — a field named in `boundedFields`, shortened to its cap: intentional, NOT actionable;
- `cut` — a REQUIRED field shortened, whether by its own cap or by the whole-turn ladder;
- `dropped` — never rendered.

Only `cut` and `dropped` appear on the item's `truncated:` footer, e.g. `truncated: content cut; insight dropped`. `relations` is reported like any other field, and the teaching draws D0's line: a CUT `relations` needs no re-read for writing (seen suffices); a DROPPED `relations` was never seen and must be read once before an edge write on that turn. The footer is a fixed element with RESERVED budget: its worst case (every budgetable field named plus `title cut`) is part of D1's structural overhead, subtracted before the body ladder runs, so a report can never cause a new cut; its bytes count in page cost, envelope and ledger end-offset. Teaching: re-read THAT turn with `fields:[<field>]` and a larger budget for it alone. Tests: a long content that drops `relations` yields the footer naming it and the single-field re-read grants; a prompt over 50 tokens with `boundedFields:["prompt"]` yields `bounded` and NO footer, and the SAME call without the list yields `cut`; with `turn = label + worst-case footer` and body allowance 0, the footer renders whole and both costs appear in page cost and ledger offset.

### D3. Stage 1 is topic-first

After the read: (1) list topics; (2) where no synonymous lane is declared, `remember(create, id="E<n>/#tag")` then the batch tag write (or `create` with `members`, which routes through the same primitive — D4); (3) existing lane → batch tag write; (4) per-turn `note` for the audit's corrections; (5) `finalize`. The audit (title, type, tags) is a duty of the read; edits are the exception; the teaching states both.

**A turn may belong to several lanes** (rubric: 一个节点可以属于多条泳道). A turn that serves two topics is hit by both topics' batch writes, and the additive union makes that the natural outcome — no special call. The teaching states the test for each membership separately: the turn's PRINCIPAL result serves that lane, not a mention of it; multi-lane is legitimate, over-tagging by mention is not.

### D4. One membership primitive; the batch tag write on `note` is one entry to it

**Primitive, with three explicit operations:** `normal` (every ordinary tag write, batch or single), `thaw-owner` (only the D5 retag transition unnamed→named), `forced-detach` (only task-tier `clear` and the explicit unhome). Under `normal`, a turn that has a FROZEN owner (a `segment_members` row of an unnamed task) REFUSES any write that would create membership in another task — "T is owned by unnamed E<u>; name it or detach first" — so a frozen turn can never end up in two tasks; only `thaw-owner` converts frozen rows into tagged membership, and only `forced-detach` deletes them. Task-tier `clear` on an unnamed task is therefore an explicit `forced-detach` (today it deletes through derive; the outcome is the same, the operation is now named and never implicit). The primitive: write tags onto N turns in one transaction → stamp the `tags` field for the acting writer (real or anonymous, exactly as the `note` path does today with `stampField(…,"tags",…)`; lane/task structural verbs raw-`UPDATE` tags today and stamp nothing) → derive `segment_members` from the tags → refresh whatever indexes/facets a tag write refreshes on the `note` path. Concurrency test: read metadata → another mutator changes the tags through the primitive → the first writer's whole-set tag write is refused as stale. **Every path that moves membership uses it**, and ticket 02 routes each of these, found by sweeping `deriveTurnSegmentMembership` and every direct `segment_members` write: the batch `note` tag write; single `note` tag writes; task-tier and lane-tier `create … members`; task `retag` (three transitions, D5); task merge (`segments.ts` ~2436, today via `reassignSegmentMembers`); lane merge / clear / retag; task-tier `clear` (`clearSegmentMembers`, `segments.ts` ~1994–2049, rewrites tags per turn); `resetTurnExtractionFields` (`turns.ts` ~450–488, strips freeform tags then derives); compact occupied-turn repair (`hooks/capture-repair.ts` ~198–234, replaces tags with two `compact:` tags and derives NOTHING — leaving old membership rows beside tags that no longer carry the task: the double truth in miniature, routed so the derive runs); the D5 migration. `reassignSegmentMembers` is deleted or made private to the migration, proven by a call-site sweep. A path left outside is named with its reason and its readers are shown to exclude it — no silent exemption.

**Frozen legacy ownership under every mutator (belongs HERE, ticket 2, not to the migration ticket).** Today `deriveTurnSegmentMembership` DELETES a turn's every `segment_members` row when it finds no task tag (segments.ts ~1020–1047), so a reset or a compact repair on a member of an unnamed task would silently destroy frozen ownership. Rule per operation: (1) derive never touches a membership row whose task has no tag — frozen rows are invisible to derive in both directions (never deleted, never created); (2) `normal` writes on a frozen member: reset / compact repair / lane clear PRESERVE the frozen row; a write that would add another task's membership REFUSES (above); (3) task merge with an UNNAMED source REFUSES ("name the source first"); (4) task-tier `clear` = `forced-detach`, deletes the frozen rows explicitly; (5) only `thaw-owner` (retag unnamed→named) converts them. **Stated plainly, not assumed:** structural readers (`getSegmentMemberTurnIds` and the verbs on it) have NO liveness filter today and RETURN frozen rows, including those of compacted or rewound turns (production: of the 185 frozen members, 1 compacted, 38 skipped/rewound); this spec keeps that behaviour — a frozen row is ownership history and is listed as such — and ticket 2 tests the structural readers, not only the recall display. Tests for each operation and each reader.

The batch form, fixed and **settlement-only**: it lands on `settlementTurnWriteInputShape` (the settlement facade's `note`), not on the public `noteInputShape` — every user story here is the settlement writer's, the public per-turn `note` stays exactly as it is (story 13), and no `crossSession` question arises because the settlement facade has no such parameter. Shape: `note(turns: [<S/T>…], task: "E<n>", addTags: [<lane tag>…])` — a tags-only write; any other content field beside it refuses; `turns` and `turn` are mutually exclusive. `task` is the explicit coordinate: the task tag that "rides along" is THAT task's; every `addTags` entry must be a lane declared in THAT task; a member already carrying a DIFFERENT task tag refuses the batch naming it; there is no per-member owner inference. No assignment verb exists (T2386). Per member: union (the `topic:` words stay); the task tag rides along when missing; a member carrying a DIFFERENT task tag refuses; every check a single tag write runs today (canonical word, lane declared in the member's task, metadata read grant, staleness). One bad member → nothing written, every failure named. Seeding never MOVES a turn between tasks (today's `reassignSegmentMembers` semantics end).

### D5. Legacy ownership frozen, name-before-grow (RULED (a), T2393) — and the retag lifecycle that keeps it true (RULED A, T2397)

At cutover (ticket 03): the 98 tag-less members of named tasks receive the task tag (idempotent). The 66 unnamed tasks keep their `segment_members` rows as **legacy ownership**: readable everywhere membership is read today, never extended — seeding into an unnamed task refuses ("name the task first"), a lane in an unnamed task takes no members, task-tier `create(members)` with empty `tag` refuses. The roster keeps `(unnamed)`.

Naming is where legacy meets the single truth, and HEAD's `retag` leaves members untouched by design ("Renaming does NOT re-derive existing members", remember.ts ~1338) — so without a rule, naming a frozen task recreates "named task with tag-less members" the day after cutover. This changes the public behaviour of `remember(retag)` on tasks that own members; **RULED by the user (T2397), option A** — all three transitions through the D4 primitive, atomically:

- **unnamed → named**: every frozen member of that task receives the new tag (the legacy rows thaw into the single truth; the task may grow from then on).
- **named → new tag**: every owned member's task tag is replaced by the new word.
- **named → null**: refused while the task owns any member (unnaming would mint new legacy ownership, which "never extended" forbids); `clear` first, explicitly.

Rejected alternative (B): keep `retag` container-only and require an explicit backfill call before a named-but-tag-less task may grow — one more manual step, and the bad state would exist between the two calls. Tests: each transition; a thawed task accepts a batch tag write; a task with members refuses unnaming; the `retag` receipt names how many members it re-tagged.

### D6. Stage 2 reads the finalize delta once — set differences, two authorities

`finalize` computes and prints two lists, defined as SET DIFFERENCES against what stage 1 read, never as source categories (a removed-side citer may already be in the initial writable set; a historical lane member may also be a window member):

- `writableDelta = frozenWritableIds − initialWritableIds` — turns stage 2 may write RELATIONS on (removed-side citers not already writable; note fields never).
- `contextDelta = ⋃ laneMembers − initialWritableIds − writableDelta`, deduplicated across lanes — read-only judgment material.

Stage 2 reads the union of both lists in ONE paginated sweep with the D1 field union — each address once, as many pages as D1 needs — then **reads nothing further** until the gate names a changed turn; it writes edges as before. Ticket 07 counts the delta's real page calls.

**Multi-lane citing turns and ruling 2 (one row per pair).** Stage 2 works the worklist lane by lane, so a turn in two worklist lanes is visited twice. A placement has TWO sides and the teaching names both: `tailTag` = the lane the CITING claim belongs to, `headTag` = the lane in which the CITED principal result is used. The writer decides `(tailLane, headLane)` for a pair ONCE, over the whole worklist, before writing it — never "first visit writes, second visit skips", which would let worklist order pick the placement. Row identity includes the lane sides, so a duplicate IS storable and `lane_check` has no duplicate-pair finding (`shared/lane-checker.ts` ~1405–1412 tolerates several placements per pair); this is a TEACHING rule, and the spec says so — a mutation pin proves the sentence ships, a fixture proves one sample obeyed. Tests: a fixture with one citing turn in two worklist lanes → exactly one qualified row for the pair in the DB; the same fixture with the two lanes' worklist order swapped → the same `(tailLane, headLane)`. The old "recall members with relations" / "before any edge write, recall the citing turn" sentences go. Tests: an address in the initial set never appears in either delta; a `contextDelta` member is read and a relation write on it is refused; a `writableDelta` member accepts a relation write and refuses a note-field write.

### D7. Out of scope, on purpose

Thinking (`noteSettlementMaxThinkingTokens` null; a third of context) and report-shaped tool outputs (`lane_check` 9K, `commit` 5K). Fewer round trips still re-read the accumulated thinking fewer times, so this batch's saving does not depend on them.

### D8. The `relations` field renders the turn's direct edge set

**Data source:** the full live relation rows of the turn, outgoing and incoming, whatever their lane sides (`getTurnRelationEdges`-class read) — not the lane view's adjacency, which shows only qualified, visible, tail-in-lane rows (timeline.ts ~6076–6143). Only the arrow notation is borrowed. Rows with `relation IS NULL` (prose text-references, called **bare** in this codebase) are not edges and do not render here.

Grammar — one block per turn, outgoing then incoming, one legend line per response, every row showing BOTH raw lane sides (each possibly empty; there is no reader context that could supply a lane):

- `word -> T<n> (#tail → #head)`; the same lane on both sides prints once, `(#lane)`; a cross-task side prints `E<m>/#lane`.
- `word -> T<n> (#tail → ·)` / `(· → #head)` — half-settled.
- `word -> T<n> [unplaced]` — relation-carrying row with both sides empty (the `''` sentinel). The canonical word is **unplaced**; not "draft", not "bare".
- `word1,word2 -> T<n> (#tail → #head)` — several relations on one pair ONLY when their lane sides are identical. Rows are grouped by `(other endpoint, tailTag, headTag)`, never by endpoint pair alone: storage identity is `(relation, tail_tag, head_tag)` and production holds 109 pairs with more than one side placement (e.g. `extends #a→#a` beside `indexes #b→#b`), which one suffix cannot carry without losing attribution. Different placements of one pair are separate rows.
- Incoming: `<- T<n> word (#tail → #head)`, same side rules.
- No `^`, no cross-page arrow, no hop expansion. Legend, once: qualifiers are the endpoints' CURRENT tasks, advisory (D0).

**Size (RULED, T2404).** A node carries at most 20 outgoing and 20 incoming edges — enforced at attach on both write faces, named refusals — so the direct set is ≤ 40 atoms and the field's default budget holds all of them at today's atom widths (D1). Outgoing atoms render first, incoming after; if a budget still cuts the field — a smaller caller budget, or wider legal tags than measured — D2 reports `cut` and the gate does not care (D0: delivered suffices). No pagination, no page ledger, no elision marker, no downstream hops: this node's edges and nothing else, in the lane view's grammar.

Grouping is the OUTER assembly's job (recall.ts ~3777–3820): one session header per session group, the legend once, every per-turn ledger end-offset preserved. The renderer never elides (no `+N more`): every atom of the ≤40 renders; a caller's undersized budget cuts and D2 says so. Acceptance counts relation ATOMS: a 20-out/20-in node at today's atom widths renders all 40 whatever the row folding, a pair with two placements renders two rows, the four cap cases above behave as pinned, a turn whose `relations` was delivered CUT passes `checkRelationsGate`, and one whose `relations` was DROPPED does not.

Consumers: `recall` (~897–904, ~2909–2915) and the segment card (~929–936) switch to the direct set; `timeline(id="S/T")` keeps `buildTurnRelationView`'s tree (~6608–6637). Tree tests rebind to the tree API; recall tests assert the direct set; the tool description (definitions.ts ~134) is rewritten.

## Testing Decisions

Seams: prompt text (mutation-pinned), the read routes (pagination, budgets, per-member grants, footer), `note` and the write gate (batch form), the membership primitive (every routed path), the edge mutators (stamps), `finalize`'s response (two set-difference lists), the renderer (direct set), the settlement transcript (measurement). The specific tests are stated under each decision above. Ticket 07 measures BOTH: cost (round trips per stage, `recall` calls per stage, delta reads, `cut` re-reads, peak context, dollars) and work equivalence against the baseline run on the same reset window (commit succeeds; title/type/tags audit coverage equal; lanes, members, edges, E4/E6 counts equal or explained). n=1 is directional; no percentage is claimed from it.

## Out of Scope

Thinking budget; report-shaped tool output sizes; the relations gate under v13; `timeline`'s missing field-completeness records; edge semantics, placement rules, the impression's form; naming the 66 unnamed tasks by hand.

## Tickets

0. **Gate changes** (D0): stamps on every outgoing-row mutator incl. the prune trigger with a reserved writer; the relations grant becomes delivered-since-last-stamp WITH the relations-specific cut/dropped recorder and its four tests; the 20-out / 20-in degree caps on prospective post-call counts in `attachTurnRelations` with the four pinned cases. Ships first; blocks 1–7.
1. **Read contract** (D1 + D2): segment-member routes paginate by rendered cost, forward `fieldBudgets`, grant per member; `boundedFields` (recall-only, subset rule, gate semantics unchanged); the render-side title cap and `title cut`; four-state report + reserved footer; budgets measured per contract; go/no-go; prompt taught. Blocked by 0, 6.
2. **Membership primitive** (D4 + D5): the primitive with its three operations and tag stamps; the settlement-only batch form; frozen-owner refusal; structural-reader tests; `create … members` routed at both tiers; task `clear`, `resetTurnExtractionFields`, compact repair, task merge routed; frozen-legacy rules under every mutator incl. task merge refusing an unnamed source; `reassignSegmentMembers` removed or migration-private; the three retag transitions (ruled A); the two new refusals. Blocked by 0.
3. **Cutover migration** (D5): the 98 tag-less members of named tasks receive the tag idempotently under a receipt; roster unchanged. The frozen-legacy semantics themselves ship in ticket 2. Blocked by 2.
4. **Topic-first stage 1 teaching** (D3). Blocked by 2.
5. **Finalize deltas + stage-2 teaching** (D6, incl. the one-placement-per-pair rule for multi-lane citing turns). Blocked by 1.
6. **Direct edge set in `relations`** (D8): renderer (outgoing first, lane view grammar, both raw sides), outer grouping, tool description, tests rebound. Blocked by 0; 1 takes its `relations` budget from the cap × measured atom width.
7. **Measure cost and work equivalence** on the reset window through the v13 harness (`scratchpad/v13ab/`). Blocked by 1–6.

## Further Notes

Measured facts (2026-09-02): stage-1 call profile (T2385); context decomposition (T2380); relations reads returning empty fields and degree distribution — mean 2.0, max 20, windows max 5–15 (T2387); unnamed-task counts (T2392, reproduced read-only); the relation tree bounded to 3 hops with a capped branch list. The ≤9-parallel-tools cache concern was tested and does not apply on this harness (T2379).
