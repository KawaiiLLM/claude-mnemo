# 03 — Calibration invariants and conditional density alarm

**What to build:** The every-10th-prompt significance-calibration block keeps its cadence and the session's own observed-distribution table, drops the fixed reference-percentage baseline sentence entirely, and gains: (a) qualitative structural invariants phrased as self-checks (deletion test for G3; one G4 per arc; troubleshooting chains resolve to G2 conclusions, not G3 chains; no-change polls are G0); (b) a conditional density alarm — the G3 density threshold (~1 per 10 turns) is a code-side constant checked against the session's own recent window, and the builder emits a single alarm line only when the threshold is exceeded ("N G3 grades in the last M turns — re-run the deletion test on each"). No standing distribution or density target of any kind remains in the injected text.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] Injected block contains the observed-distribution table and the qualitative invariants; contains no percentage baseline and no standing density number.
- [x] For a seeded session whose recent window exceeds the G3 density threshold, exactly one alarm line appears; for a compliant window, no alarm line and no threshold number appears anywhere in the output.
- [x] Cadence unchanged (every 10th prompt; empty string otherwise) — existing cadence tests still pass.
- [x] Full suite green.
