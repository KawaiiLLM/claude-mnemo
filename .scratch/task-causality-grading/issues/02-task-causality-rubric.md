# 02 — Task-causality rubric rewrite in the extraction instructions

**What to build:** The extraction agent's per-turn grade rubric rewritten around task-level causality, per the spec's Solution section. The five definitions:

- G4 — task origin / re-foundation (arc expected ~50+ turns by scope of the ask; one per arc, second only for radical motive/criteria redefinition).
- G3 — major milestone within the arc affecting its design or conclusions; operative test is the deletion test ("if deleted, would the task's design, evaluation method, principles of action, or established conclusions change? If only the next execution action changes, cap at G2"). Unblocking-execution work (environment fixes, toolchain repair, local debugging) caps at G2 regardless of drama.
- G2 — durable conclusion or complete delivery; environment/toolchain decisions live here; a complete answer to a knowledge-question task is a delivery graded by completeness.
- G1 — routine execution with no independently persistable conclusion.
- G0 — no future value, judged by outcome not action type; "no later decision consumed it" is never sufficient by itself.

Regrade and citation duties: negate-on-cite downgrade retained unchanged; the "better flag bearer" G4 rule replaced by the re-foundation rule with its citation duty (a re-foundation G4 cites the G4 it re-founds; rollback stays separate and evidence-gated); bridge-G4 instruction for cutoff-straddling sessions (never present regrade as a way to make a legacy turn trusted); a G3 resuming an earlier arc must cite that arc's G4. Compound-turn rule (grade by highest material consequence) retained. Worked examples replaced with the S15385 exemplars from the spec.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] Assembled instruction text contains the deletion test, the unblocking-execution cap, the knowledge-answer-as-delivery rule, the bridge-G4 instruction, and both citation duties.
- [x] Assembled instruction text no longer contains the before/after-next-action G3 test, the "better flag bearer" rule, or any reference to a percentage baseline.
- [x] Old worked examples (T925/T909/T908/T850 etc.) replaced by the S15385 exemplar set.
- [x] Prompt-assembly tests assert the presences and absences above; full suite green.
