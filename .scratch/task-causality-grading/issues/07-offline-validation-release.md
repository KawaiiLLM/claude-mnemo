# 07 — Pre-ship offline validation and cutoff finalization

**What to build:** The release gate. (a) Re-run the S15385 blind-annotation experiment feeding the annotator the slim ticket-05 skeleton payload instead of full context; compare G3/G2 boundaries against the full-context run on the validated exemplar set (extraction-failure diagnosis G4; probe design / SFT-pilot design / probe-result G3; driver root-cause chain G2; launch confirmations G1; polls G0). Divergence on the exemplars blocks release. This is a /tmp-verifier style manual experiment, NOT a CI test. (b) Set the era cutoff constant to the release timestamp. (c) Version bump across all six sites per the release checklist, rebuild, release.

**Blocked by:** 02, 03, 04, 05, 06 — all implementation tickets.

**Status:** ready-for-agent (execution reserved for the maintainer session, not Codex)

- [ ] Slim-payload blind run completed; boundary comparison recorded alongside the validation script outside the repo.
- [ ] No divergence on the validated exemplar set (or divergences resolved by rubric/skeleton fixes before release).
- [ ] Cutoff constant set to the release timestamp.
- [ ] Version bumped at all six sites, artifacts rebuilt, release pushed.
