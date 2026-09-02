# 02 — One membership primitive: tags written, members derived, three operations, batch form for settlement

**What to build:** every path that moves membership shares one primitive — write tags, stamp the `tags` field for the acting writer, derive `segment_members`, refresh facets — with three explicit operations; the settlement writer tags a topic's turns in ONE additive call; frozen legacy ownership in unnamed tasks can never be extended or duplicated. Spec D4 + D5.

**Blocked by:** 00.

**Status:** LANDED **VERIFIED S15069/T2411 at bcd10be5 (merged 024e6325, no conflicts)**: tsc 0; merged tree 4780/0/263 (+48/+2 accounted); my probes RED — unnaming allowed while members exist (1), task merge accepting an unnamed source (1). `reassignSegmentMembers` deleted and every `segment_members` mutation pinned to segments.ts by a sweep test. Batch form confirmed settlement-only (`noteInputShape` pinned to have none of turns/task/addTags).

- [x] The primitive with operations `normal` / `thaw-owner` / `forced-detach`. Under `normal`, a turn with a FROZEN owner (a `segment_members` row of an unnamed task) refuses any write that would create membership in another task, naming the owner. Derive never touches rows of an unnamed task (neither deletes nor creates).
- [x] Routed through the primitive, each listed in the report with its operation: batch and single `note` tag writes; `create … members` at both tiers (task-tier with empty `tag` refuses; lane-tier under an unnamed parent refuses); task `retag` — unnamed→named = `thaw-owner` backfilling every frozen member atomically, named→new replaces the tag on every owned member, named→null refuses while members exist; task merge (an UNNAMED source refuses: "name the source first"); lane merge / clear / retag; task-tier `clear` = `forced-detach`; `resetTurnExtractionFields`; compact occupied-turn repair (derive runs; frozen rows preserved); the ticket-03 migration. `reassignSegmentMembers` deleted or migration-private, proven by a call-site sweep. Any path left outside is named with its reason.
- [x] Structural readers (`getSegmentMemberTurnIds` and the verbs on it) keep returning frozen rows, including those of compacted/rewound turns; tested, not assumed.
- [x] The batch form, settlement-only on `settlementTurnWriteInputShape`: `note(turns:[…], task:"E<n>", addTags:[…])`, tags-only, mutually exclusive with `turn`; per member: union (`topic:` words kept), the task tag of `task` supplied when missing, a member carrying a DIFFERENT task tag refuses, every `addTags` entry must be a lane declared in `task`, every single-write check (canonical, declared, metadata grant, staleness); all-or-nothing with every failure named; one transaction. Public `noteInputShape` unchanged.
- [x] Concurrency: read metadata → another mutator changes tags through the primitive → the first writer's whole-set tag write is refused as stale.
- [x] Tests for each routed path, each retag transition, the frozen-owner refusal, forced-detach, and a thawed task accepting a batch write.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [x] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.

---

## Report (LANDED)

**Branch** `worktree-agent-a59eb18f17e6e915f`, branched from `main` at `4dd91a52`.
Baseline reproduced before any edit: **4676 pass / 0 fail / 256 files**.
Final: **4724 pass / 0 fail / 258 files** (+48 tests, +2 files — 32 in
`tests/db/membership-primitive.test.ts`, 15 in
`tests/worker/settlement-batch-tag-write.test.ts`, 1 added to
`tests/hooks/capture-repairs.test.ts`).

### The primitive

`writeMembershipTags` (db/segments.ts) — write tags on N turns → stamp `tags`
for the acting writer (`ANONYMOUS_WRITER` when none) → derive
`segment_members` → refresh facets. Three explicit operations:
`normal` / `thaw-owner` / `forced-detach`. `deriveTurnSegmentMembership` gained
the operation parameter, restricts its DELETE to rows of NAMED segments, and
THROWS `MembershipFrozenOwnerError` on a `normal` write that would give a
frozen-owned turn a second task. `checkMembershipTagWrite` asks the same
question without writing, and both write faces (`mcp/note.ts`, the settlement
facade) call it so the caller hears a refusal rather than an exception.

