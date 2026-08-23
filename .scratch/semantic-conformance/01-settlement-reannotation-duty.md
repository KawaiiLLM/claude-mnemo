# 01 — Settlement duty: non-conforming content is re-annotated, not kept

**Ruling (S15069/T1396, verbatim core):** 结算 agent 的任务是——缺失或不符合
现行语义的,重新标注;符合现行语义的,进行检查、纠正与补充。

**What to build:** the settlement prompt's duty framing changes so legacy
content is never "keepable standing content":

- MISSING or NON-CONFORMING annotations — a type carrying words outside the
  current closed vocabulary (discovery/change/feature/bugfix-as-only-word/
  decision-as-legacy etc.), an empty type on a substantive turn, retired
  relation vocabulary, fields violating current field law — are
  RE-ANNOTATED from scratch under the Memory Rubric, exactly as a first
  writer would annotate them today. Re-annotation is not "correction of an
  explicit mistake"; the old word being retired IS the nonconformity.
- CONFORMING annotations keep today's discipline: check, correct the
  explicit, supplement what is missing (edges included), leave doubt alone.

Context: job 76 (T1-100 backfill) kept 82/96 legacy-typed turns untouched —
phase-empty, hence nearly edge-illegal, hence a 9-edge window. The premise
"the backfill campaign doubles as type migration" fails without this duty.

**Blocked by:** None.

**Status:** done

- [x] The settlement prompt states the two-branch duty (re-annotate
      non-conforming / check-correct-supplement conforming) with the closed
      vocabulary named as the conformance test; existing duty structure and
      numbering preserved where possible
- [x] Prompt guard tests pin the two branches' load-bearing phrases; no
      restatement of rubric judgment content (pointer discipline intact)
- [x] The pre-era path (allow_pre_era windows) needs no special-casing — the
      duty is uniform; if any pre-era-specific text exists that contradicts
      it, it is updated in the same pass

## Comments

Implemented in `src/worker/note-settlement-prompt.ts` (duty 2's
RECONCILIATION preamble) + `tests/worker/note-settlement-prompt.test.ts`
(new `describe("ticket 01 — ...")` block, 4 tests). No other files touched.

- Duty 2's preamble now states: "Every annotation you meet follows the SAME
  rule on every window, backfill or check: MISSING (empty on a substantive
  turn) or NON-CONFORMING (stated, but in vocabulary this system no longer
  uses — for `type`, conformance means every word is a member of the closed
  vocabulary the Rubric defines above) is RE-ANNOTATED FROM SCRATCH —
  judged under the Memory Rubric exactly as a first writer would today; the
  old word being retired IS the nonconformity, not a mistake to correct. A
  CONFORMING annotation keeps the ordinary discipline instead: check it,
  correct the explicit, supplement what is missing, leave doubt alone."
- The conformance test is named ("member of the closed vocabulary") without
  restating `MEMORY_TYPES`' word list or definitions — those stay the
  Rubric's one copy (pointer discipline; guard test asserts none of the 11
  `MEMORY_TYPES` words appear quoted in duty 2's own added prose).
- Checkbox 3 verified as a no-op: grepped the prompt file and found no
  `pre-era`/`backfill`-conditioned branching in its text before this change
  (the existing "backfill = rebuild from zero, ordinary = check" framing in
  "## Your task" is about whether NOTES already exist, orthogonal to
  per-field type conformance, and does not contradict the new uniform
  rule). `allow_pre_era` lives entirely in `db/note-settlement.ts` /
  `server.ts` (job-claiming), never in this prompt's text — nothing to
  special-case or update. New guard test asserts the prompt never mentions
  `pre-era`/`allow_pre_era` at all.
- Edges/relations needed no analogous text: `EDGE_RELATIONS` already drives
  every relation word this prompt offers as a call shape, so a retired
  relation word was never representable here in the first place — the
  duty's uniform framing covers it by construction, no separate mention
  added (documented in the file's own top-of-file history comment,
  "TICKET 01'S DUTY" paragraph).
