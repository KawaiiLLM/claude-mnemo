# 02 — Note receipt trim: a segment prints only on divergence

**What to build:** A compliant note receipt runs ~105 tokens where ~18 carry
information (measured at S15069/T1159 against note.ts:1278-1369). The heavy
payer is the settlement agent — dozens of receipts per 50-turn window land in
its context. One principle governs all four cuts: **a receipt segment prints
only when it tells the caller something it does not already know.**

1. **writer_model** — print only when a model was recorded. The
   "not recorded — this environment does not expose the model to the MCP
   server" apology (note.ts:1308) is an environment constant: zero information
   per call. The standing fact moves to a code comment; the branch deletes.
2. **ride_turn** — print only when the ride turn differs from the written turn
   or is unknown (both diagnostic); silent in the common same-turn case.
3. **type/tags echo** — print only when the STORED form differs from the
   submitted form (normalization, merge, clearing to `(none)`); silent when
   identical. If inspection shows stored can never diverge from submitted,
   delete the echo lines outright — state which case held in the report.
4. **Budget warning** — the shared `formatBudgetWarning`
   (src/shared/note-budget.ts:105, consumed by BOTH note.ts and the settlement
   facade at note-settlement-turn-facade.ts:1121) KEEPS firing on every ≥1.5×
   call — the every-call firing is a protected ruling (a one-shot reminder
   cannot suppress a standing habit); only the sentence compresses. Target
   wording: `content over 1.5× — occasional is fine, a standing pattern is
   not.` (field name as today; the ratio detail already sits on the budget
   line).

Unchanged by declaration: the Noted/Updated verb + address, the budget line,
the attached/restated distinction (a D2 ruling), retraction and citation
lines, `Private-tagged content was removed` (fires only when true — already
divergence-shaped).

Cross-surface duties:
- tests/metrics/p1-exposure-freeze.test.ts, p1-compliance.test.ts and
  p1-fixture.ts reference writer_model/ride_turn — determine whether p1
  metrics parse receipt STRINGS or database rows; update fixtures faithfully
  and do not weaken what the metrics assert.
- Check the settlement facade's own receipt composition for the same segments;
  cuts flow through shared helpers, never copy-paste.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A same-turn, in-budget, no-divergence write's receipt is exactly
      `Noted S<x>/T<y>. budget: <…>. Attached N relation(s).` (plus only the
      relation/citation/retraction lines that genuinely fired).
- [ ] A backlog write (ride ≠ target) still prints ride_turn; a recorded
      writer_model still prints; ride_turn unknown still prints.
- [ ] A ≥1.5× write warns on EVERY offending call with the compressed wording
      — a test pins the every-call property (two consecutive offending calls
      both warn).
- [ ] Divergence echo tested both ways: stored ≠ submitted prints the line,
      identical stays silent (or the echo is deleted with the never-diverges
      finding recorded).
- [ ] p1 metric fixtures updated without weakening assertions.
- [ ] Full suite green except the sanctioned stale-bundle guard; counts
      reported.
