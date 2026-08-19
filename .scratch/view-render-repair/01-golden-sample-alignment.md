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
      member listings).
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

## 待裁 (golden sample vs later arc-spine rulings — user decides)

1. G grade column on milestone/turns rows (arc-spine 等级直读) — samples show
   none.
2. Day-group folding headers (arc-spine 日框架) vs per-row `08-17 18:19`
   timestamps — samples show per-row time, no day headers.
3. Spine rows' desc sub-line (arc-spine 脊柱行带 desc) — samples show none.
4. Turns-table columns (`T# | time | gap | stats | G | prompt → title`,
   arc-spine §D) — keep as a distinct table surface, or fold into sample form?
5. Search-shape session headers (samples don't cover the search shape) —
   badge removal presumably applies there too; confirm.

## Acceptance

- [ ] Byte-level format tests derived from the golden samples (the spec's
      金样例 blocks are the fixtures' source of truth — quote, don't retype).
- [ ] The unambiguous six land regardless of the 待裁 answers; conflicted
      surfaces follow their rulings.
- [ ] Skill docs (mnemo-recall / mnemo-timeline) re-teach the new bytes in the
      same release (E60 constraint: skill docs are the stale teacher).
