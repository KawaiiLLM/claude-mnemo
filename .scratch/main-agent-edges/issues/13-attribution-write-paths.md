# 13 — Every attribution write goes through the one rule and the one seam

**What to build:** repairs from the whole-batch peer review (S15069/T2461, P1-3, P1-6, P1-7, P1-9). After it, a pair collision anywhere resolves by `selectLogicalEdgeRow` (most specific class, then lowest id); creating a lane is an attribution mutation that runs the seam; a membership veto is honoured by every caller before it changes anything else; the claim scope is replaced atomically under a generation CAS.

**Blocked by:** None.

**Status:** ready-for-agent

## Findings, verified at 36af9878

- **P1-3 — two write paths pick a collision survivor by the wrong rule.** `mergeLaneTag` (lanes.ts ~729–816) changed its identity key to pair+side but still picks the survivor by provenance/creation time; `normalizeIncidentAttribution`'s clear-collision path (normalize-incident-attribution.ts ~260–357) DELETES the current row outright. Both can delete a `correct/full` and keep a `use`, contradicting `selectLogicalEdgeRow` (memory-edges.ts ~420–455) which the fold and the writer use. Ticket 01 recorded the first as a divergence; the peer classified it as a defect. It is.
- **P1-6 — `create lane` bypasses the seam.** `remember.ts` ~783–833 and `note-settlement-membership-facade.ts` ~445–475 call `insertLane` directly. Turns already carrying the word become members of the new lane; a blank side on such an endpoint goes `derived` → `ambiguous` with no normalisation, no PRE record, no invalidation.
- **P1-7 — claim scope replace is neither transactional nor CAS'd.** `persistNoteSettlementClaimScope` (settlement-job-invalidation.ts ~119–136) does DELETE + INSERT without a transaction or a generation check; a stale generation N dispatch can overwrite generation N+1's scope, and readers can see it empty in between.
- **P1-9 — two callers ignore the membership veto after already mutating the turn.** `turns.ts` ~456–505 (reset clears extraction fields, then calls `writeMembershipTags` without reading `.ok`) and `hooks/capture-repair.ts` ~203–253 (marks compact, deletes outgoing edges, ignores `.ok`). A lane-stranding refusal leaves old tags/membership beside the already-applied change.

## What to change

- [ ] ONE survivor rule: both collision sites call `selectLogicalEdgeRow` (import it; no local rule) and the loser is deleted with the existing receipt. A test on each path seeds `correct/full` (higher id) vs `use` (lower id) and asserts the `correct/full` row survives; the revert probe (provenance/time rule restored; delete-current restored) names the red test.
- [ ] Lane creation runs `normalizeIncidentAttribution` for every turn that already carries the word, inside the same transaction as `insertLane`, with the live-job branch — one seam (P2). Test: a unique-lane endpoint with a blank side becomes ambiguous on lane creation and the edge is disposed by the seam's rule (receipt), not left `derived` in a stale reading.
- [ ] `persistNoteSettlementClaimScope` runs inside one transaction and takes `claimGeneration`; it refuses (no-op + return false) when the job's current generation differs. Both dispatch shapes pass their generation. Test: a stale generation cannot overwrite; readers never observe an empty scope mid-replace.
- [ ] `writeMembershipTags` is called BEFORE any other mutation in both callers and its `.ok` is honoured: on refusal, nothing else changes and the refusal is surfaced (return value or thrown, matching the caller's contract). Tests for both.

## What to prove

- [ ] Revert probe per predicate, red test named; ≥4 (one per finding), verified applied, md5-restored.

## Constraints

- `~/.claude-mnemo/` STRICTLY READ-ONLY. NEVER `git stash`/`checkout`/`checkout-index`/`restore`/`reset`/`clean`; restore from your own `cp` copies, md5-verified.
- Explicit pathspecs; never stage `plugin/scripts/*.cjs`; nothing under `.scratch/` but this ticket. No control bytes; `anthropic-ai` in worker.cjs = 0. No subagents. No version bump, no push.
- `npx tsc --noEmit` clean; `npm run typecheck:tests` no new errors in touched files; full `bun test` once with every delta accounted (baseline 4785/0/274 at 36af9878); `npm run build`; guards green; `git diff --check` clean.
