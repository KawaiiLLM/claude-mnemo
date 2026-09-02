# 02 — One membership primitive: tags written, members derived, three operations, batch form for settlement

**What to build:** every path that moves membership shares one primitive — write tags, stamp the `tags` field for the acting writer, derive `segment_members`, refresh facets — with three explicit operations; the settlement writer tags a topic's turns in ONE additive call; frozen legacy ownership in unnamed tasks can never be extended or duplicated. Spec D4 + D5.

**Blocked by:** 00.

**Status:** ready-for-agent (after 00)

- [ ] The primitive with operations `normal` / `thaw-owner` / `forced-detach`. Under `normal`, a turn with a FROZEN owner (a `segment_members` row of an unnamed task) refuses any write that would create membership in another task, naming the owner. Derive never touches rows of an unnamed task (neither deletes nor creates).
- [ ] Routed through the primitive, each listed in the report with its operation: batch and single `note` tag writes; `create … members` at both tiers (task-tier with empty `tag` refuses; lane-tier under an unnamed parent refuses); task `retag` — unnamed→named = `thaw-owner` backfilling every frozen member atomically, named→new replaces the tag on every owned member, named→null refuses while members exist; task merge (an UNNAMED source refuses: "name the source first"); lane merge / clear / retag; task-tier `clear` = `forced-detach`; `resetTurnExtractionFields`; compact occupied-turn repair (derive runs; frozen rows preserved); the ticket-03 migration. `reassignSegmentMembers` deleted or migration-private, proven by a call-site sweep. Any path left outside is named with its reason.
- [ ] Structural readers (`getSegmentMemberTurnIds` and the verbs on it) keep returning frozen rows, including those of compacted/rewound turns; tested, not assumed.
- [ ] The batch form, settlement-only on `settlementTurnWriteInputShape`: `note(turns:[…], task:"E<n>", addTags:[…])`, tags-only, mutually exclusive with `turn`; per member: union (`topic:` words kept), the task tag of `task` supplied when missing, a member carrying a DIFFERENT task tag refuses, every `addTags` entry must be a lane declared in `task`, every single-write check (canonical, declared, metadata grant, staleness); all-or-nothing with every failure named; one transaction. Public `noteInputShape` unchanged.
- [ ] Concurrency: read metadata → another mutator changes tags through the primitive → the first writer's whole-set tag write is refused as stale.
- [ ] Tests for each routed path, each retag transition, the frozen-owner refusal, forced-detach, and a thawed task accepting a batch write.

## Constraints

- `~/.claude-mnemo/` is production data and STRICTLY READ-ONLY. Measure on a `cp -c` clone of the scratchpad copy.
- NEVER `git stash` / `checkout` / `checkout-index` / `restore` / `reset` / `clean` in the shared tree. Restore from your own `cp` copies, md5-verified.
- Explicit pathspecs on every `git add`. No raw control bytes in source. `grep -c anthropic-ai plugin/scripts/worker.cjs` stays `0`.
- Every teaching sentence added or removed is pinned by a test a mutation drives red. At least three mutation probes of your own, RED, md5-restored.
- [ ] `npx tsc --noEmit` clean (excludes `tests/`; typecheck new tests separately); full `bun test` once (account for every delta against the baseline in your brief); `npm run build`; stale-bundle and release-artifacts guards green; `git diff --check` clean. Do NOT bump any version and do NOT push.
