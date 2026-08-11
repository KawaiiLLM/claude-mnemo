# Spec — caller identity must survive a resumed session

**Status:** ready-for-agent

Follow-up to `01-caller-identity.md` (shipped in 0.9.8). That ticket built the
identity map and the `crossSession` guard; this one fixes the join key, which
production measurement showed never matches on a resumed session.

## Problem Statement

`note` is supposed to refuse a write addressed at another session's turn unless
the caller says `crossSession: true`. Measured on the live database after
0.9.8 reloaded, it does not: a probe writing to a foreign session's turn came
back with the `replace: true` message — the guard ahead of it never fired,
because caller identity resolved to "unknown" and unknown always admits.

The cause is the join key. Both halves read `CLAUDE_CODE_SESSION_ID`, but the
two processes hold different values for it:

| process | value | what it is |
|---|---|---|
| the hook that writes the map | `e8541c19…` | the resumed conversation id — has a transcript and a `sessions` row |
| the MCP server that reads it | `01d52bb7…` | a boot id — its only artifact is an empty `tool-results/` directory |

Claude Code hands every child a *snapshot* of `process.env` taken when that
child is spawned. The MCP server is spawned once, during startup, before the
resumed conversation's id is adopted; hooks are spawned per invocation and
therefore see the current value. Claude Code re-syncs its own env copy in
exactly one place (after `/clear`) and does not do so on the resume path, so
the MCP server's snapshot stays at the boot id for the life of the session.

A fresh session's boot id and conversation id are the same string, so the map
joins and the guard works. Every resumed session — which is most long-lived
work — silently loses it. The failure is safe (identity unknown admits, so no
write is blocked and none is misfiled) but the guard the user asked for is
inert, and nothing in the test suite says so: the write side and the read side
are each tested with a key the test itself chose, so the join was assumed
rather than exercised.

The module's own documentation states the mechanism backwards — it says the
process id "mints a fresh value each time" while the payload id is stable.
The opposite is true of the value each side actually holds.

## Solution

Stop assuming one key. Both sides derive an ordered list of candidate identity
keys from their environment; the hook records the session under *every* key it
can derive, and the MCP entry point tries them in order and takes the first
hit. Unknown still means unknown, and unknown still admits.

The list is ordered most-reliable first:

1. **The messaging socket path** — `CLAUDE_CODE_MESSAGING_SOCKET`, measured to
   hold the identical string in both the hook's environment and the MCP
   server's, because it names the owning Claude Code process rather than the
   conversation. It is set before any hook can spawn, and it does not move when
   a conversation is resumed.
2. **The session env var** — today's key, kept as the fallback for builds or
   modes where the socket is absent (it is feature-gated, and bare mode skips
   it entirely).

On a resumed session the socket key matches and the guard becomes live. Where
the socket is unavailable the behaviour is exactly today's — the session env
var, matching on fresh sessions, unknown on resumed ones.

## User Stories

1. As a user, I want `note` to refuse a write aimed at another session's turn
   even in a session I have resumed many times, so that the guard I asked for
   is actually in force where I do most of my work.
2. As a user, I want that refusal to name the cross-session problem rather than
   the `replace` problem, so that the message tells me what is actually wrong.
3. As a user, I want `crossSession: true` to remain the single documented way
   past that refusal, so that a deliberate cross-session write stays possible.
4. As a user, I want a session whose identity cannot be determined to keep
   admitting writes, so that a missing or renamed environment variable can
   never brick note-taking.
5. As a user, I want the guard to hold on the first prompt of a session, so
   that a session does not have a window in which it is unprotected.
6. As a user, I want the identity to follow the conversation across a resume, a
   compact, and a plugin reload, so that the protection does not quietly lapse
   at the moments a long session is most likely to be confused about itself.
7. As a user, I want two Claude Code sessions running at once to be told apart,
   so that a note written in one can never land on the other's turn without
   the flag.
8. As a user, I want a stale mapping left by a dead session to be incapable of
   misidentifying a live one, so that identity is never confidently wrong.
9. As a maintainer, I want a test that writes through the real hook handler and
   reads through the real resolver, so that a future change to either side
   cannot silently break the join again.
10. As a maintainer, I want that test to feed the reader an environment whose
    session variable disagrees with the writer's, so that the resumed-session
    shape is the one under test rather than the fresh-session shape.
11. As a maintainer, I want the failing shape red-checked before the fix, so
    that the test is known to catch this bug and not merely to pass.
12. As a maintainer, I want the identity keys derived in one place used by both
    sides, so that the two halves cannot drift apart into different key
    vocabularies again.
13. As a maintainer, I want each key namespaced by its source, so that a socket
    path and a session id can never collide in the same column.
14. As a maintainer, I want the module documentation corrected, so that the
    next reader is not told the opposite of what the values do.
15. As a maintainer, I want the worker's tool channels to stay on unknown
    identity, so that a worker process inheriting a hook's environment never
    looks like the session that spawned it.
16. As a maintainer, I want a way to confirm on the live database that the
    guard fires, so that "shipped" and "in force" are not conflated a second
    time.

## Implementation Decisions

