# 10b — Every settlement write stages, and `commit` is the only writer

**What to build:** The settlement agent works through tools as before, but nothing it writes reaches the live tables until it calls `commit` — which either lands the whole window in one transaction or reports what is still missing and keeps the staging.

**Blocked by:** 10a

**Status:** ready-for-agent

Spec **A7** is the whole ticket; read it before anything else. It supersedes A2, moots A2a, amends A3 and G8, and dissolves G5.

The observation A7 rests on: the envelope was safe because **one reply was one transaction**, not because its parser was good. A1 replaced the parser to fix three data-destructive bugs and surrendered the transaction along with it; G5's unsolved replay contracts were the bill. Staging separates the two — authorization stays live and per-call, durability moves to `commit`.

- [x] Every settlement write stages in the per-request server closure and reaches no live table before `commit`
- [x] A staged write still runs its full validation immediately and returns a real receipt, so the agent learns of an error while it can still act on it
- [x] The segment tool lands as a staged write: create or extend, members, type, tags, body
- [x] A staged segment is addressable within the run (`E#1`) and `commit` resolves handles to real ids in staging order
- [x] `commit` re-validates inside its own transaction — the world moves between staging and commit, so stage-time validation is feedback and commit-time validation is truth
- [x] `commit` runs the completion gate as its precondition: coverage, segmentation, duty 2, under 10a's ownership fence, all in the one transaction that performs the writes
- [x] A refused `commit` reports what is missing and **keeps the staging**, so the agent fills the gaps and commits again
- [x] Settlement gets no `check` tool — the gate is `commit`'s own precondition and cannot drift from it. The main agent's `check` is untouched
- [x] The dispatch stops routing through the write-back: after this ticket `commit` is the only path that completes a job
- [x] Full suite green

## What survives, and what is now impossible

Ticket 09's exclusion table, anti-join and ownership fence all survive — they become `commit`'s precondition rather than a repair for partial state. What becomes impossible is G7's motivating crash: a window whose fields are written but which died before segmenting cannot exist when the fields and the membership commit together.

**No job-scoped operation key is needed.** Both of G5's segment contracts were lost-receipt problems, and a lost receipt on a staged write costs nothing.

## The one piece of new machinery, and why it is not the parser A1 removed

`commit` replays staged intents in order, resolving `E#n` handles as it creates segments. That is a small interpreter. The parser A1 removed carried **authorization** — it decided for itself who could write what, and was wrong three times in ways that destroyed data. This one replays intents that authorization has already passed, and re-checks them against real ids inside the commit transaction. State that distinction in the code, because the next reader will ask.

## Accepted cost

An agent that never calls `commit` yields nothing, where incremental writes left a partial result. The retry cap is three and a window is at most fifty turns, and a clean re-run beats reconciling against a half-state.

## Closed

`note-settlement-staging.ts` is the staging engine and `commit`;
`note-settlement-segment-facade.ts` is the segment tool. ace3e38, 1802 pass.

The turn facade split into evaluate-and-maybe-apply, so stage time and commit
time run the SAME validation rather than two copies that could disagree. The
completion gate needed a transaction-free core extracted, because bun:sqlite's
`.transaction().immediate()` does not nest cleanly and `commit` needs the
gate's body without its own `BEGIN IMMEDIATE`; the public wrapper is unchanged,
so ticket 09's tests needed no edits.

Anchor edges needed no new code: `createSegment` and `applySegmentWrites`
already reconcile their own cited pairs (C6), so citations in a segment's
title or content become bare edges by themselves.

### An extend capability gate was added, and removed

The implementation gated `extend` on the open segments the prompt listed,
flagging it rather than presenting it as inherited — correctly, because the
retiring write-back declared `exposedSegmentIds` and never read it. Removed
(user ruling): whether a model saw something is not auditable, which is the
same ruling that retired the note-id exposure ledger. Existence and openness
are facts storage answers exactly. `extend` is gated by the compare-and-set
alone, byte-for-byte the old behaviour.

### Two things this surfaced

The segment tool has no relation fields — an omission in this ticket, against
A3. Restored in 10c.

"Fill the gap and commit again" holds for a gate gap and not for a replay
conflict on an already-staged call, because a staged write cannot be
un-staged. A7 now says so.
