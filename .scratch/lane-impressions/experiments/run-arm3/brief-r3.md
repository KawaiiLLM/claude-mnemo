You are the settlement run for a memory system. You are the SOLE writer of "lane impressions".
Your ONLY inputs are the writing law below and the settlement window you are given.
You have no other knowledge of this project and must not use any. Do not read any other file
in the repository, do not search the web, do not ask questions.

Read these two files first:

1. /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-arm3/teaching.txt  — THE WRITING LAW. It governs absolutely.
2. /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/corpus/w3.txt                 — the settlement window you are settling now.

CONTAINER COORDINATES (these are the facts the law refers to as "told to you per lane"):

- `E1/#visual-style`: baseRevision 1, TOTAL CAP 150 tokens, not stale. No overridden anchors.
  Its CURRENT stored impression is exactly these lines:
  ```
  The SAN11 visual-style lane: pixel art, 3/4 top-down is locked as M3's visual milestone in SPEC v4 (S18993/T89, T93), overriding the earlier oblique 2.5D vector/Board2D plan (S18993/T82, T85) — oblique+pixel causes forbidden aliasing; pixel art was also judged proceduralizable via placement rules, not drawing (S18993/T88). 3-tier asset sourcing locked: ~80% CC0/paid packs, ~15% AI pixel generators (S18993/T89). The placement pipeline remains design-only.
  ```
- `E1/#map-data-extraction`: baseRevision 1, TOTAL CAP 150 tokens, not stale, no overridden anchors.
  Its CURRENT stored impression is exactly these lines:
  ```
  The SAN11 map-data-extraction lane: original tile/region data is pulled from san11pkres.bin via the community S11Bin editor, run on a Windows machine at 192.168.1.6 (S18993/T96, T97). The extraction recipe came from a forum post (S18993/T95); the 1.5G asset folder and editor v1.095 were copied there and verified byte-exact (S18993/T98, T99). v1.095 postdates the forum's v1.07 parsing-bug fix, likely already fixed but unconfirmed. Open: exporting the tile-info table to the converter is not yet done.
  ```

  (The fenced block is a display wrapper only: the stored text is the lines inside it, with the two
  leading indent spaces removed. Do NOT copy the fences or the indent into your answer.)

ANCHOR ADDRESSES: every turn in the window belongs to session 18993. A turn printed as `T199`
in the window has the full address `S18993/T199`. Turn ids appearing inside a turn's own
`content` in square brackets (e.g. `[T11011]`) are RAW ids from a different numbering and are
NOT valid anchors — never write them.

WHAT YOU PRODUCE. For each lane, decide `retain` or `replace`, exactly as the law describes.
Write your answer to files, one file per lane:

- `E1/#visual-style` -> /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-arm3/r3/visual-style.txt
- `E1/#map-data-extraction` -> /Users/zhaoqixuan/Projects/claude-mnemo/.scratch/lane-impressions/experiments/run-arm3/r3/map-data-extraction.txt

Each file must contain EITHER the single word `RETAIN` on one line, OR the literal word
`REPLACE` on line 1 followed by the WHOLE new impression text starting on line 2. Nothing else
— no commentary, no code fences, no trailing blank line.

Then reply with one short sentence per lane saying what you decided and why. Nothing more.
