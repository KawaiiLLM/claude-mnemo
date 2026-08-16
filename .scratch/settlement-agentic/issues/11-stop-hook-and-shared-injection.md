# 11 — The settlement agent is told what it still owes, and sees what the main agent sees

**What to build:** An agent that tries to stop with gaps is handed the list and continues; and changing the main agent's injected context no longer requires a second, divergent edit for the subagent.

**Blocked by:** 10c

**Status:** ready-for-agent

- [ ] A Stop hook tells an agent that is stopping without having committed what `commit` would refuse, at most twice
- [ ] The main agent's injection is assembled by one entry point that both the SessionStart hook and the settlement agent call
- [ ] The settlement context renders window turns through recall's collapsed view rather than a private renderer
- [ ] Full suite green

## Amended by spec A7

Two changes, neither cosmetic.

**The completion-gate criterion moved to 10b.** Under staged commit the gate is
`commit`'s own precondition, in the transaction that performs the writes —
there is no separate re-check for this ticket to build, and G2's two layers
are now the Stop hook (trusts the agent) and `commit` (trusts nobody).

**The Stop hook's message changed shape.** It was "here is your gap list";
under A7 an agent that stops without committing has produced *nothing*, so the
hook's job is to say so and report what `commit` would refuse. That is a
better shape than a standalone list — the agent is told the one action that
would make its work durable, not an inventory.

**Blocked by 10c, not 10a.** The hook's message is a function of what `commit`
reports (10b) and the prompt describes the tool protocol the agent is being
held to (10c). Written against 10a's world it would need rewriting twice.
