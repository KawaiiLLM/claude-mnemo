# 06 — Retire the justify / disposition ledger from the settlement path

**What to build:** the `justify` / disposition ledger leaves the settlement path. **RULED: RETIRE** (user, S15069/T2278).

**Blocked by:** 04 — fractures must already be warnings before their disposal machinery is removed.

**Status:** REPORTED — all boxes done.

## The decision, as ruled

Once a fracture is a warning, the disposition ledger's only substantive consumer is gone. The user ruled RETIRE on 2026-09-01. The rejected alternative was keeping it as a way to silence a warning permanently.

The reasoning of record:

1. Its only correctness consumer was the terminal gate; what remains is a duplicate-reason anomaly signal.
2. A bounded warning leaves the reporting window on its own as the window advances — permanent silencing is not needed.
3. Keeping it means continuing to maintain fingerprints, the run-touch ledger, component coverage, representative full-text delivery, freshness and content sequences with no correctness consumer — accidental complexity by the project's own standard.
4. Keeping the ledger but deleting its read grants is WORSE than either: a persistent semantic judgment with no evidence requirement is unevidenced permanent concealment. Those grants exist because of earlier rulings (S15069/T1950, T1961, T1967; S21460/T234), and 400+ of the last week's refusals are the price they charge.

The argument that did NOT win, recorded because it may return: a deliberate split is a real judgment a human may want on the record, and the 400+ refusals are an ergonomics cost rather than proof the evidence boundary was wrong. If that need reappears it comes back as an operator-owned annotation, never as an unattended-settlement obligation.

## What retiring does NOT do (ticket 01)

Retiring `justify` removes the only second opinion that ever CONTRADICTED the gate — it does not remove the phantom fractures themselves. Ticket 02 owns that. Do not let this ticket be read as the fix.

## The work

- [x] Remove the write entry point, the terminal consumer, the `justify` source in run-touch tracking, and the duplicate-reason warning.
- [x] **The `justify` touch class must go with it, and the leftovers must be handled.**
- [x] Old rows and the table go INERT rather than being dropped in this batch — no destructive schema change on production data.
- [x] Any future "a human confirms this split is deliberate" need becomes an OPERATOR-owned annotation, designed separately.
- [x] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.
- [x] Report what the retirement actually removed, in lines and in call sites, and confirm by query that no remaining code path can refuse a settlement call over a fracture.

---

## What was removed

**+335 / −1099 in `src`, +743 / −2137 in `tests`.** Four removals, in the ticket's own order.

### 1. The write entry point

`src/worker/note-settlement-membership-facade.ts` (−491): `evaluateJustify` and its five
helpers (`turnAddressFor`, `reasonNamesAddress`, `OVERSIZE_PAGE_HINT`,
`splitObligationByEraVisibility`, plus the fingerprint match) are gone;
`SETTLEMENT_LANE_ACTIONS` is three words; the input shape loses
`representative`/`otherRepresentative`/`reason`; the outcome loses `justify?`; the
receipt renderer loses its branch. Fourteen imports fall away with it —
`loadLaneCheckScope`, `checkLanes`, `computeLaneFractures`,
`computeComponentFingerprint`, `recordLaneDispositionJustification`,
`hasAnyLaneReadReceipt`, `unreadLaneMembers`, `resolveEraCutoff`,
`chronologicalSegmentMembers`, `getTurn`/`getTurnById`, `parseTurnAddress`,
`checkTurnLiveForWrite`, `checkCompleteReadFreshness`, `claimWriterId`,
`getFieldStamp` — and with them the `context` PARAMETER of
`evaluateSettlementMembershipWrite` (`justify` was its only reader), so the facade
now takes `(db, input, nowEpoch)`.

`justify` joins `RETIRED_SETTLEMENT_MEMBERSHIP_VERB_REPLACEMENT` — this project's
standing retirement shape. It is the only entry there whose sentence names no
replacement call, because there is none: it names the obligation that no longer
exists.

**The tool went with the action, on the edge pass.** `justify` was stage 2's ONLY
legal `remember` action (`create`/`delete`/`merge` were already refused at the
toolset), so `remember` is no longer registered by
`createNoteSettlementSdkQuery` and is out of `SETTLEMENT_ALLOWED_TOOLS`;
`SETTLEMENT_REMEMBER_TOOL_DESCRIPTION` is deleted. The UNIFIED dispatch keeps its
`remember` (its topic pass still mints and removes lanes) and refuses every call
in the edge origin, unconditionally rather than by denylist.

### 2. The terminal consumer

