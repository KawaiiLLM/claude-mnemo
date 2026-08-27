# 01 — `note` carries the relation parameters again

**What to build:** the main agent can write an edge when it has reason to, exactly
as the ruling that supposedly authorised their removal actually said. The tool's
DESCRIPTION still teaches only the common path — notes, not edges — but a caller
that sends a relation gets it written instead of a parse error.

**Blocked by:** None — can start immediately.

**Status:** resolved — landed as `cbf7461`, every criterion below re-checked verbatim by its worker

## Why

`src/mcp/note.ts` (~line 196) removes the seven relation parameters and their seven
`retract…` mirrors from `noteInputShape`, so a caller sending one gets `.strict()`'s
unrecognised-key parse error, plus an entry guard naming settlement. It cites its
authority as `ruling [S15069/T1651]`.

That ruling says the opposite. The user's own words, verbatim:

> b，要不直接把写边全部给结算，主agent只写title content insight type tags，这样不需要
> 这些复杂的概念，行动原则也可以简化。段的归属也不需要主动挂靠，而是根据段tag自动挂靠。
> **工具上保留这些能力**，但基本只需要调用note记如上turn字段、调用remember更新段字段和
> 创建/删除段，

"工具上保留这些能力" — the tools KEEP these capabilities. The turn's own note
recorded the same reading at the time: *"the tools keep their capabilities while the
descriptions teach only the common path."* The implementation deleted the
capability and cited the ruling that told it not to.

The cost is live and blocking: a hand-curated set of 38 index edges for E70 has no
write path at all today. `note` refuses them, no worker route writes an edge, and
settlement cannot be handed a list. A judgment the user has already made cannot be
recorded anywhere.

## Decisions (settled — implement as given)

1. **Restore the seven relation parameters and their seven `retract…` mirrors** to
   `noteInputShape`/`noteInputSchema` and to the handler, at the capability they had
   before the removal. Nothing else about the write gate changes.
2. **The DESCRIPTION keeps teaching the common path.** The ruling's whole shape is
   capability retained, guidance narrowed — so the description says edges are
   normally settlement's business and that a main-agent caller rarely needs these,
   without claiming they are unavailable. It must not say "refused".
3. **The rubric's action principles are NOT re-widened.** The main agent is still
   told not to write edges as routine practice; this restores the escape hatch, not
   the habit. Both halves of the ruling stand together.
4. **Every validation the edge path had stays** — address shape, lane legality (E4),
   vocabulary (E3), self-edge. A restored parameter is not a relaxed one.
   ("future-citation" was listed here too and is struck: no such refusal exists on
   this path — see the acceptance criterion below.)

## Acceptance criteria

- [x] A `note` call carrying a relation parameter writes the edge instead of raising
      a parse error, asserted at the tool boundary rather than at an internal helper.
- [x] A `retract…` mirror parameter works the same way.
- [x] The edge written is byte-identical in shape to one settlement writes for the
      same input — same identity key, same side tags, same mirror rows.
- [x] Every pre-existing refusal still refuses: undeclared lane, out-of-vocabulary
      relation, self-edge, tag missing from an endpoint's own tags. Assert each; a
      restored capability that skips a gate is worse than the removal.
      **"citing the future" WITHDRAWN from this criterion, not met and not
      implementable:** no such refusal has ever existed on the relation-write path,
      before or after the removal — `validateRelationTarget` has five refusal reasons
      and none is temporal. Time-order is `lane_check`'s report 4c, a CHECKER finding;
      the criterion put a checker report into a write gate. The worker declined to
      invent the behaviour and asked for the wording's source, which was the right
      call. Four of five asserted; the fifth was a defect in this ticket.
- [x] The tool description mentions edges as settlement's normal business WITHOUT
      asserting the parameters are unavailable, and no test pins the old "refused"
      wording. Grep for tests archiving that text and fix them rather than leaving a
      verbatim archive pinning a superseded contract.
- [x] The rubric's main-agent action principles are unchanged — asserted by a test or
      by showing the file is untouched.
- [x] Every new test is mutation-verified: name the observable that must differ,
      assert the mutation's needle matched and PRINT that it applied, confirm red,
      restore from a backup taken AFTER the implementation lands, confirm green.
- [x] `npx tsc --noEmit` clean, `node scripts/build.js` succeeds, `bun test` green;
      report the number and account for the change.

## Out of scope

Writing the 38 E70 index edges. This ticket restores the channel; using it is a
separate act with its own authorisation.

## Notes

The production database is read-only from this work. Do not write to
`~/.claude-mnemo/`.

The general lesson belongs in the project's constraints, not only here: an
implementation may not narrow a capability the ruling it cites said to retain, and
"the ruling authorised this" is checkable against the ruling's own words.
