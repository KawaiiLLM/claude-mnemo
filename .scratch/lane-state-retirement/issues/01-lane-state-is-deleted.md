# 01 — A lane has no state

**What to build:** `open` and `closed` stop existing. A lane is its members and the
edges claiming it; nothing in the system claims to know whether the work will
continue. Every reader that showed a lane's state shows something true instead, and
the rubric teaches one definition of `index` rather than two.

**Blocked by:** None — can start immediately.

**Status:** resolved — landed as `bccd429`, every criterion below re-checked verbatim by its worker

## Why

See `../spec.md`. Short version: `closed` = "the lane's newest member is its
terminus" is what forces `index` to mean lane-death, which is why it is used once in
819 edges; and the distinction it draws — at rest vs finished forever — is
undecidable from inside a bounded settlement window and is needed by no reader.

## Decisions (settled — implement as given)

1. **Delete, do not reinterpret.** `LaneClosure`, `deriveLaneStates`,
   `laneClosureClaim` in `src/shared/lane-interpretation.ts`, and everything downstream
   that exists only to carry their answer.
2. **The rubric loses its `open`/`closed` bullets and the sentence "七个词里只有
   index 参与 open / closed 的判定".** The adjacent clause **"被 override 的节点依然
   有效" STAYS** — a separate law, and load-bearing for ticket 02.
3. **`index`'s definition is unified on the concepts text's own wording**
   (阶段性收敛) and gains the granularity rule: it cites the batch of nodes that
   genuinely contributed to ONE phase result — one `/to-spec` run, one release — and
   a single cited node means the phase was cut too fine.
4. **The settlement prompt's step 4 ("DECLARE CONVERGENCE") is rewritten** to ask the
   local question — did this turn close out a stretch of work — with no reference to
   lane state, and its "leaving a lane honestly OPEN is normal life" clause removed.
   Its coupling principle "一条 closed 泳道的终点,应该被外部节点引用" is re-expressed
   without lane state.
5. **The too-fine rule is a `lane_check` WARNING, never a write refusal** — it is a
   per-turn aggregate and the rows are written one at a time, so refusing mid-batch
   would kill an unfinished write.
6. **Rendering follows**: the checker's three-state line, the console's lane state,
   and `timeline`'s `◎` terminus marker lose their basis. Re-specify or remove each;
   do not leave a marker whose meaning is now undefined.

## Acceptance criteria

- [x] The retired symbols are gone, pinned by a deletions test in the style of the
      existing `lane-model-v12-deletions` test.
- [x] The rubric's injected text no longer defines `open`/`closed`, still contains
      "被 override 的节点依然有效", and fits the injection ceiling — state the new
      char count against `MAX_INJECTED_BLOCK_CHARS`.
- [x] The rubric hash constants and every test archiving the rubric verbatim are
      updated together. Any test holding its own copy of the rubric text also needs a
      check comparing that copy to the authority, or it pins a superseded version.
- [x] The `lane_check` too-fine warning fires on a single-target index and stays
      silent at two targets. Both directions.
- [x] No write path refuses a single-target index — assert it, so decision 5 cannot
      drift into a gate.
- [x] Every surface that rendered lane state renders something true instead, with the
      choice recorded per surface (checker line, console, `timeline` `◎`).
- [x] Settlement's prompt no longer contains "leaving a lane honestly OPEN is normal
      life" nor any lane-state reference in step 4 or the coupling principle.
- [x] Every new test mutation-verified: name the observable that must differ, assert
      the mutation's needle matched and PRINT that it applied, confirm red, restore
      from a backup taken AFTER the implementation lands, confirm green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test` green;
      report the number and account for the change.

## Out of scope

The election's new rule (ticket 02). Removing lane state takes away tier ②'s only
input, and the code must still compile — so make tier ② **qualify nobody**, as an
explicit and tested "no seats until ticket 02", rather than inventing a replacement
rule here. State it plainly in the report; a silent fallback that happens to seat
something would hide 02's whole effect.

## Notes

Production database read-only. Do not write to `~/.claude-mnemo/`.
