# 08 — One coverage predicate, and the agent can ask it

**What to build:** An agent can ask what it still owes before it believes it has finished, instead of discovering it at the moment it tries to stop.

**Blocked by:** 02

**Status:** ready-for-agent

One predicate, three callers, decreasing trust: the `check` tool pulled by the agent, the Stop hook pushed at stop, the completion gate server-side. Three implementations would drift, and drift resolves toward whichever is loosest.

- [x] The predicate is a pure function: database in, gap list out
- [x] An eligible turn with an empty field is a gap
- [x] A skipped turn counts as covered — skip is itself a verdict, and a turn that cannot yield a type is a skip rather than a kept empty row
- [x] Compact markers and slash commands needing no model reply are excluded; sidechain rows are included
- [x] The predicate is exposed as a `check` tool reporting what is missing, never why
- [x] The per-grade histogram is NOT in anything the grading agent can see, at any point in its run (spec G9)
- [x] Full suite green

## Closed

`src/db/coverage.ts` holds the predicate; `src/mcp/check.ts` exposes it as the
fourth MCP tool. 17e3bdf, 1716 pass.

**Skip needed two signals, measured not assumed.** `turns.status = 'skipped'`
is the mechanical floor a later prompt writes, and 2124 of 2245 production
skipped turns carry no `note_debt` row at all — so the floor alone is
necessary. But it never reaches a turn the agent has just declined, nor a
sidechain row, which is born `undone` and is never mechanically promoted. 56
live rows carry an empty type plus a `declined` debt and would read as false
gaps without the ledger branch. That branch is narrowed to `reason =
'declined'`: `aged`/`closed` are the old reminder's write-offs, and
settlement's own `listOwedNoteTurnsInRange` still treats those as owed.

**G9 is pinned by a test that goes red when the histogram appears**, verified
by adding one and watching it fail.

**The no-reply slash-command branch is unexercised by production data.**
`turns.user_prompt` holds the UserPromptSubmit hook's raw prompt text, never
the transcript's expanded envelope XML, so the `<local-command-` /
`<command-name>` forms `timeline.ts` already defines match zero live rows. It
is written against the codebase's own vocabulary rather than an observed row;
if ticket 11 meets a different real shape, this is the branch to revisit.

### Open: `check`'s address is a whole session, which is too coarse

Measured on this project's own session: 715 turns, **180 untyped and
unskipped**, 105 of them in the last 120 turns — a live session always carries
unsettled turns, so `check(id="S…")` answers "what does this session owe,
ever", not "what does my current work owe". The predicate itself takes a bare
turn-id list and is unaffected: ticket 09's completion gate and ticket 11's
Stop hook both pass their own window. If the agent-facing tool is to be useful
it needs the window too — a turn-range address, or the settlement job's frozen
window. Deferred, not resolved.
