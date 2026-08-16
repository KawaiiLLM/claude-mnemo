# 10b — Every settlement write stages, and `commit` is the only writer

**What to build:** The settlement agent works through tools as before, but nothing it writes reaches the live tables until it calls `commit` — which either lands the whole window in one transaction or reports what is still missing and keeps the staging.

**Blocked by:** 10a

**Status:** ready-for-agent

Spec **A7** is the whole ticket; read it before anything else. It supersedes A2, moots A2a, amends A3 and G8, and dissolves G5.

The observation A7 rests on: the envelope was safe because **one reply was one transaction**, not because its parser was good. A1 replaced the parser to fix three data-destructive bugs and surrendered the transaction along with it; G5's unsolved replay contracts were the bill. Staging separates the two — authorization stays live and per-call, durability moves to `commit`.

- [ ] Every settlement write stages in the per-request server closure and reaches no live table before `commit`
- [ ] A staged write still runs its full validation immediately and returns a real receipt, so the agent learns of an error while it can still act on it
- [ ] The segment tool lands as a staged write: create or extend, members, type, tags, body
- [ ] A staged segment is addressable within the run (`E#1`) and `commit` resolves handles to real ids in staging order
- [ ] `commit` re-validates inside its own transaction — the world moves between staging and commit, so stage-time validation is feedback and commit-time validation is truth
- [ ] `commit` runs the completion gate as its precondition: coverage, segmentation, duty 2, under 10a's ownership fence, all in the one transaction that performs the writes
- [ ] A refused `commit` reports what is missing and **keeps the staging**, so the agent fills the gaps and commits again
- [ ] Settlement gets no `check` tool — the gate is `commit`'s own precondition and cannot drift from it. The main agent's `check` is untouched
- [ ] The dispatch stops routing through the write-back: after this ticket `commit` is the only path that completes a job
- [ ] Full suite green

## What survives, and what is now impossible

Ticket 09's exclusion table, anti-join and ownership fence all survive — they become `commit`'s precondition rather than a repair for partial state. What becomes impossible is G7's motivating crash: a window whose fields are written but which died before segmenting cannot exist when the fields and the membership commit together.

**No job-scoped operation key is needed.** Both of G5's segment contracts were lost-receipt problems, and a lost receipt on a staged write costs nothing.

## The one piece of new machinery, and why it is not the parser A1 removed

`commit` replays staged intents in order, resolving `E#n` handles as it creates segments. That is a small interpreter. The parser A1 removed carried **authorization** — it decided for itself who could write what, and was wrong three times in ways that destroyed data. This one replays intents that authorization has already passed, and re-checks them against real ids inside the commit transaction. State that distinction in the code, because the next reader will ask.

## Accepted cost

An agent that never calls `commit` yields nothing, where incremental writes left a partial result. The retry cap is three and a window is at most fifty turns, and a clean re-run beats reconciling against a half-state.
