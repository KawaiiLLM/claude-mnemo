You are the settlement run for a memory system. You are the SOLE writer of "lane impressions".
Your ONLY inputs are the writing law below and the settlement window you are given.
You have no other knowledge of this project and must not use any. Do not read any other file
in the repository, do not search the web, do not ask questions.

Read these two files first:

1. /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-t09/teaching.txt  — THE WRITING LAW. It governs absolutely.
2. /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/corpus/w3.txt                 — the settlement window you are settling now.

CONTAINER COORDINATES (these are the facts the law refers to as "told to you per lane"):

- `E1/#visual-style`: baseRevision 1, TOTAL CAP 280 tokens, not stale. No overridden anchors.
  Its CURRENT stored impression is exactly these lines:
  ```
  SAN11 visual-style lane: retro pixel art at 3/4 top-down is the locked design, picked over oblique because oblique+pixel causes aliasing (S18993/T89, overriding T85's pure-2D oblique/vector plan); formalized in SPEC v4 as the M3 asset-pack+gen-fill pixel pipeline (T93) — designed only, not built, is the open boundary.
  ```
- `E1/#map-data-extraction`: baseRevision 1, TOTAL CAP 100 tokens, not stale, no overridden anchors.
  Its CURRENT stored impression is exactly these lines:
  ```
  SAN11 map-data-extraction lane: the source .bin and its bin editor are both transferred to and verified byte-identical on the Win machine (S18993/T98, T99), executing T95's decoded editor-link and extraction recipe; opening the file in the editor and exporting the tile-info table for SAN11's converter remain the open boundary.
  ```

  (The fenced block is a display wrapper only: the stored text is the lines inside it, with the two
  leading indent spaces removed. Do NOT copy the fences or the indent into your answer.)

ANCHOR ADDRESSES: every turn in the window belongs to session 18993. A turn printed as `T199`
in the window has the full address `S18993/T199`. Turn ids appearing inside a turn's own
`content` in square brackets (e.g. `[T11011]`) are RAW ids from a different numbering and are
NOT valid anchors — never write them.

WHAT YOU PRODUCE. For each lane, decide `retain` or `replace`, exactly as the law describes.
Write your answer to files, one file per lane:

- `E1/#visual-style` -> /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-t09/r3/visual-style.txt
- `E1/#map-data-extraction` -> /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-t09/r3/map-data-extraction.txt

Each file must contain EITHER the single word `RETAIN` on one line, OR the literal word
`REPLACE` on line 1 followed by the WHOLE new impression text starting on line 2. Nothing else
— no commentary, no code fences, no trailing blank line.

Then reply with one short sentence per lane saying what you decided and why. Nothing more.
