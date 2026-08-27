# 02 — An index node seats in the milestone on its own account

**What to build:** a turn that declares an `index` appears in its task's milestone
because it declared one — not because it happened to be the last member of its lane.
A task that converged five times shows five wrap-ups instead of one.

**Blocked by:** 01 — lane state must be gone first; this ticket's whole change is
what replaces the rule 01 removes.

**Status:** ready-for-agent

## Why

Election tier ② currently qualifies "a CLOSED lane's terminus and nothing else — an
open lane seats nobody". With lane state deleted that rule has no input. Its
replacement is the ruling: an index-declaring node seats on its own account. See
`../spec.md`.

## Decisions (settled — implement as given)

1. **Tier ② qualification becomes "this node declares an `index` edge."** The
   `closed-terminus` reason retires; the new reason names what actually qualified.
2. **Tier ③ is unchanged in RULE** — nodes indexed by an elected tier-①/② node that
   made the stage-1 cut. Its population grows because tier ②'s does; that is a
   consequence, not an edit.
3. **No override gate.** A node with an incoming `override` still qualifies. The
   rubric says a node overridden stays valid, and version progression means every
   version node is overridden by its successor — a gate here would delete exactly the
   nodes the user named as the ones that must not go missing.
4. **The within-tier sort key is NOT changed by this ticket.** See the spec's "Open"
   section: leading tier ② with out-degree is the obvious candidate and is NOT ruled.
   Measure and report; do not implement.

## Acceptance criteria

- [ ] A node declaring `index` seats at tier ② **in a fixture where its lane has
      later members**. A fixture where it is the lane's last member proves nothing —
      that case already passed under the old rule.
- [ ] A node with an incoming `override` still seats, pinning decision 3.
- [ ] The tier reason returned names index declaration; no `closed-terminus` reason
      survives anywhere, including in types and tests.
- [ ] Tier ③ still admits only nodes indexed by an elected tier-①/② node — assert
      that a tier-②候选 losing the stage-1 cut grants no tier-③ seat, so the existing
      guarantee is not lost while its input changes.
- [ ] Report, against a `/tmp` COPY of production, how many nodes now qualify for
      tier ② per live segment, and how the seated list changes for at least E60.
- [ ] **Measure and report the within-tier ordering** for tier ② at the new
      population: the in-degree distribution, the out-degree distribution, and how
      many seats are decided by each key. Do not change the key — this measurement is
      the input to a ruling that has not been made.
- [ ] Every new test mutation-verified: name the observable that must differ, assert
      the mutation's needle matched and PRINT that it applied, confirm red, restore
      from a backup taken AFTER the implementation lands, confirm green.
- [ ] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test` green;
      report the number and account for the change.

## Out of scope

The within-tier sort key, and writing any new `index` edges.

## Notes

Production database read-only; run measurements with `sqlite3 -readonly` or against a
`/tmp` copy.
