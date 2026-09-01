You are the settlement run for a memory system. You are the SOLE writer of "lane impressions".
Your ONLY inputs are the writing law below and the settlement window you are given.
You have no other knowledge of this project and must not use any. Do not read any other file
in the repository, do not search the web, do not ask questions.

Read these two files first:

1. /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-arm3/teaching.txt  — THE WRITING LAW. It governs absolutely.
2. /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/corpus/w4.txt                 — the settlement window you are settling now.

CONTAINER COORDINATES (these are the facts the law refers to as "told to you per lane"):

- `E1/#visual-style`: baseRevision 2, TOTAL CAP 150 tokens, not stale.
  OVERRIDDEN ANCHORS (this window's own edges overrode them): S18993/T133.
  Its CURRENT stored impression is exactly these lines:
  ```
  The SAN11 visual-style lane: locked to 2:1 isometric, diagonal-brick diamond tiles with visible stagger (S18993/T124, T125), reversing the earlier 3/4-top-down pick (S18993/T105). Top-down misreads trace to axis-aligned gridlines, not foreshortening — a yawed diagonal grid over brick-square ground yields the stagger (S18993/T119, T124). MVP scope: cities/corps/combat, tickets 001-004 (S18993/T122); officer portraits from 萌战 (S18993/T133). Ticket 004 verified, commit staged not landed (S18993/T149).
  ```
- `E1/#map-data-extraction`: baseRevision 2, TOTAL CAP 150 tokens, not stale, no overridden anchors.
  Its CURRENT stored impression is exactly these lines:
  ```
  The SAN11 map-data-extraction lane: san11pkres.bin (963MB) decoded as the SHEX binary format — 200×200 cells, terrain id + region ownership per cell, containing two embedded maps (S18993/T101). mapA is the build target, picked over the mirror-defective mapB, deferred to reuse mapA's pipeline (S18993/T102). Hex adjacency locked odd-r, proven via city-flower row-parity; hex and isometric projection are identical (S18993/T103). mapA.json plus tooling delivered and verified (42/42 cities) — closing the prior converter-export gap; mapB conversion open (S18993/T103).
  ```

  (The fenced block is a display wrapper only: the stored text is the lines inside it, with the two
  leading indent spaces removed. Do NOT copy the fences or the indent into your answer.)

ANCHOR ADDRESSES: every turn in the window belongs to session 18993. A turn printed as `T199`
in the window has the full address `S18993/T199`. Turn ids appearing inside a turn's own
`content` in square brackets (e.g. `[T11011]`) are RAW ids from a different numbering and are
NOT valid anchors — never write them.

WHAT YOU PRODUCE. For each lane, decide `retain` or `replace`, exactly as the law describes.
Write your answer to files, one file per lane:

- `E1/#visual-style` -> /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-arm3/r4/visual-style.txt
- `E1/#map-data-extraction` -> /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-arm3/r4/map-data-extraction.txt

Each file must contain EITHER the single word `RETAIN` on one line, OR the literal word
`REPLACE` on line 1 followed by the WHOLE new impression text starting on line 2. Nothing else
— no commentary, no code fences, no trailing blank line.

Then put your report in your FINAL REPORT: one short sentence per lane saying what you decided
and why. Send no messages to anyone.
