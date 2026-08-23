# 06 — Settlement goes pull: a range-only prompt, self-recalled reads, the rewritten checklist

**What to build:** the pushed window rendering retires. The settlement
prompt carries: the rubric, the duties, the IMMUTABLE WRITABLE SET
(printed from ticket 05's computation), the roster pointer, and the commit
contract; all content — turns and segment cards — is read by the agent's
own recall/timeline calls. Spec: `.scratch/tag-mandate/spec.md`, the whole
"Settlement surface" section including the peer-round bullets.

Division of labor (ruled S15069/T1452): **the prompt text itself is
authored by the main agent personally — this ticket's worker builds the
plumbing around a provided text**, and stops-and-reports if the text is
not yet present in the ticket directory when it starts:
- Retire the window rendering path; wire the writable-set printing.
- Unify read-grant licensing onto the agent's own recalls (the
  rendered-in-full channel retires).
- Verify the settlement SDK agent's tool allowlist includes recall (and
  timeline), and that the relations field renders through it.
- Coverage contract (checklist Step 0) support: exhaustive paging of the
  writable set is teachable and testable; timeline navigates only.

**Blocked by:** edge-read-surface ticket 01 (accepted against the peer's
completeness bar), 02 (the gate must hold the mandate the prompt
teaches), 05 (the commit contract the prompt names). The prompt text file
from the main agent is a fourth, human-side gate.

**Status:** done (mutation-verified: one-word paraphrase SURVIVED the sampled pins → durable verbatim guard added reading the authored file, then red; recall readerId neutered → 2 red; closure-only ids dropped from the printed set → 1 red. Accepted-with-note: the recall-handler readerId duplication carries a commented fold-back; the shadow-note blind-overwrite hole is a named follow-up)

- [ ] Window rendering gone; prompt carries the writable set verbatim;
      grants unify (the special rendering-grant path deleted with tests
      updated)
- [ ] Allowlist verified with a pinned test; relations field reachable
      from the settlement agent's recall
- [ ] A full settlement run against a fixture DB works end-to-end pull
      (real-handler discipline)
- [ ] Load-bearing properties declared for mutation acceptance
