# Milestone selection simulations (0.2.38 calibration)

> **Archived evidence tooling** for the milestone-election design rounds — not product code; nothing imports it and nothing here ships.

Companion scripts for `docs/plans/2026-07-03-milestone-weighted-scoring.md`. Each is
self-contained Python 3 (stdlib only); later scripts import earlier ones by
`__file__`-relative path, so run them from anywhere.

| script | purpose |
|---|---|
| `milestone-sim.py` | production `selectMilestoneTurns` replica + rules A (outcome coalescing) / B (discovery scoring) / D (victim hard-demote) |
| `milestone-sim2.py` | tag-keyword bonus experiment (replace / additive / pass-gate arms); exposes the A+B+D `ref` selection used as the comparison baseline |
| `milestone-sim3.py` | weighted multi-signal arms v1–v3 (spine break / flood / dark-day failures); exposes signal precomputation (`indeg`, `pure_spec`, `tag_fam`, markers) |
| `milestone-sim4.py` | 4,608-config grid calibration against GOLD/MUD hand judgments; prints winner, TOP-3, hard-constraint checks, diff vs ref |
| `milestone-sim5.py` | self-contained cross-session validation of the winner config (S1730 / S5233 / S9262) + sensitivity spot-checks |

## Fixtures (NOT committed — regenerate locally)

The session dumps contain cross-project conversation summaries (private data) and
are deliberately excluded from the repo. Regenerate from your local DB:

```bash
for sid in 1730 5233 9262; do
  sqlite3 -json "file:$HOME/.claude-mnemo/claude-mnemo.db?mode=ro" "
  SELECT id, prompt_number, status, type, tags, title, content, insight,
         files_modified, tool_call_count, was_interrupted, was_rolled_back, created_at_epoch
  FROM turns WHERE session_id=$sid ORDER BY prompt_number, created_at_epoch, id;
  " > /tmp/s${sid}_turns.json
done
```

Dumps used for the 2026-07-03 calibration (sha256, for drift detection — the DB
keeps growing, so a re-export of a still-active session will not match):

```text
10a082d6f5c442ed4a8f1e2f7d41ce8343be60f597d410a851667ac59803fbd1  s1730_turns.json  (577 turns)
c32082d4a39d62388e26e45457c415a7e8d60229bace9055fdd265ce9da8f645  s5233_turns.json  (615 non-skipped basis)
c787396fd8e0705548827f775baf3a111863260de6b243b5c968eec1e406ae85  s9262_turns.json  (251 non-skipped basis)
```

Calibration result to reproduce: `milestone-sim4.py` winner
`decision=4, feature=refactor=2, bugfix=2, change=1, discovery=1, W_insight=2,
W_spec=3, W_fam=1 (bare tags only), W_cite=1, CITE_CAP=2, W_burst=0, POOL_MIN=2,
DAY_BASE=4, DAY_MAX=7` → objective +38, GOLD 19/28, MUD 0/12, kept 102 (22.3%),
all hard constraints OK (with the structural core including invalidated +
reversed-without-corrector).

`tagFam` reads bare tags only (topic: tags never affect milestones, per the
0.2.37 two-class contract); the redundant `roleTag` term was dropped — both
changes leave the winner and all three cross-session selections bit-identical.