**One derivation, two callers.** A single function turns an environment into an
ordered list of candidate identity keys. The hook's write path and the MCP
entry point's read path both call it; neither reads an environment variable
name directly any more. This is the concept-integrity move — the previous
design had the same variable name spelled out on both sides and no structural
guarantee they agreed.

**Keys are namespaced strings.** Each candidate is prefixed by its source (the
socket key and the session-var key carry different prefixes) so the map's
primary key stays unambiguous. No schema change: the existing
`process_session_map` table already keys on an opaque string.

**The hook records every key it can derive**, all pointing at the same mnemo
session, in the same write transaction it already uses. A session with both
variables present therefore owns two rows. Deriving nothing writes nothing, as
today.

**The reader takes the first hit in order**, not a majority or a merge. A miss
on all keys is `null` — identity unknown — and every downstream reader already
treats that as "admit".

**Pid reuse is handled by write ordering, not by a freshness window.** The
socket path embeds the owning process's pid, so a dead session's row could in
principle be matched by a later process that inherits that pid. It cannot
mislead a `note` call: `note` only happens inside a turn, and the hook that
claims the key runs at UserPromptSubmit, before any of that turn's tool calls.
The upsert overwrites, so by the time an MCP server in the new session resolves
anything, the new session already owns the key. This ordering argument is the
reason no expiry column is added.

**Fail-open is unchanged and is a stated invariant, not an accident.** Unknown
identity admits. This spec must not turn a resolution miss into a refusal.

**Worker and test construction paths keep supplying no resolver**, so their
identity stays unknown by construction. Only the MCP direct-execution entry
point wires the resolver, exactly as today.

**Documentation correction.** The identity map's module doc currently asserts
that the process env var mints a fresh value each time while the payload id is
stable. Replace it with the measured mechanism: every child snapshots the
environment at spawn, so a long-lived child (the MCP server) holds whatever was
current when it started, while a per-invocation child (a hook) holds the
current value.

## Testing Decisions

A good test here asserts the externally visible behaviour — what `note`
answers, and what the resolver returns for a given environment — and never
inspects how the key was spelled. The one test that matters is a **round trip
across both halves**: drive the real hook handler to record the mapping, then
call the real resolver with an environment that agrees on the socket variable
and *disagrees* on the session variable, and assert it resolves to the same
mnemo session. That is precisely the shape the current suite is missing, and it
needs no new seam — both functions are already exported and already under test
individually.

Seams used, both pre-existing:

- the session-init hook handler, for the write side
- `resolveCallerSessionIdFromEnv(db, env)`, whose injected `env` parameter is
  what makes the resumed-session shape expressible without spawning anything

Cases to cover:

- the resumed shape: socket agrees, session var differs → resolves
- the fresh shape: both agree → resolves (regression guard for today's
  behaviour)
- socket absent on both sides, session var agrees → resolves via the fallback
- socket absent on both sides, session var differs → unknown (today's honest
  miss, preserved)
- no recognised variable at all → unknown, not an error
- an unrecorded key → unknown
- through `note`: a foreign turn under a resumed-shape environment is refused
  with the cross-session message, and `crossSession: true` gets past it

Prior art: `tests/db/process-session-map.test.ts` for the map's own behaviour,
the `resolveCallerSessionIdFromEnv` block in `tests/mcp/server.test.ts` for
environment-driven resolution, and the caller-identity block in
`tests/mcp/handlers.test.ts` for the guard's messages and for the pinned rule
that a handler set built without a resolver leaves identity unknown.

The red check is mandatory: the round-trip test must be seen failing against
the current single-key implementation before the fix lands.

Live verification after release and reload, in a resumed session: probing a
foreign session's turn must come back with the cross-session message rather
than the `replace` message.

## Out of Scope

- Walking the process ancestry to the owning Claude Code process. It needs no
  feature-gated variable, but costs platform-specific code and a pid-reuse
  story; the socket key gets the same information from a variable both sides
  already hold. Revisit only if the socket turns out to be absent in practice.
- Any change to what `note` does once identity is known — the guard's ordering,
  its messages, the `replace` rule, and the `Noted`/`Updated` receipts all
  shipped in 0.9.8 and were verified live.
- The dead-session settlement backlog. The user has ruled it out: those jobs
  get consumed if the session is ever resumed, and are simply dead otherwise.
- The unwritten note backlog on this session's turns. That is agent compliance,
  not a mechanism defect.
- Making the identity available to worker tool channels.

## Further Notes

The generalisable lesson, and the reason this is worth a spec rather than a
one-line patch: Claude Code's own source names this trap twice without
generalising it — the startup path awaits the messaging server so the socket is
exported "before any hook can spawn and snapshot process.env", and the `/clear`
path reassigns the session variable afterwards. Both are point fixes for the
same class. An environment variable is a snapshot taken at spawn; any identity
that can move afterwards must not be keyed on one alone. A long-lived child is
exactly where such a snapshot rots.

Everything in the Problem Statement was measured on the live installation, not
inferred: the two environments were dumped from the running processes, and the
guard's failure was reproduced with a real `note` probe that was refused for
the wrong reason.
