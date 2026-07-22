# 07 — Pre-ship offline validation and cutoff finalization

**What to build:** The release gate. (a) Re-run the S15385 blind-annotation experiment feeding the annotator the slim ticket-05 skeleton payload instead of full context; compare G3/G2 boundaries against the full-context run on the validated exemplar set (extraction-failure diagnosis G4; probe design / SFT-pilot design / probe-result G3; driver root-cause chain G2; launch confirmations G1; polls G0). Divergence on the exemplars blocks release. This is a /tmp-verifier style manual experiment, NOT a CI test. (b) Set the era cutoff constant to the release timestamp. (c) Version bump across all six sites per the release checklist, rebuild, release.

**Blocked by:** 02, 03, 04, 05, 06 — all implementation tickets.

**Status:** ready-for-agent (execution reserved for the maintainer session, not Codex)

- [x] Slim-payload blind run completed; boundary comparison recorded alongside the validation script outside the repo (/tmp/s15385-grades-sonnet-slim{,2,3}.json; three rounds, 2026-07-22).
- [x] No divergence on the validated exemplar set — round 3 passed 9/9 after two rubric fixes (evaluation-validity-fix = G3 worked example; numeric on-track polls = G0). Round-1 divergence was traced to the experiment brief lacking the production worked examples, not to the slim payload.
- [x] Cutoff constant set to the release timestamp (epoch 1784711427).
- [x] Version bumped at all six sites (0.8.0), artifacts rebuilt, release pushed.
