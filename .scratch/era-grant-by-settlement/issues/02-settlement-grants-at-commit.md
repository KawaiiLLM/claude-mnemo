# 02 — Settlement grants era eligibility when it commits a window

**What to build:** a backfill of a pre-era window takes effect on what can be read.
After settlement commits, that window's turns are visible in their task's member
reads without anyone re-running a migration, and the operator can see from the log
how many turns the run granted.

**Blocked by:** 01 — the column, the predicate and the read sites must exist first.

**Status:** ready-for-agent

## Why

Ticket 01 makes grants readable and seeds the ones already earned. Without this
ticket the grant is frozen at migration time: every future backfill of a pre-era
window would re-create the exact silent failure the spec describes — a completed
settlement that changes nothing anyone can read, with no signal saying so.

## Decisions (settled — implement as given)

1. **Population = window COVERAGE, not turns reviewed** (ruled [S15069/T1818]).
   The recorded fact is "this turn's window was processed by settlement under the
   current model". An agent's decision not to write a note on a given turn is its
   own legitimate judgment and must not leave that turn permanently invisible.
   Coverage is also the only population ticket 01's retroactive seed can
   reconstruct, so one rule serves both directions.
2. **Written in the commit path, in the commit's own transaction.** A grant is part
   of the commit landing, not a follow-up write that a crash could separate from it.
3. **Idempotent.** A second commit over an already-granted window neither duplicates
   nor revokes; the first grant's epoch stands.
4. **Reported.** The count reaches the operator as its own field on the existing
   `[claude-mnemo] note-settlement` metrics line — the same path the commit counts
   already ride. A write with no receipt is the failure mode this whole spec exists
   to fix; do not reproduce it.

## Acceptance criteria

- [ ] A settlement commit over a pre-era window grants exactly that window's turns —
      asserted by naming the turns granted and the turns deliberately not, not by a
      count alone.
- [ ] A turn the agent skipped inside a committed window IS granted, per decision 1.
- [ ] A second commit over the same window changes nothing: same set, same epochs.
- [ ] A run that does NOT commit (gate refusal, exhausted attempts) grants nothing.
- [ ] The grant count appears in the metrics payload emitted by
      `note-settlement-dispatch.ts`, and is zero-suppressed or not per whatever the
      neighbouring fields already do — match them rather than inventing a rule.
- [ ] A post-era window's commit grants nothing new and costs no extra write.
- [ ] Every new test mutation-verified: name the observable that must differ, assert
      the mutation's needle matched and PRINT that it applied, confirm red, restore
      from a backup taken AFTER the implementation lands, confirm green.
- [ ] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test` green;
      report the number and account for the change.

## Out of scope

Revoking a grant, and any operator surface for granting by hand. If a grant turns
out to have been wrongly earned, that is a later ticket with its own evidence.

## Notes

Read-only against `~/.claude-mnemo/`; rehearse against a `/tmp` copy.
