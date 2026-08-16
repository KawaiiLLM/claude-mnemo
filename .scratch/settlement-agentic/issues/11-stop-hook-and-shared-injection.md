# 11 — The settlement agent is told what it still owes, and sees what the main agent sees

**What to build:** An agent that tries to stop with gaps is handed the list and continues; and changing the main agent's injected context no longer requires a second, divergent edit for the subagent.

**Blocked by:** 10c

**Status:** done

- [x] A Stop hook tells an agent that is stopping without having committed what `commit` would refuse, at most twice
- [x] The main agent's injection is assembled by one entry point that both the SessionStart hook and the settlement agent call
- [x] The settlement context renders window turns through recall's collapsed view rather than a private renderer
- [x] Full suite green (except the known release-artifacts stale-bundle failure — bundles are not rebuilt in this ticket)

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

## How it landed

**The Stop hook** is `src/worker/note-settlement-stop-hook.ts`, registered per
REQUEST in `note-settlement-sdk-query.ts` as an SDK `hooks: { Stop: [...] }`
callback returning `{ decision: "block", reason }`. It cannot be a
file-configured mnemo hook: `hooks/hook-command.ts` short-circuits to success
whenever `CLAUDE_CODE_ENTRYPOINT === "sdk-ts"`, so mnemo's own Stop handler
deliberately never fires inside a spawned SDK child.

"What `commit` would refuse" is answered by `previewCommit()` — the SAME replay
and the SAME gate as `commit`, in a transaction whose last statement is a throw
(spec G8's "the check IS the gate", one level up). Computing it against
un-replayed tables would have reported gaps the agent had already staged the fix
for. It does not block at all in two cases: a run whose `commit` already landed,
and a run whose lease was reclaimed (no commit from that run can ever succeed,
so telling it to call one would be telling it to do the impossible — 10d's own
distinction).

**The cap is a counter in the hook's closure**, not the SDK's `stop_hook_active`
flag: that flag reports only "this stop follows a blocked one", which can
express a cap of one, not G2's two.

**Three things beyond the literal checklist, none of them cosmetic:**

1. `context.sessionStateRendering` was **built and never rendered** — nothing in
   `note-settlement-prompt.ts` read it, from ticket 07 onward. Unifying the
   assembly without also rendering it would have satisfied A4 only on paper, so
   the prompt gained a `## Session summary` section. That also means the
   settlement agent now sees ~2,000 tokens it did not see before.
2. The window turn's annotation line **restates the address as
   `[S<n>/T<n>]`**. Recall labels a turn `[S15][T7]`, and window turns are the
   ones the model must address in every write call under a schema that takes one
   address shape; keeping the qualified form is what makes routing this section
   through recall's renderer behaviourally safe. `tools=` was dropped because
   recall's own stats already print the tool count; the file NAMES stayed
   because recall counts files without naming them.
3. When a window turn has a note, the collapsed view is rendered with the
   note's title/content substituted in. For an agent note on an era turn those
   already ARE the turn record's fields (`promoteTurnFromNote`); for a note only
   `shadow_notes` carries — an earlier settlement pass's reconstruction, never
   promoted by design — the substitution is what keeps it visible without a
   second renderer to show it in.

**Loose end closed:** `SessionStateRenderInput.current` and the settlement
builder's pass of it are both gone (`src/mcp/session-output.ts`,
`src/worker/note-settlement-context.ts`).
