# ADR-0008 — One gate, one renderer: read grants, freshness stamps, settlement direct-write

**Status:** accepted · 2026-08-19 · source: S15069 grill rounds T953–T958 (two rounds of
convergence) · **baseline revised 2026-08-20** — the gate below is the write-mode-edit-
semantics batch's shipped contract (tickets 05–07), not the pre-implementation draft: the
mode vocabulary is `write`/`edit`, and the gate has a third rejection. Revised in place
rather than annotated, because a reader who took the earlier four-rung text as the baseline
would flatten the two modes back into one.

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

1. The field has never been written by anyone → **admit** (a create path needs no read).
2. The field's own last writer is this same writer → **admit** (writing is reading: no field
   a writer already owns can go stale under its own hand, and the only content its
   replacement can lose is content it put there itself).
3. *From here the field holds another writer's content.* This writer's session holds no read
   grant on the entity → **reject** `never-read` ("recall `<address>` first"). A grant is
   earned by the entity being rendered to this writer this call/session (injected into
   context, or rendered by a `recall`/`timeline` call); it is entity-level, licensing every
   one of the entity's fields.
4. A grant exists, but the field was stamped by that other writer after the grant was earned
   → **reject** `stale` ("`<field>` was changed by `<writer>` at `<time>`, recall again").
5. The grant is current, **and** this call's mode is `write` — whole-field replacement —
   **and** the render that earned the grant did not deliver *that* field untruncated →
   **reject** `incomplete-read`, naming the field and the remedy. `edit` never reaches this
   rung: it replaces only the span its `oldString` matched, so it cannot lose what it never
   saw.
6. Otherwise → **admit**.

**Write and edit differ in exactly one thing — rung 5.** Both modes stand under the same two
premises, seen and unchanged-since-seen (rungs 3 and 4 judge them identically: an exact
`oldString` match is not a substitute for having read, and a foreign write since the read
invalidates both modes). Only the completeness requirement separates them, and only where
there is something to destroy: a `write` onto an empty or never-written field is exempt
(nothing to lose), and a `write` over the writer's own content is exempt because rung 2
admits before rung 5 is ever reached. That order is load-bearing — the two admissions that
rest on no render at all are tested first, so the completeness requirement can only bite the
case it exists for. The stricter "any existing content" reading would need a mechanism this
decision does not authorize: a write recording completeness for its own writer.

**Rendering records grants, and per-field completeness.** One table (writer, entity class,
entity id, `read_at`) is the read set; the single unified renderer that recall, timeline, and
every context injection now share is the **only** place that writes to it, as a side effect
of rendering. A second, finer record rides along: for each field the render touched, whether
it was delivered **whole** or cut by a budget — the evidence rung 5 consults. A field the
render never selected has no record at all, which the gate reads the same as truncated: this
writer's grant did not come with a full view of it. Later wins; a field read truncated once
and complete the next time is complete, never permanently disqualified. There is no TTL — a
grant is invalidated only by a later write, never by time, and is cleared at session end (a
janitor backstops any leak). This is the hinge: the read half of the contract (a rewritten
renderer, two token budgets replacing the four-rung ladder) and the write half (the gate
above) are one spec because the renderer's own output is the write half's admission evidence.

**The remedy is the caller's, not the gate's.** A rejection at rung 5 must name the field and
the exact read that would deliver it whole, because the writer cannot otherwise tell which of
the fields it just sent was the one its read cut. That read differs per surface, so the gate
takes it as a parameter rather than guessing: a **turn field** widens with recall's per-item
`turn` cap; a **segment card's field rows** widen with `pageBudget` (the card elides rows
against the page budget, not against `turn`); a turn's **`type`/`tags`** are not selectable
by their own names at all — they ride the rendered metadata line, so the only read that earns
completeness for them is a metadata-selecting recall
(`recall(id="S<n>/T<m>", filter={fields:["metadata"]})`). A plain recall renders title and
content, and therefore earns no completeness for type or tags: cross-session correction of
either now costs one metadata-selecting read first. A gate that guessed one of these three
remedies would send the other two writers back to a read that cannot possibly clear the
rejection.

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
- The two write modes are one mechanism with one branch, not two policies: `write` and `edit`
  are the single vocabulary both write surfaces (`note`, `remember`) speak, and the only
  behavioural difference between them anywhere in the system is rung 5. `overwrite`,
  `append` and `replace` retire; `append`'s capability survives as an `edit` anchored on the
  field's last row.
- **Open gap — settlement does not opt into rung 5.** Its context render records no field
  completeness, so requiring one today would reject every correction of a non-empty field.
  Settlement therefore passes rungs 1–4 only; wiring the completeness record into its own
  render is its own decision, recorded in [ADR-0007](0007-one-tool-surface-staged-apply.md)'s
  amendment, not silently accepted as correct.
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
