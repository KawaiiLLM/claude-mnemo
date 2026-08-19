# 01 — Row-level rendering aligns to the golden samples

**What to build:** recall and timeline output whose bytes match the user's
golden samples (now VERBATIM in `.scratch/read-write-contract/spec.md`
"金样例" — [S15069/T1029] restating the T919/T921 rulings that were lost at
the T959 spec-writing, see [S15069/T1024]/[T1026] for the loss accounting).

**Blocked by:** the 待裁 list below — the unambiguous half can start; the
conflicted half waits for rulings.

**Status:** blocked-on-rulings (partially ready)

## Unambiguous alignments (no conflicting later ruling)

- [ ] Session as TRANSITION LINE: `[S15069]` (title only on first appearance);
      turn rows lose the `[S…]` prefix everywhere (listings, search results,
      member listings). Citation-assembly resolution ([S15069/T1032]): a page
      that opens mid-session gives its FIRST turn row the full `[Sxx][Txx]`
      form (no repeated transition line); every later row in the same session
      run stays bare. Any page is thus self-contained for the `Sxx/Txx`
      citation join without paying the prefix on every row.
- [ ] Count badges retire from session headers and turn rows (T921 ruling,
      double-confirmed): `💬1017 💡5950`, `💡32 ✏️3 🔧32` go; tail status
      markers (`[skipped]`, `[rewind]`, `[extracted]`) stay.
- [ ] Field lines take the `filter.fields` vocabulary: `- content:`, never
      `- desc:` — on turn rows AND segment cards.
- [ ] Indentation hierarchy `[E]` → `[S]` → `[T]` → field rows per the samples.
- [ ] Segment card `- sessions:` row = bare id list (`Sxxx, Sxxx`), not
      title+stats rows.
- [ ] ↳ rows carry antecedent ADDRESSES (`↳ T811, T812`); first LOCATE whether
      the current `↳ +1 前件` is arc-spine budget degradation or a plain miss,
      then fix accordingly (degradation may keep a count form only under
      pressure — record which).

## Ruled ([S15069/T1032][S15069/T1035] — all five conflicts closed)

1. G grade DISPLAY goes everywhere (the grading machinery itself retires as
   historical debt — ticket 02's own scope; this ticket only strips the
   rendered column/values).
2. + 3. Golden sample = the degradation-ladder BASELINE; per-row `08-17 18:19`
   timestamps are the sample form. Day-folding headers and spine desc
   sub-lines survive only as budget-permitting enrichments that DEGRADE back
   to the sample form — never below it.
4. The turns TABLE dissolves — no tabular surface. timeline's turn view = the
   unified row form plus a `metadata` FIELD SLOT (time/gap/stats live there);
   field slots other than metadata default to content only. The user's
   verbatim example is in the spec's 金样例 补充 block — quote it as the
   fixture, don't retype.
5. Search shape differs from browse in ORDERING ONLY (relevance vs chrono);
   same unified row form, same transition lines, no session-header stats.
   Match-bolding + neighborhood is content-field excerpt behavior inside the
   one form.

## Pinned interpretations (correct me if wrong, else they stand)

- `metadata` renders as an unprefixed line directly under the turn row (per
  the sample's `metadata` line), content like `08-17 18:19 · +6m · 🔧20 ✏️3`
  — exact composition at implementer's judgment from existing metadata.
- `metadata` is selectable via `filter.fields` like any turn field; recall
  defaults exclude it; timeline's turn view defaults INCLUDE it (it replaces
  the audit columns).
- The rewind marker becomes the sample's tail `[rewind]`; the long
  do-not-trust-replay teaching moves to the replay skill doc alone.

## Acceptance

- [ ] Byte-level format tests derived from the golden samples (the spec's
      金样例 blocks are the fixtures' source of truth — quote, don't retype).
- [ ] The unambiguous six land regardless of the 待裁 answers; conflicted
      surfaces follow their rulings.
- [ ] Skill docs (mnemo-recall / mnemo-timeline) re-teach the new bytes in the
      same release (E60 constraint: skill docs are the stale teacher).
