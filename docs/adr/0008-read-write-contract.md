# ADR-0008 — One gate, one renderer: read grants, freshness stamps, settlement direct-write

**Status:** accepted · 2026-08-19 · source: S15069 grill rounds T953–T958 (two rounds of convergence)

## Context

Three problems sat on the same seam. First, write safety had no general rule: cross-session
turn writes, session field writes, segment writes, and settlement's four-field correction
each carried their own point defense (a `crossSession` confirmation flag, a roster
read-before-write convention, settlement's own eligibility window and yield fence), and two
concurrent sessions attached to the same segment could still overwrite each other's field
writes whole with no fence at all. Second, settlement's staged-commit machinery (ADR-0007)
was a special case of that missing general rule, not a second mechanism worth keeping once
the rule existed — its atomicity was also excess for check-and-correct work: settlement is
idempotent correction, every individually landed write is independently valid, and a crash
mid-run leaves an ordinary "partially corrected window," not a state that needs an undo log
to recover from. Third, the view redesign that recall/timeline needed — collapsing the
four-rung escalation ladder and the collapsed/expanded switch into two token budgets — had
been decided in prior grill rounds but never written down, and its unified renderer turned
out to be the natural point to record a read grant. The read half and the write half share
one hinge for a structural reason: rendering IS how a grant gets earned.

## Decision

**The gate.** Every managed write (cross-session turn writes, session field writes, all
segment writes, settlement's four structured-field corrections) is judged per field, in one
fixed order, inside the same transaction as the write and its stamp update — there is no
window between judging the gate and landing the write for a second writer to land in:

1. This writer's session has read the entity this call/session (injected into context, or
   rendered by a `recall`/`timeline` call) — an entity-level grant, licensing every one of
   its fields — **and** the field was not written by someone else since → **admit**.
2. Not read, but the field's own last writer is this same writer → **admit** (writing is
   reading: no field a writer already owns can go stale under its own hand).
3. The field has never been written by anyone → **admit** (a create path needs no read).
4. Otherwise → **reject**, with one of two distinct messages: never-granted ("recall
   `<address>` first") or stale ("`<field>` was changed by `<writer>` at `<time>`, recall
   again").

**Rendering records grants.** One table (writer, entity class, entity id, `read_at`) is the
read set; the single unified renderer that recall, timeline, and every context injection now
share is the **only** place that writes to it, as a side effect of rendering. There is no
TTL — a grant is invalidated only by a later write, never by time, and is cleared at session
end (a janitor backstops any leak). This is the hinge: the read half of the contract (a
rewritten renderer, two token budgets replacing the four-rung ladder) and the write half (the
gate above) are one spec because the renderer's own output is the write half's admission
evidence.

**Freshness stamps.** A second table (entity class, entity id, field, last writer, a
**monotonic sequence number**) tracks who touched a field last. The sequence number, not a
wall-clock second, is what breaks ties — a same-second stamp comparison using `>=` could
misjudge which of two same-second writers actually went last, which the prior yield fence's
epoch-second comparison could not distinguish. A note write on a turn also stamps that turn's
derived `type`/`tags` fields under the writing agent's identity, even though the write itself
targets the `note` entity — this is what makes settlement's old "yield" behavior (an agent's
late note invalidating a settlement-in-flight correction) fall out of the freshness rule for
free, rather than needing its own bespoke check.

**Writer identities.** The main agent writes as `session:<id>`, resolved through the same
caller-session identity chain the `crossSession` flag already uses. Settlement writes as
`claim:<jobId>:<generation>` — a fresh identity every time a job is claimed. A lapsed
claimant and the reclaiming successor are, to the gate, simply two different writers; the
freshness rule alone keeps a stale claimant's write from landing over its successor's, with
no separate claim-CAS check needed. `crossSession` stays orthogonal to the gate: the gate
stops "wrote without reading," the flag stops "read the right thing but addressed the wrong
one." A hook-driven writer (the Stop handler's session close) writes only its own narrow
field, never re-upserts the whole row it opened by reading — the TOCTOU where a wide close
silently overwrites a mid-run settlement narrative write is closed by narrowing the write,
not by adding a gate rule.

**Settlement direct-write.** ADR-0007's staged-commit half — the subagent's writes accumulate
and apply only on a closing `commit` call — is replaced. Every settlement `note`/`remember`
call now gates, writes, and stamps in its own transaction immediately, the same as a main
agent write. `commit` is reduced to three things: a claim-validity check, a per-run write
count for the reply, and a terminal-status mark. There is no undo log and no rollback path:
a mid-run crash leaves whatever had already landed as independently valid, and the next
triggering event (a Stop hook, a manual backfill) retries the remaining window to
convergence — nothing to roll back, because nothing was ever staged.

**One transaction per write.** Every managed write — main agent or settlement, turn or
segment or session field — performs its gate check, its field write, and its stamp update as
one atomic unit. This is what actually removes the race the missing general rule left open:
two writers who both evaluated the gate before either wrote could previously land a silent
last-writer-wins overwrite; a row-level `updated_at` or a whole-row `UPDATE` does not, by
itself, constitute a field-level gate.

## Consequences

- Settlement's three ad hoc fences (eligibility window, yield, claim CAS) collapse into
  instances of one mechanism — the freshness stamp plus the per-run writer identity — rather
  than staying a second, parallel write-safety system alongside the gate.
- Rewind does not retract a stamp: `v1` ships without a stamp history log, so a turn on a
  branch that later gets rewound still invalidated whichever other writer's grant it touched,
  once. Recorded as a known gap (Out of Scope), not silently accepted as correct.
- An independent per-write generation check for settlement is unnecessary: its per-run writer
  identity already makes the freshness gate mutually exclusive between an old and a new
  claimant, so no second mechanism duplicates that protection.
- ADR-0007's staged-apply half is superseded by this decision; its one-tool-surface half
  (the settlement subagent uses the same note/remember/timeline/recall quartet as the main
  agent, not a dedicated facade set) is untouched and stands.
- The `.scratch/turn-edge-mechanism/spec.md` status line deferred milestone admission and
  grading rendering's *consumption* side to "the view spec," at the time unwritten. This
  decision is that spec: the unified renderer, its two token budgets, and the lexicographic
  edge-signal milestone selection are that consumption side, now landed.
