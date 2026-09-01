# 06 — Retire the justify / disposition ledger from the settlement path

**What to build:** the `justify` / disposition ledger leaves the settlement path. **RULED: RETIRE** (user, S15069/T2278).

**Blocked by:** 04 — fractures must already be warnings before their disposal machinery is removed.

**Status:** ready-for-agent

## The decision, as ruled

Once a fracture is a warning, the disposition ledger's only substantive consumer is gone. The user ruled RETIRE on 2026-09-01. The rejected alternative was keeping it as a way to silence a warning permanently.

The reasoning of record:

1. Its only correctness consumer was the terminal gate; what remains is a duplicate-reason anomaly signal.
2. A bounded warning leaves the reporting window on its own as the window advances — permanent silencing is not needed.
3. Keeping it means continuing to maintain fingerprints, the run-touch ledger, component coverage, representative full-text delivery, freshness and content sequences with no correctness consumer — accidental complexity by the project's own standard.
4. Keeping the ledger but deleting its read grants is WORSE than either: a persistent semantic judgment with no evidence requirement is unevidenced permanent concealment. Those grants exist because of earlier rulings (S15069/T1950, T1961, T1967; S21460/T234), and 400+ of the last week's refusals are the price they charge.

The argument that did NOT win, recorded because it may return: a deliberate split is a real judgment a human may want on the record, and the 400+ refusals are an ergonomics cost rather than proof the evidence boundary was wrong. If that need reappears it comes back as an operator-owned annotation, never as an unattended-settlement obligation.

## What retiring does NOT do (ticket 01)

Retiring `justify` removes the only second opinion that ever CONTRADICTED the gate — it does not remove the phantom fractures themselves. Ticket 02 owns that. Do not let this ticket be read as the fix.

## The work

- [ ] Remove the write entry point, the terminal consumer, the `justify` source in run-touch tracking, and the duplicate-reason warning.
- [ ] **The `justify` touch class must go with it, and the leftovers must be handled.** Ticket 01 found job 166's lane was armed ONLY by a `lane|60|execution-repair` touch row that `justify` itself had written — a self-arming trap: calling justify made the lane touched, which made the gate demand a disposition for it. The touch ledger is durable and job-scoped, so rows left by earlier attempts keep arming the gate after the code that wrote them is gone. Say explicitly what happens to existing rows of that class.
- [ ] Old rows and the table go INERT rather than being dropped in this batch — no destructive schema change on production data.
- [ ] Any future "a human confirms this split is deliberate" need becomes an OPERATOR-owned annotation, designed separately. Unattended settlement never pays whole-lane reading cost to silence a warning again.
- [ ] `npx tsc --noEmit` clean; touched suites green; full `bun test` once; bundles rebuilt, stale-bundle guard green.

- [ ] Report what the retirement actually removed, in lines and in call sites, and confirm by query that no remaining code path can refuse a settlement call over a fracture.
