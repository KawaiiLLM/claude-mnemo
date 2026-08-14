# 03 — Milestone rows nest under segment lines

**What to build:** The arc view renders milestone rows beneath each segment line for the era side of a session, in prompt order. The rows are indistinguishable from the legacy era's — grade column, type glyph, prompt prefix, note title, changed files, collapsed antecedent counts, overturned turns demoted under the turn that overturned them — because they come from the same renderer fed by the same selection. Only the scoping unit changes: segment instead of day.

A reader of a long arc now sees which of its turns carried it without leaving the view. A session whose era turns carry no grades yet must render exactly as it does today; that is a pinned regression, not a tolerated degradation, and it is what makes the no-backfill decision free at read time.

**Blocked by:** None — can start immediately. Tests seed grades directly, so this does not wait on 02; until 02 ships, real sessions simply render as they do now.

**Status:** done — `9634440`. The render gate that hid titles behind ⏳ shipped alongside as `35d4e0f`.

- [ ] Milestone rows appear under their own segment line, in prompt order
- [ ] Admission is effGrade ≥ 3 plus structural always-keep rows, reached by calling the existing selection rather than a parallel implementation
- [ ] The printed grade is effGrade after victim demotion and corrector promotion, so it agrees with the legacy column
- [ ] An overturned era turn renders as a demoted casualty beneath its corrector
- [ ] Antecedents collapse to a count
- [ ] A segment whose members carry no grades renders byte-identically to current output, pinned as a regression
- [ ] Era turns belonging to no segment — compact markers and turns without notes — produce no rows
- [ ] Under budget pressure milestone rows degrade before any segment line is touched
- [ ] The legacy selection still runs over legacy turns alone, including the universe it resolves citations against; no era turn is pulled into the legacy block
- [ ] Full suite green
