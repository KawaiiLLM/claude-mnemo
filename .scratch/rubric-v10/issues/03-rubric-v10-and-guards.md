# 03 — Rubric v10 §Relations, guards, and teaching sync

**What to build:** the rubric's §Relations replaced by the v10 lane-model text — English translation of the user-confirmed Chinese draft, prepared at `.scratch/rubric-v10/relations-v10-en.md` (the PROMPT TEXT itself is written by the main agent personally, per user ruling; this ticket lands it plus the guards). Fields/Segments/Policy sections unchanged. Guard tests re-point: the closed-vocabulary parser asserts the eight words, their phase domains AND their taggability against the validator, parsed from the RENDERED text; the rendered-byte guard asserts positive headroom against the silent-truncation cap on the untruncated constant. Plugin skill docs that teach the edge surface sync in the same change (the stale-teacher discipline).

**Blocked by:** 02 — Write surface and the three hard gates (guards assert the new validator behavior).

**Status:** ready-for-agent

- [ ] Rendered rubric carries the interpretation principle, lane, eight words with tagged/untagged readings, convergence + subset invariant, three principles as aspirations, the release axiom, and the miscellany block — nothing from the migration/checker mechanics.
- [ ] Guard parses phase domain AND taggability per word from the rendered text and both match the validator exhaustively.
- [ ] Rendered size leaves positive headroom under the injection cap; the guard asserts it on the untruncated constant.
- [ ] Skill docs teaching edges/relations updated in the same change; no doc still teaches flows, collects, or the decision-only cage.