`src/worker/note-settlement-sdk-query.ts` — `evaluateLaneDispositionGate` no longer
calls `checkLaneDispositionJustification`; the `fresh` skip and the
`stale`/`none` refusal texts are gone. `blocking.push` stays reachable (ticket 04
decision 9) with a text that names a stitch and nothing else.

`src/db/lane-disposition.ts` (−320): `LaneDispositionJustification`,
`recordLaneDispositionJustification`, `checkLaneDispositionJustification`,
`laneRepresentativeContentSequence`, `MovedJustificationEvidence`,
`LaneDispositionJustificationStatus`. Plus the two lane-read-receipt READERS —
`hasAnyLaneReadReceipt`, `unreadLaneMembers`, `renderedLaneMembers` — whose only
caller was justify's read obligation.

### 3. The `justify` source in run-touch tracking

`src/worker/note-settlement-direct-write.ts` — the `recordLaneTouch({kind:"lane"})`
inside `writeMembership`'s transaction and the in-memory `touchedLaneKeys.add`
beside it. `writeMembership` now records NO touch at all: `create`/`delete`/`merge`
never were touch sources. `lanesJustified` leaves the commit counts, the metrics
summary line and `note-settlement-child.ts`'s required-field list.

Touch sources: **five → four**. Every one that remains is a write to the GRAPH,
so `touched` now implies `wrote at a member of the lane`. Ticket 01's finding —
job 166's gate armed ONLY by `lane|60|execution-repair`, a row `justify` itself
had written — is recorded verbatim at all three sites that used to depend on it
(`db/lane-disposition.ts`, `db/schema.ts`, `note-settlement-direct-write.ts`).

### 4. The duplicate-reason anomaly warning

`computeDuplicateReasonRate`, `DUPLICATE_REASON_MIN_SAMPLE`,
`DUPLICATE_REASON_ANOMALY_RATE` and the `segmentsSeen` loop that emitted it.

## What happens to the rows already on disk — the ticket's explicit question

**Nothing is deleted, and nothing can be.**

- **`lane_disposition_justifications`** — INERT. No writer, no reader. The
  `CREATE TABLE` stays in `db/schema.ts` (removing the declaration would make the
  schema file disagree with every existing database without dropping anything),
  carrying a comment that says so.
- **`lane_run_touches` rows of the `lane` kind written by a justify** — THEY STAY,
  and they are **indistinguishable**. The table has no column recording which verb
  wrote a row, and a tag REMOVAL legitimately writes the identical shape, so there
  is no predicate to filter on and no honest migration. What they still do is
  bounded to one line: the JOB that wrote them (the ledger is job-scoped), if it is
  ever re-dispatched, still counts that lane as touched and still gets its
  fractures listed in the LANE DISPOSITION **warning** block. Since ticket 04 that
  block refuses nothing, asks for nothing, and cannot be discharged or silenced. A
  stale row costs a warning line on one job where it used to cost an unsatisfiable
  gate.

## The criterion: no path can refuse a settlement call over a fracture

Not a reading — a three-step query, run at HEAD-of-branch:

```
$ grep -n "blocking.push" src/worker/note-settlement-sdk-query.ts
1208:      blocking.push(          # evaluateLaneDispositionGate — fractures
1391:      blocking.push(error);   # classifyEvaluationErrors — grammar errors only (E3/E4/E6)

$ sed -n 1196,1200p src/worker/note-settlement-sdk-query.ts
        fractureWarnings.push(`${fractureText} (stitch target)`);
        continue;                 # taken whenever the rule answers "warning"

$ grep -n -A2 'case "lane-fracture":' src/worker/note-settlement-finding-class.ts
123:    case "lane-fracture":  124-      return false;   # condition 1
148:    case "lane-fracture":  149-      return (...)    # condition 2
202:    case "lane-fracture":  203-      return false;   # condition 3
```

Line 1208 is the ONLY producer of a fracture-derived blocking line, and it sits
behind `findingClass !== "warning"`. `classifySettlementFinding` is the
conjunction of the three conditions above, and two of the three return a literal
`false` for `lane-fracture` with no context read. The bucket is therefore
provably empty, and the four `disposition.blocking.length > 0` refusal branches
(2 commit, 2 lane_check) are unreachable by the rule — kept deliberately, so the
demotion stays a property of the rule.

Runtime confirmation at the real seam:
`bun test tests/worker/note-settlement-sdk-query.test.ts -t "commit SUCCEEDS on a SEVERED touched lane"` → **1 pass**.

## The trap ticket 03 handed me, and the control that replaced it