`reassignSegmentMembers` is **deleted** — no definition, no call site in `src/`
or `tests/`, proven by a sweep test that also pins `segment_members` writes to
`src/db/segments.ts` alone.

### Routed paths

| path | operation | where | test |
|---|---|---|---|
| batch `note` tag write | `normal` | facade `evaluateSettlementBatchTagWrite` | settlement-batch-tag-write, 15 tests |
| single `note` tag write | `normal` | note.ts gate + `updateTurnById` derive | membership-primitive "single `note`-shaped tag write" |
| settlement single tag write | `normal` | facade, beside `checkTurnTagWrite` | note-settlement-turn-facade (existing suite) |
| task-tier `create … members` | `normal` (empty `tag` refuses) | remember.ts `handleCreate` | "empty tag refuses" + "writes the TASK TAG onto every member" |
| lane-tier `create … members` | `normal` (unnamed parent refuses) | remember.ts `handleCreateLane` | two tests |
| task `retag` unnamed→named | `thaw-owner` | remember.ts `handleRetag` | "every FROZEN member receives the new tag" + "a THAWED task then accepts" |
| task `retag` named→new | `normal` | remember.ts `handleRetag` | "replaces the word on every owned member" |
| task `retag` named→null | refused while members exist | remember.ts `handleRetag` | two tests (refusal, and the memberless case still clears) |
| task merge | `normal`; UNNAMED source refuses | segments.ts `mergeSegments` | two tests |
| lane merge | `normal` | lanes.ts `mergeLaneTag` | "rewrites the member's word … and stamps it" |
| lane retag | `normal` (composes the merge) | lanes.ts `renameLane` | "lane retag rides the same primitive" |
| lane clear | `normal` | lanes.ts `clearLane` | "strips the lane word, stamps" |
| task-tier `clear` | `forced-detach` | segments.ts `clearSegmentMembers` | "removes even a frozen row" |
| `resetTurnExtractionFields` | `normal` | db/turns.ts | "drops the derived row, PRESERVES a frozen one" |
| compact occupied-turn repair | `normal` (derive now runs) | hooks/capture-repair.ts | "the conversion DERIVES membership" |
| ticket-03 cutover migration | — | **not in this ticket** (ticket 03 owns it); the semantics it migrates onto ship here |

**Left outside, with its reason:** `addSegmentMembers` — the derivation's own
insert half, called from nowhere else in `src/`. It stays exported for two
non-move callers: ticket 03's migration, which writes the pre-cutover stock it
is migrating, and fixtures reproducing that stock. Documented at the function.

### The batch form

`settlementTurnWriteInputShape` only: `turns` / `task` / `addTags`.
`noteInputShape` is unchanged and a test pins that. Per member: union
(`topic:` words kept), the task tag rides along, a DIFFERENT task tag refuses
naming it, every `addTags` entry must be a lane declared in `task`, plus every
single-write check (address, turn exists, not a compact marker, reviewable
window, field authority, `checkTurnTagWrite`, frozen-owner, `checkFieldGate`
staleness). All-or-nothing with every failure named; one transaction (the
caller's `writeTransaction`, and the primitive refuses whole before its first
`UPDATE`). Any other content field beside `turns` refuses; `turns`/`turn` are
mutually exclusive; `task`/`addTags` without `turns` refuse rather than being
ignored.

### Structural readers

`getSegmentMemberTurnIds` keeps its no-liveness-filter contract, now stated in
its own doc comment and tested: it returns frozen rows, including those of
compacted and rewound turns.

### Guards

`npx tsc --noEmit` clean (src); new tests typechecked under a temporary
tsconfig, then removed. `npm run build` + `tests/shared/release-artifacts.test.ts`
green. `git diff --check` clean, no control bytes,
`grep -c anthropic-ai plugin/scripts/worker.cjs` = 0. Five mutation probes, all
RED, all md5-restored: frozen rows visible to derive again (4 red); the
primitive stamps nothing (6 red); the batch replaces instead of unioning (1
red); the batch lands its good members anyway (5 red); compact repair derives
nothing (1 red).