`tests/worker/settlement-one-evaluator.test.ts` proved "this lane really is severed
AND this run really touched it" with a landed `remember(justify)` — the verb only
accepted a CURRENT fracture (severed half) and recorded a lane touch of its own
(touched half). Retiring it would have removed BOTH halves and left the fixture
passing while asserting nothing.

Replaced by two controls, one per half:

1. **Severed** — `wholeLaneFracturePairs()`: `loadLaneCheckScope({kind:"lanes"})` +
   `checkLanes` + `computeLaneFractures`, i.e. exactly what `justify` built
   internally, taken before the run and re-taken after it (asserted equal, so the
   touch write provably moved no topology).
2. **Touched** — a real EDGE SIDE: `w2 --grounds--> o4`, `window-lane` on the tail
   and `outside-lane` on the head. `o4` is a member of the lane's islands, so
   `loadRunLaneTouches(db, job.id).turnTagPairs` holds `o4:outside-lane` — the
   exact predicate the gate resolves a touch through. The edge is not one of
   `outside-lane`'s OWN edges, so it stitches nothing. This is production's own
   touch shape, and the one job 166's ledger should have held instead of a
   self-arming justify row.

**Mutation proof, run:** the disposition block re-computed UNPROJECTED inside the
`lane_check` handler (ticket 03's own mutation, reconstructed) →

```
1 fail — expect(laneCheckText).not.toContain("LANE DISPOSITION")
Received: … "## Report 2 … Lane E3:{window-lane} - components: 1 (healthy)" …
          "LANE DISPOSITION — 2 severed fracture(s) in lane(s) this run touched:
             [LANE-DISPOSITION] E3 lane "outside-lane" — severed fracture S1/T1 <-> S1/T4
             [LANE-DISPOSITION] E3 lane "outside-lane" — severed fracture S1/T4 <-> S1/T6"
```

Report 2 says nothing about `outside-lane`; the block below names two fractures
in it — job 166's disagreement, reproduced. Mutation reverted; 3 pass.

`tests/worker/lane-fracture-agreement.test.ts` (ticket 01's) got the same
treatment: arm 3 was `remember(justify)`'s refusal text, and it is now the same
whole-lane projection computed directly. The spec's "the `justify` arm stays in
ticket 01" is honoured in substance — what made it a second opinion was the
PROJECTION, not the entry point.

## Design choices the ticket left open

1. **`remember` is unregistered on the edge pass rather than kept and refused.**
   The ticket says "remove the write entry point"; for a pass whose only action
   was `justify`, that is the tool. A tool registered with nothing it will accept
   is a token cost and an invitation to spend a round trip discovering it. The
   unified dispatch keeps its `remember` because its topic pass genuinely uses it.
2. **`LANE_CHECK_WARNING_NOTICE` is left byte-identical**, including "Do not call
   justify or delay commit." It is FROZEN VERBATIM by the spec's "Warning
   wording" section and is not on this ticket's removal list. It now names a verb
   that does not exist — harmless (a negative instruction), and it still steers a
   run served by a stale live plugin away from the round trip. **Flagged for a
   ruling** rather than changed unilaterally.
3. **The two lane-read-receipt READERS are deleted; the WRITER is not.**
   `mcp/recall.ts`'s lane route still writes `lane_read_receipts`, so the table is
   now WRITE-ONLY. Removing the writer is a change to the recall read path, not to
   the settlement path this ticket retires, and the receipts are the one durable
   record of what a run was shown of a lane. Stated as residue at the foot of
   `db/lane-disposition.ts` and in `db/schema.ts`.
4. **`checkCompleteReadFreshness` stays exported and separate** although
   `checkFieldGate` is now its only caller. Folding it back would re-create the
   shape whose two halves drifted apart (ticket 07 P1-3).
5. **`lanesJustified` is dropped from the metrics line, not pinned at 0.** A
   permanently-zero count teaches every future reader that the verb still exists.
6. **The blocking bucket keeps a message.** Its old text named the two discharges
   (stitch or justify); it now names only the stitch, since a fracture that
   blocked would be repaired by a stitch or by nothing.
7. **Stage 2's duty list went from three to two.** Duty 2 ("A SEVERED LANE'S
   DISPOSITION") is deleted rather than reworded — the severed-lane contract is
   taught inside batch step 5, where a run meets it. Restating a warning as a
   numbered duty is how it starts reading like a queue.

## Fixtures, and the mutation each one catches

- `settlement-one-evaluator.test.ts` — controls rebuilt (above); mutation verified RED.
- `lane-fracture-agreement.test.ts` — arm 3 rebuilt; test 1's touch is now a real
  edge side and both surfaces name BOTH fractures (no disposal exists to remove one).
- `note-settlement-parity.test.ts` — the tool difference now runs both ways:
  `{commit, lane_check}` settlement-only, `{remember}` main-only. Goes red if
  either side gains or loses a tool.
- `note-settlement-prompt.test.ts` — the lane-action inventory guard is INVERTED:
  this prompt must name NO lane action, live or retired. It goes red the moment
  any verb reappears, which is exactly the event that would put a third
  independent literal back.
- `tag-mandate-teaching-surfaces.test.ts` — the enum/description pin moves to
  `UNIFIED_REMEMBER_TOOL_DESCRIPTION`, the one surviving description of this
  facade a model reads; the read-obligation pin inverts to "teaches no obligation".
- `note-settlement-sdk-query.test.ts` — "stage 2's remember tool is justify and
  nothing else" becomes "stage 2 holds no lane tool at all", asserted on the
  ABSENT handler rather than on refusal text (a string can be softened by a later
  edit; an absent registration cannot).

## Coverage genuinely lost, stated rather than claimed elsewhere

- **16 tests deleted** across three files, all of which drove `remember(justify)`:
  phase-connectivity ticket 05 (4), ticket 07 (4), ticket 08 (2), the two
  ticket-04 justify tests, the two P2-3 liveness/fracture-binding tests, and the
  justify-ledger / duplicate-reason / receipt-reader blocks in
  `tests/db/lane-disposition.test.ts`. Every obligation they pinned existed to
  make ONE write trustworthy. Each deletion site carries a named inventory of what
  went, so it reads as a retirement and not as a gap.
- **`grantPrincipalCandidates`' stage-sibling widening** was exercised through the
  receipt readers. `db/write-gate.ts` is its remaining caller and has its own
  tests; no assertion in `tests/db/lane-disposition.test.ts` covers it any more.
- **OVER-DETERMINED, and no single mutation can falsify it** —
  `lane-fracture-agreement`'s second test asserts `gate === []` for an undiscovered
  lane. That is now true for TWO independent reasons: the lane is unwidened AND
  untouched. It used to be touched, by a landed `justify` that addressed the lane
  by `(segment, tag)` and needed no writable member — the self-arming source this
  ticket retired. Every remaining touch source is a write to the graph, and that
  run has no ghost-lane member it may write; reaching one from `w2` with an edge
  side would put the lane in the SEED and destroy the premise. The RENDER
  assertions (`previewText` must not contain `ghost-lane`) are NOT
  over-determined and are what ticket 04's criterion is read off. Written into the
  test.
- **The same shape, one level up:** a run can no longer touch a lane NONE of whose
  members it may write. Touch conditions (a) edge side and (b) landed tags write
  both resolve through the lane's own island membership. Condition (c)'s test is
  deleted; the fact is recorded where it stood.

## UNVERIFIED

- **`tsc` does not typecheck `tests/`** (`tsconfig.json` excludes it). Test-file
  type errors surface only through `bun test`, which is green — but a
  type-level-only break in an unexecuted branch of a test file would not be caught
  by either gate. Pre-existing, noted because this ticket edited 12 test files.
- **`NOTE_SETTLEMENT_SYSTEM_PROMPT`'s tool sentence omits `finalize`**, which the
  unified dispatch registers. Pre-existing, unrelated to this ticket, NOT fixed —
  the superset guard's own comment records it. The sentence keeps `remember`
  because the unified dispatch shares this one system prompt.
- **No production-DB measurement.** This ticket removes code and a warning; it
  changes no projection and no verdict a query could count. `~/.claude-mnemo/`
  was never opened.

## Gates

| gate | command | result |
|---|---|---|
| typecheck | `npx tsc --noEmit` | clean (no output) |
| touched suites | `bun test tests/worker/settlement-one-evaluator.test.ts` | 3 pass / 0 fail |
| | `bun test tests/worker/lane-fracture-agreement.test.ts` | 2 pass / 0 fail |
| | `bun test tests/worker/note-settlement-sdk-query.test.ts` | 74 pass / 0 fail |
| | `bun test tests/worker/note-settlement-prompt.test.ts` | 77 pass / 0 fail |
| | `bun test tests/db/lane-disposition.test.ts` | 9 pass / 0 fail |
| full suite | `bun test` | **4719 pass / 0 fail**, 261 files |
| bundles | `npm run build` | ok |
| stale-bundle guard | `bun test tests/shared/release-artifacts.test.ts` | 10 pass / 0 fail |
| no-model guard | `grep -c 'anthropic-ai/claude-agent-sdk' plugin/scripts/*.cjs` | worker 1, settlement-child 1 — identical to HEAD |
| whitespace | `git diff --check` | clean |
